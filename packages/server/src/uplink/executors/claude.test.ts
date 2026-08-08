import { existsSync } from "node:fs";
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
		await git.addConfig("commit.gpgsign", "false");
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

	it("rejects start when the Claude binary cannot be spawned", async () => {
		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: join(testDir, "missing-claude"),
		});

		await expect(
			activeExecutor.startRun({
				profile: "claude",
				workspace: testDir,
				initialPrompt: "Hello",
			}),
		).rejects.toThrow(/ENOENT|spawn/u);
		expect(sessionManager.list()).toHaveLength(1);
		expect(sessionManager.list()[0]?.status).toBe("error");
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

	it("assigns a native session ID before a project-aware start succeeds", async () => {
		const argsPath = join(testDir, "claude-project-args.txt");
		const argsCapturingMockPath = join(testDir, "mock-claude-project-args");
		const argsScript = `#!/bin/sh
echo "$@" > "${argsPath}"
printf '%s\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\n' '{"type":"end"}'
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
			projectStart: {
				operationId: "claude-project-start",
				originProjectPath: testDir,
				mode: "project_folder",
				preparation: { type: "none" },
			},
		});
		activeSessionId = result.sessionId;

		await waitFor(() => existsSync(argsPath));
		const invokedArgs = await readFile(argsPath, "utf8");
		expect(invokedArgs).toMatch(
			/--session-id [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
		);
		expect(invokedArgs).not.toContain("--resume");

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

	it("survives a claude CLI that exits before the initial prompt write lands", async () => {
		// Closes its stdin and exits without reading. Paired with a prompt larger than the
		// OS pipe buffer, the initial write is guaranteed to still be in flight when the
		// read end goes away, so the write fails with EPIPE.
		const earlyExitMockPath = join(testDir, "mock-claude-early-exit");
		const earlyExitScript = `#!/bin/sh
exec 0<&-
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
exit 0
`;
		await writeFile(earlyExitMockPath, earlyExitScript);
		await chmod(earlyExitMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: earlyExitMockPath,
		});

		const uncaught: unknown[] = [];
		const collect = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", collect);
		process.on("unhandledRejection", collect);

		try {
			const result = await activeExecutor.startRun({
				profile: "claude",
				workspace: testDir,
				initialPrompt: "x".repeat(1024 * 1024),
			});
			activeSessionId = result.sessionId;

			await waitFor(() => {
				const status = sessionManager.get(result.sessionId)?.status;
				return status === "ended" || status === "error";
			});

			// The stdin failure can surface a tick or two after exit; let it land.
			await new Promise((r) => setTimeout(r, 200));

			expect(uncaught).toEqual([]);
			expect(["ended", "error"]).toContain(sessionManager.get(result.sessionId)?.status);

			activeSessionId = null;
		} finally {
			process.off("uncaughtException", collect);
			process.off("unhandledRejection", collect);
		}
	});

	it("reports a follow-up prompt that could not be delivered instead of acking it", async () => {
		// Finishes a turn (session reaches idle) but drops the read end of its stdin, then
		// execs sleep so no shell-held duplicate of that fd survives. The session is still
		// live and accepting input as far as the executor is concerned.
		const deadStdinMockPath = join(testDir, "mock-claude-dead-stdin");
		const deadStdinScript = `#!/bin/sh
exec 0<&-
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"result","session_id":"mock-session","result":"first turn done"}'
exec sleep 30
`;
		await writeFile(deadStdinMockPath, deadStdinScript);
		await chmod(deadStdinMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: deadStdinMockPath,
		});

		const uncaught: unknown[] = [];
		const collect = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", collect);
		process.on("unhandledRejection", collect);

		try {
			const result = await activeExecutor.startRun({
				profile: "claude",
				workspace: testDir,
				initialPrompt: "Hello",
			});
			activeSessionId = result.sessionId;

			await waitFor(() => sessionManager.get(result.sessionId)?.status === "idle");
			expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

			// Must exceed the stdin socket buffer: a write that fits is absorbed by the OS
			// and reported as delivered even though nothing will ever read it. Node's
			// stdio "pipes" are Unix socketpairs, and Linux defaults that buffer to
			// roughly 208 KB against macOS's far smaller one, so the payload has to clear
			// the larger of the two or this passes on macOS and fails on Linux.
			await expect(
				activeExecutor.sendInput(result.sessionId, "x".repeat(4 * 1024 * 1024)),
			).rejects.toThrow(/could not be delivered/);

			await new Promise((r) => setTimeout(r, 200));

			// A dropped prompt must not leave the session looking like a turn in progress.
			expect(sessionManager.get(result.sessionId)?.status).toBe("idle");
			// And the crash guard from the EPIPE fix must still hold.
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", collect);
			process.off("unhandledRejection", collect);
		}
	});

	it("gives up on a prompt write that never flushes", async () => {
		// Leaves stdin OPEN but never reads it, so an over-buffer write neither flushes
		// nor fails — it just parks. Without a bound the send would hang forever.
		const wedgedMockPath = join(testDir, "mock-claude-wedged-stdin");
		const wedgedScript = `#!/bin/sh
printf '%s\\n' '{"type":"session_start","session_id":"mock-session"}'
printf '%s\\n' '{"type":"result","session_id":"mock-session","result":"first turn done"}'
exec sleep 30
`;
		await writeFile(wedgedMockPath, wedgedScript);
		await chmod(wedgedMockPath, 0o755);

		activeExecutor = new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
			claudePath: wedgedMockPath,
			stdinWriteTimeoutMs: 500,
		});

		const uncaught: unknown[] = [];
		const collect = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", collect);
		process.on("unhandledRejection", collect);

		try {
			const result = await activeExecutor.startRun({
				profile: "claude",
				workspace: testDir,
				initialPrompt: "Hello",
			});
			activeSessionId = result.sessionId;

			await waitFor(() => sessionManager.get(result.sessionId)?.status === "idle");
			expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

			await expect(
				activeExecutor.sendInput(result.sessionId, "x".repeat(4 * 1024 * 1024)),
			).rejects.toThrow(/could not be delivered: write did not flush within 500ms/);

			// The destroy fires the parked write callback; it must not settle a second time.
			await new Promise((r) => setTimeout(r, 200));

			expect(uncaught).toEqual([]);
			// The stall belongs to the input attempt, not to the session.
			expect(sessionManager.get(result.sessionId)?.status).toBe("idle");
		} finally {
			process.off("uncaughtException", collect);
			process.off("unhandledRejection", collect);
		}
	});
});
