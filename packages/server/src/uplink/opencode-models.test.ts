import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { discoverOpenCodeModels } from "./opencode-models.js";

const execMock = exec as unknown as Mock;

beforeEach(() => {
	execMock.mockReset();
});

describe("discoverOpenCodeModels", () => {
	it("parses multi-line output with provider/model format", async () => {
		execMock.mockImplementation(
			(cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				if (cmd.includes("anthropic")) {
					cb(null, "anthropic/claude-sonnet-4-6\nanthropic/claude-opus-4-6\n");
				} else if (cmd.includes("openai")) {
					cb(null, "openai/gpt-5.3-codex\n");
				} else {
					cb(new Error("unknown provider"), "");
				}
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["anthropic", "openai", "google"]);
		expect(result).toEqual([
			{ id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
			{ id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic" },
			{ id: "openai/gpt-5.3-codex", label: "Gpt 5.3 Codex", provider: "openai" },
		]);
	});

	it("silently skips providers that error", async () => {
		execMock.mockImplementation(
			(cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				if (cmd.includes("anthropic")) {
					cb(null, "anthropic/claude-sonnet-4-6\n");
				} else {
					cb(new Error("provider not authenticated"), "");
				}
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["anthropic", "openai"]);
		expect(result).toEqual([
			{ id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
		]);
	});

	it("returns empty when command is not found", async () => {
		execMock.mockImplementation(
			(_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				cb(new Error("command not found: opencode"), "");
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["anthropic"]);
		expect(result).toEqual([]);
	});

	it("returns empty when all providers time out", async () => {
		execMock.mockImplementation(
			(_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				cb(new Error("Command timed out"), "");
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["anthropic", "openai"]);
		expect(result).toEqual([]);
	});

	it("handles models without slash (bare model names)", async () => {
		execMock.mockImplementation(
			(_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				cb(null, "gpt-5.3-codex\n");
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["openai"]);
		expect(result).toEqual([{ id: "gpt-5.3-codex", label: "Gpt 5.3 Codex", provider: "openai" }]);
	});

	it("filters blank lines from output", async () => {
		execMock.mockImplementation(
			(_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
				cb(null, "\nanthropic/claude-sonnet-4-6\n\n\n");
			},
		);

		const result = await discoverOpenCodeModels("opencode", ["anthropic"]);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("anthropic/claude-sonnet-4-6");
	});
});
