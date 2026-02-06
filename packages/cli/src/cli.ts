#!/usr/bin/env node

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
import { ensureLocalTLS } from "./tls.js";
import { renderUI, updateStatus } from "./ui.js";

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline";

import type { RuntimeType } from "@codemote/uplink";

async function main() {
	const port = Number.parseInt(process.env["PORT"] || "8080", 10);
	let interactive = false;
	const configuredRepoPath = process.env["CODEMOTE_REPO_PATH"]?.trim();
	const inferredRepoPath = process.env["INIT_CWD"]?.trim() || process.cwd();
	const repoPath = resolve(configuredRepoPath || inferredRepoPath);

	if (configuredRepoPath) {
		await mkdir(repoPath, { recursive: true });
	}

	console.log("Starting Codemote...");

	// Start the server (relay + uplink + bridge)
	const server = await startServer({
		port,
		repoPath,
		onClientConnected: () => {
			if (interactive) {
				console.log("Device connected");
			} else {
				updateStatus("   ✓ Device connected");
			}
		},
	});

	// Get local IP and build QR code URL
	const host = getLocalIP();
	const relayScheme = server.url.startsWith("wss://") ? "wss" : "ws";
	const relayUrl = `${relayScheme}://${host}:${port}/ws`;
	const tlsPin = relayScheme === "wss" ? (await ensureLocalTLS()).tlsPin : undefined;
	const pairingURL = tlsPin
		? buildPairingURL(host, port, server.pin, { tlsPin, relayUrl })
		: buildPairingURL(host, port, server.pin);
	const qrCode = await generateQRCode(pairingURL);

	// Start mDNS advertisement
	const mdns = advertiseService(port, server.pin);

	console.log(`[CLI] mDNS advertising on port ${port}`);
	console.log(`[CLI] Session workspace root: ${repoPath}`);

	// Render the UI
	await renderUI({
		qrCode,
		pin: server.pin,
		localURL: relayUrl,
		status: "ready",
		...(tlsPin ? { tlsPin } : {}),
	});

	// Optional interactive terminal commands (for starting sessions)
	if (process.stdin.isTTY) {
		interactive = true;
		console.log("\nCommands: claude|opencode|codex|gemini <prompt>  (or: help)");
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
					"\nCommands:\n  claude <prompt>\n  opencode <prompt>\n  codex <prompt>\n  gemini <prompt>\n  quit\n",
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

main().catch((err) => {
	console.error("[CLI] Failed to start:", err);
	process.exit(1);
});
