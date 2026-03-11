import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { ClaudeExecutor } from "./claude.js";

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

describe.skipIf(platform() === "win32")("ClaudeExecutor", () => {
	let testDir: string;
	let mockClaudePath: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let activeExecutor: ClaudeExecutor | null = null;
	let activeSessionId: string | null = null;

	beforeEach(async () => {
		activeExecutor = null;
		activeSessionId = null;

		// Create test git repo
		testDir = await mkdtemp(join(tmpdir(), "claude-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		// Create mock claude executable shell script that outputs realistic streaming JSON
		// This script ignores all arguments (which is important since the executor adds CLI flags)
		// Use printf for more predictable output behavior across different shells
		mockClaudePath = join(testDir, "mock-claude");
		const mockScriptContent = `#!/bin/bash
# Mock Claude CLI - ignores all arguments and outputs streaming JSON events
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
sleep 0.2
printf '%s\\n' '{"type":"assistant_message","content":"Hello from mock Claude!"}'
sleep 0.2
printf '%s\\n' '{"type":"end"}'
exit 0
`;
		await writeFile(mockClaudePath, mockScriptContent);
		await chmod(mockClaudePath, 0o755);

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
		const executor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: mockClaudePath,
		});

		expect(executor.type).toBe("claude");
	});

	it("starts a run and receives events", async () => {
		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: mockClaudePath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "claude",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		expect(result.sessionId).toBeDefined();
		expect(result.runId).toBeDefined();

		await waitFor(() => events.some((e) => (e as { type: string }).type === "session.message"));

		// Should have received events
		expect(events.length).toBeGreaterThan(0);

		// Should have message events with content from mock Claude
		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		expect(messageEvents.length).toBeGreaterThan(0);

		// Verify we received the mock Claude message
		const hasClaudeMessage = messageEvents.some((e) => {
			const payload = (e as { payload?: { content?: string } }).payload;
			return payload?.content?.includes("Hello from mock Claude");
		});
		expect(hasClaudeMessage).toBe(true);

		// Should have status events
		const statusEvents = events.filter((e) => (e as { type: string }).type === "session.status");
		expect(statusEvents.length).toBeGreaterThan(0);
		const statuses = statusEvents.map(
			(event) => (event as { payload: { status: string } }).payload.status,
		);
		expect(statuses[0]).toBe("starting");
		expect(statuses).toContain("running");

		// Mark as cleaned up so afterEach doesn't try to stop again
		activeSessionId = null;
	});

	it("passes --resume when resumeSessionId is provided", async () => {
		const argsPath = join(testDir, "claude-args.txt");
		const argsCapturingMockPath = join(testDir, "mock-claude-args");
		const argsScript = `#!/bin/sh
echo "$@" > "${argsPath}"
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"end"}'
exit 0
`;
		await writeFile(argsCapturingMockPath, argsScript);
		await chmod(argsCapturingMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: argsCapturingMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "claude",
			workspace: testDir,
			initialPrompt: "Hello",
			resumeSessionId: "claude-resume-id",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		const invokedArgs = await readFile(argsPath, "utf8");
		expect(invokedArgs).toContain("--permission-mode acceptEdits");
		expect(invokedArgs).toContain("--resume claude-resume-id");

		activeSessionId = null;
	});

	it("passes --model when model is provided", async () => {
		const argsPath = join(testDir, "claude-args-model.txt");
		const argsCapturingMockPath = join(testDir, "mock-claude-args-model");
		const argsScript = `#!/bin/sh
echo "$@" > "${argsPath}"
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"end"}'
exit 0
`;
		await writeFile(argsCapturingMockPath, argsScript);
		await chmod(argsCapturingMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: argsCapturingMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "claude",
			workspace: testDir,
			initialPrompt: "Hello",
			model: "claude-sonnet-4-20250514",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		const invokedArgs = await readFile(argsPath, "utf8");
		expect(invokedArgs).toContain("--model claude-sonnet-4-20250514");

		activeSessionId = null;
	});

	it("passes --temperature when temperature is provided", async () => {
		const argsPath = join(testDir, "claude-args-temp.txt");
		const argsCapturingMockPath = join(testDir, "mock-claude-args-temp");
		const argsScript = `#!/bin/sh
echo "$@" > "${argsPath}"
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"end"}'
exit 0
`;
		await writeFile(argsCapturingMockPath, argsScript);
		await chmod(argsCapturingMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: argsCapturingMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "claude",
			workspace: testDir,
			initialPrompt: "Hello",
			temperature: 0.7,
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		const invokedArgs = await readFile(argsPath, "utf8");
		expect(invokedArgs).toContain("--temperature 0.7");

		activeSessionId = null;
	});

	it("allows overriding claude permission mode", async () => {
		const argsPath = join(testDir, "claude-args-permission-mode.txt");
		const argsCapturingMockPath = join(testDir, "mock-claude-args-permission-mode");
		const argsScript = `#!/bin/sh
echo "$@" > "${argsPath}"
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"end"}'
exit 0
`;
		await writeFile(argsCapturingMockPath, argsScript);
		await chmod(argsCapturingMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: argsCapturingMockPath,
			permissionMode: "default",
		});

		const result = await activeExecutor.startRun({
			profile: "claude",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		const invokedArgs = await readFile(argsPath, "utf8");
		expect(invokedArgs).toContain("--permission-mode default");

		activeSessionId = null;
	});

	it("stops session and cleans up resources", async () => {
		// Create a mock script that runs longer
		const longRunningMockPath = join(testDir, "mock-claude-long");
		const longRunningScript = `#!/bin/sh
# Long-running mock Claude for testing stop functionality
echo '{"type":"session_start","session_id":"mock-session"}'
sleep 10
echo '{"type":"end"}'
`;
		await writeFile(longRunningMockPath, longRunningScript);
		await chmod(longRunningMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: longRunningMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "claude",
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
