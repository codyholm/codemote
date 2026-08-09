import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	ATTENTION_DESCRIPTION_MAX,
	type ProjectStateAggregate,
	type RunOptions,
} from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { reserveFreePort, waitForOpen } from "../test-support/network.js";
import type { EventBus } from "./events.js";
import { BaseExecutor } from "./executor.js";
import { UplinkServer } from "./server.js";
import type { SessionManager } from "./session.js";
import type { Session } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

interface ServerInternals {
	workspaceManager: WorkspaceManager;
	sessionManager: SessionManager;
	eventBus: EventBus;
}

class ProjectStateTestExecutor extends BaseExecutor {
	readonly type = "opencode" as const;

	protected async doStartRun(session: Session, _options: RunOptions): Promise<void> {
		this.emitStatus(session.id, "idle");
	}

	protected async doSendInput(_session: Session, _input: string): Promise<void> {}

	protected async doStop(_session: Session): Promise<void> {}
}

interface UplinkMessage {
	type: string;
	requestId?: string;
	payload?: unknown;
}

/**
 * Buffers every message so a test can correlate a solicited reply by requestId
 * while independently counting unsolicited pushes. A one-shot `once("message")`
 * cannot do both, and the push arrives interleaved with the reply.
 */
class TestClient {
	readonly received: UplinkMessage[] = [];
	private waiters: Array<{ match: (msg: UplinkMessage) => boolean; resolve: () => void }> = [];

	private constructor(private readonly ws: WebSocket) {}

	static async connect(port: number): Promise<TestClient> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);

		const client = new TestClient(ws);
		ws.on("message", (data) => client.ingest(JSON.parse(data.toString()) as UplinkMessage));
		return client;
	}

	private ingest(msg: UplinkMessage): void {
		this.received.push(msg);
		const remaining: typeof this.waiters = [];
		for (const waiter of this.waiters) {
			if (waiter.match(msg)) {
				waiter.resolve();
				continue;
			}
			remaining.push(waiter);
		}
		this.waiters = remaining;
	}

	pushes(): ProjectStateAggregate[] {
		return this.received
			.filter((msg) => msg.type === "project_state_push")
			.map((msg) => msg.payload as ProjectStateAggregate);
	}

	send(command: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(command));
	}

	/** Index to pass as `from`, so a wait can be scoped to messages after this point. */
	mark(): number {
		return this.received.length;
	}

	async waitFor(
		match: (msg: UplinkMessage) => boolean,
		description: string,
		from = 0,
		timeoutMs = 20000,
	): Promise<UplinkMessage> {
		const existing = this.received.slice(from).find(match);
		if (existing) return existing;

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for ${description}`)),
				timeoutMs,
			);
			this.waiters.push({
				match,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});

		const found = this.received.slice(from).find(match);
		if (!found) throw new Error(`Resolved but missing ${description}`);
		return found;
	}

	async request(command: Record<string, unknown>, requestId: string): Promise<UplinkMessage> {
		this.send({ ...command, requestId });
		return this.waitFor((msg) => msg.requestId === requestId, `response to ${requestId}`);
	}

	close(): void {
		this.ws.close();
	}
}

/**
 * The executor's protected emit helpers. Reached by cast so the tests drive the
 * real production path (setAttention plus the event) without adding a test-only
 * accessor to UplinkServer or BaseExecutor.
 */
interface ExecutorProbe {
	emitAttention(sessionId: string, reason: string, details?: unknown): void;
	emitOutput(sessionId: string, text: string): void;
}

function probe(server: UplinkServer): ExecutorProbe {
	const executor = server.getExecutor("opencode");
	if (!executor) throw new Error("project-state test executor is not registered");
	return executor as unknown as ExecutorProbe;
}

function settle(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIdlePush(msg: UplinkMessage): boolean {
	if (msg.type !== "project_state_push") return false;
	const state = msg.payload as ProjectStateAggregate;
	return state.projects[0]?.sessions[0]?.status === "idle";
}

describe("UplinkServer project state", () => {
	let port: number;
	let server: UplinkServer;
	let client: TestClient;
	let fixtureDir = "";

	beforeEach(async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "codemote-uplink-registry-"));
		port = await reserveFreePort();
		server = new UplinkServer({
			port,
			host: "127.0.0.1",
			runtimes: [],
			projectRegistryPath: join(fixtureDir, "projects.json"),
			projectStartJournalPath: join(fixtureDir, "project-start-operations.json"),
		});
		const internals = server as unknown as ServerInternals;
		server.registerExecutor(
			new ProjectStateTestExecutor(
				internals.workspaceManager,
				internals.sessionManager,
				internals.eventBus,
			),
		);
		await server.start();
		client = await TestClient.connect(port);
	});

	afterEach(async () => {
		try {
			client?.close();
			await server?.stop();
		} finally {
			if (fixtureDir) {
				await rm(fixtureDir, { recursive: true, force: true });
			}
		}
	});

	it("returns an empty aggregate on a fresh server and echoes the requestId", async () => {
		const response = await client.request({ type: "get_project_state" }, "req-empty");

		expect(response.type).toBe("project_state");
		expect(response.requestId).toBe("req-empty");
		const state = response.payload as ProjectStateAggregate;
		expect(state.projects).toEqual([]);
		expect(state.truncated).toBe(false);
		expect(state.sessionCount).toBe(0);
	});

	it("reports a started session under its workspace path with an addressable sessionId", async () => {
		const workspace = tmpdir();
		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace, initialPrompt: "hello" },
			},
			"req-start",
		);
		expect(started.type).toBe("run_started");
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		const response = await client.request({ type: "get_project_state" }, "req-state");
		const state = response.payload as ProjectStateAggregate;

		expect(state.projects).toHaveLength(1);
		expect(state.projects[0]?.path).toBe(workspace);
		expect(state.projects[0]?.sessions).toHaveLength(1);
		expect(state.projects[0]?.sessions[0]?.sessionId).toBe(sessionId);
	});

	it("pushes the aggregate unsolicited after a run starts", async () => {
		await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: tmpdir(), initialPrompt: "hello" },
			},
			"req-start",
		);

		const push = await client.waitFor(
			(msg) => msg.type === "project_state_push",
			"an unsolicited project_state_push",
		);

		const state = push.payload as ProjectStateAggregate;
		expect(push.requestId).toBeUndefined();
		expect(state.projects).toHaveLength(1);
	});

	it("correlates registry CRUD while publishing the sessionless aggregate", async () => {
		const projectPath = join(fixtureDir, "alpha");

		const beforeAdd = client.mark();
		const added = await client.request(
			{ type: "add_project", payload: { name: "Alpha", path: `${projectPath}/./` } },
			"req-add",
		);
		expect(added).toEqual({
			type: "project_registry_result",
			requestId: "req-add",
			payload: { operation: "add", path: projectPath, success: true },
		});

		const addPush = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects[0]?.name === "Alpha",
			"the add project-state push",
			beforeAdd,
		);
		expect(addPush.requestId).toBeUndefined();
		expect((addPush.payload as ProjectStateAggregate).projects).toEqual([
			expect.objectContaining({
				name: "Alpha",
				path: projectPath,
				registered: true,
				sessionCount: 0,
				sessions: [],
			}),
		]);

		const listed = await client.request({ type: "list_projects" }, "req-list");
		expect(listed.type).toBe("project_state");
		expect(listed.requestId).toBe("req-list");
		expect((listed.payload as ProjectStateAggregate).projects).toEqual([
			expect.objectContaining({
				name: "Alpha",
				path: projectPath,
				registered: true,
			}),
		]);

		const beforeRename = client.mark();
		const renamed = await client.request(
			{ type: "rename_project", payload: { path: projectPath, name: "Beta" } },
			"req-rename",
		);
		expect(renamed).toEqual({
			type: "project_registry_result",
			requestId: "req-rename",
			payload: { operation: "rename", path: projectPath, success: true },
		});

		const renamePush = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects[0]?.name === "Beta",
			"the rename project-state push",
			beforeRename,
		);
		expect(renamePush.requestId).toBeUndefined();
		expect((renamePush.payload as ProjectStateAggregate).projects[0]).toEqual(
			expect.objectContaining({
				name: "Beta",
				path: projectPath,
				registered: true,
				sessionCount: 0,
			}),
		);

		const beforeRemove = client.mark();
		const removed = await client.request(
			{ type: "remove_project", payload: { path: projectPath } },
			"req-remove",
		);
		expect(removed).toEqual({
			type: "project_registry_result",
			requestId: "req-remove",
			payload: { operation: "remove", path: projectPath, success: true },
		});

		const removePush = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects.length === 0,
			"the remove project-state push",
			beforeRemove,
		);
		expect(removePush.requestId).toBeUndefined();
	});

	it("keeps a live session visible as an unregistered project after removal", async () => {
		const projectPath = join(fixtureDir, "registered-workspace");
		await client.request(
			{ type: "add_project", payload: { name: "Registered Workspace", path: projectPath } },
			"req-add",
		);

		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: projectPath, initialPrompt: "hello" },
			},
			"req-start",
		);
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		const registeredResponse = await client.request(
			{ type: "get_project_state" },
			"req-registered",
		);
		const registeredState = registeredResponse.payload as ProjectStateAggregate;
		expect(registeredState.projects).toHaveLength(1);
		expect(registeredState.projects[0]).toEqual(
			expect.objectContaining({
				name: "Registered Workspace",
				path: projectPath,
				registered: true,
				sessionCount: 1,
			}),
		);
		expect(registeredState.projects[0]?.sessions[0]?.sessionId).toBe(sessionId);

		const beforeRemove = client.mark();
		const removed = await client.request(
			{ type: "remove_project", payload: { path: projectPath } },
			"req-remove",
		);
		expect(removed.requestId).toBe("req-remove");

		const fallbackPush = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects[0]?.registered === false,
			"the unregistered fallback push",
			beforeRemove,
		);
		expect(fallbackPush.requestId).toBeUndefined();
		const fallback = (fallbackPush.payload as ProjectStateAggregate).projects[0];
		expect(fallback).toEqual(
			expect.objectContaining({
				name: basename(projectPath),
				path: projectPath,
				registered: false,
				sessionCount: 1,
			}),
		);
		expect(fallback?.sessions[0]?.sessionId).toBe(sessionId);
	}, 30000);

	it("preserves stable registry errors without changing the aggregate", async () => {
		const projectPath = join(fixtureDir, "existing");
		const missingPath = join(fixtureDir, "missing");
		await client.request(
			{ type: "add_project", payload: { name: "Existing", path: projectPath } },
			"req-setup",
		);

		const baseline = await client.request({ type: "list_projects" }, "req-baseline");
		const baselineState = baseline.payload as ProjectStateAggregate;
		const beforeInvalid = client.mark();

		const relative = await client.request(
			{ type: "add_project", payload: { name: "Relative", path: "relative/path" } },
			"req-relative",
		);
		expect(relative).toEqual({
			type: "error",
			requestId: "req-relative",
			payload: {
				message: "Project path must be an absolute path",
				code: "INVALID_PROJECT",
			},
		});

		const duplicate = await client.request(
			{ type: "add_project", payload: { name: "Duplicate", path: projectPath } },
			"req-duplicate",
		);
		expect(duplicate).toEqual({
			type: "error",
			requestId: "req-duplicate",
			payload: {
				message: `Project already exists: ${projectPath}`,
				code: "PROJECT_ALREADY_EXISTS",
			},
		});

		const missingRename = await client.request(
			{ type: "rename_project", payload: { path: missingPath, name: "Missing" } },
			"req-missing-rename",
		);
		expect(missingRename).toEqual({
			type: "error",
			requestId: "req-missing-rename",
			payload: {
				message: `Project not found: ${missingPath}`,
				code: "PROJECT_NOT_FOUND",
			},
		});

		const missingRemove = await client.request(
			{ type: "remove_project", payload: { path: missingPath } },
			"req-missing-remove",
		);
		expect(missingRemove).toEqual({
			type: "error",
			requestId: "req-missing-remove",
			payload: {
				message: `Project not found: ${missingPath}`,
				code: "PROJECT_NOT_FOUND",
			},
		});

		expect(
			client.received.slice(beforeInvalid).filter((msg) => msg.type === "project_state_push"),
		).toEqual([]);

		const final = await client.request({ type: "list_projects" }, "req-final");
		const finalState = final.payload as ProjectStateAggregate;
		expect(finalState.projects).toEqual(baselineState.projects);
		expect(finalState.projectCount).toBe(baselineState.projectCount);
		expect(finalState.sessionCount).toBe(baselineState.sessionCount);
	});

	it("does not push when only lastActivityAt moved", async () => {
		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: tmpdir(), initialPrompt: "hello" },
			},
			"req-start",
		);
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		// Wait for the specific push that says the simulation reached idle. After that
		// the mock's timer chain has stopped, so the server is quiescent and any later
		// push can only have come from what this test does next.
		await client.waitFor(isIdlePush, "the idle push");
		const before = client.pushes().length;

		// send_input to a settled session touches lastActivityAt and changes nothing
		// else, then hits the explicit publishProjectState in the send_input handler.
		// A snapshot comparison would push here; a signature comparison must not.
		await client.request(
			{ type: "send_input", payload: { sessionId, input: "again" } },
			"req-input",
		);
		await settle(400);

		expect(client.pushes()).toHaveLength(before);
	}, 30000);

	it("does not push on session output", async () => {
		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: tmpdir(), initialPrompt: "hello" },
			},
			"req-start",
		);
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		await client.waitFor(isIdlePush, "the idle push");
		const before = client.pushes().length;

		probe(server).emitOutput(sessionId, "another line of output\n");
		await settle(300);

		expect(client.pushes()).toHaveLength(before);
	}, 30000);

	it("bounds a runtime-supplied description before it reaches the aggregate", async () => {
		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: tmpdir(), initialPrompt: "hello" },
			},
			"req-start",
		);
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		// A Bash approval carrying a large heredoc. Unbounded, this is what would push
		// the aggregate past the payload cap.
		probe(server).emitAttention(sessionId, "approval_required", {
			description: "x".repeat(5000),
		});

		const response = await client.request({ type: "get_project_state" }, "req-state");
		const state = response.payload as ProjectStateAggregate;
		const description = state.projects[0]?.sessions[0]?.pending?.description ?? "";

		expect(description.length).toBe(ATTENTION_DESCRIPTION_MAX);
	}, 30000);

	it("pushes when a session becomes blocked and again when the answer clears it", async () => {
		const started = await client.request(
			{
				type: "start_run",
				payload: { profile: "opencode", workspace: tmpdir(), initialPrompt: "hello" },
			},
			"req-start",
		);
		const sessionId = (started.payload as { sessionId: string }).sessionId;

		await client.waitFor(isIdlePush, "the idle push");

		const beforeBlock = client.mark();
		probe(server).emitAttention(sessionId, "approval_required", {
			description: "Run the database migration?",
		});

		const blocked = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects[0]?.attention === "blocked",
			"a push reporting blocked",
			beforeBlock,
		);
		const blockedState = blocked.payload as ProjectStateAggregate;
		expect(blockedState.blockedProjectCount).toBe(1);
		expect(blockedState.blockedSessionCount).toBe(1);
		expect(blockedState.projects[0]?.sessions[0]?.pending?.description).toBe(
			"Run the database migration?",
		);

		const beforeAnswer = client.mark();
		await client.request({ type: "send_input", payload: { sessionId, input: "y" } }, "req-answer");

		const cleared = await client.waitFor(
			(msg) =>
				msg.type === "project_state_push" &&
				(msg.payload as ProjectStateAggregate).projects[0]?.attention !== "blocked",
			"a push reporting the block cleared",
			beforeAnswer,
		);
		const clearedState = cleared.payload as ProjectStateAggregate;
		expect(clearedState.blockedProjectCount).toBe(0);
		expect(clearedState.blockedSessionCount).toBe(0);
		expect(clearedState.projects[0]?.sessions[0]?.pending).toBeNull();
	}, 30000);
});
