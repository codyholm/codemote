/**
 * CLI Entry Point for Codemote
 *
 * Main executable that starts the server, displays the UI, and handles
 * graceful shutdown. This is the entry point for `npx codemote`.
 *
 * RESPONSIBILITIES:
 * 1. Start relay + uplink server on configured port
 * 2. Generate QR code for mobile pairing
 * 3. Advertise service via mDNS/Bonjour
 * 4. Display terminal UI with status updates
 * 5. Graceful shutdown on SIGINT/SIGTERM
 *
 * USAGE:
 * ```bash
 * # Default port 8080
 * npx codemote
 *
 * # Custom port
 * PORT=3000 npx codemote
 * ```
 */

import { advertiseService } from "./mdns.js";
import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";
import { startServer } from "./server.js";
import {
	installService,
	readServiceLogs,
	readServiceStatus,
	resolveServicePaths,
	startService,
	stopService,
	uninstallService,
} from "./service.js";
import { ensureLocalTLS, fetchRelayTlsPin } from "./tls.js";
import { renderUI, updateStatus } from "./ui.js";

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type { RuntimeType } from "@codemote/server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
const rawArgs = process.argv.slice(2);

type StartupMode = "interactive" | "serve";

function resolveServiceScriptPath(): string {
	const workspaceScriptPath = resolve(process.cwd(), "packages/cli/dist/cli.js");
	if (existsSync(workspaceScriptPath)) {
		return workspaceScriptPath;
	}

	return fileURLToPath(import.meta.url);
}

function showHelp(): void {
	console.log(`codemote v${pkg.version} — Control AI coding agents from your phone

Usage:
  codemote
  codemote serve [--remote <relay-url>]
  codemote service install|start|stop|status|uninstall|logs [--remote <relay-url>]

Options:
  -h, --help     Show this help message
  -v, --version  Show version number
  --remote       Enable hosted relay mode (optionally provide relay URL)

Environment:
  PORT                         Server port (default: 8080)
  CODEMOTE_START_DIR           Default directory for project browsing (default: cwd)
  CODEMOTE_TRUSTED_PAIRINGS    Enable trusted pairing persistence (default: true)
  CODEMOTE_PAIRING_STORE_PATH  Override trusted pairing store JSON path
  CODEMOTE_REMOTE_RELAY_URL    Default hosted relay URL for --remote
  CODEMOTE_STATUS_FILE         Machine-readable status file path

${pkg.homepage}`);
}

async function startApp(mode: StartupMode, remoteRelayUrl?: string) {
	const port = Number.parseInt(process.env["PORT"] || "8080", 10);
	let interactive = mode === "interactive";
	const configuredRepoPath = (
		process.env["CODEMOTE_START_DIR"] || process.env["CODEMOTE_REPO_PATH"]
	)?.trim();
	const inferredRepoPath = process.env["INIT_CWD"]?.trim() || process.cwd();
	const repoPath = resolve(configuredRepoPath || inferredRepoPath);
	const statusFilePath = process.env["CODEMOTE_STATUS_FILE"]?.trim() || undefined;

	if (configuredRepoPath) {
		await mkdir(repoPath, { recursive: true });
	}

	console.log(
		remoteRelayUrl
			? `Starting Codemote in hosted relay mode (${remoteRelayUrl})...`
			: "Starting Codemote...",
	);

	// Keep advertised endpoint transport aligned with server-side TLS mode.
	const tlsDisableRequested =
		process.env["GUILD_REMOTE_DISABLE_TLS"] === "1" ||
		process.env["GUILD_REMOTE_DISABLE_TLS"] === "true";
	const allowInsecure =
		process.env["GUILD_REMOTE_ALLOW_INSECURE"] === "1" ||
		process.env["GUILD_REMOTE_ALLOW_INSECURE"] === "true";
	const tlsDisabled =
		tlsDisableRequested && allowInsecure && process.env["NODE_ENV"] !== "production";

	// Start the server (relay + uplink + bridge)
	const host = getLocalIP();
	const localRelayUrl = `${tlsDisabled ? "ws" : "wss"}://${host}:${port}/ws`;
	const server = await startServer({
		port,
		repoPath,
		...(remoteRelayUrl ? { remoteRelayUrl } : {}),
		...(!remoteRelayUrl ? { advertisedRelayUrl: localRelayUrl } : {}),
		...(statusFilePath ? { statusFilePath } : {}),
		onClientConnected: () => {
			if (mode === "serve") {
				console.log("[CLI] Mobile device connected");
			} else if (interactive) {
				console.log("Device connected");
			} else {
				updateStatus("   ✓ Device connected. Waiting for session...");
			}
		},
		onSessionStatus: ({ runtime, status }) => {
			if (mode === "serve") {
				if (status === "running" || status === "starting") {
					console.log(`[CLI] Active session: ${runtime} (${status})`);
				}
				return;
			}

			if (interactive) {
				return;
			}

			if (status === "running" || status === "starting") {
				updateStatus(`   Active session: ${formatRuntimeLabel(runtime)}`);
				return;
			}

			if (status === "idle") {
				updateStatus("   ✓ Device connected. Waiting for next prompt...");
			}
		},
	});

	const localMode = !remoteRelayUrl;
	const mdns = localMode ? advertiseService(port, server.pin) : { destroy: () => undefined };
	if (localMode) {
		console.log(`[CLI] mDNS advertising on port ${port}`);
	} else {
		console.log("[CLI] mDNS disabled in hosted relay mode");
	}
	console.log(`[CLI] Session workspace root: ${repoPath}`);

	const relayScheme = server.url.startsWith("wss://") ? "wss" : "ws";
	const relayUrl = localMode
		? `${relayScheme}://${host}:${port}/ws`
		: (remoteRelayUrl ?? server.url);

	if (mode === "interactive") {
		let tlsPin: string | undefined;
		if (relayScheme === "wss") {
			if (localMode) {
				tlsPin = (await ensureLocalTLS()).tlsPin;
			} else {
				try {
					tlsPin = await fetchRelayTlsPin(relayUrl);
				} catch (error) {
					console.warn(
						`[CLI] Unable to derive relay TLS pin for QR pairing: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		}

		const pairingHostPort = resolvePairingHostPort(relayUrl, host, port);
		const pairingURL = tlsPin
			? buildPairingURL(pairingHostPort.host, pairingHostPort.port, server.pin, {
					tlsPin,
					relayUrl,
				})
			: buildPairingURL(pairingHostPort.host, pairingHostPort.port, server.pin);
		const qrCode = await generateQRCode(pairingURL);

		await renderUI({
			qrCode,
			pin: server.pin,
			localURL: relayUrl,
			status: "ready",
			...(tlsPin ? { tlsPin } : {}),
		});
	} else {
		console.log(`[CLI] Serve mode ready. Relay: ${relayUrl}`);
	}

	// Optional interactive terminal commands (for starting sessions)
	if (mode === "interactive" && process.stdin.isTTY) {
		interactive = true;
		console.log(
			"\nCommands: claude|opencode|codex|gemini <prompt> | devices | unpair <mobileDeviceId> | unpair-all | help",
		);
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		rl.setPrompt("> ");
		rl.prompt();

		rl.on("line", async (line) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				rl.prompt();
				return;
			}

			if (trimmed === "help") {
				console.log(
					"\nCommands:\n  claude <prompt>\n  opencode <prompt>\n  codex <prompt>\n  gemini <prompt>\n  devices\n  unpair <mobileDeviceId>\n  unpair-all\n  quit\n",
				);
				rl.prompt();
				return;
			}

			if (trimmed === "quit" || trimmed === "exit") {
				rl.close();
				process.kill(process.pid, "SIGINT");
				return;
			}

			const [first, ...rest] = trimmed.split(/\s+/);

			if (first === "devices") {
				try {
					const trustedDevices = await server.listTrustedDevices();
					if (trustedDevices.length === 0) {
						console.log("No trusted devices.");
					} else {
						console.log("Trusted devices:");
						for (const device of trustedDevices) {
							console.log(
								`  ${device.mobileDeviceId}  paired=${formatTimestamp(device.pairedAt)}  last_seen=${formatTimestamp(device.lastSeenAt)}`,
							);
						}
					}
				} catch (err) {
					console.error(
						`Failed to list trusted devices: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				rl.prompt();
				return;
			}

			if (first === "unpair") {
				const mobileDeviceId = rest[0]?.trim();
				if (!mobileDeviceId) {
					console.log("Usage: unpair <mobileDeviceId>");
					rl.prompt();
					return;
				}

				try {
					const removed = await server.revokeTrustedDevice(mobileDeviceId);
					if (removed) {
						console.log(`Unpaired device: ${mobileDeviceId}`);
					} else {
						console.log(`Device was not paired: ${mobileDeviceId}`);
					}
				} catch (err) {
					console.error(
						`Failed to unpair device: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				rl.prompt();
				return;
			}

			if (first === "unpair-all") {
				try {
					const removed = await server.revokeAllTrustedDevices();
					console.log(`Unpaired ${removed} trusted device${removed === 1 ? "" : "s"}.`);
				} catch (err) {
					console.error(
						`Failed to unpair devices: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				rl.prompt();
				return;
			}

			const runtime = first as RuntimeType;
			const prompt = rest.join(" ").trim();

			const allowed: RuntimeType[] = ["claude", "opencode", "codex", "gemini"];
			if (!allowed.includes(runtime)) {
				console.log(`Unknown command: ${first}. Try: help`);
				rl.prompt();
				return;
			}

			let finalPrompt = prompt;
			if (finalPrompt.length === 0) {
				finalPrompt = (
					await new Promise<string>((resolve) => {
						rl.question("Prompt: ", (answer) => resolve(answer));
					})
				).trim();
			}

			if (finalPrompt.length === 0) {
				console.log("Prompt is required");
				rl.prompt();
				return;
			}

			try {
				const { sessionId } = await server.startSession(runtime, finalPrompt);
				console.log(`Started session ${sessionId} (${runtime})`);
			} catch (err) {
				console.error(
					`Failed to start session: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			rl.prompt();
		});

		rl.on("close", () => {
			// No-op; cleanup handled by SIGINT/SIGTERM.
		});
	}

	// Handle shutdown
	const cleanup = async () => {
		console.log("\n[CLI] Shutting down...");
		mdns.destroy();
		await server.stop();
		console.log("[CLI] Goodbye!");
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// Keep process alive
	// The server and mDNS advertiser are now running in the background
}

async function runServiceSubcommand(args: string[]): Promise<void> {
	const action = args[0];
	if (!action) {
		throw new Error("Missing service action. Use: install|start|stop|status|uninstall|logs");
	}

	const scriptPath = resolveServiceScriptPath();
	const { remoteRelayUrl } = extractRemoteOption(args.slice(1));

	switch (action) {
		case "install":
			await installService({
				nodePath: process.execPath,
				scriptPath,
				workingDirectory: process.cwd(),
				...(remoteRelayUrl ? { remoteRelayUrl } : {}),
			});
			console.log("Service installed.");
			console.log(`Log file: ${resolveServicePaths().logFile}`);
			return;
		case "start":
			await startService();
			console.log("Service started.");
			return;
		case "stop":
			await stopService();
			console.log("Service stopped.");
			return;
		case "status": {
			const status = await readServiceStatus();
			console.log(JSON.stringify(status, null, 2));
			return;
		}
		case "uninstall":
			await uninstallService();
			console.log("Service uninstalled.");
			return;
		case "logs": {
			const logs = await readServiceLogs();
			console.log(logs.length > 0 ? logs : "No logs available.");
			return;
		}
		default:
			throw new Error(`Unknown service action: ${action}`);
	}
}

function extractRemoteOption(args: string[]): { remaining: string[]; remoteRelayUrl?: string } {
	const remaining: string[] = [];
	let remoteRelayUrl: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		if (arg !== "--remote") {
			remaining.push(arg);
			continue;
		}

		const next = args[index + 1];
		if (next && !next.startsWith("-")) {
			remoteRelayUrl = next;
			index += 1;
		} else {
			remoteRelayUrl =
				process.env["CODEMOTE_REMOTE_RELAY_URL"]?.trim() || "wss://relay.codemote.app/ws";
		}
	}

	return { remaining, ...(remoteRelayUrl ? { remoteRelayUrl } : {}) };
}

async function run(): Promise<void> {
	if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
		console.log(pkg.version);
		return;
	}

	if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
		showHelp();
		return;
	}

	const command = rawArgs[0];
	if (command === "serve") {
		const { remoteRelayUrl } = extractRemoteOption(rawArgs.slice(1));
		await startApp("serve", remoteRelayUrl);
		return;
	}

	if (command === "service") {
		await runServiceSubcommand(rawArgs.slice(1));
		return;
	}

	if (command && !command.startsWith("-")) {
		throw new Error(`Unknown command: ${command}`);
	}

	const { remoteRelayUrl } = extractRemoteOption(rawArgs);
	await startApp("interactive", remoteRelayUrl);
}

run().catch((err) => {
	console.error("[CLI] Failed:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "unknown";
	return date.toISOString();
}

function formatRuntimeLabel(runtime: RuntimeType): string {
	switch (runtime) {
		case "claude":
			return "Claude";
		case "opencode":
			return "OpenCode";
		case "codex":
			return "Codex";
		case "gemini":
			return "Gemini";
	}
}

function resolvePairingHostPort(
	relayUrl: string,
	fallbackHost: string,
	fallbackPort: number,
): { host: string; port: number } {
	try {
		const parsed = new URL(relayUrl);
		const parsedPort = Number.parseInt(
			parsed.port || (parsed.protocol === "wss:" ? "443" : "80"),
			10,
		);
		if (parsed.hostname && Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535) {
			return {
				host: parsed.hostname,
				port: parsedPort,
			};
		}
	} catch {
		// Fall back to local host/port when relay URL cannot be parsed.
	}

	return {
		host: fallbackHost,
		port: fallbackPort,
	};
}
