import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		argsLogPath = join(testDir, "gemini-args.log");
		mockGeminiPath = join(testDir, "mock-gemini");
		const mockScriptContent = `#!/bin/bash
set -euo pipefail
raw_args="$*"
prompt=""
resume=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-p|--prompt)
			prompt="$2"
			shift 2
			;;
		-r|--resume)
			resume="$2"
			shift 2
			;;
		*)
			shift
			;;
	esac
done
printf '%s\\n' "$raw_args" >> "${argsLogPath}"
if [[ -n "$resume" ]]; then
	session_id="$resume"
	response="Follow-up from mock Gemini! ($prompt)"
else
	session_id="mock-session-abc"
	response="Hello from mock Gemini! ($prompt)"
fi
printf 'Loaded cached credentials.\\n'
printf '{\\n  "session_id": "%s",\\n  "response": "%s"\\n}\\n' "$session_id" "$response"
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

		await waitFor(() => events.some((e) => (e as { type: string }).type === "session.message"));

		const messageEvents = events.filter((e) => (e as { type: string }).type === "session.message");
		expect(messageEvents.length).toBeGreaterThan(0);

		const hasGeminiMessage = messageEvents.some((e) => {
			const payload = (e as { payload?: { content?: string } }).payload;
			return payload?.content?.includes("Hello from mock Gemini");
		});
		expect(hasGeminiMessage).toBe(true);
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

		// Mark as cleaned up so afterEach doesn't try to stop again
		activeSessionId = null;
	});

	it("ignores unrelated JSON preamble before the headless payload", async () => {
		const noisyMockPath = join(testDir, "mock-gemini-noisy");
		const noisyScriptContent = `#!/bin/bash
set -euo pipefail
printf '{ "level": "info", "message": "warming up" }\\n'
printf '{\\n  "session_id": "mock-session-noisy",\\n  "response": "Noisy hello"\\n}\\n'
`;
		await writeFile(noisyMockPath, noisyScriptContent);
		await chmod(noisyMockPath, 0o755);

		activeExecutor = new GeminiExecutor(workspaceManager, sessionManager, eventBus, {
			geminiPath: noisyMockPath,
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
		const outputText = messageEvents
			.map((e) => (e as { payload?: { content?: string } }).payload?.content ?? "")
			.join("\n");

		expect(outputText).toContain("Noisy hello");
		expect(outputText).not.toContain("warming up");
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("mock-session-noisy");

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

		await waitFor(() =>
			events.some((e) => {
				if ((e as { type: string }).type !== "session.message") return false;
				const payload = (e as { payload?: { content?: string } }).payload;
				return payload?.content?.includes("Follow-up from mock Gemini") ?? false;
			}),
		);

		const argsLog = await readFile(argsLogPath, "utf8");
		expect(argsLog).toContain("--prompt Initial prompt --output-format json");
		expect(argsLog).toContain(
			"--resume mock-session-abc --prompt Follow-up prompt --output-format json",
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

	it("maps Gemini tool blocks to session.tool_call and session.tool_result events", async () => {
		const toolMockPath = join(testDir, "mock-gemini-tool");
		const toolMockScript = `#!/bin/bash
set -euo pipefail
printf '{\\n  "session_id": "mock-session-tools",\\n  "response": {"parts":[{"functionCall":{"id":"gem-call-1","name":"read_file","args":{"path":"README.md"}}},{"text":"Tool executed."},{"functionResponse":{"id":"gem-call-1","name":"read_file","response":{"content":"# Test"}}}]}\\n}\\n'
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
		expect(resultPayload.payload.output).toContain("content");

		activeSessionId = null;
	});
});
