import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { OpenCodeExecutor } from "./opencode.js";

describe("OpenCodeExecutor", () => {
	let testDir: string;
	let mockOpenCodePath: string;
	let argsLogPath: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let activeExecutor: OpenCodeExecutor | null = null;
	let activeSessionId: string | null = null;

	beforeEach(async () => {
		activeExecutor = null;
		activeSessionId = null;

		testDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		argsLogPath = join(testDir, "opencode-args.log");
		mockOpenCodePath = join(testDir, "mock-opencode");
		const mockScriptContent = `#!/bin/bash
set -euo pipefail
raw_args="$*"
printf '%s\\n' "$raw_args" >> "${argsLogPath}"

session_id=""
prompt=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--session)
			session_id="$2"
			shift 2
			;;
		*)
			prompt="$1"
			shift
			;;
	esac
done

if [[ -z "$session_id" ]]; then
	session_id="ses_mock_123"
fi

printf '{"type":"step_start","sessionID":"%s"}\\n' "$session_id"

if [[ "$prompt" == "tool-test" ]]; then
	printf '{"type":"tool_use","sessionID":"%s","part":{"callID":"call_mock_1","tool":"apply_patch","state":{"status":"completed","input":{"patchText":"*** Begin Patch"},"output":"patched","metadata":{"diff":"@@ -1 +1 @@","files":[{"relativePath":"README.md"}]}}}}\\n' "$session_id"
	printf '{"type":"tool_use","sessionID":"%s","part":{"callID":"call_mock_1","tool":"apply_patch","state":{"status":"completed","input":{"patchText":"*** Begin Patch"},"output":"patched","metadata":{"diff":"@@ -1 +1 @@","files":[{"relativePath":"README.md"}]}}}}\\n' "$session_id"
fi

if [[ "$prompt" == "stderr-test" ]]; then
	printf '\\033[31mpermission requested: external_directory (/etc/*); auto-rejecting\\033[0m\\n' >&2
fi

if [[ "$prompt" == "nonjson-test" ]]; then
	printf 'plain stdout line\\n'
fi

printf '{"type":"text","sessionID":"%s","part":{"type":"text","text":"reply:%s"}}\\n' "$session_id" "$prompt"
printf '{"type":"step_finish","sessionID":"%s"}\\n' "$session_id"
exit 0
`;
		await writeFile(mockOpenCodePath, mockScriptContent);
		await chmod(mockOpenCodePath, 0o755);

		workspaceManager = new WorkspaceManager(testDir);
		sessionManager = new SessionManager();
		eventBus = new EventBus();
	});

	afterEach(async () => {
		if (activeExecutor && activeSessionId) {
			try {
				await activeExecutor.stop(activeSessionId);
			} catch {
				// Ignore cleanup errors.
			}
		}

		await new Promise((r) => setTimeout(r, 50));
		await rm(testDir, { recursive: true, force: true });
	});

	it("creates executor with correct type", () => {
		const executor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		expect(executor.type).toBe("opencode");
	});

	it("starts a run, emits structured message output, and stores runtime session id", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "initial-prompt",
		});
		activeSessionId = result.sessionId;

		const messageEvents = events.filter(
			(event) => (event as { type: string }).type === "session.message",
		);
		expect(messageEvents.length).toBeGreaterThan(0);
		expect((messageEvents[0] as { payload: { content: string } }).payload.content).toContain(
			"reply:initial-prompt",
		);
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("ses_mock_123");
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");
		const statusEvents = events.filter(
			(event) => (event as { type: string }).type === "session.status",
		);
		const statuses = statusEvents.map(
			(event) => (event as { payload: { status: string } }).payload.status,
		);
		expect(statuses[0]).toBe("starting");
		expect(statuses).toContain("running");
		expect(statuses).toContain("idle");

		const argsLog = await readFile(argsLogPath, "utf8");
		expect(argsLog).toContain("run --format json initial-prompt");
	});

	it("resumes follow-up turns with --session", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "initial-prompt",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "follow-up-prompt");

		const argsLog = await readFile(argsLogPath, "utf8");
		expect(argsLog).toContain("run --format json initial-prompt");
		expect(argsLog).toContain("run --format json --session ses_mock_123 follow-up-prompt");
	});

	it("passes --model when model is provided and preserves it across turns", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "initial-prompt",
			model: "claude-sonnet-4-20250514",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "follow-up-prompt");

		const argsLog = await readFile(argsLogPath, "utf8");
		expect(argsLog).toContain("run --format json --model claude-sonnet-4-20250514 initial-prompt");
		expect(argsLog).toContain(
			"run --format json --session ses_mock_123 --model claude-sonnet-4-20250514 follow-up-prompt",
		);
	});

	it("emits tool_call + tool_result and git.diff_updated for tool_use events", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
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
		const diffEvents = events.filter(
			(event) => (event as { type: string }).type === "git.diff_updated",
		);

		expect(toolCallEvents.length).toBe(1);
		expect(toolResultEvents.length).toBe(1);
		expect(diffEvents.length).toBe(1);

		const toolCallPayload = toolCallEvents[0] as {
			payload: { toolCallId: string; toolName: string; arguments?: string };
		};
		const toolResultPayload = toolResultEvents[0] as {
			payload: { toolCallId: string; toolName: string; output?: string };
		};

		expect(toolCallPayload.payload.toolCallId).toBe("call_mock_1");
		expect(toolResultPayload.payload.toolCallId).toBe("call_mock_1");
		expect(toolCallPayload.payload.toolName).toBe("apply_patch");
		expect(toolResultPayload.payload.toolName).toBe("apply_patch");
		expect(toolCallPayload.payload.arguments).toContain("patchText");
		expect(toolResultPayload.payload.output).toContain("patched");
	});

	it("preserves parentToolUseId metadata when provided by OpenCode JSON events", async () => {
		const parentMockPath = join(testDir, "mock-opencode-parent");
		const parentScript = `#!/bin/bash
set -euo pipefail
printf '{"type":"text","sessionID":"ses_parent_123","part":{"type":"text","text":"nested text","parentToolUseId":"parent-opencode-1"}}\\n'
printf '{"type":"tool_use","sessionID":"ses_parent_123","parent_tool_use_id":"parent-opencode-1","part":{"callID":"call_parent_1","tool":"read_file","state":{"status":"completed","input":{"path":"README.md"},"output":"ok"}}}\\n'
`;
		await writeFile(parentMockPath, parentScript);
		await chmod(parentMockPath, 0o755);

		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: parentMockPath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "parent",
		});
		activeSessionId = result.sessionId;

		const message = events.find(
			(event) => (event as { type: string }).type === "session.message",
		) as { payload?: { parentToolUseId?: string } } | undefined;
		const toolCall = events.find(
			(event) => (event as { type: string }).type === "session.tool_call",
		) as { payload?: { parentToolUseId?: string } } | undefined;
		const toolResult = events.find(
			(event) => (event as { type: string }).type === "session.tool_result",
		) as { payload?: { parentToolUseId?: string } } | undefined;

		expect(message?.payload?.parentToolUseId).toBe("parent-opencode-1");
		expect(toolCall?.payload?.parentToolUseId).toBe("parent-opencode-1");
		expect(toolResult?.payload?.parentToolUseId).toBe("parent-opencode-1");
	});

	it("forwards stderr as session.output and strips ANSI color codes", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "stderr-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter(
			(event) => (event as { type: string }).type === "session.output",
		);
		expect(outputEvents.length).toBeGreaterThan(0);
		const combinedOutput = outputEvents
			.map((event) => (event as { payload?: { text?: string } }).payload?.text ?? "")
			.join("\n");
		expect(combinedOutput).toContain(
			"permission requested: external_directory (/etc/*); auto-rejecting",
		);
		expect(combinedOutput).not.toContain("\u001b[");
	});

	it("forwards non-JSON stdout lines as session.output", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			opencodePath: mockOpenCodePath,
		});

		const events: unknown[] = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "nonjson-test",
		});
		activeSessionId = result.sessionId;

		const outputEvents = events.filter(
			(event) => (event as { type: string }).type === "session.output",
		);
		expect(outputEvents.length).toBeGreaterThan(0);
		const combinedOutput = outputEvents
			.map((event) => (event as { payload?: { text?: string } }).payload?.text ?? "")
			.join("\n");
		expect(combinedOutput).toContain("plain stdout line");
	});
});
