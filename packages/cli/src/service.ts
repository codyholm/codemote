import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";

const DARWIN_LABEL = "app.codemote.service";
const LINUX_UNIT = "codemote.service";
const WINDOWS_TASK_NAME = "Codemote";

function getServicePathFallbackSegments(): string[] {
	const home = homedir();
	return process.platform === "win32"
		? [
				join(home, "AppData", "Roaming", "npm"),
				join(home, ".volta", "bin"),
				join(home, "scoop", "shims"),
			]
		: [
				"/opt/homebrew/bin",
				"/opt/homebrew/sbin",
				"/usr/local/bin",
				"/usr/local/sbin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
				join(home, ".local", "bin"),
				join(home, ".volta", "bin"),
			];
}

export interface ServicePaths {
	logFile: string;
	statusFile: string;
	launchAgentPlist: string;
	systemdUnit: string;
	windowsTaskXml: string;
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
		windowsTaskXml: join(home, ".codemote", "service", "codemote-task.xml"),
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
		case "win32":
			await installWindowsTask(config, paths);
			return;
		default:
			throw new Error(`Service install is not supported on platform: ${process.platform}`);
	}
}

export async function startService(): Promise<void> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin":
			await runLaunchctlCommand(["load", "-w", paths.launchAgentPlist], ["already loaded"]);
			await runLaunchctlCommand(["start", DARWIN_LABEL], ["already running"]);
			return;
		case "linux":
			await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
			await runCommand("systemctl", ["--user", "start", LINUX_UNIT]);
			return;
		case "win32":
			await runCommand("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
			return;
		default:
			throw new Error(`Service start is not supported on platform: ${process.platform}`);
	}
}

export async function stopService(): Promise<void> {
	const paths = resolveServicePaths();
	switch (process.platform) {
		case "darwin":
			await runLaunchctlCommand(
				["stop", DARWIN_LABEL],
				["no such process", "could not find service"],
			);
			// Unload without -w. The -w flag writes a persistent "disabled" override,
			// which would survive logout and reboot and defeat RunAtLoad/KeepAlive —
			// so a stop would silently mean "never come back" until someone ran start
			// by hand. Plain unload stops the agent for this session while leaving it
			// enabled, so it returns at next login or reboot. Permanently disabling is
			// `uninstall`, which removes the plist outright.
			await runLaunchctlCommand(
				["unload", paths.launchAgentPlist],
				[
					"no such process",
					"could not find service",
					"could not find specified service",
					"no such file",
				],
			);
			return;
		case "linux":
			await runCommand("systemctl", ["--user", "stop", LINUX_UNIT], { allowFailure: true });
			return;
		case "win32":
			await runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], { allowFailure: true });
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
		case "win32":
			await stopService();
			await runCommand("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], {
				allowFailure: true,
			});
			await rm(paths.windowsTaskXml, { force: true });
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
		case "win32": {
			const queryResult = await runCommand(
				"schtasks",
				["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "CSV", "/V", "/NH"],
				{ allowFailure: true },
			);
			const installed = queryResult.code === 0;
			const details = queryResult.stdout || queryResult.stderr;
			// CSV /V columns are locale-independent by position.
			// Column 3 = Status, Column 11 = Scheduled Task State.
			const csvFields = installed ? parseCsvLine(details.trim()) : undefined;
			const statusValue = csvFields?.[3];
			const taskStateValue = csvFields?.[11];
			return {
				platform: process.platform,
				installed,
				running:
					statusValue?.toLowerCase() === "running" && taskStateValue?.toLowerCase() === "enabled",
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
		if (
			journal.code === 0 &&
			journal.stdout.trim().length > 0 &&
			!journal.stdout.includes("-- No entries --")
		) {
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

function parseCsvLine(line: string): string[] | undefined {
	if (!line) return undefined;
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;
	for (const char of line) {
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === "," && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields.length > 0 ? fields : undefined;
}

async function installLaunchAgent(
	config: ServiceInstallConfig,
	paths: ServicePaths,
): Promise<void> {
	await mkdir(dirname(paths.launchAgentPlist), { recursive: true });
	const servicePath = buildServicePath(config.nodePath);
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
			<string>${xmlEscape(servicePath)}</string>
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
	const servicePath = buildServicePath(config.nodePath);
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
Environment=PATH=${servicePath}
StandardOutput=append:${paths.logFile}
StandardError=append:${paths.logFile}

[Install]
WantedBy=default.target
`;
	await writeFile(paths.systemdUnit, unit, "utf8");
	await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
	await runCommand("systemctl", ["--user", "enable", LINUX_UNIT], { allowFailure: true });
}

function quoteCmdArg(value: string): string {
	// Escape percent signs by doubling them (%% becomes literal % in cmd.exe)
	// Escape embedded double quotes by prefixing with backslash
	const escaped = value.replaceAll("%", "%%").replaceAll('"', '\\"');
	return `"${escaped}"`;
}

function resolveWindowsTaskUserId(): string {
	const username = process.env["USERNAME"]?.trim();
	const userDomain = process.env["USERDOMAIN"]?.trim();
	const computerName = process.env["COMPUTERNAME"]?.trim();
	if (username && userDomain && userDomain !== computerName) {
		return `${userDomain}\\${username}`;
	}
	if (username) return username;
	return userInfo().username;
}

async function installWindowsTask(
	config: ServiceInstallConfig,
	paths: ServicePaths,
): Promise<void> {
	await mkdir(dirname(paths.windowsTaskXml), { recursive: true });
	const taskUserId = resolveWindowsTaskUserId();
	const cliArgs = [quoteCmdArg(config.nodePath), quoteCmdArg(config.scriptPath), "serve"];
	if (config.remoteRelayUrl) {
		cliArgs.push("--remote", quoteCmdArg(config.remoteRelayUrl));
	}
	const escapedStatusFile = paths.statusFile.replaceAll("%", "%%").replaceAll('"', '"');
	const cmd = [
		"/c",
		`set "CODEMOTE_STATUS_FILE=${escapedStatusFile}" && ${cliArgs.join(" ")} >> ${quoteCmdArg(
			paths.logFile,
		)} 2>&1`,
	].join(" ");

	const task = `<?xml version="1.0" encoding="UTF-16"?>
	<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
		<RegistrationInfo>
			<Author>${xmlEscape(taskUserId)}</Author>
			<Description>Codemote background service</Description>
		</RegistrationInfo>
		<Triggers>
			<LogonTrigger>
				<UserId>${xmlEscape(taskUserId)}</UserId>
				<Enabled>true</Enabled>
			</LogonTrigger>
		</Triggers>
		<Principals>
			<Principal id="Author">
				<UserId>${xmlEscape(taskUserId)}</UserId>
				<LogonType>InteractiveToken</LogonType>
				<RunLevel>LeastPrivilege</RunLevel>
			</Principal>
		</Principals>
		<Settings>
			<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
			<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
			<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
			<AllowHardTerminate>true</AllowHardTerminate>
			<StartWhenAvailable>true</StartWhenAvailable>
			<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
			<AllowStartOnDemand>true</AllowStartOnDemand>
			<Enabled>true</Enabled>
			<Hidden>false</Hidden>
			<RunOnlyIfIdle>false</RunOnlyIfIdle>
			<WakeToRun>false</WakeToRun>
			<RestartOnFailure>
				<Interval>PT1M</Interval>
				<Count>999</Count>
			</RestartOnFailure>
			<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
		</Settings>
		<Actions Context="Author">
			<Exec>
				<Command>cmd.exe</Command>
				<Arguments>${xmlEscape(cmd)}</Arguments>
				<WorkingDirectory>${xmlEscape(config.workingDirectory)}</WorkingDirectory>
			</Exec>
		</Actions>
	</Task>
		`;

	await writeFile(paths.windowsTaskXml, `\ufeff${task}`, "utf16le");
	await runCommand("schtasks", [
		"/Create",
		"/TN",
		WINDOWS_TASK_NAME,
		"/XML",
		paths.windowsTaskXml,
		"/F",
	]);
}

export function buildServicePath(nodePath: string): string {
	const segments = new Set<string>();
	const nodeDir = dirname(nodePath);
	if (nodeDir.length > 0) {
		segments.add(nodeDir);
	}

	for (const segment of getServicePathFallbackSegments()) {
		segments.add(segment);
	}

	return Array.from(segments).join(delimiter);
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

async function runLaunchctlCommand(
	args: string[],
	benignFailureSnippets: string[] = [],
): Promise<void> {
	const result = await runCommand("launchctl", args, { allowFailure: true });
	if (result.code === 0) {
		return;
	}

	const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
	const benignFailure = benignFailureSnippets.some((snippet) =>
		output.includes(snippet.toLowerCase()),
	);
	if (benignFailure) {
		return;
	}

	throw new Error(
		`Command failed (launchctl ${args.join(" ")}): ${result.stderr || result.stdout}`,
	);
}
