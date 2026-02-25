import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DARWIN_LABEL = "app.codemote.service";
const LINUX_UNIT = "codemote.service";
const SERVICE_PATH = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/local/sbin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
].join(":");

export interface ServicePaths {
	logFile: string;
	statusFile: string;
	launchAgentPlist: string;
	systemdUnit: string;
}

export interface ServiceInstallConfig {
	nodePath: string;
	scriptPath: string;
	workingDirectory: string;
	remoteRelayUrl?: string;
}

export interface ServiceStatus {
	platform: NodeJS.Platform;
	installed: boolean;
	running: boolean;
	logFile: string;
	statusFile: string;
	details?: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function resolveServicePaths(): ServicePaths {
	const home = homedir();
	return {
		logFile: join(home, ".codemote", "logs", "server.log"),
		statusFile: join(home, ".codemote", "status", "server-status.json"),
		launchAgentPlist: join(home, "Library", "LaunchAgents", `${DARWIN_LABEL}.plist`),
		systemdUnit: join(home, ".config", "systemd", "user", LINUX_UNIT),
	};
}

export async function installService(config: ServiceInstallConfig): Promise<void> {
	const paths = resolveServicePaths();
	await mkdir(dirname(paths.logFile), { recursive: true });
	await mkdir(dirname(paths.statusFile), { recursive: true });

	switch (process.platform) {
		case "darwin":
			await installLaunchAgent(config, paths);
			return;
		case "linux":
			await installSystemdUnit(config, paths);
			return;
		default:
			throw new Error(`Service install is not supported on platform: ${process.platform}`);
	}
}

export async function startService(): Promise<void> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin":
			await runCommand("launchctl", ["load", "-w", paths.launchAgentPlist], { allowFailure: true });
			await runCommand("launchctl", ["start", DARWIN_LABEL], { allowFailure: true });
			return;
		case "linux":
			await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
			await runCommand("systemctl", ["--user", "start", LINUX_UNIT]);
			return;
		default:
			throw new Error(`Service start is not supported on platform: ${process.platform}`);
	}
}

export async function stopService(): Promise<void> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin":
			await runCommand("launchctl", ["stop", DARWIN_LABEL], { allowFailure: true });
			await runCommand("launchctl", ["unload", "-w", paths.launchAgentPlist], {
				allowFailure: true,
			});
			return;
		case "linux":
			await runCommand("systemctl", ["--user", "stop", LINUX_UNIT], { allowFailure: true });
			return;
		default:
			throw new Error(`Service stop is not supported on platform: ${process.platform}`);
	}
}

export async function uninstallService(): Promise<void> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin":
			await stopService();
			await rm(paths.launchAgentPlist, { force: true });
			return;
		case "linux":
			await runCommand("systemctl", ["--user", "stop", LINUX_UNIT], { allowFailure: true });
			await runCommand("systemctl", ["--user", "disable", LINUX_UNIT], { allowFailure: true });
			await rm(paths.systemdUnit, { force: true });
			await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
			return;
		default:
			throw new Error(`Service uninstall is not supported on platform: ${process.platform}`);
	}
}

export async function readServiceStatus(): Promise<ServiceStatus> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin": {
			const installed = await fileExists(paths.launchAgentPlist);
			const runningResult = await runCommand("launchctl", ["list", DARWIN_LABEL], {
				allowFailure: true,
			});
			const details = runningResult.stdout || runningResult.stderr;
			return {
				platform: process.platform,
				installed,
				running: runningResult.code === 0,
				logFile: paths.logFile,
				statusFile: paths.statusFile,
				...(details ? { details } : {}),
			};
		}
		case "linux": {
			const installed = await fileExists(paths.systemdUnit);
			const activeResult = await runCommand("systemctl", ["--user", "is-active", LINUX_UNIT], {
				allowFailure: true,
			});
			const enabledResult = await runCommand("systemctl", ["--user", "is-enabled", LINUX_UNIT], {
				allowFailure: true,
			});
			const details = [activeResult.stdout.trim(), enabledResult.stdout.trim()]
				.filter(Boolean)
				.join(" / ");
			return {
				platform: process.platform,
				installed,
				running: activeResult.stdout.trim() === "active",
				logFile: paths.logFile,
				statusFile: paths.statusFile,
				...(details ? { details } : {}),
			};
		}
		default:
			return {
				platform: process.platform,
				installed: false,
				running: false,
				logFile: paths.logFile,
				statusFile: paths.statusFile,
			};
	}
}

export async function readServiceLogs(lines = 200): Promise<string> {
	const paths = resolveServicePaths();
	if (process.platform === "linux") {
		const journal = await runCommand(
			"journalctl",
			["--user", "-u", LINUX_UNIT, "-n", String(lines), "--no-pager"],
			{ allowFailure: true },
		);
		if (journal.code === 0 && journal.stdout.trim().length > 0) {
			return journal.stdout;
		}
	}

	const text = await readFile(paths.logFile, "utf8").catch(() => "");
	return tailLines(text, lines);
}

function tailLines(text: string, lines: number): string {
	const all = text.split(/\r?\n/);
	return all.slice(Math.max(0, all.length - lines)).join("\n");
}

async function installLaunchAgent(
	config: ServiceInstallConfig,
	paths: ServicePaths,
): Promise<void> {
	await mkdir(dirname(paths.launchAgentPlist), { recursive: true });
	const args = [config.nodePath, config.scriptPath, "serve"];
	if (config.remoteRelayUrl) {
		args.push("--remote", config.remoteRelayUrl);
	}
	const argsXml = args.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n");

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${DARWIN_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${argsXml}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(config.workingDirectory)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CODEMOTE_STATUS_FILE</key>
		<string>${xmlEscape(paths.statusFile)}</string>
		<key>PATH</key>
		<string>${xmlEscape(SERVICE_PATH)}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${xmlEscape(paths.logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(paths.logFile)}</string>
</dict>
</plist>
`;
	await writeFile(paths.launchAgentPlist, plist, "utf8");
}

async function installSystemdUnit(
	config: ServiceInstallConfig,
	paths: ServicePaths,
): Promise<void> {
	await mkdir(dirname(paths.systemdUnit), { recursive: true });
	const args = [config.nodePath, config.scriptPath, "serve"];
	if (config.remoteRelayUrl) {
		args.push("--remote", config.remoteRelayUrl);
	}
	const execStart = args.map(shellEscapeArg).join(" ");
	const unit = `[Unit]
Description=Codemote background service
After=network.target

[Service]
Type=simple
WorkingDirectory=${config.workingDirectory}
ExecStart=${execStart}
Restart=always
RestartSec=3
Environment=CODEMOTE_STATUS_FILE=${paths.statusFile}
Environment=PATH=${SERVICE_PATH}
StandardOutput=append:${paths.logFile}
StandardError=append:${paths.logFile}

[Install]
WantedBy=default.target
`;
	await writeFile(paths.systemdUnit, unit, "utf8");
	await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
	await runCommand("systemctl", ["--user", "enable", LINUX_UNIT], { allowFailure: true });
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function shellEscapeArg(value: string): string {
	if (value === "") {
		return "''";
	}
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			if (options.allowFailure) {
				resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
				return;
			}
			reject(error);
		});
		child.on("close", (code) => {
			const result = { code: code ?? 1, stdout, stderr };
			if (result.code !== 0 && !options.allowFailure) {
				reject(
					new Error(
						`Command failed (${command} ${args.join(" ")}): ${result.stderr || result.stdout || "unknown error"}`,
					),
				);
				return;
			}
			resolve(result);
		});
	});
}
