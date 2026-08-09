import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { GeminiExecutor } from "./gemini.js";

describe.skipIf(platform() === "win32")("GeminiExecutor", () => {
	let testDir: string;
	let mockGeminiPath: string;
	let argsLogPath: string;
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
		await git.addConfig("commit.gpgsign", "false");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		argsLogPath = join(testDir, "gemini-args.log");
		mockGeminiPath = join(testDir, "mock-gemini");
		// Default mock emits stream-json JSONL events
		const mockScriptContent = `#!/bin/bash
set -euo pipefail
raw_args="$*"
prompt=""
resume=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--resume)
			resume="$2"
			shift 2
			;;
		--output-format|--model)
			shift 2
			;;
		*)
			prompt="$1"
			shift
			;;
	esac
done
printf '%s\\n' "$raw_args" >> "${argsLogPath}"
if [[ -n "$resume" ]]; then
	session_id="$resume"
	printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"%s","model":"gemini-2.5-flash"}\\n' "$session_id"
	printf '{"type":"message","timestamp":"2026-01-01T00:00:01Z","role":"assistant","content":"Follow-up from mock Gemini! (%s)"}\\n' "$prompt"
	printf '{"type":"result","timestamp":"2026-01-01T00:00:02Z","status":"success"}\\n'
else
	printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"mock-session-abc","model":"gemini-2.5-flash"}\\n'
	printf '{"type":"message","timestamp":"2026-01-01T00:00:01Z","role":"assistant","content":"Hello from mock Gemini! (%s)"}\\n' "$prompt"
	printf '{"type":"result","timestamp":"2026-01-01T00:00:02Z","status":"success"}\\n'
fi
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

	it("starts a run and emits structured assistant messages", async () => {
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

		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		expect(messageEvents.length).toBeGreaterThan(0);

		const hasGeminiMessage = messageEvents.some((e) => {
			const payload = (e as { payload?: { content?: string } }).payload;
			return payload?.content?.includes("Hello from mock Gemini");
		});
		expect(hasGeminiMessage).toBe(true);
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

		activeSessionId = null;
	});

	it("init event captures runtime session ID", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("mock-session-abc");

		activeSessionId = null;
	});

	it("message with delta:true emits session.output instead of session.message", async () => {
		const deltaMockPath = join(testDir, "mock-gemini-delta");
		const deltaMockScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"ses-delta","model":"gemini-2.5-flash"}\\n'
printf '{"type":"message","timestamp":"2026-01-01T00:00:01Z","role":"assistant","content":"streaming chunk","delta":true}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:02Z","status":"success"}\\n'
`;
		await writeFile(deltaMockPath, deltaMockScript);
		await chmod(deltaMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: deltaMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "delta-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter((e) => (e as { type: string }).type === "session.output");
		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");

		// Delta messages go to session.output, not session.message
		const hasStreamingChunk = outputEvents.some((e) => {
			const payload = (e as { payload?: { text?: string } }).payload;
			return payload?.text?.includes("streaming chunk");
		});
		expect(hasStreamingChunk).toBe(true);
		expect(messageEvents.length).toBe(0);

		activeSessionId = null;
	});

	it("sends follow-up input using captured runtime session id", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "Initial prompt",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "Follow-up prompt");

		const messageEvents = events.filter((e) => {
			if ((e as { type: string }).type !== "session.message") return false;
			const payload = (e as { payload?: { content?: string } }).payload;
			return payload?.content?.includes("Follow-up from mock Gemini") ?? false;
		});
		expect(messageEvents.length).toBeGreaterThan(0);

		const argsLog = await readFile(argsLogPath, "utf8");
		expect(argsLog).toContain("--output-format stream-json Initial prompt");
		expect(argsLog).toContain(
			"--resume mock-session-abc --output-format stream-json Follow-up prompt",
		);
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("mock-session-abc");

		const statusEvents = events.filter((e) => (e as { type: string }).type === "session.status");
		const statuses = statusEvents.map((event) => {
			return (event as { payload: { status: string } }).payload.status;
		});
		expect(statuses[0]).toBe("starting");
		expect(statuses.filter((status) => status === "running").length).toBeGreaterThanOrEqual(2);
		expect(statuses.filter((status) => status === "idle").length).toBeGreaterThanOrEqual(2);
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

		activeSessionId = null;
	});

	it("recovers a durable session lazily and resumes its exact runtime id", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});
		const execution = { directory: testDir, mode: "project_folder" as const, git: null };
		const recovered = await activeExecutor.recoverRun(
			{
				sessionId: "gemini-recovered",
				runId: "gemini-run",
				workspaceId: "gemini-workspace",
				createdAt: 1,
				execution,
				runtimeSessionId: "gemini-runtime-789",
				recoveryState: "resumable",
			},
			{ originProjectPath: testDir, execution },
		);
		activeSessionId = "gemini-recovered";

		expect(recovered).toBe(true);
		expect(sessionManager.get(activeSessionId)).toMatchObject({ status: "idle" });
		await expect(readFile(argsLogPath, "utf8")).rejects.toBeDefined();

		await activeExecutor.sendInput(activeSessionId, "recovered-follow-up");
		expect(await readFile(argsLogPath, "utf8")).toContain(
			"--resume gemini-runtime-789 --output-format stream-json recovered-follow-up",
		);
	});

	it("passes --model when model is provided and preserves it across turns", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "Initial prompt",
			model: "gemini-2.5-pro",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "Follow-up prompt");

		const argsLog = await readFile(argsLogPath, "utf8");
		const modelArgsCount = argsLog
			.split("\n")
			.filter((line) => line.includes("--model gemini-2.5-pro")).length;
		expect(modelArgsCount).toBeGreaterThanOrEqual(2);

		activeSessionId = null;
	});

	it("passes --temperature and --max-tokens when provided and preserves them across turns", async () => {
		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: mockGeminiPath,
		});

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "Initial prompt",
			temperature: 0.3,
			maxTokens: 2048,
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "Follow-up prompt");

		const argsLog = await readFile(argsLogPath, "utf8");
		const lines = argsLog.split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(
			lines.filter((line) => line.includes("--temperature 0.3")).length,
		).toBeGreaterThanOrEqual(2);
		expect(
			lines.filter((line) => line.includes("--max-tokens 2048")).length,
		).toBeGreaterThanOrEqual(2);

		activeSessionId = null;
	});

	it("maps tool_use and tool_result events to session.tool_call and session.tool_result", async () => {
		const toolMockPath = join(testDir, "mock-gemini-tool");
		const toolMockScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"mock-session-tools","model":"gemini-2.5-flash"}\\n'
printf '{"type":"tool_use","timestamp":"2026-01-01T00:00:01Z","tool_id":"gem-call-1","tool_name":"read_file","parameters":{"path":"README.md"}}\\n'
printf '{"type":"tool_result","timestamp":"2026-01-01T00:00:02Z","tool_id":"gem-call-1","status":"success","output":"# Test"}\\n'
printf '{"type":"message","timestamp":"2026-01-01T00:00:03Z","role":"assistant","content":"Tool executed."}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:04Z","status":"success"}\\n'
`;
		await writeFile(toolMockPath, toolMockScript);
		await chmod(toolMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: toolMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "tool-test",
		});
		activeSessionId = result.sessionId;

		const toolCallEvents = events.filter(
			(event) => (event as { type: string }).type === "session.tool_call",
		);
		const toolResultEvents = events.filter(
			(event) => (event as { type: string }).type === "session.tool_result",
		);
		const messageEvents = events.filter(
			(event) => (event as { type: string }).type === "session.message",
		);

		expect(toolCallEvents.length).toBe(1);
		expect(toolResultEvents.length).toBe(1);
		expect(messageEvents.length).toBeGreaterThan(0);

		const callPayload = toolCallEvents[0] as {
			payload: { toolCallId: string; toolName: string; arguments?: string };
		};
		const resultPayload = toolResultEvents[0] as {
			payload: { toolCallId: string; toolName: string; output?: string };
		};
		expect(callPayload.payload.toolCallId).toBe("gem-call-1");
		expect(resultPayload.payload.toolCallId).toBe("gem-call-1");
		expect(callPayload.payload.toolName).toBe("read_file");
		expect(resultPayload.payload.toolName).toBe("read_file");
		expect(callPayload.payload.arguments).toContain("README.md");
		expect(resultPayload.payload.output).toContain("# Test");

		activeSessionId = null;
	});

	it("tool_result with status error emits error tool result", async () => {
		const errorToolMockPath = join(testDir, "mock-gemini-tool-error");
		const errorToolMockScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"ses-tool-err","model":"gemini-2.5-flash"}\\n'
printf '{"type":"tool_use","timestamp":"2026-01-01T00:00:01Z","tool_id":"gem-err-1","tool_name":"write_file","parameters":{"path":"/etc/passwd"}}\\n'
printf '{"type":"tool_result","timestamp":"2026-01-01T00:00:02Z","tool_id":"gem-err-1","status":"error","error":{"message":"Permission denied"}}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:03Z","status":"success"}\\n'
`;
		await writeFile(errorToolMockPath, errorToolMockScript);
		await chmod(errorToolMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: errorToolMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "tool-error-test",
		});
		activeSessionId = result.sessionId;

		const toolResultEvents = events.filter(
			(event) => (event as { type: string }).type === "session.tool_result",
		);
		expect(toolResultEvents.length).toBe(1);

		const resultPayload = toolResultEvents[0] as {
			payload: { toolCallId: string; toolName: string; error?: string; output?: string };
		};
		expect(resultPayload.payload.toolCallId).toBe("gem-err-1");
		expect(resultPayload.payload.toolName).toBe("write_file");
		expect(resultPayload.payload.error).toBe("Permission denied");
		expect(resultPayload.payload.output).toBeUndefined();

		activeSessionId = null;
	});

	it("error event emits session.output with error text", async () => {
		const errorMockPath = join(testDir, "mock-gemini-error-event");
		const errorMockScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"ses-err","model":"gemini-2.5-flash"}\\n'
printf '{"type":"error","timestamp":"2026-01-01T00:00:01Z","severity":"error","message":"Rate limit exceeded"}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:02Z","status":"success"}\\n'
`;
		await writeFile(errorMockPath, errorMockScript);
		await chmod(errorMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: errorMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "error-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter(
			(event) => (event as { type: string }).type === "session.output",
		);
		const combinedOutput = outputEvents
			.map((event) => (event as { payload?: { text?: string } }).payload?.text ?? "")
			.join("");
		expect(combinedOutput).toContain("Error: Rate limit exceeded");

		activeSessionId = null;
	});

	it("forwards non-JSON stdout lines as session.output", async () => {
		const nonJsonMockPath = join(testDir, "mock-gemini-nonjson");
		const nonJsonMockScript = `#!/bin/bash
set -euo pipefail
printf 'plain text line\\n'
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"ses-nj","model":"gemini-2.5-flash"}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:01Z","status":"success"}\\n'
`;
		await writeFile(nonJsonMockPath, nonJsonMockScript);
		await chmod(nonJsonMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: nonJsonMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "nonjson-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter(
			(event) => (event as { type: string }).type === "session.output",
		);
		const combinedOutput = outputEvents
			.map((event) => (event as { payload?: { text?: string } }).payload?.text ?? "")
			.join("");
		expect(combinedOutput).toContain("plain text line");

		activeSessionId = null;
	});

	it("handles result event with error status", async () => {
		const resultErrorMockPath = join(testDir, "mock-gemini-result-error");
		const resultErrorMockScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"ses-re","model":"gemini-2.5-flash"}\\n'
printf '{"type":"result","timestamp":"2026-01-01T00:00:01Z","status":"error","error":{"message":"Context window exceeded"}}\\n'
`;
		await writeFile(resultErrorMockPath, resultErrorMockScript);
		await chmod(resultErrorMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: resultErrorMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "gemini",
			workspace: testDir,
			initialPrompt: "result-error-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter(
			(event) => (event as { type: string }).type === "session.output",
		);
		const combinedOutput = outputEvents
			.map((event) => (event as { payload?: { text?: string } }).payload?.text ?? "")
			.join("");
		expect(combinedOutput).toContain("Session error: Context window exceeded");

		activeSessionId = null;
	});
});
