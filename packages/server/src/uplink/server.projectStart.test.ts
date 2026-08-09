import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProjectStartState, RunOptions, RunResult } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { EventBus } from "./events.js";
import { BaseExecutor } from "./executor.js";
import { ClaudeExecutor } from "./executors/claude.js";
import { CodexExecutor } from "./executors/codex.js";
import { ProjectRegistry } from "./projectRegistry.js";
import { UplinkServer } from "./server.js";
import type { SessionManager } from "./session.js";
import type { Session } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);

interface UplinkMessage {
	type: string;
	requestId?: string;
	payload?: unknown;
}

class TestClient {
	private readonly messages: UplinkMessage[] = [];
	private readonly messageWaiters = new Set<{
		predicate: (message: UplinkMessage) => boolean;
		resolve: (message: UplinkMessage) => void;
		reject: (error: Error) => void;
		timeout: NodeJS.Timeout;
	}>();
	private readonly waiters = new Map<
		string,
		{
			resolve: (message: UplinkMessage) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	>();

	private constructor(private readonly socket: WebSocket) {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as UplinkMessage;
			this.messages.push(message);
			for (const waiter of this.messageWaiters) {
				if (!waiter.predicate(message)) continue;
				clearTimeout(waiter.timeout);
				this.messageWaiters.delete(waiter);
				waiter.resolve(message);
			}
			if (message.requestId) {
				const waiter = this.waiters.get(message.requestId);
				if (waiter) {
					clearTimeout(waiter.timeout);
					waiter.resolve(message);
					this.waiters.delete(message.requestId);
				}
			}
		});
		socket.on("close", () => {
			for (const waiter of this.messageWaiters) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error("Socket closed before matching uplink message"));
			}
			this.messageWaiters.clear();
			for (const [requestId, waiter] of this.waiters) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error(`Socket closed before response for ${requestId}`));
			}
			this.waiters.clear();
		});
	}

	waitForMessage(predicate: (message: UplinkMessage) => boolean): Promise<UplinkMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolvePromise, reject) => {
			const waiter = {
				predicate,
				resolve: resolvePromise,
				reject,
				timeout: setTimeout(() => {
					this.messageWaiters.delete(waiter);
					reject(new Error("Timed out waiting for matching uplink message"));
				}, 5_000),
			};
			this.messageWaiters.add(waiter);
		});
	}

	static async connect(port: number): Promise<TestClient> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise<void>((resolvePromise, reject) => {
			socket.once("open", () => resolvePromise());
			socket.once("error", reject);
		});
		return new TestClient(socket);
	}

	request(command: Record<string, unknown>, requestId: string): Promise<UplinkMessage> {
		return new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(requestId);
				reject(new Error(`Timed out waiting for ${requestId}`));
			}, 20_000);
			this.waiters.set(requestId, { resolve: resolvePromise, reject, timeout });
			try {
				this.socket.send(JSON.stringify({ ...command, requestId }));
			} catch (error) {
				clearTimeout(timeout);
				this.waiters.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolvePromise) => {
			this.socket.once("close", () => resolvePromise());
			this.socket.close();
		});
	}
}

class ControlledExecutor extends BaseExecutor {
	readonly type = "codex" as const;
	starts = 0;
	inputs = 0;
	/** Identity the base executor handed to runtime-specific code, in order. */
	readonly started: Array<{ sessionId: string; runId: string; workspaceId: string }> = [];
	private nextGate:
		| { entered: () => void; released: Promise<void>; release: () => void }
		| undefined;

	holdNextStart(): { entered: Promise<void>; release: () => void } {
		let enter: (() => void) | undefined;
		let releasePromise: (() => void) | undefined;
		const entered = new Promise<void>((resolvePromise) => {
			enter = resolvePromise;
		});
		const released = new Promise<void>((resolvePromise) => {
			releasePromise = resolvePromise;
		});
		let releasedAlready = false;
		const release = (): void => {
			if (releasedAlready) return;
			releasedAlready = true;
			releasePromise?.();
		};
		this.nextGate = {
			entered: () => enter?.(),
			released,
			release,
		};
		return { entered, release };
	}

	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const gate = this.nextGate;
		this.nextGate = undefined;
		gate?.entered();
		if (gate) await gate.released;
		this.starts++;
		this.started.push({
			sessionId: session.id,
			runId: session.runId,
			workspaceId: session.workspace.id,
		});
		if (options.initialPrompt === "fail launch") throw new Error("Controlled launch failure");
	}

	protected async doSendInput(_session: Session, _input: string): Promise<void> {
		this.inputs++;
	}

	protected async doStop(_session: Session): Promise<void> {}
}

interface ServerInternals {
	workspaceManager: WorkspaceManager;
	sessionManager: SessionManager;
	eventBus: EventBus;
}

function reserveFreePort(): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Failed to reserve port")));
				return;
			}
			server.close(() => resolvePromise(address.port));
		});
	});
}

describe("UplinkServer project-folder starts", { timeout: 30_000 }, () => {
	let fixtureRoot: string;
	let project: string;
	let plainProject: string;
	let journalPath: string;
	let port: number;
	let server: UplinkServer;
	let client: TestClient;
	let controlled: ControlledExecutor;

	beforeEach(async () => {
		fixtureRoot = await mkdtemp(join(tmpdir(), "uplink-project-start-test-"));
		project = join(fixtureRoot, "project");
		plainProject = join(fixtureRoot, "plain");
		journalPath = join(fixtureRoot, "machine", "operations.json");
		await mkdir(project);
		await mkdir(plainProject);
		await git(project, ["init", "-b", "main"]);
		await git(project, ["config", "user.name", "Codemote Test"]);
		await git(project, ["config", "user.email", "codemote@example.invalid"]);
		await git(project, ["config", "commit.gpgsign", "false"]);
		await writeFile(join(project, "tracked.txt"), "committed\n", "utf8");
		await git(project, ["add", "tracked.txt"]);
		await git(project, ["commit", "--no-gpg-sign", "-m", "fixture"]);

		const registryPath = join(fixtureRoot, "machine", "projects.json");
		const registry = new ProjectRegistry(registryPath);
		registry.add("Git Project", project);
		registry.add("Plain Project", plainProject);
		port = await reserveFreePort();
		server = new UplinkServer({
			port,
			host: "127.0.0.1",
			repoPath: fixtureRoot,
			runtimes: [],
			projectRegistryPath: registryPath,
			projectStartJournalPath: journalPath,
			managedWorktreeRoot: join(fixtureRoot, "managed"),
		});
		const internals = server as unknown as ServerInternals;
		controlled = new ControlledExecutor(
			internals.workspaceManager,
			internals.sessionManager,
			internals.eventBus,
		);
		server.registerExecutor(controlled);
		await server.start();
		client = await TestClient.connect(port);
	});

	afterEach(async () => {
		await client?.close();
		await server?.stop();
		await rm(fixtureRoot, { recursive: true, force: true });
	});

	async function git(cwd: string, args: string[]): Promise<string> {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		});
		return result.stdout.trim();
	}

	async function createFakeGitFixture(): Promise<{
		bin: string;
		pidFile: string;
		realGit: string;
	}> {
		const bin = join(fixtureRoot, "fake-git-bin");
		const pidFile = join(fixtureRoot, "git.pid");
		await mkdir(bin, { recursive: true });
		const realGit = (await execFileAsync("which", ["git"], { encoding: "utf8" })).stdout.trim();
		await writeFile(
			join(bin, "git"),
			[
				"#!/bin/sh",
				'if [ "$CODEMOTE_TEST_BLOCK_GIT" = "1" ]; then',
				'\tprintf "%s" "$$" > "$CODEMOTE_TEST_GIT_PID_FILE"',
				'\tchild=""',
				'\tcleanup() { if [ -n "$child" ]; then kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; rm -f "$CODEMOTE_TEST_GIT_PID_FILE"; exit 0; }',
				"\ttrap cleanup TERM INT EXIT",
				'\twhile :; do sleep 1 & child="$!"; wait "$child"; child=""; done',
				"fi",
				'exec "$CODEMOTE_TEST_REAL_GIT" "$@"',
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(join(bin, "git"), 0o755);
		return { bin, pidFile, realGit };
	}

	async function waitForFile(path: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				await readFile(path, "utf8");
				return;
			} catch {
				// The fake Git wrapper has not started yet.
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
		throw new Error(`Timed out waiting for ${path}`);
	}

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isPidAlive(pid)) return;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
		throw new Error(`Timed out waiting for PID ${pid} to exit`);
	}

	async function cleanupFixturePid(pid: number): Promise<void> {
		if (!isPidAlive(pid)) return;
		process.kill(pid, "SIGTERM");
		try {
			await waitForPidGone(pid, 250);
			return;
		} catch {
			// Escalate only the exact fixture PID when cooperative cleanup fails.
		}
		if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
		await waitForPidGone(pid);
	}

	function readJournal(): { version: number; operations: Array<Record<string, unknown>> } {
		return JSON.parse(readFileSync(journalPath, "utf8")) as {
			version: number;
			operations: Array<Record<string, unknown>>;
		};
	}

	async function waitForJournalPhase(
		operationId: string,
		phase: string,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				const operation = readJournal().operations.find(
					(candidate) => candidate["operationId"] === operationId,
				);
				if (operation?.["phase"] === phase) return operation;
			} catch {
				// The first durable write may not have happened yet.
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
		throw new Error(`Timed out waiting for ${operationId} to reach ${phase}`);
	}

	/**
	 * Leave the journal at the durable state an interruption at `phase` would
	 * have produced, dropping what that phase could not yet have recorded.
	 */
	function rewindTo(operationId: string, phase: string): Record<string, unknown> {
		const file = readJournal();
		let rewound: Record<string, unknown> | undefined;
		file.operations = file.operations.map((operation) => {
			if (operation["operationId"] !== operationId) return operation;
			const { result: _result, ...rest } = operation;
			rewound = { ...rest, phase };
			return rewound;
		});
		if (!rewound) throw new Error(`Operation not found in journal: ${operationId}`);
		writeFileSync(journalPath, JSON.stringify(file), "utf8");
		return rewound;
	}

	/**
	 * Replace the running service with a new one over the same fixture-owned
	 * registry, journal and managed root: a service restart, not a new machine.
	 */
	async function restartServer(
		options: { stopExisting?: boolean } = {},
	): Promise<{ client: TestClient; executor: ControlledExecutor }> {
		await client.close();
		if (options.stopExisting !== false) await server.stop();
		port = await reserveFreePort();
		server = new UplinkServer({
			port,
			host: "127.0.0.1",
			repoPath: fixtureRoot,
			runtimes: [],
			projectRegistryPath: join(fixtureRoot, "machine", "projects.json"),
			projectStartJournalPath: journalPath,
			managedWorktreeRoot: join(fixtureRoot, "managed"),
		});
		const internals = server as unknown as ServerInternals;
		controlled = new ControlledExecutor(
			internals.workspaceManager,
			internals.sessionManager,
			internals.eventBus,
		);
		server.registerExecutor(controlled);
		await server.start();
		client = await TestClient.connect(port);
		return { client, executor: controlled };
	}

	async function state(path = project): Promise<ProjectStartState> {
		const response = await client.request(
			{ type: "get_project_start_state", payload: { projectPath: path } },
			`state-${path === project ? "git" : "plain"}`,
		);
		expect(response.type).toBe("project_start_state");
		return response.payload as ProjectStartState;
	}

	async function waitForSession(
		sessionId: string,
		predicate: (session: Session) => boolean,
	): Promise<Session> {
		let response = await client.request({ type: "list_sessions" }, `wait-session-${sessionId}-0`);
		let session = (response.payload as Session[]).find((candidate) => candidate.id === sessionId);
		if (session && predicate(session)) return session;
		await client.waitForMessage((message) => {
			if (message.type !== "event") return false;
			const event = message.payload as
				| { type?: string; sessionId?: string; payload?: { status?: string } }
				| undefined;
			return (
				event?.type === "session.status" &&
				event.sessionId === sessionId &&
				event.payload?.status === "idle"
			);
		});
		response = await client.request({ type: "list_sessions" }, `wait-session-${sessionId}-1`);
		session = (response.payload as Session[]).find((candidate) => candidate.id === sessionId);
		if (session && predicate(session)) return session;
		throw new Error(`Timed out waiting for session ${sessionId}`);
	}

	function startPayload(
		operationId: string,
		initialPrompt: string,
		preparation: Record<string, unknown> = { type: "none" },
		path = project,
		profile: "claude" | "codex" = "codex",
	): Record<string, unknown> {
		return {
			profile,
			workspace: path,
			initialPrompt,
			projectStart: {
				operationId,
				originProjectPath: path,
				mode: "project_folder",
				preparation,
			},
		};
	}

	function worktreeStartPayload(
		operationId: string,
		baseRef: string,
		expectedCommit: string,
		newBranch: string | null = null,
	): Record<string, unknown> {
		return {
			profile: "codex",
			workspace: project,
			initialPrompt: "managed worktree",
			projectStart: {
				operationId,
				originProjectPath: project,
				mode: "worktree",
				preparation: {
					type: "create_worktree",
					baseRef,
					expectedCommit,
					newBranch,
				},
			},
		};
	}

	it("correlates Git and non-Git capability inspection", async () => {
		const gitState = await state();
		expect(gitState.originProjectPath).toBe(project);
		expect(gitState.git?.head).toBe(await git(project, ["rev-parse", "HEAD"]));
		expect(gitState.git?.branch).toBe("main");

		const plainState = await state(plainProject);
		expect(plainState.originProjectPath).toBe(plainProject);
		expect(plainState.git).toBeNull();
	});

	it.skipIf(platform() === "win32")(
		"cancels a blocked start-state inspection when its Uplink connection closes",
		async () => {
			const fake = await createFakeGitFixture();
			const inherited = {
				PATH: process.env["PATH"],
				CODEMOTE_TEST_REAL_GIT: process.env["CODEMOTE_TEST_REAL_GIT"],
				CODEMOTE_TEST_GIT_PID_FILE: process.env["CODEMOTE_TEST_GIT_PID_FILE"],
				CODEMOTE_TEST_BLOCK_GIT: process.env["CODEMOTE_TEST_BLOCK_GIT"],
			};
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			let pid: number | undefined;

			try {
				process.env["PATH"] = `${fake.bin}${delimiter}${inherited.PATH ?? ""}`;
				process.env["CODEMOTE_TEST_REAL_GIT"] = fake.realGit;
				process.env["CODEMOTE_TEST_GIT_PID_FILE"] = fake.pidFile;
				process.env["CODEMOTE_TEST_BLOCK_GIT"] = "1";
				const pending = client.request(
					{ type: "get_project_start_state", payload: { projectPath: project } },
					"disconnect-inspection",
				);
				await waitForFile(fake.pidFile);
				pid = Number(await readFile(fake.pidFile, "utf8"));
				const closed = expect(pending).rejects.toThrow("Socket closed before response");
				await client.close();
				await closed;
				if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid fake Git PID");
				await waitForPidGone(pid);
				expect(
					errorLog.mock.calls.some(([message]) => message === "Uplink WS command failed:"),
				).toBe(false);
			} finally {
				if (pid !== undefined) await cleanupFixturePid(pid);
				errorLog.mockRestore();
				for (const [key, value] of Object.entries(inherited)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}

			client = await TestClient.connect(port);
			const pong = await client.request({ type: "ping" }, "after-inspection-disconnect");
			expect(pong.type).toBe("pong");
		},
	);

	it("keeps an accepted durable Start alive after response loss and replays one result", async () => {
		const current = await state();
		const base = current.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const payload = worktreeStartPayload("response-loss", base.ref, base.commit);
		const gate = controlled.holdNextStart();
		const pending = client.request({ type: "start_run", payload }, "response-loss");
		const closed = expect(pending).rejects.toThrow("Socket closed before response");

		try {
			await gate.entered;
			await client.close();
			await closed;
		} finally {
			gate.release();
		}

		await waitForJournalPhase("response-loss", "session_started");
		client = await TestClient.connect(port);
		const replay = await client.request({ type: "start_run", payload }, "response-loss-replay");
		expect(replay.type).toBe("run_started");
		expect(controlled.starts).toBe(1);
		expect(readJournal().operations).toHaveLength(1);
		expect((server as unknown as ServerInternals).sessionManager.list()).toHaveLength(1);
		const result = replay.payload as RunResult;
		const execution = result.execution;
		if (!execution || execution.mode !== "worktree")
			throw new Error("Expected managed worktree result");
		const worktreePath = execution.worktree.path;
		const worktrees = await git(project, ["worktree", "list", "--porcelain"]);
		expect(
			worktrees.split("\n").filter((line) => line === `worktree ${worktreePath}`),
		).toHaveLength(1);
	});

	it("starts one managed worktree beneath the configured root and continues it by session ID", async () => {
		const current = await state();
		const base = current.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const started = await client.request(
			{ type: "start_run", payload: worktreeStartPayload("worktree-start", base.ref, base.commit) },
			"worktree-start",
		);
		expect(started.type).toBe("run_started");
		const result = started.payload as RunResult;
		if (result.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		expect(await realpath(dirname(result.execution.worktree.path))).toBe(
			await realpath(join(fixtureRoot, "managed")),
		);
		expect(result.execution.directory).toBe(result.execution.worktree.path);
		expect(result.execution.git.detached).toBe(true);
		expect(await git(project, ["branch", "--show-current"])).toBe("main");
		expect(controlled.starts).toBe(1);

		const input = await client.request(
			{ type: "send_input", payload: { sessionId: result.sessionId, input: "continue" } },
			"worktree-input",
		);
		expect(input.type).toBe("input_sent");
		expect(controlled.inputs).toBe(1);
		expect(controlled.starts).toBe(1);
	});

	it("creates a branch, returns effective state, replays success, and sends input without preparation", async () => {
		const current = await state();
		const preparation = {
			type: "create_branch",
			newBranch: "feature/uplink",
			expectedHead: current.git?.head,
			expectedBranch: current.git?.branch,
		};
		const payload = startPayload("branch-start", "branch", preparation);
		const first = await client.request({ type: "start_run", payload }, "branch-first");
		const firstResult = first.payload as RunResult;

		expect(first.type).toBe("run_started");
		expect(firstResult.execution?.git?.branch).toBe("feature/uplink");
		expect(await git(project, ["branch", "--show-current"])).toBe("feature/uplink");
		expect(controlled.starts).toBe(1);

		const replay = await client.request({ type: "start_run", payload }, "branch-replay");
		expect(replay.payload).toEqual(first.payload);
		expect(controlled.starts).toBe(1);

		const input = await client.request(
			{
				type: "send_input",
				payload: { sessionId: firstResult.sessionId, input: "continue" },
			},
			"send-input",
		);
		expect(input.type).toBe("input_sent");
		expect(controlled.inputs).toBe(1);
		expect(controlled.starts).toBe(1);

		const aggregate = await client.request({ type: "get_project_state" }, "project-state");
		const projected = aggregate.payload as {
			projects: Array<{
				id: string;
				sessions: Array<{ originProjectPath?: string; execution?: { directory: string } }>;
			}>;
		};
		expect(projected.projects[0]?.id).toBe(project);
		expect(projected.projects[0]?.sessions[0]?.originProjectPath).toBe(project);
		expect(projected.projects[0]?.sessions[0]?.execution?.directory).toBe(project);

		const file = JSON.parse(await readFile(journalPath, "utf8")) as { operations: unknown[] };
		expect(file.operations).toHaveLength(1);
	});

	it("preserves structured retained branch state and replays launch failure", async () => {
		const current = await state();
		const payload = startPayload("retained-start", "fail launch", {
			type: "create_branch",
			newBranch: "feature/retained-uplink",
			expectedHead: current.git?.head,
			expectedBranch: current.git?.branch,
		});
		const first = await client.request({ type: "start_run", payload }, "retained-first");
		const firstPayload = first.payload as {
			code: string;
			message: string;
			details?: { retainedBranch?: string; createdSessionId?: string };
		};

		expect(first.type).toBe("error");
		expect(firstPayload.code).toBe("RUNTIME_LAUNCH_FAILED");
		expect(firstPayload.message).toBe("Controlled launch failure");
		expect(firstPayload.details?.retainedBranch).toBe("feature/retained-uplink");
		expect(firstPayload.details?.createdSessionId).toBeDefined();
		expect(await git(project, ["branch", "--show-current"])).toBe("feature/retained-uplink");

		const replay = await client.request({ type: "start_run", payload }, "retained-replay");
		expect(replay.type).toBe("error");
		expect(replay.payload).toEqual(first.payload);
		expect(controlled.starts).toBe(1);
	});

	it.skipIf(platform() === "win32")(
		"retains prepared branches when actual Claude and Codex binaries cannot spawn",
		async () => {
			const internals = server as unknown as ServerInternals;
			server.registerExecutor(
				new ClaudeExecutor(
					internals.workspaceManager,
					internals.sessionManager,
					internals.eventBus,
					{
						claudePath: join(fixtureRoot, "missing-claude"),
					},
				),
			);
			const unexecutableCodex = join(fixtureRoot, "unexecutable-codex");
			await writeFile(unexecutableCodex, "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(unexecutableCodex, 0o644);
			server.registerExecutor(
				new CodexExecutor(
					internals.workspaceManager,
					internals.sessionManager,
					internals.eventBus,
					{
						codexPath: unexecutableCodex,
					},
				),
			);

			const claudeState = await state();
			const claudeResponse = await client.request(
				{
					type: "start_run",
					payload: startPayload(
						"actual-claude-missing",
						"start Claude",
						{
							type: "create_branch",
							newBranch: "feature/missing-claude",
							expectedHead: claudeState.git?.head,
							expectedBranch: claudeState.git?.branch,
						},
						project,
						"claude",
					),
				},
				"actual-claude-missing",
			);
			expect(claudeResponse.type).toBe("error");
			expect(claudeResponse.payload).toMatchObject({
				code: "RUNTIME_LAUNCH_FAILED",
				details: {
					phase: "retained",
					retainedBranch: "feature/missing-claude",
				},
			});
			expect(await git(project, ["branch", "--show-current"])).toBe("feature/missing-claude");

			const codexState = await state();
			const codexResponse = await client.request(
				{
					type: "start_run",
					payload: startPayload(
						"actual-codex-unexecutable",
						"start Codex",
						{
							type: "create_branch",
							newBranch: "feature/unexecutable-codex",
							expectedHead: codexState.git?.head,
							expectedBranch: codexState.git?.branch,
						},
						project,
						"codex",
					),
				},
				"actual-codex-unexecutable",
			);
			expect(codexResponse.type).toBe("error");
			expect(codexResponse.payload).toMatchObject({
				code: "RUNTIME_LAUNCH_FAILED",
				details: {
					phase: "retained",
					retainedBranch: "feature/unexecutable-codex",
				},
			});
			expect(await git(project, ["branch", "--show-current"])).toBe("feature/unexecutable-codex");

			const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
				operations: Array<{ operationId: string; phase: string; failure?: { code: string } }>;
			};
			expect(journal.operations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						operationId: "actual-claude-missing",
						phase: "retained",
						failure: expect.objectContaining({ code: "RUNTIME_LAUNCH_FAILED" }),
					}),
					expect.objectContaining({
						operationId: "actual-codex-unexecutable",
						phase: "retained",
						failure: expect.objectContaining({ code: "RUNTIME_LAUNCH_FAILED" }),
					}),
				]),
			);
		},
	);

	it("starts with an unreadable journal, fails Project-start closed, and serves everything else", async () => {
		await mkdir(join(fixtureRoot, "machine"), { recursive: true });
		await writeFile(journalPath, "{ invalid", "utf8");
		const headBefore = await git(project, ["rev-parse", "HEAD"]);

		const { client: restartedClient } = await restartServer();

		const inspection = await restartedClient.request(
			{ type: "get_project_start_state", payload: { projectPath: project } },
			"corrupt-journal",
		);
		expect(inspection.type).toBe("error");
		expect(inspection.payload).toEqual({
			code: "INVALID_PROJECT_START_JOURNAL",
			message: "Invalid project start operation journal",
		});

		const start = await restartedClient.request(
			{ type: "start_run", payload: startPayload("corrupt-journal-start", "start") },
			"corrupt-journal-start",
		);
		expect(start.type).toBe("error");
		expect((start.payload as { code: string }).code).toBe("INVALID_PROJECT_START_JOURNAL");
		expect(controlled.starts).toBe(0);

		// Unrelated capability is unaffected by an unusable Project-start journal.
		expect((await restartedClient.request({ type: "ping" }, "corrupt-ping")).type).toBe("pong");
		expect(
			(await restartedClient.request({ type: "list_sessions" }, "corrupt-sessions")).type,
		).toBe("sessions");
		expect(await readFile(journalPath, "utf8")).toBe("{ invalid");
		expect(await git(project, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(await git(project, ["branch", "--show-current"])).toBe("main");
	});

	it("replays a completed branch start after restart and keeps the session discoverable", async () => {
		const current = await state();
		const payload = startPayload("restart-branch", "branch", {
			type: "create_branch",
			newBranch: "feature/restart-branch",
			expectedHead: current.git?.head,
			expectedBranch: current.git?.branch,
		});
		const first = await client.request({ type: "start_run", payload }, "restart-branch-first");
		const firstResult = first.payload as RunResult;
		expect(first.type).toBe("run_started");

		const { client: restartedClient, executor } = await restartServer();

		const replay = await restartedClient.request(
			{ type: "start_run", payload },
			"restart-branch-replay",
		);
		expect(replay.type).toBe("run_started");
		expect(replay.payload).toEqual(firstResult);
		expect(executor.starts).toBe(0);

		const sessions = (
			await restartedClient.request({ type: "list_sessions" }, "restart-branch-sessions")
		).payload as Session[];
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(firstResult.sessionId);
		expect(sessions[0]?.status).toBe("ended");
		expect(sessions[0]?.originProjectPath).toBe(project);
		expect(sessions[0]?.execution?.directory).toBe(project);

		const aggregate = await restartedClient.request(
			{ type: "get_project_state" },
			"restart-branch-state",
		);
		const projected = aggregate.payload as {
			projects: Array<{
				id: string;
				sessions: Array<{ sessionId: string; execution?: { directory: string } }>;
			}>;
		};
		expect(projected.projects[0]?.id).toBe(project);
		expect(projected.projects[0]?.sessions[0]?.sessionId).toBe(firstResult.sessionId);
		expect(projected.projects[0]?.sessions[0]?.execution?.directory).toBe(project);
		expect(await git(project, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
			"refs/heads/feature/restart-branch\nrefs/heads/main",
		);
	});

	it("replays a completed worktree start after restart without a second worktree", async () => {
		const current = await state();
		const base = current.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const payload = worktreeStartPayload(
			"restart-worktree",
			base.ref,
			base.commit,
			"feature/restart-worktree",
		);
		const first = await client.request({ type: "start_run", payload }, "restart-worktree-first");
		const firstResult = first.payload as RunResult;
		if (firstResult.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		const destination = firstResult.execution.worktree.path;

		const { client: restartedClient, executor } = await restartServer();

		const replay = await restartedClient.request(
			{ type: "start_run", payload },
			"restart-worktree-replay",
		);
		expect(replay.type).toBe("run_started");
		expect(replay.payload).toEqual(firstResult);
		expect(executor.starts).toBe(0);

		const registrations = (await git(project, ["worktree", "list", "--porcelain"]))
			.split("\n")
			.filter((line) => line === `worktree ${destination}`);
		expect(registrations).toHaveLength(1);
		const sessions = (
			await restartedClient.request({ type: "list_sessions" }, "restart-worktree-sessions")
		).payload as Session[];
		expect(sessions[0]?.execution?.directory).toBe(firstResult.execution.directory);
		expect(sessions[0]?.originProjectPath).toBe(project);
		expect(await git(project, ["branch", "--show-current"])).toBe("main");
	});

	it.skipIf(platform() === "win32")(
		"recovers one live Claude worktree session for one follow-up after restart",
		async () => {
			const invocationLog = join(fixtureRoot, "claude-invocations.log");
			const inputLog = join(fixtureRoot, "claude-inputs.log");
			const claudePath = join(fixtureRoot, "mock-claude-resume");
			await writeFile(
				claudePath,
				[
					"#!/bin/sh",
					`printf '%s|%s\\n' "$PWD" "$*" >> "${invocationLog}"`,
					"while IFS= read -r line; do",
					`	printf '%s\\n' "$line" >> "${inputLog}"`,
					`	printf '%s\\n' '{"type":"session_start","session_id":"claude-runtime-1"}'`,
					`	printf '%s\\n' '{"type":"result","session_id":"claude-runtime-1","result":"done"}'`,
					"done",
					"",
				].join("\n"),
				"utf8",
			);
			await chmod(claudePath, 0o755);

			const current = await state();
			const base = current.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
			if (!base) throw new Error("Expected local main base");
			const payload = worktreeStartPayload(
				"restart-live-claude",
				base.ref,
				base.commit,
				"feature/restart-live-claude",
			);
			payload["profile"] = "claude";

			const firstInternals = server as unknown as ServerInternals;
			server.registerExecutor(
				new ClaudeExecutor(
					firstInternals.workspaceManager,
					firstInternals.sessionManager,
					firstInternals.eventBus,
					{ claudePath },
				),
			);
			const started = await client.request(
				{ type: "start_run", payload },
				"restart-live-claude-start",
			);
			const result = started.payload as RunResult;
			if (result.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
			const original = await waitForSession(
				result.sessionId,
				(session) => session.status === "idle" && session.runtimeSessionId === "claude-runtime-1",
			);
			expect(original.workspace.workingDir).toBe(result.execution.directory);

			await client.close();
			await server.stop();
			port = await reserveFreePort();
			server = new UplinkServer({
				port,
				host: "127.0.0.1",
				repoPath: fixtureRoot,
				runtimes: [],
				projectRegistryPath: join(fixtureRoot, "machine", "projects.json"),
				projectStartJournalPath: journalPath,
				managedWorktreeRoot: join(fixtureRoot, "managed"),
			});
			const restartedInternals = server as unknown as ServerInternals;
			server.registerExecutor(
				new ClaudeExecutor(
					restartedInternals.workspaceManager,
					restartedInternals.sessionManager,
					restartedInternals.eventBus,
					{ claudePath },
				),
			);
			await server.start();
			client = await TestClient.connect(port);

			const recovered = await waitForSession(
				result.sessionId,
				(session) => session.status === "idle",
			);
			expect(recovered).toMatchObject({
				id: result.sessionId,
				runId: original.runId,
				runtimeSessionId: "claude-runtime-1",
				originProjectPath: project,
			});
			expect(recovered.workspace).toMatchObject({
				id: original.workspace.id,
				workingDir: result.execution.directory,
			});
			expect((await readFile(invocationLog, "utf8")).trim().split("\n")).toHaveLength(1);

			const followedUp = await client.request(
				{ type: "send_input", payload: { sessionId: result.sessionId, input: "continue" } },
				"restart-live-claude-follow-up",
			);
			expect(followedUp.type).toBe("input_sent");
			await waitForSession(result.sessionId, (session) => session.status === "idle");

			const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n");
			expect(invocations).toHaveLength(2);
			expect(invocations[1]).toContain(`${result.execution.directory}|`);
			expect(invocations[1]).toContain("--resume claude-runtime-1");
			const inputs = (await readFile(inputLog, "utf8")).trim().split("\n");
			expect(inputs).toHaveLength(2);
			expect(inputs[1]).toContain("continue");

			const sessions = (
				await client.request({ type: "list_sessions" }, "restart-live-claude-sessions")
			).payload as Session[];
			expect(sessions).toHaveLength(1);
			const operationJournal = readJournal();
			expect(operationJournal.operations).toHaveLength(1);
			const registrations = (await git(project, ["worktree", "list", "--porcelain"]))
				.split("\n")
				.filter((line) => line === `worktree ${result.execution?.directory}`);
			expect(registrations).toHaveLength(1);
		},
	);

	it("relaunches a recorded session through the real executor exactly once after restart", async () => {
		const payload = startPayload(
			"session-recorded-restart",
			"prepared",
			{ type: "none" },
			plainProject,
		);
		const first = await client.request({ type: "start_run", payload }, "session-recorded-first");
		const firstResult = first.payload as RunResult;
		expect(first.type).toBe("run_started");

		// Rewind to the boundary where the session identity was durable but the
		// runtime call had not been made, exactly as an interruption leaves it.
		await server.stop();
		const recorded = rewindTo("session-recorded-restart", "session_recorded");
		const durable = recorded["session"] as {
			sessionId: string;
			runId: string;
			workspaceId: string;
		};
		expect(durable.sessionId).toBe(firstResult.sessionId);

		const { client: restartedClient, executor } = await restartServer({ stopExisting: false });
		const resumed = await restartedClient.request(
			{ type: "start_run", payload },
			"session-recorded-resume",
		);

		expect(resumed.type).toBe("run_started");
		const resumedResult = resumed.payload as RunResult;
		expect(resumedResult.sessionId).toBe(durable.sessionId);
		expect(resumedResult.runId).toBe(durable.runId);
		// The base executor reused the recorded identity rather than allocating a
		// new one, and entered runtime code exactly once.
		expect(executor.starts).toBe(1);
		expect(executor.started).toEqual([
			{
				sessionId: durable.sessionId,
				runId: durable.runId,
				workspaceId: durable.workspaceId,
			},
		]);

		const sessions = (
			await restartedClient.request({ type: "list_sessions" }, "session-recorded-sessions")
		).payload as Session[];
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(durable.sessionId);
		expect(sessions[0]?.workspace.id).toBe(durable.workspaceId);

		// Both durable callbacks were crossed in order: the journal's own
		// transition rules admit `session_started` only by way of
		// `runtime_launch_requested`, which in turn requires `session_recorded`.
		const journal = readJournal();
		expect(journal.operations).toHaveLength(1);
		expect(journal.operations[0]?.["phase"]).toBe("session_started");
		expect(journal.operations[0]?.["session"]).toMatchObject(durable);
	});

	it("discards the session when a durable launch boundary cannot be written", async () => {
		const payload = startPayload(
			"boundary-write-failure",
			"prepared",
			{ type: "none" },
			plainProject,
		);
		await client.request({ type: "start_run", payload }, "boundary-first");

		await server.stop();
		rewindTo("boundary-write-failure", "session_recorded");
		const { client: restartedClient, executor } = await restartServer({ stopExisting: false });
		// Make the next journal write fail while the executor is mid-launch.
		await mkdir(`${journalPath}.tmp`, { recursive: true });

		const response = await restartedClient.request(
			{ type: "start_run", payload },
			"boundary-write-failure",
		);

		expect(response.type).toBe("error");
		expect((response.payload as { code: string }).code).toBe("PROJECT_START_JOURNAL_IO");
		// Runtime code never ran, and no phantom session was left discoverable.
		expect(executor.starts).toBe(0);
		const sessions = (
			await restartedClient.request({ type: "list_sessions" }, "boundary-write-sessions")
		).payload as Session[];
		expect(sessions).toHaveLength(0);
	});

	it("retains a worktree whose runtime launch may already have started, across restart", async () => {
		const current = await state();
		const base = current.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const payload = worktreeStartPayload("restart-ambiguous", base.ref, base.commit);
		const started = await client.request({ type: "start_run", payload }, "restart-ambiguous-first");
		const result = started.payload as RunResult;
		if (result.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");

		// Rewind to the boundary where the runtime call may or may not have run.
		await server.stop();
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			version: number;
			operations: Array<Record<string, unknown>>;
		};
		journal.operations = journal.operations.map((operation) => {
			if (operation["operationId"] !== "restart-ambiguous") return operation;
			const { result: _result, ...rest } = operation;
			return { ...rest, phase: "runtime_launch_requested" };
		});
		await writeFile(journalPath, JSON.stringify(journal), "utf8");
		const { client: restartedClient, executor } = await restartServer({ stopExisting: false });

		const replay = await restartedClient.request(
			{ type: "start_run", payload },
			"restart-ambiguous-replay",
		);

		expect(replay.type).toBe("error");
		const failure = replay.payload as {
			code: string;
			details?: { retainedWorktreePath?: string; createdSessionId?: string };
		};
		expect(failure.code).toBe("OPERATION_RETAINED");
		expect(failure.details?.retainedWorktreePath).toBe(result.execution.worktree.path);
		expect(failure.details?.createdSessionId).toBe(result.sessionId);
		expect(executor.starts).toBe(0);
		expect(await realpath(result.execution.worktree.path)).toBeTruthy();
	});

	it("preserves unwritable journal errors with operation phase details over WebSocket", async () => {
		await mkdir(`${journalPath}.tmp`, { recursive: true });

		const response = await client.request(
			{
				type: "start_run",
				payload: startPayload("unwritable-journal", "start without a branch"),
			},
			"unwritable-journal",
		);

		expect(response.type).toBe("error");
		expect(response.payload).toEqual({
			code: "PROJECT_START_JOURNAL_IO",
			message: "Failed to persist project start operation journal",
			details: {
				operationId: "unwritable-journal",
				phase: "recorded",
				originProjectPath: project,
			},
		});
	});
});
