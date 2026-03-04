import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { probeInstalledRuntimes } from "./runtime-probe.js";

const execMock = exec as unknown as Mock;

function stubExec(installed: Set<string>) {
	execMock.mockImplementation((cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
		const cliName = cmd.replace(/^(command -v |where\.exe )/, "").trim();
		if (installed.has(cliName)) {
			cb(null);
		} else {
			cb(new Error(`not found: ${cliName}`));
		}
	});
}

beforeEach(() => {
	execMock.mockReset();
});

describe("probeInstalledRuntimes", () => {
	it("returns all candidates when all CLIs are installed", async () => {
		stubExec(new Set(["claude", "opencode", "codex", "gemini"]));
		const result = await probeInstalledRuntimes(["claude", "opencode", "codex", "gemini"]);
		expect(result).toEqual(["claude", "opencode", "codex", "gemini"]);
	});

	it("returns only installed runtimes", async () => {
		stubExec(new Set(["claude", "gemini"]));
		const result = await probeInstalledRuntimes(["claude", "opencode", "codex", "gemini"]);
		expect(result).toEqual(["claude", "gemini"]);
	});

	it("returns empty when no CLIs are installed", async () => {
		stubExec(new Set());
		const result = await probeInstalledRuntimes(["claude", "opencode", "codex", "gemini"]);
		expect(result).toEqual([]);
	});

	it("returns empty for no candidates", async () => {
		stubExec(new Set());
		const result = await probeInstalledRuntimes([]);
		expect(result).toEqual([]);
	});

	it("excludes a runtime that times out without blocking others", async () => {
		// Verify the error/rejection path excludes the failed runtime
		execMock.mockImplementation((cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
			const cliName = cmd.replace(/^(command -v |where\.exe )/, "").trim();
			if (cliName === "opencode") {
				cb(new Error("Command timed out"));
			} else if (cliName === "claude") {
				cb(null);
			} else {
				cb(new Error("not found"));
			}
		});
		const result = await probeInstalledRuntimes(["claude", "opencode"]);
		expect(result).toEqual(["claude"]);
	});
});
