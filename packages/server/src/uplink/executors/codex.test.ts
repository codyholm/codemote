import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { CodexExecutor } from "./codex.js";

async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Condition not met within timeout");
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

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

		// Create a mock codex executable that validates argument order and emits
		// modern JSONL events on stdout.
		mockCodexPath = join(testDir, "mock-codex");
		const mockScriptContent = `#!/bin/sh
# Validate top-level flags come before exec
if [ "$1" != "--ask-for-approval" ] || [ "$2" != "on-request" ] || [ "$3" != "--sandbox" ] || [ "$4" != "workspace-write" ] || [ "$5" != "exec" ] || [ "$6" != "--json" ]; then
	echo "unexpected args: $*" >&2
	exit 2
fi

echo '{"type":"thread.started","thread_id":"mock-thread"}'
sleep 0.1
echo '{"type":"turn.started"}'
sleep 0.1
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello from Codex!"}}'
sleep 0.1
echo '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"echo hi","aggregated_output":"","exit_code":null,"status":"in_progress"}}'
sleep 0.1
echo '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"echo hi","aggregated_output":"hi","exit_code":0,"status":"completed"}}'
sleep 0.1
echo '{"type":"turn.completed"}'
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

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");

		// Should have received events
		expect(events.length).toBeGreaterThan(0);

		// Should have status events
		const statusEvents = events.filter((e) => (e as { type: string }).type === "session.status");
		expect(statusEvents.length).toBeGreaterThan(0);
		const statuses = statusEvents.map(
			(event) => (event as { payload: { status: string } }).payload.status,
		);
		expect(statuses[0]).toBe("starting");
		expect(statuses).toContain("running");
		expect(statuses).toContain("idle");

		// Should map agent messages into structured session messages
		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		expect(messageEvents.length).toBeGreaterThan(0);
		expect((messageEvents[0] as { payload: { content?: string } }).payload.content).toContain(
			"Hello from Codex!",
		);

		// Should map command execution into tool call + result
		const toolCallEvents = events.filter(
			(e) => (e as { type: string }).type === "session.tool_call",
		);
		const toolResultEvents = events.filter(
			(e) => (e as { type: string }).type === "session.tool_result",
		);
		expect(toolCallEvents.length).toBeGreaterThan(0);
		expect(toolResultEvents.length).toBeGreaterThan(0);
		const callPayload = toolCallEvents[0] as {
			payload: { toolCallId?: string; toolName?: string; arguments?: string };
		};
		const resultPayload = toolResultEvents[0] as {
			payload: { toolCallId?: string; toolName?: string; output?: string };
		};
		expect(callPayload.payload.toolCallId).toBeDefined();
		expect(resultPayload.payload.toolCallId).toBe(callPayload.payload.toolCallId);
		expect(callPayload.payload.toolName).toBe("shell");
		expect(resultPayload.payload.toolName).toBe("shell");
		expect(resultPayload.payload.output).toContain("hi");

		// Thread id should be captured as runtime session id for future resume.
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("mock-thread");

		// Mark as cleaned up so afterEach doesn't try to stop again
		activeSessionId = null;
	});

	it("normalizes structured item.message content", async () => {
		const structuredMockPath = join(testDir, "mock-codex-structured");
		const structuredScript = `#!/bin/sh
echo '{"type":"thread.started","thread_id":"mock-thread"}'
sleep 0.1
echo '{"type":"turn.started"}'
sleep 0.1
echo '{"type":"item.message","content":[{"type":"output_text","text":"Answer: "},{"type":"output_text","text":"15"}]}'
sleep 0.1
echo '{"type":"turn.completed"}'
exit 0
`;
		await writeFile(structuredMockPath, structuredScript);
		await chmod(structuredMockPath, 0o755);

		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: structuredMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		await waitFor(() =>
			events.some((event) => (event as { type: string }).type === "session.message"),
		);

		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		expect(messageEvents.length).toBeGreaterThan(0);
		expect((messageEvents[0] as { payload: { content?: string } }).payload.content).toBe(
			"Answer: 15",
		);

		activeSessionId = null;
	});

	it("resumes ended sessions when sending follow-up input", async () => {
		const resumeMockPath = join(testDir, "mock-codex-resume");
		const resumeScript = `#!/bin/sh
if [ "$1" != "--ask-for-approval" ] || [ "$2" != "on-request" ] || [ "$3" != "--sandbox" ] || [ "$4" != "workspace-write" ] || [ "$5" != "exec" ]; then
	echo "unexpected args: $*" >&2
	exit 2
fi

if [ "$6" = "--json" ]; then
	echo '{"type":"thread.started","thread_id":"resume-thread"}'
	sleep 0.1
	echo '{"type":"turn.started"}'
	sleep 0.1
	echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"17"}}'
	sleep 0.1
	echo '{"type":"turn.completed"}'
	exit 0
fi

if [ "$6" = "resume" ]; then
	if [ -z "$7" ] || [ "$8" != "--json" ]; then
		echo "unexpected resume args: $*" >&2
		exit 2
	fi
	echo '{"type":"thread.started","thread_id":"'"$7"'"}'
	sleep 0.1
	echo '{"type":"turn.started"}'
	sleep 0.1
	echo '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"You asked: \\"What is 8 + 9?\\""}}'
	sleep 0.1
	echo '{"type":"turn.completed"}'
	exit 0
fi

echo "unexpected args: $*" >&2
exit 2
`;
		await writeFile(resumeMockPath, resumeScript);
		await chmod(resumeMockPath, 0o755);

		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: resumeMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "What is 8 + 9?",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		expect(sessionManager.get(result.sessionId)?.status).toBe("ended");
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("resume-thread");

		await activeExecutor.sendInput(result.sessionId, "What question did I ask you?");
		await waitFor(() =>
			events.some((event) => {
				if ((event as { type: string }).type !== "session.message") {
					return false;
				}
				const content = (event as { payload?: { content?: string } }).payload?.content;
				return typeof content === "string" && content.includes('You asked: "What is 8 + 9?"');
			}),
		);

		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		const messageContents = messageEvents.map((e) =>
			((e as { payload: { content?: string } }).payload.content ?? "").trim(),
		);
		expect(messageContents.some((content) => content.includes("17"))).toBe(true);
		expect(messageContents.some((content) => content.includes('You asked: "What is 8 + 9?"'))).toBe(
			true,
		);

		const startingEvents = events.filter(
			(e) =>
				(e as { type: string }).type === "session.status" &&
				(e as { payload: { status?: string } }).payload.status === "starting",
		);
		expect(startingEvents.length).toBeGreaterThan(1);

		activeSessionId = null;
	});

	it("passes --model when model is provided and preserves it when resuming", async () => {
		const argsLogPath = join(testDir, "codex-args.log");
		const modelMockPath = join(testDir, "mock-codex-model");
		const modelScript = `#!/bin/sh
echo "$@" >> "${argsLogPath}"

thread_id="mock-thread"
previous=""
for arg in "$@"; do
	if [ "$previous" = "resume" ]; then
		thread_id="$arg"
		break
	fi
	previous="$arg"
done

echo '{"type":"thread.started","thread_id":"'"$thread_id"'"}'
sleep 0.1
echo '{"type":"session.id","session_id":"'"$thread_id"'"}'
sleep 0.1
echo '{"type":"turn.started"}'
sleep 0.1
echo '{"type":"turn.completed"}'
exit 0
`;
		await writeFile(modelMockPath, modelScript);
		await chmod(modelMockPath, 0o755);

		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: modelMockPath,
		});

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "Hello",
			model: "o4-mini",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => sessionManager.get(result.sessionId)?.runtimeSessionId === "mock-thread");
		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");
		expect(sessionManager.get(result.sessionId)?.status).toBe("ended");

		await activeExecutor.sendInput(result.sessionId, "Follow-up");
		await waitFor(() => sessionManager.get(result.sessionId)?.status === "ended");

		const argsLog = await readFile(argsLogPath, "utf8");
		const lines = argsLog.split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.filter((line) => line.includes("--model o4-mini")).length).toBeGreaterThanOrEqual(
			2,
		);
		expect(argsLog).toContain("exec resume mock-thread --json");

		activeSessionId = null;
	});

	it("preserves parentToolUseId metadata on structured events", async () => {
		const parentMockPath = join(testDir, "mock-codex-parent");
		const parentScript = `#!/bin/sh
echo '{"type":"thread.started","thread_id":"parent-thread"}'
sleep 0.1
echo '{"type":"turn.started"}'
sleep 0.1
echo '{"type":"item.message","parent_tool_use_id":"parent_123","content":[{"type":"output_text","text":"Nested assistant output"}]}'
sleep 0.1
echo '{"type":"item.started","item":{"id":"item_9","type":"command_execution","command":"echo nested","parent_tool_use_id":"parent_123"}}'
sleep 0.1
echo '{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"echo nested","aggregated_output":"nested","exit_code":0,"status":"completed","parent_tool_use_id":"parent_123"}}'
sleep 0.1
echo '{"type":"turn.completed"}'
exit 0
`;
		await writeFile(parentMockPath, parentScript);
		await chmod(parentMockPath, 0o755);

		activeExecutor = new CodexExecutor(workspaceManager, sessionManager, eventBus, {
			codexPath: parentMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "codex",
			workspace: testDir,
			initialPrompt: "parent metadata",
		});
		activeSessionId = result.sessionId;

		await waitFor(() => {
			const hasMessage = events.some((event) => {
				if ((event as { type: string }).type !== "session.message") return false;
				return (
					(event as { payload?: { parentToolUseId?: string } }).payload?.parentToolUseId ===
					"parent_123"
				);
			});
			const hasToolCall = events.some((event) => {
				if ((event as { type: string }).type !== "session.tool_call") return false;
				return (
					(event as { payload?: { parentToolUseId?: string } }).payload?.parentToolUseId ===
					"parent_123"
				);
			});
			const hasToolResult = events.some((event) => {
				if ((event as { type: string }).type !== "session.tool_result") return false;
				return (
					(event as { payload?: { parentToolUseId?: string } }).payload?.parentToolUseId ===
					"parent_123"
				);
			});
			return hasMessage && hasToolCall && hasToolResult;
		});

		const messageEvent = events.find(
			(event) => (event as { type: string }).type === "session.message",
		) as { payload?: { parentToolUseId?: string } } | undefined;
		const toolCallEvent = events.find(
			(event) => (event as { type: string }).type === "session.tool_call",
		) as { payload?: { parentToolUseId?: string } } | undefined;
		const toolResultEvent = events.find(
			(event) => (event as { type: string }).type === "session.tool_result",
		) as { payload?: { parentToolUseId?: string } } | undefined;

		expect(messageEvent?.payload?.parentToolUseId).toBe("parent_123");
		expect(toolCallEvent?.payload?.parentToolUseId).toBe("parent_123");
		expect(toolResultEvent?.payload?.parentToolUseId).toBe("parent_123");

		activeSessionId = null;
	});

	it("stops session and cleans up resources", async () => {
		// Create a mock script that runs longer
		const longRunningMockPath = join(testDir, "mock-codex-long");
		const longRunningScript = `#!/bin/sh
# Long-running mock Codex for testing stop functionality
echo '{"type":"thread.started","thread_id":"mock-thread"}'
sleep 10
echo '{"type":"turn.completed"}'
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
