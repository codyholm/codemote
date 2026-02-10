import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceStorage } from "./storage.js";

describe("evidence/storage", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "uplink-evidence-store-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes diff, per-command output, and summary", async () => {
		const storage = new EvidenceStorage(join(dir, "evidence"));
		const runId = "run-1";

		await storage.store(runId, {
			diff: "diff --git a/foo.txt b/foo.txt\n",
			commandResults: [
				{
					command: "node -e \"console.log('ok')\"",
					success: true,
					exitCode: 0,
					stdout: "ok\n",
					stderr: "",
					duration: 1,
				},
			],
			timestamp: 123,
		});

		const diff = await readFile(join(dir, "evidence", runId, "diff.patch"), "utf-8");
		expect(diff).toContain("diff --git");

		const cmdOutput = await readFile(join(dir, "evidence", runId, "cmd-1-output.txt"), "utf-8");
		expect(cmdOutput).toContain("Command:");
		expect(cmdOutput).toContain("=== STDOUT ===");

		const summary = JSON.parse(
			await readFile(join(dir, "evidence", runId, "summary.json"), "utf-8"),
		) as { runId: string; commandsRun: number };
		expect(summary.runId).toBe(runId);
		expect(summary.commandsRun).toBe(1);
	});
});
