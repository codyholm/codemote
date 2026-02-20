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
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

		// Mark as cleaned up so afterEach doesn't try to stop again
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
				if ((e as { type: string }).type !== "session.output") return false;
				const payload = (e as { payload?: { text?: string } }).payload;
				return payload?.text?.includes("Follow-up from mock Gemini") ?? false;
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
		expect(statuses.filter((status) => status === "running").length).toBeGreaterThanOrEqual(2);
		expect(statuses.filter((status) => status === "idle").length).toBeGreaterThanOrEqual(2);
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");

		activeSessionId = null;
	});
});
