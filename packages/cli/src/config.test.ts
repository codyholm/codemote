import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodemoteConfig } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to mock homedir so loadConfig/saveConfig use our temp dir
const tempBase = join(tmpdir(), `config-test-${Date.now()}`);

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => tempBase,
	};
});

// Import after mocking
const { loadConfig, saveConfig, runConfigSubcommand } = await import("./config.js");

describe("config", () => {
	beforeEach(async () => {
		await mkdir(join(tempBase, ".codemote"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempBase, { recursive: true, force: true });
	});

	describe("loadConfig / saveConfig", () => {
		it("returns empty config when file is missing", async () => {
			const config = await loadConfig();
			expect(config).toEqual({});
		});

		it("round-trips a valid config", async () => {
			const original: CodemoteConfig = {
				runtimeSettings: {
					claude: { defaultModel: "opus" },
					opencode: { defaultModel: "anthropic/claude-sonnet-4-6", defaultProvider: "anthropic" },
				},
			};
			await saveConfig(original);
			const loaded = await loadConfig();
			expect(loaded).toEqual(original);
		});

		it("returns empty config on invalid JSON", async () => {
			const configPath = join(tempBase, ".codemote", "config.json");
			await mkdir(join(tempBase, ".codemote"), { recursive: true });
			const { writeFile } = await import("node:fs/promises");
			await writeFile(configPath, "not valid json {{{", "utf8");
			const config = await loadConfig();
			expect(config).toEqual({});
		});

		it("writes formatted JSON with trailing newline", async () => {
			await saveConfig({ runtimeSettings: { claude: { defaultModel: "sonnet" } } });
			const raw = await readFile(join(tempBase, ".codemote", "config.json"), "utf8");
			expect(raw.endsWith("\n")).toBe(true);
			expect(() => JSON.parse(raw)).not.toThrow();
		});
	});

	describe("runConfigSubcommand", () => {
		it("get returns (not set) for missing key", async () => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			await runConfigSubcommand(["get", "runtimeSettings.claude.defaultModel"]);
			expect(spy).toHaveBeenCalledWith("(not set)");
			spy.mockRestore();
		});

		it("set creates nested key and get retrieves it", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			await runConfigSubcommand(["set", "runtimeSettings.claude.defaultModel", "opus"]);
			logSpy.mockClear();
			await runConfigSubcommand(["get", "runtimeSettings.claude.defaultModel"]);
			expect(logSpy).toHaveBeenCalledWith("opus");
			logSpy.mockRestore();
		});
	});
});
