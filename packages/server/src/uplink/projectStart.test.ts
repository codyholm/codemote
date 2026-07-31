import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	ProjectFolderStartPreparation,
	ProjectStartRequest,
	RunOptions,
	RunResult,
} from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorStartError } from "./executor.js";
import { ProjectRegistry } from "./projectRegistry.js";
import { ProjectStartCoordinator, ProjectStartError, runGitCommand } from "./projectStart.js";
import { ProjectStartJournal, type ProjectStartOperationRecord } from "./projectStartJournal.js";
import { SessionManager } from "./session.js";
import type { SessionStartContext } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);

describe("ProjectStartCoordinator", { timeout: 30_000 }, () => {
	let fixtureRoot: string;
	let registry: ProjectRegistry;
	let journal: ProjectStartJournal;
	let sessions: SessionManager;
	let workspaces: WorkspaceManager;

	beforeEach(async () => {
		fixtureRoot = await mkdtemp(join(tmpdir(), "project-start-test-"));
		registry = new ProjectRegistry(join(fixtureRoot, "machine", "projects.json"));
		journal = new ProjectStartJournal(join(fixtureRoot, "machine", "operations.json"));
		sessions = new SessionManager();
		workspaces = new WorkspaceManager(fixtureRoot);
	});

	afterEach(async () => {
		await rm(fixtureRoot, { recursive: true, force: true });
	});

	async function git(cwd: string, args: string[]): Promise<string> {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		});
		return result.stdout.trim();
	}

	async function makeGitProject(name = "project"): Promise<string> {
		const project = join(fixtureRoot, name);
		await mkdir(project, { recursive: true });
		await git(project, ["init", "-b", "main"]);
		await git(project, ["config", "user.name", "Codemote Test"]);
		await git(project, ["config", "user.email", "codemote@example.invalid"]);
		await git(project, ["config", "commit.gpgsign", "false"]);
		await writeFile(join(project, ".gitignore"), "ignored.txt\n", "utf8");
		await writeFile(join(project, "tracked.txt"), "committed\n", "utf8");
		await git(project, ["add", ".gitignore", "tracked.txt"]);
		await git(project, ["commit", "--no-gpg-sign", "-m", "fixture"]);
		registry.add(name, project);
		return resolve(project);
	}

	function coordinator(
		overrides: Partial<ConstructorParameters<typeof ProjectStartCoordinator>[0]> = {},
	): ProjectStartCoordinator {
		return new ProjectStartCoordinator({
			journal,
			registry,
			sessionManager: sessions,
			workspaceManager: workspaces,
			managedWorktreeRoot: join(fixtureRoot, "managed"),
			...overrides,
		});
	}

	function request(
		project: string,
		operationId: string,
		preparation: ProjectFolderStartPreparation = { type: "none" },
		overrides: Partial<RunOptions> = {},
	): RunOptions {
		return {
			profile: "codex",
			workspace: project,
			initialPrompt: "Test the project",
			projectStart: {
				operationId,
				originProjectPath: project,
				mode: "project_folder",
				preparation,
			},
			...overrides,
		};
	}

	/**
	 * Stands in for `BaseExecutor.startRun`: it reuses a recorded session identity
	 * when one is supplied and crosses both durable boundaries in the same order.
	 */
	function launcher(
		manager = sessions,
		onLaunch?: (options: RunOptions, context: SessionStartContext) => void,
	): (options: RunOptions, context: SessionStartContext) => Promise<RunResult> {
		return async (options, context) => {
			onLaunch?.(options, context);
			const recorded = context.launch?.session;
			const workspace = {
				id: recorded?.workspaceId ?? `workspace-${manager.list().length}`,
				workingDir: options.workspace,
				createdAt: 1,
			};
			const session = recorded
				? manager.restore({
						id: recorded.sessionId,
						runId: recorded.runId,
						runtime: options.profile,
						status: "starting",
						workspace,
						startedAt: recorded.createdAt,
						endedAt: null,
						lastActivityAt: Date.now(),
						statusChangedAt: Date.now(),
						originProjectPath: context.originProjectPath,
						execution: context.execution,
					})
				: manager.create(options.profile, workspace, context);
			context.launch?.recordSession(session);
			context.launch?.recordRuntimeLaunchRequested(session);
			return { runId: session.runId, sessionId: session.id };
		};
	}

	function worktreeRequest(
		project: string,
		operationId: string,
		baseRef: string,
		expectedCommit: string,
		newBranch: string | null = null,
	): RunOptions {
		return {
			profile: "codex",
			workspace: project,
			initialPrompt: "Test the managed worktree",
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

	async function expectStartError(
		action: Promise<unknown> | (() => unknown | Promise<unknown>),
		code: ProjectStartError["code"],
	): Promise<ProjectStartError> {
		try {
			if (typeof action === "function") await action();
			else await action;
			throw new Error(`Expected ${code}`);
		} catch (error) {
			expect(error).toBeInstanceOf(ProjectStartError);
			expect((error as ProjectStartError).code).toBe(code);
			return error as ProjectStartError;
		}
	}

	function branchPreparation(
		state: Awaited<ReturnType<ProjectStartCoordinator["inspect"]>>,
		newBranch: string,
	): ProjectFolderStartPreparation {
		if (!state.git?.head) throw new Error("Expected committed Git fixture");
		return {
			type: "create_branch",
			newBranch,
			expectedHead: state.git.head,
			expectedBranch: state.git.branch,
		};
	}

	/**
	 * A runtime that dies before any session exists: the executor never reaches
	 * its session boundary, so the operation owns an unlaunched worktree.
	 */
	function failBeforeSession(
		beforeFailure?: (directory: string) => Promise<void>,
	): (options: RunOptions) => Promise<RunResult> {
		return async (options) => {
			await beforeFailure?.(options.workspace);
			throw new Error("Runtime binary is missing");
		};
	}

	/**
	 * Replace the journal file with the durable state an interruption would have
	 * left, then reload it.
	 *
	 * Written through the file rather than `update()` on purpose: an interruption
	 * leaves an older document behind, it does not perform a backwards phase
	 * transition, and the journal refuses those.
	 */
	function rewriteJournalFile(
		operationId: string,
		mutate: (operation: Record<string, unknown>) => Record<string, unknown>,
	): void {
		const path = join(fixtureRoot, "machine", "operations.json");
		const file = JSON.parse(readFileSync(path, "utf8")) as {
			version: number;
			operations: Array<Record<string, unknown>>;
		};
		file.operations = file.operations.map((operation) =>
			operation["operationId"] === operationId ? mutate(operation) : operation,
		);
		writeFileSync(path, JSON.stringify(file), "utf8");
		journal = new ProjectStartJournal(path);
	}

	/** Put an operation into a durable rollback phase, as an interruption would. */
	function rewriteRollbackPhase(
		operationId: string,
		phase: "rollback_requested" | "worktree_removed",
	): void {
		rewriteJournalFile(operationId, (operation) => {
			const { result: _result, failure: _failure, session: _session, ...rest } = operation;
			return {
				...rest,
				phase,
				updatedAt: Date.now(),
				rollback: {
					requestedAt: Date.now(),
					code: "RUNTIME_LAUNCH_FAILED",
					message: "Runtime failed before any session existed",
				},
			};
		});
	}

	/** How many times a path is registered as a worktree of this repository. */
	async function worktreeRegistrations(repository: string, path: string): Promise<number> {
		const listed = await git(repository, ["worktree", "list", "--porcelain"]);
		return listed.split("\n").filter((line) => line === `worktree ${path}`).length;
	}

	/**
	 * Rewrite the journal exactly as the landed version-1 writer left it: no file
	 * or record version, and none of the payloads that version could not record.
	 */
	function downgradeToVersionOne(): void {
		const path = join(fixtureRoot, "machine", "operations.json");
		const file = JSON.parse(readFileSync(path, "utf8")) as {
			operations: Array<Record<string, unknown>>;
		};
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				operations: file.operations.map(
					({ recordVersion: _recordVersion, session: _session, rollback: _rollback, ...rest }) =>
						rest,
				),
			}),
			"utf8",
		);
		journal = new ProjectStartJournal(path);
	}

	/**
	 * Rewind a completed operation to the durable state an interruption at that
	 * phase would have left, dropping anything the phase could not have recorded.
	 */
	function rewritePhase(operationId: string, phase: ProjectStartOperationRecord["phase"]): void {
		rewriteJournalFile(operationId, (operation) => {
			const {
				result: _result,
				failure: _failure,
				rollback: _rollback,
				session,
				...rest
			} = operation;
			const carriesSession =
				phase === "session_recorded" ||
				phase === "runtime_launch_requested" ||
				phase === "session_started";
			return {
				...rest,
				...(carriesSession && session ? { session } : {}),
				phase,
				updatedAt: Date.now(),
			};
		});
	}

	it("reports registered non-Git and nested Git projects without mutation", async () => {
		const nonGit = join(fixtureRoot, "plain");
		await mkdir(nonGit);
		registry.add("Plain", nonGit);
		const repo = await makeGitProject("repo");
		const nested = join(repo, "packages", "nested");
		await mkdir(nested, { recursive: true });
		registry.add("Nested", nested);
		const service = coordinator();

		expect(await service.inspect(nonGit)).toEqual({
			originProjectPath: nonGit,
			mode: "project_folder",
			directory: nonGit,
			git: null,
			worktree: null,
		});
		const nestedState = await service.inspect(nested);
		expect(nestedState.originProjectPath).toBe(nested);
		expect(nestedState.directory).toBe(nested);
		expect(nestedState.git?.repositoryRoot).toBe(await git(repo, ["rev-parse", "--show-toplevel"]));
		expect(nestedState.git?.branch).toBe("main");
		expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("launches detached and attached managed worktrees with origin and effective truth", async () => {
		const repository = await makeGitProject("worktree-repo");
		const nested = join(repository, "packages", "nested");
		await mkdir(nested, { recursive: true });
		await writeFile(join(nested, "committed.txt"), "nested\n");
		await git(repository, ["add", "."]);
		await git(repository, ["commit", "--no-gpg-sign", "-m", "nested"]);
		registry.add("Nested worktree", nested);
		await writeFile(join(repository, "tracked.txt"), "dirty\n");
		await writeFile(join(repository, "untracked.txt"), "local\n");
		await writeFile(join(repository, "ignored.txt"), "ignored-local\n");
		const sourceHead = await git(repository, ["rev-parse", "HEAD"]);
		const state = await coordinator().inspect(nested);
		const base = state.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const launches: Array<{ options: RunOptions; context: SessionStartContext }> = [];
		const service = coordinator();
		const first = await service.start(
			worktreeRequest(nested, "worktree-detached", base.ref, base.commit),
			launcher(sessions, (options, context) => launches.push({ options, context })),
		);

		expect(first.originProjectPath).toBe(nested);
		expect(first.execution?.mode).toBe("worktree");
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		expect(first.execution.directory).toBe(
			join(first.execution.worktree.path, "packages", "nested"),
		);
		expect(first.execution.git.head).toBe(sourceHead);
		expect(first.execution.git.detached).toBe(true);
		expect(launches[0]?.options.workspace).toBe(first.execution.directory);
		expect(launches[0]?.options.resumeSessionId).toBeUndefined();
		expect(launches[0]?.context.originProjectPath).toBe(nested);
		expect(await git(repository, ["rev-parse", "HEAD"])).toBe(sourceHead);
		expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("dirty\n");
		await expect(
			readFile(join(first.execution.worktree.path, "untracked.txt"), "utf8"),
		).rejects.toThrow();
		await expect(
			readFile(join(first.execution.worktree.path, "ignored.txt"), "utf8"),
		).rejects.toThrow();
		expect(
			await service.start(
				worktreeRequest(nested, "worktree-detached", base.ref, base.commit),
				launcher(),
			),
		).toEqual(first);

		const attached = await service.start(
			worktreeRequest(repository, "worktree-attached", base.ref, base.commit, "feature/managed"),
			launcher(),
		);
		if (attached.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		expect(attached.execution.git.branch).toBe("feature/managed");
		expect(attached.execution.git.detached).toBe(false);
		expect(await git(repository, ["branch", "--show-current"])).toBe("main");
	});

	it("retains a created worktree when mapping or runtime launch fails", async () => {
		const repository = await makeGitProject("retained-worktree-repo");
		const missingNested = join(repository, "packages", "not-committed");
		await mkdir(missingNested, { recursive: true });
		registry.add("Missing nested", missingNested);
		const inspected = await coordinator().inspect(missingNested);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		let launches = 0;
		await expectStartError(
			coordinator().start(
				worktreeRequest(
					repository,
					"worktree-stale-base",
					base.ref,
					"0".repeat(base.commit.length),
				),
				async () => {
					launches += 1;
					throw new Error("must not launch");
				},
			),
			"STALE_WORKTREE_BASE",
		);
		expect(launches).toBe(0);
		const mappingError = await expectStartError(
			coordinator().start(
				worktreeRequest(missingNested, "worktree-mapping-failure", base.ref, base.commit),
				async () => {
					launches += 1;
					throw new Error("must not launch");
				},
			),
			"WORKTREE_PROJECT_PATH_MISSING",
		);
		expect(launches).toBe(0);
		expect(mappingError.details?.retainedWorktreePath).toBeTruthy();
		expect(journal.get("worktree-mapping-failure")?.phase).toBe("retained");

		const launchService = coordinator();
		const launchError = await expectStartError(
			launchService.start(
				worktreeRequest(repository, "worktree-launch-failure", base.ref, base.commit),
				async () => {
					throw new ExecutorStartError("Runtime unavailable", "run-created", "session-created");
				},
			),
			"RUNTIME_LAUNCH_FAILED",
		);
		expect(launchError.details).toMatchObject({
			phase: "retained",
			createdSessionId: "session-created",
		});
		expect(launchError.details?.retainedWorktreePath).toBeTruthy();
	});

	it("resumes an interrupted prepared worktree without creating a second one", async () => {
		const repository = await makeGitProject("interrupted-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(
			repository,
			"worktree-interrupted-ready",
			base.ref,
			base.commit,
			"feature/interrupted",
		);
		const first = await coordinator().start(options, launcher());
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");

		for (const phase of ["worktree_created", "worktree_ready"] as const) {
			rewritePhase("worktree-interrupted-ready", phase);
			const restartedSessions = new SessionManager();
			let launches = 0;

			const resumed = await coordinator({
				sessionManager: restartedSessions,
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(restartedSessions, () => {
					launches++;
				}),
			);

			expect(resumed.execution).toEqual(first.execution);
			expect(launches).toBe(1);
			expect(journal.get("worktree-interrupted-ready")?.phase).toBe("session_started");
			expect(await worktreeRegistrations(repository, first.execution.worktree.path)).toBe(1);
			expect(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
				"refs/heads/feature/interrupted\nrefs/heads/main",
			);
		}
	});

	it("adopts only the exact deterministic worktree when a creation response was lost", async () => {
		const repository = await makeGitProject("adoption-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(repository, "worktree-adopted", base.ref, base.commit);
		const first = await coordinator().start(options, launcher());
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		const destination = first.execution.worktree.path;

		// The worktree exists exactly as recorded, but the phase write was lost.
		rewritePhase("worktree-adopted", "recorded");
		const adoptedSessions = new SessionManager();
		const adopted = await coordinator({
			sessionManager: adoptedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(options, launcher(adoptedSessions));

		expect(adopted.execution).toEqual(first.execution);
		expect(await worktreeRegistrations(repository, destination)).toBe(1);

		// A registration that moved off the recorded commit is not the same worktree.
		await writeFile(join(repository, "tracked.txt"), "moved\n", "utf8");
		await git(repository, ["add", "tracked.txt"]);
		await git(repository, ["commit", "--no-gpg-sign", "-m", "moved"]);
		const movedCommit = await git(repository, ["rev-parse", "HEAD"]);
		await git(destination, ["checkout", "--detach", movedCommit]);
		rewritePhase("worktree-adopted", "recorded");
		let launches = 0;

		const retained = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(new SessionManager(), () => {
					launches++;
				}),
			),
			"OPERATION_RETAINED",
		);

		expect(retained.details?.retainedWorktreePath).toBe(destination);
		expect(launches).toBe(0);
		expect(await worktreeRegistrations(repository, destination)).toBe(1);
	});

	it("retains an unregistered directory or branch-only residue at the recorded destination", async () => {
		const repository = await makeGitProject("residue-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(
			repository,
			"worktree-residue",
			base.ref,
			base.commit,
			"feature/residue",
		);
		const first = await coordinator().start(options, launcher());
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		const destination = first.execution.worktree.path;

		// Registration removed, directory left behind: not ours to reuse or delete.
		await git(repository, ["worktree", "remove", "--force", destination]);
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, "left-behind.txt"), "residue\n", "utf8");
		rewritePhase("worktree-residue", "recorded");

		const unregistered = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(options, launcher(new SessionManager())),
			"OPERATION_RETAINED",
		);
		expect(unregistered.details?.retainedWorktreePath).toBe(destination);
		expect(await readFile(join(destination, "left-behind.txt"), "utf8")).toBe("residue\n");

		// Directory gone, request-owned branch still present: branch-only residue.
		await rm(destination, { recursive: true, force: true });
		rewritePhase("worktree-residue", "recorded");

		const branchOnly = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(options, launcher(new SessionManager())),
			"OPERATION_RETAINED",
		);
		expect(branchOnly.details?.retainedBranch).toBe("feature/residue");
		expect(branchOnly.details?.retainedWorktreePath).toBeUndefined();
		expect(await git(repository, ["rev-parse", "--verify", "refs/heads/feature/residue"])).toBe(
			base.commit,
		);
	});

	it("rolls back an exact clean unlaunched worktree and its request-owned branch", async () => {
		const repository = await makeGitProject("rollback-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const beforeRefs = await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"]);

		const detached = await expectStartError(
			coordinator().start(
				worktreeRequest(repository, "rollback-detached", base.ref, base.commit),
				failBeforeSession(),
			),
			"RUNTIME_LAUNCH_FAILED",
		);

		expect(detached.message).toBe("Runtime binary is missing");
		expect(detached.details).toEqual({
			operationId: "rollback-detached",
			phase: "failed",
			originProjectPath: repository,
		});
		const detachedRecord = journal.get("rollback-detached");
		expect(detachedRecord?.phase).toBe("failed");
		if (detachedRecord?.mode !== "worktree") throw new Error("Expected Worktree record");
		expect(existsSync(detachedRecord.worktree.destination)).toBe(false);
		expect(await worktreeRegistrations(repository, detachedRecord.worktree.destination)).toBe(0);

		const attached = await expectStartError(
			coordinator().start(
				worktreeRequest(
					repository,
					"rollback-attached",
					base.ref,
					base.commit,
					"feature/rolled-back",
				),
				failBeforeSession(),
			),
			"RUNTIME_LAUNCH_FAILED",
		);

		expect(attached.details?.retainedWorktreePath).toBeUndefined();
		expect(attached.details?.retainedBranch).toBeUndefined();
		expect(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
			beforeRefs,
		);
		expect(await git(repository, ["branch", "--show-current"])).toBe("main");
		expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
	});

	it("keeps a worktree that is dirty, ignored-dirty, or otherwise not provably clean", async () => {
		const repository = await makeGitProject("rollback-blocked-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const cases = [
			{ id: "tracked", file: "tracked.txt", contents: "modified in worktree\n" },
			{ id: "untracked", file: "scratch.txt", contents: "untracked\n" },
			{ id: "ignored", file: "ignored.txt", contents: "ignored\n" },
		];

		for (const { id, file, contents } of cases) {
			const failure = await expectStartError(
				coordinator().start(
					worktreeRequest(
						repository,
						`rollback-blocked-${id}`,
						base.ref,
						base.commit,
						`feature/blocked-${id}`,
					),
					failBeforeSession(async (directory) => {
						await writeFile(join(directory, file), contents, "utf8");
					}),
				),
				"RUNTIME_LAUNCH_FAILED",
			);

			const record = journal.get(`rollback-blocked-${id}`);
			if (record?.mode !== "worktree") throw new Error("Expected Worktree record");
			expect(record.phase).toBe("retained");
			expect(failure.details?.retainedWorktreePath).toBe(record.worktree.destination);
			expect(failure.details?.retainedBranch).toBe(`feature/blocked-${id}`);
			expect(failure.message).toContain("Runtime binary is missing");
			expect(await readFile(join(record.worktree.destination, file), "utf8")).toBe(contents);
			expect(
				await git(repository, ["rev-parse", "--verify", `refs/heads/feature/blocked-${id}`]),
			).toBe(base.commit);
		}
	});

	it("finishes an interrupted rollback from durable intent and retains a moved branch", async () => {
		const repository = await makeGitProject("rollback-resume-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(
			repository,
			"rollback-resume",
			base.ref,
			base.commit,
			"feature/resume-rollback",
		);
		const prepared = await coordinator().start(options, launcher());
		if (prepared.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		const destination = prepared.execution.worktree.path;

		// Interrupted after intent was durable but before any removal ran.
		rewriteRollbackPhase("rollback-resume", "rollback_requested");
		const resumed = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(options, launcher(new SessionManager())),
			"RUNTIME_LAUNCH_FAILED",
		);
		expect(resumed.message).toBe("Runtime failed before any session existed");
		expect(journal.get("rollback-resume")?.phase).toBe("failed");
		expect(existsSync(destination)).toBe(false);
		expect(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
			"refs/heads/main",
		);

		// Interrupted after removal ran but before its phase write landed.
		const lostWrite = worktreeRequest(
			repository,
			"rollback-resume-lost-write",
			base.ref,
			base.commit,
			"feature/lost-write-rollback",
		);
		const lostWriteStart = await coordinator().start(lostWrite, launcher());
		if (lostWriteStart.execution?.mode !== "worktree") {
			throw new Error("Expected Worktree execution");
		}
		await git(repository, ["worktree", "remove", lostWriteStart.execution.worktree.path]);
		rewriteRollbackPhase("rollback-resume-lost-write", "rollback_requested");

		const finished = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(lostWrite, launcher(new SessionManager())),
			"RUNTIME_LAUNCH_FAILED",
		);
		expect(finished.details).toEqual({
			operationId: "rollback-resume-lost-write",
			phase: "failed",
			originProjectPath: repository,
		});
		expect(journal.get("rollback-resume-lost-write")?.phase).toBe("failed");
		await expect(
			execFileAsync("git", [
				"-C",
				repository,
				"rev-parse",
				"--verify",
				"refs/heads/feature/lost-write-rollback",
			]),
		).rejects.toBeDefined();

		// Interrupted between removal and branch deletion, with the branch moved on.
		const second = worktreeRequest(
			repository,
			"rollback-resume-moved",
			base.ref,
			base.commit,
			"feature/moved-rollback",
		);
		const movedStart = await coordinator().start(second, launcher());
		if (movedStart.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		await git(repository, ["worktree", "remove", "--force", movedStart.execution.worktree.path]);
		await writeFile(join(repository, "tracked.txt"), "advanced\n", "utf8");
		await git(repository, ["add", "tracked.txt"]);
		await git(repository, ["commit", "--no-gpg-sign", "-m", "advanced"]);
		const movedCommit = await git(repository, ["rev-parse", "HEAD"]);
		await git(repository, ["update-ref", "refs/heads/feature/moved-rollback", movedCommit]);
		rewriteRollbackPhase("rollback-resume-moved", "worktree_removed");

		const retained = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(second, launcher(new SessionManager())),
			"RUNTIME_LAUNCH_FAILED",
		);

		expect(retained.details?.retainedBranch).toBe("feature/moved-rollback");
		expect(retained.details?.retainedWorktreePath).toBeUndefined();
		expect(retained.message).toContain("moved away from the recorded commit");
		expect(
			await git(repository, ["rev-parse", "--verify", "refs/heads/feature/moved-rollback"]),
		).toBe(movedCommit);
	});

	it("advances, retains, and finishes durable phases at service start without launching", async () => {
		const repository = await makeGitProject("startup-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const created = await coordinator().start(
			worktreeRequest(repository, "startup-created", base.ref, base.commit),
			launcher(),
		);
		const ambiguous = await coordinator().start(
			worktreeRequest(repository, "startup-ambiguous", base.ref, base.commit),
			launcher(),
		);
		if (created.execution?.mode !== "worktree" || ambiguous.execution?.mode !== "worktree") {
			throw new Error("Expected Worktree executions");
		}
		rewritePhase("startup-created", "worktree_created");
		rewritePhase("startup-ambiguous", "runtime_launch_requested");

		const restartedSessions = new SessionManager();
		await coordinator({
			sessionManager: restartedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).reconcileOnStartup();

		// An exact created worktree advances one phase; the runtime is never started.
		expect(journal.get("startup-created")?.phase).toBe("worktree_ready");
		expect(restartedSessions.list()).toHaveLength(0);
		expect(existsSync(created.execution.worktree.path)).toBe(true);

		// A launch that may already have run becomes an actionable retained result.
		const retained = journal.get("startup-ambiguous");
		expect(retained?.phase).toBe("retained");
		expect(retained?.failure?.details?.retainedWorktreePath).toBe(
			ambiguous.execution.worktree.path,
		);
		expect(retained?.failure?.details?.createdSessionId).toBe(ambiguous.sessionId);
		expect(existsSync(ambiguous.execution.worktree.path)).toBe(true);
	});

	it("fails an attached worktree start when its requested branch already exists", async () => {
		const repository = await makeGitProject("existing-worktree-branch-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		await git(repository, ["branch", "feature/already-exists"]);
		const options = worktreeRequest(
			repository,
			"worktree-existing-branch",
			base.ref,
			base.commit,
			"feature/already-exists",
		);
		let launches = 0;

		const failure = await expectStartError(
			coordinator().start(
				options,
				launcher(sessions, () => {
					launches++;
				}),
			),
			"BRANCH_EXISTS",
		);

		expect(failure.details?.phase).toBe("failed");
		expect(failure.details?.retainedBranch).toBeUndefined();
		expect(failure.details?.retainedWorktreePath).toBeUndefined();
		expect(journal.get("worktree-existing-branch")?.phase).toBe("failed");
		expect(await git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
			join(fixtureRoot, "managed"),
		);
		expect(launches).toBe(0);
		expect(sessions.list()).toHaveLength(0);
	});

	it("ignores poisoned Git repository and config redirection variables", async () => {
		const registered = await makeGitProject("registered");
		const unrelated = await makeGitProject("unrelated");
		const state = await coordinator().inspect(registered);
		const environment = {
			GIT_DIR: process.env["GIT_DIR"],
			GIT_WORK_TREE: process.env["GIT_WORK_TREE"],
			GIT_CONFIG_COUNT: process.env["GIT_CONFIG_COUNT"],
			GIT_CONFIG_KEY_0: process.env["GIT_CONFIG_KEY_0"],
			GIT_CONFIG_VALUE_0: process.env["GIT_CONFIG_VALUE_0"],
		};

		try {
			process.env["GIT_DIR"] = join(unrelated, ".git");
			process.env["GIT_WORK_TREE"] = unrelated;
			process.env["GIT_CONFIG_COUNT"] = "1";
			process.env["GIT_CONFIG_KEY_0"] = "core.bare";
			process.env["GIT_CONFIG_VALUE_0"] = "true";

			await coordinator().start(
				request(
					registered,
					"sanitized-environment",
					branchPreparation(state, "feature/registered-only"),
				),
				launcher(),
			);
		} finally {
			for (const [key, value] of Object.entries(environment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(await git(registered, ["branch", "--show-current"])).toBe("feature/registered-only");
		expect(await git(unrelated, ["branch", "--show-current"])).toBe("main");
		await expect(
			execFileAsync(
				"git",
				["-C", unrelated, "show-ref", "--verify", "refs/heads/feature/registered-only"],
				{ encoding: "utf8" },
			),
		).rejects.toBeDefined();
	});

	it.skipIf(platform() === "win32")(
		"classifies non-Git folders independently of the inherited locale",
		async () => {
			const nonGit = join(fixtureRoot, "localized-plain");
			const fakeBin = join(fixtureRoot, "fake-bin");
			const fakeGit = join(fakeBin, "git");
			await mkdir(nonGit);
			await mkdir(fakeBin);
			await writeFile(
				fakeGit,
				[
					"#!/bin/sh",
					'if [ "$LC_ALL" = "C" ]; then',
					'\tprintf "%s\\n" "fatal: not a git repository" >&2',
					"else",
					'\tprintf "%s\\n" "fatal: dépôt Git introuvable" >&2',
					"fi",
					"exit 128",
					"",
				].join("\n"),
				"utf8",
			);
			await chmod(fakeGit, 0o755);
			registry.add("Localized plain folder", nonGit);
			const inherited = {
				PATH: process.env["PATH"],
				LC_ALL: process.env["LC_ALL"],
				LANG: process.env["LANG"],
			};

			try {
				process.env["PATH"] = `${fakeBin}${delimiter}${inherited.PATH ?? ""}`;
				process.env["LC_ALL"] = "fr_FR.UTF-8";
				process.env["LANG"] = "fr_FR.UTF-8";

				expect(await coordinator().inspect(nonGit)).toEqual({
					originProjectPath: nonGit,
					mode: "project_folder",
					directory: nonGit,
					git: null,
					worktree: null,
				});
			} finally {
				for (const [key, value] of Object.entries(inherited)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);

	it("rejects oversized Git output after terminating and reaping the command", async () => {
		const repo = await makeGitProject();
		const largePath = join(repo, "large-output.txt");
		await writeFile(largePath, "x".repeat(4 * 1024 * 1024), "utf8");
		const objectId = await git(repo, ["hash-object", "-w", largePath]);

		await expect(runGitCommand(repo, ["cat-file", "blob", objectId])).rejects.toThrow(
			"Git output exceeded the safety limit",
		);
		expect((await runGitCommand(repo, ["status", "--porcelain=v1"])).exitCode).toBe(0);
	});

	it("rejects unregistered, missing, conflicting-directory, and resume requests", async () => {
		const missing = join(fixtureRoot, "missing");
		registry.add("Missing", missing);
		const service = coordinator();
		await expectStartError(
			service.inspect(join(fixtureRoot, "unregistered")),
			"PROJECT_NOT_REGISTERED",
		);
		await expectStartError(service.inspect(missing), "PROJECT_PATH_UNAVAILABLE");

		const project = await makeGitProject();
		await expectStartError(
			() =>
				service.start(
					request(project, "wrong-dir", undefined, { workspace: dirname(project) }),
					launcher(),
				),
			"INVALID_PROJECT_START",
		);
		await expectStartError(
			() =>
				service.start(
					request(project, "resume", undefined, { resumeSessionId: "runtime-session" }),
					launcher(),
				),
			"INVALID_PROJECT_START",
		);
		expect(sessions.list()).toHaveLength(0);
	});

	it("starts non-Git and dirty Git projects without branch mutation", async () => {
		const plain = join(fixtureRoot, "plain");
		await mkdir(plain);
		registry.add("Plain", plain);
		const repo = await makeGitProject();
		await writeFile(join(repo, "tracked.txt"), "modified\n", "utf8");
		await writeFile(join(repo, "untracked.txt"), "untracked\n", "utf8");
		const beforeStatus = await git(repo, ["status", "--porcelain=v1"]);
		const service = coordinator();

		const plainResult = await service.start(request(plain, "plain-start"), launcher());
		const gitResult = await service.start(request(repo, "git-start"), launcher());

		expect(plainResult.execution?.git).toBeNull();
		expect(gitResult.execution?.git?.branch).toBe("main");
		expect(await git(repo, ["branch", "--show-current"])).toBe("main");
		expect(await git(repo, ["status", "--porcelain=v1"])).toBe(beforeStatus);
		expect(sessions.get(gitResult.sessionId)?.originProjectPath).toBe(repo);
	});

	it("creates one nested branch from the presented HEAD and preserves every local file class", async () => {
		const repo = await makeGitProject();
		await writeFile(join(repo, "tracked.txt"), "modified\n", "utf8");
		await writeFile(join(repo, "untracked.txt"), "untracked\n", "utf8");
		await writeFile(join(repo, "ignored.txt"), "ignored\n", "utf8");
		const beforeStatus = await git(repo, ["status", "--porcelain=v1", "--ignored"]);
		const state = await coordinator().inspect(repo);

		const result = await coordinator().start(
			request(repo, "branch-start", branchPreparation(state, "feature/mobile/session")),
			launcher(),
		);

		expect(await git(repo, ["branch", "--show-current"])).toBe("feature/mobile/session");
		expect(await git(repo, ["rev-parse", "HEAD"])).toBe(state.git?.head);
		expect(await git(repo, ["status", "--porcelain=v1", "--ignored"])).toBe(beforeStatus);
		expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("modified\n");
		expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe("untracked\n");
		expect(await readFile(join(repo, "ignored.txt"), "utf8")).toBe("ignored\n");
		expect(result.execution?.git?.branch).toBe("feature/mobile/session");
	});

	it("creates a branch from a presented detached checkout", async () => {
		const repo = await makeGitProject();
		await git(repo, ["checkout", "--detach"]);
		const service = coordinator();
		const state = await service.inspect(repo);
		expect(state.git?.detached).toBe(true);
		expect(state.git?.branch).toBeNull();

		const result = await service.start(
			request(repo, "detached-start", branchPreparation(state, "feature/from-detached")),
			launcher(),
		);

		expect(await git(repo, ["branch", "--show-current"])).toBe("feature/from-detached");
		expect(result.execution?.git?.detached).toBe(false);
	});

	it("rejects unborn, invalid, and existing branches without changing checkout state", async () => {
		const unborn = join(fixtureRoot, "unborn");
		await mkdir(unborn);
		await git(unborn, ["init", "-b", "main"]);
		registry.add("Unborn", unborn);
		const unbornService = coordinator();
		const unbornState = await unbornService.inspect(unborn);
		expect(unbornState.git?.head).toBeNull();
		await expectStartError(
			unbornService.start(
				request(unborn, "unborn", {
					type: "create_branch",
					newBranch: "feature/unborn",
					expectedHead: "deadbeef",
					expectedBranch: "main",
				}),
				launcher(),
			),
			"UNBORN_HEAD",
		);
		expect(await git(unborn, ["branch", "--show-current"])).toBe("main");

		const repo = await makeGitProject("committed");
		const state = await coordinator().inspect(repo);
		const invalidOptions = request(repo, "invalid", branchPreparation(state, "invalid branch"));
		await expectStartError(coordinator().start(invalidOptions, launcher()), "INVALID_BRANCH");
		await expectStartError(coordinator().start(invalidOptions, launcher()), "INVALID_BRANCH");
		await git(repo, ["branch", "existing"]);
		await expectStartError(
			coordinator().start(
				request(repo, "existing", branchPreparation(state, "existing")),
				launcher(),
			),
			"BRANCH_EXISTS",
		);
		expect(await git(repo, ["branch", "--show-current"])).toBe("main");
		expect(sessions.list()).toHaveLength(0);
	});

	it("rejects stale HEAD and stale branch presentation before mutation", async () => {
		const staleHeadRepo = await makeGitProject("stale-head");
		const headState = await coordinator().inspect(staleHeadRepo);
		await writeFile(join(staleHeadRepo, "second.txt"), "second\n", "utf8");
		await git(staleHeadRepo, ["add", "second.txt"]);
		await git(staleHeadRepo, ["commit", "--no-gpg-sign", "-m", "second"]);
		await expectStartError(
			coordinator().start(
				request(staleHeadRepo, "stale-head", branchPreparation(headState, "feature/stale")),
				launcher(),
			),
			"STALE_PROJECT_STATE",
		);
		expect(
			await git(staleHeadRepo, [
				"show-ref",
				"--verify",
				"--quiet",
				"refs/heads/feature/stale",
			]).then(
				() => true,
				() => false,
			),
		).toBe(false);

		const staleBranchRepo = await makeGitProject("stale-branch");
		const branchState = await coordinator().inspect(staleBranchRepo);
		await git(staleBranchRepo, ["branch", "other"]);
		await git(staleBranchRepo, ["symbolic-ref", "HEAD", "refs/heads/other"]);
		await expectStartError(
			coordinator().start(
				request(
					staleBranchRepo,
					"stale-branch",
					branchPreparation(branchState, "feature/stale-branch"),
				),
				launcher(),
			),
			"STALE_PROJECT_STATE",
		);
		expect(await git(staleBranchRepo, ["branch", "--show-current"])).toBe("other");
		expect(sessions.list()).toHaveLength(0);
	});

	it("rejects branch preparation during a conflicted merge without changing HEAD", async () => {
		const repo = await makeGitProject("merge-in-progress");
		await git(repo, ["checkout", "-b", "conflict-side"]);
		await writeFile(join(repo, "tracked.txt"), "side change\n", "utf8");
		await git(repo, ["add", "tracked.txt"]);
		await git(repo, ["commit", "--no-gpg-sign", "-m", "side change"]);
		await git(repo, ["checkout", "main"]);
		await writeFile(join(repo, "tracked.txt"), "main change\n", "utf8");
		await git(repo, ["add", "tracked.txt"]);
		await git(repo, ["commit", "--no-gpg-sign", "-m", "main change"]);

		const service = coordinator();
		const state = await service.inspect(repo);
		const headBeforeMerge = await git(repo, ["rev-parse", "HEAD"]);
		await expect(
			execFileAsync("git", ["-C", repo, "merge", "--no-edit", "conflict-side"], {
				encoding: "utf8",
				maxBuffer: 64 * 1024,
			}),
		).rejects.toBeDefined();
		expect(await git(repo, ["rev-parse", "--verify", "MERGE_HEAD"])).not.toBe("");

		const failure = await expectStartError(
			service.start(
				request(repo, "merge-in-progress", branchPreparation(state, "feature/during-merge")),
				launcher(),
			),
			"REPOSITORY_OPERATION_IN_PROGRESS",
		);

		expect(failure.details?.phase).toBe("failed");
		expect(await git(repo, ["branch", "--show-current"])).toBe("main");
		expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBeforeMerge);
		await expect(
			execFileAsync(
				"git",
				["-C", repo, "show-ref", "--verify", "refs/heads/feature/during-merge"],
				{ encoding: "utf8" },
			),
		).rejects.toBeDefined();
		expect(sessions.list()).toHaveLength(0);
	});

	it("serializes different operations and lets only the first matching checkout launch", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		let launches = 0;
		const launch = launcher(sessions, () => {
			launches++;
		});
		const service = coordinator();

		const settled = await Promise.allSettled([
			service.start(request(repo, "concurrent-a", branchPreparation(state, "feature/a")), launch),
			service.start(request(repo, "concurrent-b", branchPreparation(state, "feature/b")), launch),
		]);

		expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(launches).toBe(1);
		expect(["feature/a", "feature/b"]).toContain(await git(repo, ["branch", "--show-current"]));
	});

	it("coalesces a live operation and rejects changed reuse of the same ID", async () => {
		const repo = await makeGitProject();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		let launches = 0;
		const launch = async (
			options: RunOptions,
			context: SessionStartContext,
		): Promise<RunResult> => {
			launches++;
			await gate;
			return launcher()(options, context);
		};
		const service = coordinator();
		const options = request(repo, "same-id");

		const first = service.start(options, launch);
		const duplicate = service.start(options, launch);
		await expectStartError(
			service.start({ ...options, initialPrompt: "Changed prompt" }, launch),
			"OPERATION_CONFLICT",
		);
		release?.();
		const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

		expect(duplicateResult).toEqual(firstResult);
		expect(launches).toBe(1);
	});

	it("resumes a durable branch_created phase after restart", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		const options = request(
			repo,
			"resume-created",
			branchPreparation(state, "feature/resume-created"),
		);
		await coordinator().start(options, launcher());
		rewritePhase("resume-created", "branch_created");
		await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		expect(journal.get("resume-created")?.phase).toBe("branch_created");
		expect(await git(repo, ["branch", "--show-current"])).toBe("main");

		const result = await coordinator({ sessionManager: new SessionManager() }).start(
			options,
			launcher(),
		);
		expect(result.execution?.git?.branch).toBe("feature/resume-created");
		expect(await git(repo, ["branch", "--show-current"])).toBe("feature/resume-created");
	});

	it("retains an existing requested ref when a recorded creation phase is uncertain", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		const options = request(
			repo,
			"uncertain-recorded",
			branchPreparation(state, "feature/uncertain-recorded"),
		);
		await coordinator().start(options, launcher());
		rewritePhase("uncertain-recorded", "recorded");
		await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		let launches = 0;

		const retained = await expectStartError(
			coordinator({ sessionManager: new SessionManager() }).start(
				options,
				launcher(new SessionManager(), () => {
					launches++;
				}),
			),
			"OPERATION_RETAINED",
		);

		expect(retained.details?.retainedBranch).toBe("feature/uncertain-recorded");
		expect(
			await git(repo, ["show-ref", "--verify", "refs/heads/feature/uncertain-recorded"]),
		).toContain(state.git?.head);
		expect(launches).toBe(0);
	});

	it("allocates one session per prepared operation across every launch boundary", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		const options = request(repo, "phase-replay", branchPreparation(state, "feature/phase-replay"));
		const first = await coordinator().start(options, launcher());

		// Interrupted before any session existed: allocate exactly one.
		rewritePhase("phase-replay", "branch_checked_out");
		const restartedSessions = new SessionManager();
		let launches = 0;
		const resumed = await coordinator({
			sessionManager: restartedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(
			options,
			launcher(restartedSessions, () => {
				launches++;
			}),
		);
		expect(resumed.sessionId).not.toBe(first.sessionId);
		expect(launches).toBe(1);
		expect(restartedSessions.list()).toHaveLength(1);

		// Interrupted after preparation but before the session boundary: still one.
		rewritePhase("phase-replay", "launch_requested");
		const preparedSessions = new SessionManager();
		const prepared = await coordinator({
			sessionManager: preparedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(options, launcher(preparedSessions));
		expect(preparedSessions.list()).toHaveLength(1);
		expect(journal.get("phase-replay")?.session?.sessionId).toBe(prepared.sessionId);

		// Interrupted after the session was recorded: reuse those exact identities.
		rewritePhase("phase-replay", "session_recorded");
		const reusedSessions = new SessionManager();
		const reused = await coordinator({
			sessionManager: reusedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(options, launcher(reusedSessions));
		expect(reused.sessionId).toBe(prepared.sessionId);
		expect(reused.runId).toBe(prepared.runId);
		expect(reusedSessions.get(prepared.sessionId)?.workspace.id).toBe(
			journal.get("phase-replay")?.session?.workspaceId,
		);

		// Interrupted while the runtime may already have started: never launch again.
		rewritePhase("phase-replay", "runtime_launch_requested");
		let ambiguousLaunches = 0;
		const ambiguous = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(new SessionManager(), () => {
					ambiguousLaunches++;
				}),
			),
			"OPERATION_RETAINED",
		);
		expect(ambiguousLaunches).toBe(0);
		expect(ambiguous.details?.phase).toBe("retained");
		expect(ambiguous.details?.createdSessionId).toBe(prepared.sessionId);
		expect(ambiguous.details?.retainedBranch).toBe("feature/phase-replay");
	});

	it("replays a completed start after restart instead of retaining it", async () => {
		const repo = await makeGitProject("session-started");
		const options = request(repo, "session-started");
		const activeResult = await coordinator().start(options, launcher());
		expect(await coordinator().start(options, launcher())).toEqual(activeResult);

		const restartedSessions = new SessionManager();
		const restartedWorkspaces = new WorkspaceManager(fixtureRoot);
		const restarted = new ProjectStartCoordinator({
			journal,
			registry,
			sessionManager: restartedSessions,
			workspaceManager: restartedWorkspaces,
		});
		await restarted.reconcileOnStartup();

		let launches = 0;
		const replayed = await restarted.start(
			options,
			launcher(restartedSessions, () => {
				launches++;
			}),
		);

		expect(replayed).toEqual(activeResult);
		expect(launches).toBe(0);
		const restoredSession = restartedSessions.get(activeResult.sessionId);
		expect(restoredSession?.status).toBe("ended");
		expect(restoredSession?.originProjectPath).toBe(repo);
		expect(restoredSession?.execution?.directory).toBe(repo);
		expect(restartedWorkspaces.get(restoredSession?.workspace.id ?? "")?.workingDir).toBe(repo);
	});

	it("resumes an interrupted non-Git start at both durable launch boundaries", async () => {
		const plain = join(fixtureRoot, "plain-restart");
		await mkdir(plain);
		registry.add("Plain restart", plain);
		const options = request(plain, "plain-restart");
		const first = await coordinator().start(options, launcher());
		expect(first.execution?.git).toBeNull();

		// A project that was never in Git has no Git truth to reconcile, so a
		// prepared start must resume rather than report a lost repository.
		rewritePhase("plain-restart", "launch_requested");
		const preparedSessions = new SessionManager();
		let launches = 0;
		const prepared = await coordinator({
			sessionManager: preparedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(
			options,
			launcher(preparedSessions, () => {
				launches++;
			}),
		);

		expect(launches).toBe(1);
		expect(prepared.execution).toEqual({ directory: plain, mode: "project_folder", git: null });
		expect(prepared.originProjectPath).toBe(plain);
		expect(preparedSessions.list()).toHaveLength(1);
		expect(journal.get("plain-restart")?.phase).toBe("session_started");

		// Interrupted after the session was recorded: reuse those exact identities.
		rewritePhase("plain-restart", "session_recorded");
		const reusedSessions = new SessionManager();
		const reused = await coordinator({
			sessionManager: reusedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(options, launcher(reusedSessions));

		expect(reused.sessionId).toBe(prepared.sessionId);
		expect(reused.runId).toBe(prepared.runId);
		expect(reused.execution).toEqual(prepared.execution);
		expect(reusedSessions.list()).toHaveLength(1);
	});

	it("resumes a Worktree start at its session boundary and never launches it twice", async () => {
		const repository = await makeGitProject("worktree-session-boundary");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(
			repository,
			"worktree-session-boundary",
			base.ref,
			base.commit,
			"feature/session-boundary",
		);
		const first = await coordinator().start(options, launcher());
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");
		const destination = first.execution.worktree.path;
		const expectedRefs = "refs/heads/feature/session-boundary\nrefs/heads/main";

		// Interrupted after the session was recorded but before the runtime call.
		rewritePhase("worktree-session-boundary", "session_recorded");
		const restartedSessions = new SessionManager();
		let launches = 0;
		const resumed = await coordinator({
			sessionManager: restartedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		}).start(
			options,
			launcher(restartedSessions, () => {
				launches++;
			}),
		);

		expect(launches).toBe(1);
		expect(resumed.sessionId).toBe(first.sessionId);
		expect(resumed.runId).toBe(first.runId);
		expect(resumed.execution).toEqual(first.execution);
		expect(restartedSessions.list()).toHaveLength(1);
		expect(await worktreeRegistrations(repository, destination)).toBe(1);
		expect(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
			expectedRefs,
		);

		// Interrupted where the runtime call may already have run: never repeat it.
		rewritePhase("worktree-session-boundary", "runtime_launch_requested");
		let ambiguousLaunches = 0;
		const retained = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(new SessionManager(), () => {
					ambiguousLaunches++;
				}),
			),
			"OPERATION_RETAINED",
		);

		expect(ambiguousLaunches).toBe(0);
		expect(retained.details?.createdSessionId).toBe(first.sessionId);
		expect(retained.details?.retainedWorktreePath).toBe(destination);
		expect(retained.details?.retainedBranch).toBe("feature/session-boundary");
		expect(existsSync(destination)).toBe(true);
		expect(await worktreeRegistrations(repository, destination)).toBe(1);
		expect(await git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
			expectedRefs,
		);
	});

	it("replays a version-1 completed start after upgrade without relaunching", async () => {
		const repo = await makeGitProject("legacy-success");
		const options = request(repo, "legacy-success");
		const first = await coordinator().start(options, launcher());
		downgradeToVersionOne();
		expect(journal.get("legacy-success")?.recordVersion).toBe(1);
		expect(journal.get("legacy-success")?.session).toBeUndefined();

		const restartedSessions = new SessionManager();
		const restarted = coordinator({
			sessionManager: restartedSessions,
			workspaceManager: new WorkspaceManager(fixtureRoot),
		});
		await restarted.reconcileOnStartup();
		let launches = 0;
		const replay = await restarted.start(
			options,
			launcher(restartedSessions, () => {
				launches++;
			}),
		);

		expect(replay).toEqual(first);
		expect(launches).toBe(0);
		// The landed record has no workspace identity to restore, so discovery is
		// not rehydrated; the recorded result is still authoritative.
		expect(restartedSessions.list()).toHaveLength(0);
		expect(journal.get("legacy-success")?.phase).toBe("session_started");
	});

	it("reports a vanished worktree as failed instead of claiming to retain it", async () => {
		const repository = await makeGitProject("vanished-worktree-repo");
		const inspected = await coordinator().inspect(repository);
		const base = inspected.worktree?.bases.find(({ ref }) => ref === "refs/heads/main");
		if (!base) throw new Error("Expected local main base");
		const options = worktreeRequest(repository, "worktree-vanished", base.ref, base.commit);
		const first = await coordinator().start(options, launcher());
		if (first.execution?.mode !== "worktree") throw new Error("Expected Worktree execution");

		rewritePhase("worktree-vanished", "worktree_ready");
		await rm(first.execution.worktree.path, { recursive: true, force: true });
		await git(repository, ["worktree", "prune"]);
		let launches = 0;

		const failure = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(new SessionManager(), () => {
					launches++;
				}),
			),
			"OPERATION_RETAINED",
		);

		expect(launches).toBe(0);
		// Nothing of this operation survives, so nothing may be reported as kept.
		expect(failure.details).toEqual({
			operationId: "worktree-vanished",
			phase: "failed",
			originProjectPath: repository,
		});
		expect(journal.get("worktree-vanished")?.phase).toBe("failed");
	});

	it("retains a version-1 launch boundary that could already have entered the runtime", async () => {
		const repo = await makeGitProject("legacy-launch");
		const state = await coordinator().inspect(repo);
		const options = request(repo, "legacy-launch", branchPreparation(state, "feature/legacy"));
		await coordinator().start(options, launcher());
		rewritePhase("legacy-launch", "launch_requested");
		downgradeToVersionOne();
		let launches = 0;

		const retained = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				workspaceManager: new WorkspaceManager(fixtureRoot),
			}).start(
				options,
				launcher(new SessionManager(), () => {
					launches++;
				}),
			),
			"OPERATION_RETAINED",
		);

		expect(launches).toBe(0);
		expect(retained.details?.retainedBranch).toBe("feature/legacy");
		expect(await git(repo, ["branch", "--show-current"])).toBe("feature/legacy");
	});

	it("persists a late runtime-native session ID against the bound operation only", async () => {
		const repo = await makeGitProject("runtime-native");
		const options = request(repo, "runtime-native");
		const result = await coordinator().start(options, launcher());

		sessions.setRuntimeSessionId(result.sessionId, "claude-native-1");
		expect(journal.get("runtime-native")?.session?.runtimeSessionId).toBe("claude-native-1");

		const unrelated = sessions.create("codex", {
			id: "workspace-unrelated",
			workingDir: repo,
			createdAt: 1,
		});
		sessions.setRuntimeSessionId(unrelated.id, "codex-native-1");
		expect(journal.list()).toHaveLength(1);
		expect(journal.get("runtime-native")?.session?.runtimeSessionId).toBe("claude-native-1");
	});

	it("persists retained outcomes when post-mutation projects cannot be safely resumed", async () => {
		const removedRepo = await makeGitProject("removed-registration");
		const removedState = await coordinator().inspect(removedRepo);
		const removedOptions = request(
			removedRepo,
			"removed-registration",
			branchPreparation(removedState, "feature/removed-registration"),
		);
		await coordinator().start(removedOptions, launcher());
		rewritePhase("removed-registration", "branch_created");
		await git(removedRepo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		registry.remove(removedRepo);
		let removedLaunches = 0;

		const removed = await expectStartError(
			coordinator({ sessionManager: new SessionManager() }).start(
				removedOptions,
				launcher(new SessionManager(), () => {
					removedLaunches++;
				}),
			),
			"OPERATION_RETAINED",
		);
		expect(removed.details?.originProjectPath).toBe(removedRepo);
		expect(removed.details?.retainedBranch).toBe("feature/removed-registration");
		expect(removed.details?.effectiveState?.directory).toBe(removedRepo);
		expect(removed.details?.effectiveState?.git?.branch).toBe("main");
		expect(journal.get("removed-registration")?.phase).toBe("retained");
		expect(removedLaunches).toBe(0);

		const missingRepo = await makeGitProject("missing-after-mutation");
		const missingState = await coordinator().inspect(missingRepo);
		const missingOptions = request(
			missingRepo,
			"missing-after-mutation",
			branchPreparation(missingState, "feature/missing-after-mutation"),
		);
		await coordinator().start(missingOptions, launcher());
		rewritePhase("missing-after-mutation", "branch_checked_out");
		await rename(missingRepo, `${missingRepo}-moved`);

		const missing = await expectStartError(
			coordinator({ sessionManager: new SessionManager() }).start(missingOptions, launcher()),
			"OPERATION_RETAINED",
		);
		expect(missing.details?.effectiveState?.directory).toBe(missingRepo);
		expect(missing.details?.effectiveState?.git?.branch).toBe("feature/missing-after-mutation");
		expect(journal.get("missing-after-mutation")?.phase).toBe("retained");

		const inspectionRepo = await makeGitProject("inspection-failure");
		const inspectionState = await coordinator().inspect(inspectionRepo);
		const inspectionOptions = request(
			inspectionRepo,
			"inspection-failure",
			branchPreparation(inspectionState, "feature/inspection-failure"),
		);
		await coordinator().start(inspectionOptions, launcher());
		rewritePhase("inspection-failure", "branch_checked_out");
		let inspectionLaunches = 0;

		const inspection = await expectStartError(
			coordinator({
				sessionManager: new SessionManager(),
				runGit: async () => {
					throw new Error("simulated Git inspection failure");
				},
			}).start(
				inspectionOptions,
				launcher(new SessionManager(), () => {
					inspectionLaunches++;
				}),
			),
			"OPERATION_RETAINED",
		);
		expect(inspection.details?.effectiveState?.git?.branch).toBe("feature/inspection-failure");
		expect(journal.get("inspection-failure")?.phase).toBe("retained");
		expect(inspectionLaunches).toBe(0);
	});

	it("retains an activated branch and structured session identity after launch failure", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		const options = request(repo, "launch-failure", branchPreparation(state, "feature/retained"));
		const failingLaunch = async (): Promise<RunResult> => {
			throw new ExecutorStartError("Runtime failed", "run-failed", "session-failed");
		};

		const first = await expectStartError(
			coordinator().start(options, failingLaunch),
			"RUNTIME_LAUNCH_FAILED",
		);
		expect(first.details?.phase).toBe("retained");
		expect(first.details?.retainedBranch).toBe("feature/retained");
		expect(first.details?.createdSessionId).toBe("session-failed");
		expect(await git(repo, ["branch", "--show-current"])).toBe("feature/retained");
		expect(await git(repo, ["rev-parse", "HEAD"])).toBe(state.git?.head);

		const replay = await expectStartError(
			coordinator().start(options, launcher()),
			"RUNTIME_LAUNCH_FAILED",
		);
		expect(replay.details).toEqual(first.details);
		expect(sessions.list()).toHaveLength(0);
	});
});
