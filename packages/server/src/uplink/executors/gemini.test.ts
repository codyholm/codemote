import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { GeminiExecutor } from "./gemini.js";

async function waitFor(
	predicate: () => boolean,
	{ timeoutMs = 4000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

describe("GeminiExecutor", () => {
	let testDir: string;
	let mockGeminiPath: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let activeExecutor: GeminiExecutor | null = null;
	let activeSessionId: string | null = null;

	beforeEach(async () => {
		activeExecutor = null;
		activeSessionId = null;

		testDir = await mkdtemp(join(tmpdir(), "gemini-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		mockGeminiPath = join(testDir, "mock-gemini");
		const mockScriptContent = `#!/bin/bash
read -r prompt
printf 'Hello from mock Gemini! (%s)\\n' "$prompt"
sleep 0.2
exit 0
`;
		await writeFile(mockGeminiPath, mockScriptContent);
		await chmod(mockGeminiPath, 0o755);

		workspaceManager = new WorkspaceManager(testDir);
		sessionManager = new SessionManager();
		eventBus = new EventBus();
	});

	afterEach(async () => {
		if (activeExecutor && activeSessionId) {
			try {
				await activeExecutor.stop(activeSessionId);
			} catch {
				// Ignore errors during cleanup
			}
		}

		await new Promise((r) => setTimeout(r, 100));
		await rm(testDir, { recursive: true, force: true });
	});

	it("creates executor with correct type", () => {
		const executor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		expect(executor.type).toBe("gemini");
	});

	it("starts a run and receives output", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => events.some((e) => (e as { type: string }).type === "session.output"));

		const outputEvents = events.filter((e) => (e as { type: string }).type === "session.output");
		expect(outputEvents.length).toBeGreaterThan(0);

		const hasGeminiMessage = outputEvents.some((e) => {
			const payload = (e as { payload?: { text?: string } }).payload;
			return payload?.text?.includes("Hello from mock Gemini");
		});
		expect(hasGeminiMessage).toBe(true);

		// Mark as cleaned up so afterEach doesn't try to stop again
		activeSessionId = null;
	});
});
