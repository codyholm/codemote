import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { CodexExecutor } from "./codex.js";

describe("CodexExecutor", () => {
	let testDir: string;
	let mockCodexPath: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let activeExecutor: CodexExecutor | null = null;
	let activeSessionId: string | null = null;

	beforeEach(async () => {
		activeExecutor = null;
		activeSessionId = null;

		// Create test git repo
		testDir = await mkdtemp(join(tmpdir(), "codex-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		// Create mock codex executable shell script that outputs realistic streaming JSON
		// Codex outputs JSON Lines to stderr and final message to stdout
		mockCodexPath = join(testDir, "mock-codex");
		const mockScriptContent = `#!/bin/sh
# Mock Codex CLI - outputs streaming JSON events to stderr, final output to stdout

# Emit JSON Lines events to stderr
>&2 echo '{"type":"thread.started","thread_id":"mock-thread"}'
sleep 0.1
>&2 echo '{"type":"item.message","content":"Hello from Codex!"}'
sleep 0.1
>&2 echo '{"type":"turn.completed"}'

# Emit final message to stdout
echo "Task completed successfully."
exit 0
`;
		await writeFile(mockCodexPath, mockScriptContent);
		await chmod(mockCodexPath, 0o755);

		workspaceManager = new WorkspaceManager(testDir);
		sessionManager = new SessionManager();
		eventBus = new EventBus();
	});

	afterEach(async () => {
		// Stop any active session to clean up processes
		if (activeExecutor && activeSessionId) {
			try {
				await activeExecutor.stop(activeSessionId);
			} catch {
				// Ignore errors during cleanup
			}
		}

		// Wait a moment for processes to exit
		await new Promise((r) => setTimeout(r, 100));

		// Clean up temp directory
		await rm(testDir, { recursive: true, force: true });
	});

	it("creates executor with correct type", () => {
		const executor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: mockCodexPath,
		});

		expect(executor.type).toBe("codex");
	});

	it("starts a run and receives events", async () => {
		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: mockCodexPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		expect(result.sessionId).toBeDefined();
		expect(result.runId).toBeDefined();

		// Wait for mock script to complete and events to propagate
		await new Promise((r) => setTimeout(r, 800));

		// Should have received events
		expect(events.length).toBeGreaterThan(0);

		// Should have status events
		const statusEvents = events.filter((e) => (e as { type: string }).type === "session.status");
		expect(statusEvents.length).toBeGreaterThan(0);

		// Mark as cleaned up so afterEach doesn't try to stop again
		activeSessionId = null;
	});

	it("stops session and cleans up resources", async () => {
		// Create a mock script that runs longer
		const longRunningMockPath = join(testDir, "mock-codex-long");
		const longRunningScript = `#!/bin/sh
# Long-running mock Codex for testing stop functionality
>&2 echo '{"type":"thread.started","thread_id":"mock-thread"}'
sleep 10
>&2 echo '{"type":"turn.completed"}'
`;
		await writeFile(longRunningMockPath, longRunningScript);
		await chmod(longRunningMockPath, 0o755);

		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: longRunningMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		// Wait for session to start
		await new Promise((r) => setTimeout(r, 200));

		// Stop should not throw
		await activeExecutor.stop(result.sessionId);

		// Session should be ended
		const session = sessionManager.get(result.sessionId);
		expect(session?.status).toBe("ended");

		// Mark as cleaned up
		activeSessionId = null;
	});
});
