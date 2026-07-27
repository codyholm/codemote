import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../types.js";
import type { WorkspaceManager } from "../workspace.js";
import { EvidenceCollector } from "./collector.js";
import { EvidenceStorage } from "./storage.js";

describe("evidence/collector", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "uplink-evidence-collect-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("stores evidence artifacts and returns summary", async () => {
		const diff = "diff --git a/foo.txt b/foo.txt\n";
		const workspaceManager = {
			getDiff: async () => diff,
		} as unknown as WorkspaceManager;

		const runId = "run-collect-1";
		const storage = new EvidenceStorage(join(dir, "evidence"));
		const collector = new EvidenceCollector(
			workspaceManager,
			{
				testCommands: ["node -e \"console.log('ok')\""],
				captureScreenshots: false,
				maxOutputSize: 10000,
			},
			storage,
		);

		const session: Session = {
			id: "session-1",
			runId,
			runtime: "opencode",
			status: "idle",
			workspace: {
				id: "ws-1",
				workingDir: dir,
				createdAt: Date.now(),
			},
			startedAt: Date.now(),
			endedAt: null,
			lastActivityAt: Date.now(),
			statusChangedAt: Date.now(),
		};

		const artifacts = await collector.collect(session);

		expect(artifacts.summary).toContain("Session");
		expect(artifacts.changes).toContain("foo.txt");
		expect(artifacts.evidence[0]).toContain("PASSED");

		const summaryJson = JSON.parse(
			await readFile(join(dir, "evidence", runId, "summary.json"), "utf-8"),
		) as { runId: string; commandsRun: number };
		expect(summaryJson.runId).toBe(runId);
		expect(summaryJson.commandsRun).toBe(1);
	});
});
