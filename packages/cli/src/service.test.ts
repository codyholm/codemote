import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildServicePath,
	installService,
	readServiceLogs,
	readServiceStatus,
	resolveServicePaths,
	uninstallService,
} from "./service.js";

describe("service", () => {
	let tempHome = "";
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(async () => {
		originalHome = process.env["HOME"];
		originalUserProfile = process.env["USERPROFILE"];
		tempHome = await mkdtemp(join(tmpdir(), "codemote-service-test-"));
		process.env["HOME"] = tempHome;
		process.env["USERPROFILE"] = tempHome;
	});

	afterEach(async () => {
		if (process.platform !== "win32") {
			try {
				await uninstallService();
			} catch {
				// Best-effort cleanup: service managers may not be available in CI.
			}
		}
		await rm(tempHome, { recursive: true, force: true });
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env["HOME"] = originalHome;
		}
		if (originalUserProfile === undefined) {
			Reflect.deleteProperty(process.env, "USERPROFILE");
		} else {
			process.env["USERPROFILE"] = originalUserProfile;
		}
	});

	it("resolves service paths under HOME", () => {
		const paths = resolveServicePaths();
		expect(paths.logFile.startsWith(tempHome)).toBe(true);
		expect(paths.statusFile.startsWith(tempHome)).toBe(true);
		expect(paths.launchAgentPlist.startsWith(tempHome)).toBe(true);
		expect(paths.systemdUnit.startsWith(tempHome)).toBe(true);
		expect(paths.windowsTaskXml.startsWith(tempHome)).toBe(true);
	});

	it("builds service PATH using platform delimiter", () => {
		const servicePath = buildServicePath(process.execPath);
		expect(servicePath.split(delimiter).length).toBeGreaterThan(1);
	});

	it("writes platform service definition for serve mode", async () => {
		const paths = resolveServicePaths();
		if (process.platform === "win32") {
			return;
		}

		if (process.platform !== "darwin" && process.platform !== "linux") {
			await expect(
				installService({
					nodePath: "/usr/bin/node",
					scriptPath: "/tmp/codemote/cli.js",
					workingDirectory: "/tmp/codemote",
				}),
			).rejects.toThrow("not supported");
			return;
		}

		await installService({
			nodePath: "/usr/bin/node",
			scriptPath: "/tmp/codemote/cli.js",
			workingDirectory: "/tmp/codemote",
			remoteRelayUrl: "wss://relay.example/ws",
		});

		if (process.platform === "darwin") {
			const plist = await readFile(paths.launchAgentPlist, "utf8");
			expect(plist).toContain("<string>serve</string>");
			expect(plist).toContain("<string>--remote</string>");
			expect(plist).toContain("<string>wss://relay.example/ws</string>");
			expect(plist).toContain(paths.logFile);
			expect(plist).toContain(paths.statusFile);
			expect(plist).toContain("<key>PATH</key>");
			expect(plist).toContain("<string>/usr/bin:/");
			expect(plist).toContain(`${tempHome}/.local/bin`);
		} else {
			const unit = await readFile(paths.systemdUnit, "utf8");
			expect(unit).toContain("Description=Codemote background service");
			expect(unit).toContain(" serve --remote wss://relay.example/ws");
			expect(unit).toContain(`Environment=CODEMOTE_STATUS_FILE=${paths.statusFile}`);
			expect(unit).toContain("Environment=PATH=/usr/bin");
			expect(unit).toContain(`${tempHome}/.local/bin`);
			expect(unit).toContain("/opt/homebrew/bin");
			expect(unit).toContain(`StandardOutput=append:${paths.logFile}`);
		}
	});

	it("writes Task Scheduler XML on Windows", async () => {
		const originalPlatform = process.platform;
		const originalUsername = process.env["USERNAME"];
		const originalUserDomain = process.env["USERDOMAIN"];
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env["USERNAME"] = "TestUser";
		process.env["USERDOMAIN"] = "TESTDOMAIN";

		const spawnMock = vi.fn().mockImplementation(() => {
			const child = new EventEmitter() as unknown as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => {
				child.emit("close", 0);
			});
			return child;
		});

		vi.resetModules();
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>("node:child_process");
			return { ...actual, spawn: spawnMock };
		});

		try {
			const { installService: installServiceWin, resolveServicePaths: resolveServicePathsWin } =
				await import("./service.js");
			const winPaths = resolveServicePathsWin();

			await installServiceWin({
				nodePath: "C:\\Program Files\\nodejs\\node.exe",
				scriptPath: "C:\\codemote\\cli.js",
				workingDirectory: "C:\\codemote",
				remoteRelayUrl: "wss://relay.example/ws",
			});

			expect(spawnMock).toHaveBeenCalledWith(
				"schtasks",
				["/Create", "/TN", "Codemote", "/XML", winPaths.windowsTaskXml, "/F"],
				expect.anything(),
			);

			const xml = await readFile(winPaths.windowsTaskXml, "utf16le");
			expect(xml).toContain("<LogonTrigger>");
			expect(xml).toContain("<Principals>");
			expect(xml).toContain("<Interval>PT1M</Interval>");
			expect(xml).toContain("<Count>999</Count>");
			expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
			expect(xml).toContain("CODEMOTE_STATUS_FILE=");
			expect(xml).toContain(" serve ");
			expect(xml).toContain("wss://relay.example/ws");
			expect(xml).toContain("<UserId>TESTDOMAIN\\TestUser</UserId>");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			if (originalUsername === undefined) {
				Reflect.deleteProperty(process.env, "USERNAME");
			} else {
				process.env["USERNAME"] = originalUsername;
			}
			if (originalUserDomain === undefined) {
				Reflect.deleteProperty(process.env, "USERDOMAIN");
			} else {
				process.env["USERDOMAIN"] = originalUserDomain;
			}
			vi.resetModules();
			vi.doUnmock("node:child_process");
		}
	});

	it("uses bare username when USERDOMAIN matches COMPUTERNAME", async () => {
		const originalPlatform = process.platform;
		const originalUsername = process.env["USERNAME"];
		const originalUserDomain = process.env["USERDOMAIN"];
		const originalComputerName = process.env["COMPUTERNAME"];
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env["USERNAME"] = "TestUser";
		process.env["USERDOMAIN"] = "MYPC";
		process.env["COMPUTERNAME"] = "MYPC";

		const spawnMock = vi.fn().mockImplementation(() => {
			const child = new EventEmitter() as unknown as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => {
				child.emit("close", 0);
			});
			return child;
		});

		vi.resetModules();
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>("node:child_process");
			return { ...actual, spawn: spawnMock };
		});

		try {
			const { installService: installServiceWin, resolveServicePaths: resolveServicePathsWin } =
				await import("./service.js");
			const winPaths = resolveServicePathsWin();

			await installServiceWin({
				nodePath: "C:\\Program Files\\nodejs\\node.exe",
				scriptPath: "C:\\codemote\\cli.js",
				workingDirectory: "C:\\codemote",
			});

			const xml = await readFile(winPaths.windowsTaskXml, "utf16le");
			expect(xml).toContain("<UserId>TestUser</UserId>");
			expect(xml).not.toContain("MYPC\\TestUser");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			if (originalUsername === undefined) {
				Reflect.deleteProperty(process.env, "USERNAME");
			} else {
				process.env["USERNAME"] = originalUsername;
			}
			if (originalUserDomain === undefined) {
				Reflect.deleteProperty(process.env, "USERDOMAIN");
			} else {
				process.env["USERDOMAIN"] = originalUserDomain;
			}
			if (originalComputerName === undefined) {
				Reflect.deleteProperty(process.env, "COMPUTERNAME");
			} else {
				process.env["COMPUTERNAME"] = originalComputerName;
			}
			vi.resetModules();
			vi.doUnmock("node:child_process");
		}
	});

	it("tails log file output", async () => {
		const paths = resolveServicePaths();
		await mkdir(join(tempHome, ".codemote", "logs"), { recursive: true });
		const logBody = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join("\n");
		await writeFile(paths.logFile, `${logBody}\n`, "utf8");

		const tailed = await readServiceLogs(10);
		expect(tailed).toContain("line-120");
		expect(tailed).not.toContain("line-1\n");
	});

	it("returns machine-readable status fields", async () => {
		const status = await readServiceStatus();
		const paths = resolveServicePaths();

		expect(status.platform).toBe(process.platform);
		expect(typeof status.installed).toBe("boolean");
		expect(typeof status.running).toBe("boolean");
		expect(status.logFile).toBe(paths.logFile);
		expect(status.statusFile).toBe(paths.statusFile);
	});

	// Regression guard. `launchctl unload -w` writes a persistent disabled override that
	// survives logout and reboot, so a stop used to mean the service never came back until
	// someone ran start by hand — RunAtLoad and KeepAlive cannot recover from it. That took
	// the service down silently in the field. Stopping must leave the agent enabled;
	// permanently disabling it is `uninstall`.
	it("stops the launch agent without writing a persistent disable flag", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });

		const spawnMock = vi.fn().mockImplementation(() => {
			const child = new EventEmitter() as unknown as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => {
				child.emit("close", 0);
			});
			return child;
		});

		vi.resetModules();
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>("node:child_process");
			return { ...actual, spawn: spawnMock };
		});

		try {
			const { stopService: stopServiceMac, resolveServicePaths: resolveServicePathsMac } =
				await import("./service.js");
			const macPaths = resolveServicePathsMac();

			await stopServiceMac();

			const launchctlArgs = spawnMock.mock.calls
				.filter(([command]) => command === "launchctl")
				.map(([, args]) => args as string[]);

			expect(launchctlArgs).toContainEqual(["stop", "app.codemote.service"]);
			expect(launchctlArgs).toContainEqual(["unload", macPaths.launchAgentPlist]);
			for (const args of launchctlArgs) {
				expect(args).not.toContain("-w");
			}
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			vi.resetModules();
			vi.doUnmock("node:child_process");
		}
	});
});
