import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		try {
			await uninstallService();
		} catch {
			// Best-effort cleanup: service managers may not be available in CI.
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
	});

	it("builds service PATH using platform delimiter", () => {
		const servicePath = buildServicePath(process.execPath);
		expect(servicePath.split(delimiter).length).toBeGreaterThan(1);
	});

	it("writes platform service definition for serve mode", async () => {
		const paths = resolveServicePaths();
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
});
