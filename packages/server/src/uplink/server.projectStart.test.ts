import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectStartState, RunOptions, RunResult } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { EventBus } from "./events.js";
import { BaseExecutor } from "./executor.js";
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
	private readonly waiters = new Map<string, (message: UplinkMessage) => void>();

	private constructor(private readonly socket: WebSocket) {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as UplinkMessage;
			this.messages.push(message);
			if (message.requestId) {
				this.waiters.get(message.requestId)?.(message);
				this.waiters.delete(message.requestId);
			}
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
			const timeout = setTimeout(
				() => reject(new Error(`Timed out waiting for ${requestId}`)),
				20_000,
			);
			this.waiters.set(requestId, (message) => {
				clearTimeout(timeout);
				resolvePromise(message);
			});
			this.socket.send(JSON.stringify({ ...command, requestId }));
		});
	}

	close(): void {
		this.socket.close();
	}
}

class ControlledExecutor extends BaseExecutor {
	readonly type = "codex" as const;
	starts = 0;
	inputs = 0;

	protected async doStartRun(_session: Session, options: RunOptions): Promise<void> {
		this.starts++;
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
		const port = await reserveFreePort();
		server = new UplinkServer({
			port,
			host: "127.0.0.1",
			repoPath: fixtureRoot,
			runtimes: [],
			projectRegistryPath: registryPath,
			projectStartJournalPath: journalPath,
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
		client?.close();
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

	async function state(path = project): Promise<ProjectStartState> {
		const response = await client.request(
			{ type: "get_project_start_state", payload: { projectPath: path } },
			`state-${path === project ? "git" : "plain"}`,
		);
		expect(response.type).toBe("project_start_state");
		return response.payload as ProjectStartState;
	}

	function startPayload(
		operationId: string,
		initialPrompt: string,
		preparation: Record<string, unknown> = { type: "none" },
		path = project,
	): Record<string, unknown> {
		return {
			profile: "codex",
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

	it("correlates Git and non-Git capability inspection", async () => {
		const gitState = await state();
		expect(gitState.originProjectPath).toBe(project);
		expect(gitState.git?.head).toBe(await git(project, ["rev-parse", "HEAD"]));
		expect(gitState.git?.branch).toBe("main");

		const plainState = await state(plainProject);
		expect(plainState.originProjectPath).toBe(plainProject);
		expect(plainState.git).toBeNull();
	});

	it("preserves legacy starts and starts project-aware non-Git sessions", async () => {
		const legacy = await client.request(
			{
				type: "start_run",
				payload: { profile: "codex", workspace: project, initialPrompt: "legacy" },
			},
			"legacy-start",
		);
		expect(legacy.type).toBe("run_started");
		expect((legacy.payload as RunResult).operationId).toBeUndefined();

		const projectAware = await client.request(
			{
				type: "start_run",
				payload: startPayload("plain-start", "plain", { type: "none" }, plainProject),
			},
			"plain-start",
		);
		expect(projectAware.type).toBe("run_started");
		expect((projectAware.payload as RunResult).execution?.git).toBeNull();
		expect(controlled.starts).toBe(2);
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
});
