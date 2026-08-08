import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	GitCheckoutState,
	ProjectStartFailureDetails,
	ProjectStartRequest,
	ProjectStartState,
	RunOptions,
	RunResult,
	SessionExecutionState,
} from "@codemote/common";
import { ExecutorStartError } from "./executor.js";
import {
	ManagedWorktreeError,
	ManagedWorktreeService,
	type ManagedWorktreeTruth,
	type RecordedManagedWorktree,
	containedIn,
} from "./managedWorktree.js";
import type { ProjectRegistry } from "./projectRegistry.js";
import type {
	ProjectStartJournal,
	ProjectStartJournalFailure,
	ProjectStartOperationRecord,
} from "./projectStartJournal.js";
import type { SessionManager } from "./session.js";
import type {
	DurableProjectSession,
	ProjectSessionLaunchControl,
	Session,
	SessionStartContext,
} from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_MAX_BYTES = 64 * 1024;
const GIT_TERMINATE_GRACE_MS = 100;
const GIT_REAP_TIMEOUT_MS = 1_000;

const GIT_OPERATION_MARKERS = [
	{ path: "MERGE_HEAD", operation: "merge" },
	{ path: "rebase-merge", operation: "rebase" },
	{ path: "rebase-apply", operation: "rebase or apply-mailbox" },
	{ path: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
	{ path: "REVERT_HEAD", operation: "revert" },
	{ path: "BISECT_START", operation: "bisect" },
	{ path: "sequencer", operation: "sequenced Git" },
] as const;

const GIT_REDIRECT_ENVIRONMENT = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_QUARANTINE_PATH",
	"GIT_WORK_TREE",
]);

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (
	cwd: string,
	args: string[],
	input?: string,
	signal?: AbortSignal,
) => Promise<GitCommandResult>;

export interface ProjectStartCoordinatorOptions {
	journal: ProjectStartJournal;
	registry: ProjectRegistry;
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	runGit?: GitCommandRunner;
	managedWorktreeRoot?: string;
	recoverSession?: (
		runtime: RunOptions["profile"],
		session: DurableProjectSession,
		context: SessionStartContext,
	) => Promise<boolean>;
}

type WorktreeOperationRecord = Extract<ProjectStartOperationRecord, { mode: "worktree" }>;

type LaunchProjectSession = (
	options: RunOptions,
	context: SessionStartContext,
) => Promise<RunResult>;

interface InFlightOperation {
	fingerprint: string;
	promise: Promise<RunResult>;
}

type ProjectStartErrorCode =
	| "INVALID_PROJECT_START"
	| "PROJECT_NOT_REGISTERED"
	| "PROJECT_PATH_UNAVAILABLE"
	| "GIT_UNAVAILABLE"
	| "GIT_TIMEOUT"
	| "OPERATION_ABORTED"
	| "GIT_COMMAND_FAILED"
	| "INVALID_BRANCH"
	| "BRANCH_EXISTS"
	| "REPOSITORY_OPERATION_IN_PROGRESS"
	| "STALE_PROJECT_STATE"
	| "UNBORN_HEAD"
	| "OPERATION_CONFLICT"
	| "OPERATION_RETAINED"
	| "RUNTIME_LAUNCH_FAILED";

export class ProjectStartError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: ProjectStartFailureDetails,
	) {
		super(message);
		this.name = "ProjectStartError";
	}
}

class GitProcessError extends Error {
	constructor(
		readonly kind: "unavailable" | "timeout" | "aborted" | "output_limit" | "spawn",
		message: string,
	) {
		super(message);
	}
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		const normalizedKey = key.toUpperCase();
		if (
			GIT_REDIRECT_ENVIRONMENT.has(normalizedKey) ||
			normalizedKey === "GIT_CONFIG" ||
			normalizedKey === "GIT_CONFIG_PARAMETERS" ||
			normalizedKey.startsWith("GIT_CONFIG_")
		) {
			continue;
		}
		environment[key] = value;
	}
	environment["LC_ALL"] = "C";
	environment["LANG"] = "C";
	return environment;
}

export function runGitCommand(
	cwd: string,
	args: string[],
	input?: string,
	signal?: AbortSignal,
): Promise<GitCommandResult> {
	if (signal?.aborted) {
		return Promise.reject(new GitProcessError("aborted", "Git command was aborted"));
	}
	return new Promise((resolvePromise, reject) => {
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let terminationError: GitProcessError | undefined;
		let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
		let reapTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn("git", ["-C", cwd, ...args], {
			env: gitEnvironment(),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const clearTimers = (): void => {
			clearTimeout(timeout);
			if (hardKillTimer) clearTimeout(hardKillTimer);
			if (reapTimer) clearTimeout(reapTimer);
			signal?.removeEventListener("abort", onAbort);
		};

		const finishError = (error: GitProcessError): void => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(error);
		};

		const stopCollection = (): void => {
			child.stdout.removeListener("data", onStdout);
			child.stderr.removeListener("data", onStderr);
			child.stdout.pause();
			child.stderr.pause();
		};

		const terminate = (error: GitProcessError): void => {
			if (settled || terminationError) return;
			terminationError = error;
			stopCollection();
			child.stdin.destroy();
			child.kill("SIGTERM");
			hardKillTimer = setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, GIT_TERMINATE_GRACE_MS);
			reapTimer = setTimeout(() => finishError(error), GIT_REAP_TIMEOUT_MS);
		};

		const onAbort = (): void => {
			terminate(new GitProcessError("aborted", "Git command was aborted"));
		};

		function onStdout(chunk: Buffer): void {
			if (stdoutBytes + chunk.byteLength > GIT_OUTPUT_MAX_BYTES) {
				terminate(new GitProcessError("output_limit", "Git output exceeded the safety limit"));
				return;
			}
			stdoutBytes += chunk.byteLength;
			stdout += chunk.toString("utf8");
		}

		function onStderr(chunk: Buffer): void {
			if (stderrBytes + chunk.byteLength > GIT_OUTPUT_MAX_BYTES) {
				terminate(new GitProcessError("output_limit", "Git output exceeded the safety limit"));
				return;
			}
			stderrBytes += chunk.byteLength;
			stderr += chunk.toString("utf8");
		}

		const timeout = setTimeout(() => {
			terminate(new GitProcessError("timeout", "Git command timed out"));
		}, GIT_TIMEOUT_MS);

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.stdin.on("error", (error) => {
			terminate(new GitProcessError("spawn", `Git command input failed: ${error.message}`));
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				finishError(new GitProcessError("unavailable", "Git executable is unavailable"));
				return;
			}
			finishError(new GitProcessError("spawn", "Git command could not be started"));
		});
		child.on("close", (code) => {
			if (settled) return;
			if (terminationError) {
				finishError(terminationError);
				return;
			}
			settled = true;
			clearTimers();
			resolvePromise({ exitCode: code ?? 1, stdout, stderr });
		});
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
		try {
			if (input !== undefined) child.stdin.end(input);
			else child.stdin.end();
		} catch (error) {
			terminate(
				new GitProcessError(
					"spawn",
					`Git command input failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
	});
}

function isNotRepository(result: GitCommandResult): boolean {
	return (
		result.exitCode === 128 &&
		(result.stderr.includes("not a git repository") ||
			result.stderr.includes("not a work tree") ||
			result.stderr.includes("outside repository"))
	);
}

function trimLine(value: string): string {
	return value.replace(/[\r\n]+$/u, "");
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameGitState(a: GitCheckoutState | null, b: GitCheckoutState | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		resolve(a.repositoryRoot) === resolve(b.repositoryRoot) &&
		a.head === b.head &&
		a.branch === b.branch &&
		a.detached === b.detached
	);
}

function executionFor(state: ProjectStartState): SessionExecutionState {
	return {
		directory: state.directory,
		mode: "project_folder",
		git: state.git,
	};
}

function sameExecution(a: SessionExecutionState, b: SessionExecutionState): boolean {
	if (a.directory !== b.directory || a.mode !== b.mode || !sameGitState(a.git, b.git)) return false;
	if (a.mode === "worktree" && b.mode === "worktree") {
		return (
			a.worktree.path === b.worktree.path &&
			a.worktree.baseRef === b.worktree.baseRef &&
			a.worktree.baseCommit === b.worktree.baseCommit
		);
	}
	return true;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Terminate a fragment so a composed failure message reads as prose. */
function sentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Why an otherwise exact worktree still cannot be removed. Ordered so the
 * caller hears the most specific reason first.
 */
function rollbackBlockedBy(
	truth: Extract<ManagedWorktreeTruth, { status: "exact" }>,
): string | null {
	if (!truth.mapping.ok) return truth.mapping.message;
	if (!truth.selectedBaseMatches) {
		return "the selected base no longer resolves to the recorded commit";
	}
	if (!truth.clean) return "it contains local changes";
	return null;
}

function terminalError(failure: ProjectStartJournalFailure): ProjectStartError {
	return new ProjectStartError(failure.code, failure.message, failure.details);
}

export class ProjectStartCoordinator {
	private readonly journal: ProjectStartJournal;
	private readonly registry: ProjectRegistry;
	private readonly sessionManager: SessionManager;
	private readonly workspaceManager: WorkspaceManager;
	private readonly runGit: GitCommandRunner;
	private readonly managedWorktrees: ManagedWorktreeService;
	private readonly recoverSession: ProjectStartCoordinatorOptions["recoverSession"];
	private readonly inFlight = new Map<string, InFlightOperation>();
	private readonly repositoryTails = new Map<string, Promise<void>>();

	constructor(options: ProjectStartCoordinatorOptions) {
		this.journal = options.journal;
		this.registry = options.registry;
		this.sessionManager = options.sessionManager;
		this.workspaceManager = options.workspaceManager;
		this.runGit = options.runGit ?? runGitCommand;
		this.recoverSession = options.recoverSession;
		this.managedWorktrees = new ManagedWorktreeService(
			this.runGit,
			options.managedWorktreeRoot ?? join(homedir(), ".codemote", "worktrees"),
		);
	}

	async inspect(projectPath: string, signal?: AbortSignal): Promise<ProjectStartState> {
		const normalizedPath = this.requireRegisteredPath(projectPath);
		await this.requireDirectory(normalizedPath);
		const git = await this.inspectGit(normalizedPath, false, signal);
		let worktree = null;
		if (git) {
			try {
				worktree = await this.managedWorktrees.listBases(git.repositoryRoot, signal);
			} catch (error) {
				throw this.mapManagedGitError(error);
			}
		}
		return {
			originProjectPath: normalizedPath,
			mode: "project_folder",
			directory: normalizedPath,
			git,
			worktree,
		};
	}

	/**
	 * Reconcile durable operations with current truth once, before this process
	 * accepts commands.
	 *
	 * Startup may validate or advance an exact Git phase, finish an already
	 * intended rollback, restore a terminal session mapping, or record an
	 * actionable retained result. It never launches a runtime: the initial prompt
	 * is represented only by the request fingerprint, so only a retransmission of
	 * the same operation can start one.
	 */
	async reconcileOnStartup(): Promise<void> {
		for (const record of this.journal.list()) {
			try {
				await this.reconcileRecordOnStartup(record);
			} catch (error) {
				// A recorded terminal outcome is the point of the reconciliation, not a
				// startup failure. Anything else must not stop unrelated recovery.
				if (error instanceof ProjectStartError) continue;
				console.error(
					`Project start recovery skipped operation ${record.operationId}:`,
					describeError(error),
				);
			}
		}
	}

	private async reconcileRecordOnStartup(record: ProjectStartOperationRecord): Promise<void> {
		if (record.phase === "session_started") {
			await this.restoreDurableSession(record);
			return;
		}
		if (record.phase === "runtime_launch_requested") {
			this.failAmbiguousLaunch(record);
		}
		if (record.mode !== "worktree") return;
		if (record.phase === "rollback_requested" || record.phase === "worktree_removed") {
			await this.withRepositoryLock(record.repositoryRoot, () => this.finishRollback(record));
			return;
		}
		if (record.phase !== "worktree_created" && record.phase !== "worktree_ready") return;
		await this.withRepositoryLock(record.repositoryRoot, async () => {
			const truth = await this.managedWorktrees.inspectRecorded(this.recordedWorktree(record));
			if (truth.status !== "exact") {
				this.failFromTruth(record, truth);
			}
			if (!truth.mapping.ok) {
				this.failWorktree(record, truth.mapping.code, truth.mapping.message);
			}
			if (record.phase === "worktree_created") {
				this.journal.update(record.operationId, (current) => ({
					...current,
					phase: "worktree_ready",
					updatedAt: Date.now(),
				}));
			}
		});
	}

	/**
	 * Make a completed operation's session, workspace and effective directory
	 * discoverable again. A runtime that explicitly supports durable recovery may
	 * rehydrate the conversation for lazy follow-up; every other runtime keeps the
	 * existing conservative ended-session mapping.
	 */
	private async restoreDurableSession(record: ProjectStartOperationRecord): Promise<void> {
		const durable = record.session;
		if (!durable) return;
		if (record.mode === "worktree") {
			const mapping = await this.managedWorktrees.inspectRecordedIdentity(
				this.recordedWorktree(record),
			);
			if (!mapping?.ok || mapping.directory !== durable.execution.directory) {
				return;
			}
		}
		if (!(await this.resolvesToRecordedDirectory(durable.execution))) return;
		const recoveryState = durable.recoveryState ?? "resumable";
		const context: SessionStartContext = {
			originProjectPath: record.originProjectPath,
			execution: durable.execution,
		};
		if (recoveryState === "resumable" && this.recoverSession) {
			try {
				if (await this.recoverSession(record.runtime, durable, context)) {
					this.bindDurableSessionPersistence(record.operationId, durable.sessionId);
					return;
				}
			} catch (error) {
				console.error(
					`Runtime session recovery fell back to ended for ${durable.sessionId}:`,
					describeError(error),
				);
			}
		}
		const workspace = this.workspaceManager.restore({
			id: durable.workspaceId,
			workingDir: durable.execution.directory,
			createdAt: durable.createdAt,
		});
		this.sessionManager.restore({
			id: durable.sessionId,
			runId: durable.runId,
			runtime: record.runtime,
			status: recoveryState === "error" ? "error" : "ended",
			resumeEligible: recoveryState === "resumable",
			workspace,
			startedAt: durable.createdAt,
			endedAt: record.updatedAt,
			lastActivityAt: record.updatedAt,
			statusChangedAt: record.updatedAt,
			...(recoveryState === "resumable" && durable.runtimeSessionId
				? { runtimeSessionId: durable.runtimeSessionId }
				: {}),
			originProjectPath: record.originProjectPath,
			execution: durable.execution,
		});
		this.bindDurableSessionPersistence(record.operationId, durable.sessionId);
	}

	/**
	 * Prove the recorded effective directory is still the same real directory
	 * before anything is rehydrated against it.
	 *
	 * A path that has become a symlink is refused outright: restoring it would
	 * publish a session, workspace and diff surface pointing wherever the link
	 * now leads. A Worktree record additionally carries canonical paths by
	 * construction, so its directory must both resolve to itself and stay inside
	 * the recorded worktree root. Refusing costs only discovery — the recorded
	 * result still replays and names the path.
	 */
	private async resolvesToRecordedDirectory(execution: SessionExecutionState): Promise<boolean> {
		try {
			if ((await lstat(execution.directory)).isSymbolicLink()) return false;
			if (!(await stat(execution.directory)).isDirectory()) return false;
			if (execution.mode !== "worktree") return true;
			const canonicalDirectory = await realpath(execution.directory);
			const canonicalRoot = await realpath(execution.worktree.path);
			return (
				canonicalDirectory === execution.directory &&
				canonicalRoot === execution.worktree.path &&
				containedIn(canonicalRoot, canonicalDirectory)
			);
		} catch {
			// The recorded directory no longer resolves safely; the journal keeps the
			// human-readable mapping and replay still names it.
			return false;
		}
	}

	start(options: RunOptions, launch: LaunchProjectSession): Promise<RunResult> {
		const normalized = this.normalizeOptions(options);
		const fingerprint = this.fingerprint(normalized);
		const operationId = normalized.projectStart.operationId;
		const running = this.inFlight.get(operationId);
		if (running) {
			if (running.fingerprint !== fingerprint) {
				return Promise.reject(
					new ProjectStartError(
						"OPERATION_CONFLICT",
						`Operation ID ${operationId} was reused with a different request`,
					),
				);
			}
			return running.promise;
		}

		const promise = this.runOperation(normalized, fingerprint, launch).finally(() => {
			const current = this.inFlight.get(operationId);
			if (current?.promise === promise) this.inFlight.delete(operationId);
		});
		this.inFlight.set(operationId, { fingerprint, promise });
		return promise;
	}

	private async runOperation(
		options: RunOptions & { projectStart: ProjectStartRequest },
		fingerprint: string,
		launch: LaunchProjectSession,
	): Promise<RunResult> {
		const request = options.projectStart;
		let record = this.journal.get(request.operationId);
		if (record && record.fingerprint !== fingerprint) {
			throw new ProjectStartError(
				"OPERATION_CONFLICT",
				`Operation ID ${request.operationId} was reused with a different request`,
			);
		}
		if (record) {
			const existing = record;
			const lockKey = existing.repositoryRoot ?? existing.originProjectPath;
			return this.withRepositoryLock(lockKey, () =>
				existing.mode === "worktree"
					? this.reconcileWorktree(options, existing, launch, true)
					: this.reconcileAndLaunch(options, existing, launch, true),
			);
		}

		const state = await this.inspect(request.originProjectPath);
		if (request.mode === "worktree") {
			if (!state.git) {
				throw new ProjectStartError(
					"INVALID_WORKTREE_BASE",
					"This project is not in a Git working repository",
				);
			}
			let commit: string;
			try {
				commit = await this.managedWorktrees.resolveBase(
					state.git.repositoryRoot,
					request.preparation.baseRef,
				);
			} catch (error) {
				throw this.mapManagedGitError(error);
			}
			if (commit !== request.preparation.expectedCommit) {
				throw new ProjectStartError(
					"STALE_WORKTREE_BASE",
					"The selected worktree base changed; refresh and start again",
				);
			}
			let plan: Awaited<ReturnType<ManagedWorktreeService["plan"]>>;
			try {
				plan = await this.managedWorktrees.plan(
					state.git.repositoryRoot,
					request.originProjectPath,
					request.operationId,
				);
			} catch (error) {
				throw this.mapManagedError(error);
			}
			const now = Date.now();
			const worktreeRecord = this.journal.create({
				operationId: request.operationId,
				fingerprint,
				recordVersion: 2,
				mode: "worktree",
				originProjectPath: request.originProjectPath,
				runtime: options.profile,
				repositoryRoot: state.git.repositoryRoot,
				observedHead: state.git.head,
				observedBranch: state.git.branch,
				requestedBranch: request.preparation.newBranch,
				worktree: {
					destination: plan.destination,
					selectedBaseRef: request.preparation.baseRef,
					selectedBaseCommit: request.preparation.expectedCommit,
					projectRelativePath: plan.projectRelativePath,
					ownershipToken: randomUUID(),
				},
				phase: "recorded",
				createdAt: now,
				updatedAt: now,
			}) as WorktreeOperationRecord;
			return this.withRepositoryLock(worktreeRecord.repositoryRoot, () =>
				this.reconcileWorktree(options, worktreeRecord, launch, false),
			);
		}
		const now = Date.now();
		record = this.journal.create({
			operationId: request.operationId,
			fingerprint,
			recordVersion: 2,
			mode: "project_folder",
			originProjectPath: request.originProjectPath,
			runtime: options.profile,
			repositoryRoot: state.git?.repositoryRoot ?? null,
			observedHead: state.git?.head ?? null,
			observedBranch: state.git?.branch ?? null,
			requestedBranch:
				request.preparation.type === "create_branch" ? request.preparation.newBranch : null,
			phase: "recorded",
			createdAt: now,
			updatedAt: now,
		});
		const lockKey = record.repositoryRoot ?? record.originProjectPath;
		return this.withRepositoryLock(lockKey, () =>
			this.reconcileAndLaunch(options, record, launch, false),
		);
	}

	/**
	 * Reconcile everything a Project-folder operation may already have done, then
	 * hand the one prepared execution to the shared launch path.
	 */
	private async reconcileAndLaunch(
		options: RunOptions & { projectStart: ProjectStartRequest },
		initialRecord: ProjectStartOperationRecord,
		launch: LaunchProjectSession,
		isReplay: boolean,
	): Promise<RunResult> {
		let record = this.journal.get(initialRecord.operationId) ?? initialRecord;
		const request = options.projectStart;

		const replay = this.replayTerminal(record);
		if (replay) return replay;
		if (record.phase === "runtime_launch_requested") {
			return this.failAmbiguousLaunch(record);
		}
		if (record.phase === "launch_requested" && record.recordVersion === 1) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"An earlier version recorded this launch without a session boundary, so the runtime may already have started; the operation will not launch again",
				record.requestedBranch ?? undefined,
				undefined,
				this.bestKnownExecution(record),
			);
		}

		let state =
			record.phase === "recorded"
				? await this.inspect(record.originProjectPath)
				: await this.inspectPostMutationState(record);
		const recordedGit =
			record.repositoryRoot === null
				? null
				: {
						repositoryRoot: record.repositoryRoot,
						head: record.observedHead,
						branch: record.observedBranch,
						detached: record.observedHead !== null && record.observedBranch === null,
					};

		if (record.phase === "recorded") {
			if (!sameGitState(state.git, recordedGit)) {
				return this.fail(
					record,
					"failed",
					"STALE_PROJECT_STATE",
					"The project checkout changed after this start was recorded; refresh and start again",
				);
			}
			if (request.preparation.type === "create_branch") {
				state = await this.createAndActivateBranch(record, request.preparation, state, isReplay);
				record = this.journal.get(record.operationId) ?? record;
			}
		} else if (record.phase === "branch_created") {
			state = await this.resumeBranchActivation(record, state);
			record = this.journal.get(record.operationId) ?? record;
		} else if (record.requestedBranch !== null) {
			await this.verifyActivatedBranch(record, state);
		} else if (!sameGitState(state.git, recordedGit)) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The prepared checkout no longer matches the recorded operation",
				undefined,
				record.session?.sessionId,
				this.bestKnownExecution(record),
			);
		}

		return this.launchPrepared(options, record, executionFor(state), launch);
	}

	/**
	 * Reconcile everything a Worktree operation may already have done. Only exact
	 * truth advances a phase; anything else keeps the resource and says so.
	 */
	private async reconcileWorktree(
		options: RunOptions & { projectStart: ProjectStartRequest },
		initialRecord: WorktreeOperationRecord,
		launch: LaunchProjectSession,
		isReplay: boolean,
	): Promise<RunResult> {
		let record =
			(this.journal.get(initialRecord.operationId) as WorktreeOperationRecord | undefined) ??
			initialRecord;

		const replay = this.replayTerminal(record);
		if (replay) return replay;
		if (record.phase === "runtime_launch_requested") {
			return this.failAmbiguousLaunch(record);
		}
		if (record.phase === "rollback_requested" || record.phase === "worktree_removed") {
			return this.finishRollback(record);
		}
		if (record.phase === "launch_requested" && record.recordVersion === 1) {
			return this.failWorktree(
				record,
				"OPERATION_RETAINED",
				"An earlier version recorded this launch without a session boundary, so the runtime may already have started; the worktree was retained",
			);
		}

		if (record.phase === "recorded") {
			record = isReplay
				? await this.adoptOrCreateWorktree(record)
				: await this.createRecordedWorktree(record);
		}

		const truth = await this.managedWorktrees.inspectRecorded(this.recordedWorktree(record));
		if (truth.status !== "exact") {
			return this.failFromTruth(record, truth);
		}
		if (!truth.mapping.ok) {
			return this.failWorktree(record, truth.mapping.code, truth.mapping.message);
		}
		const effective: SessionExecutionState = {
			directory: truth.mapping.directory,
			mode: "worktree",
			git: truth.git,
			worktree: {
				path: record.worktree.destination,
				baseRef: record.worktree.selectedBaseRef,
				baseCommit: record.worktree.selectedBaseCommit,
			},
		};
		if (record.phase === "worktree_created") {
			record = this.journal.update(record.operationId, (current) => ({
				...current,
				phase: "worktree_ready",
				updatedAt: Date.now(),
			})) as WorktreeOperationRecord;
		}
		if (record.session && !sameExecution(effective, record.session.execution)) {
			return this.failWorktree(
				record,
				"OPERATION_RETAINED",
				"The prepared worktree no longer matches the recorded session; the worktree was retained",
				record.session.execution,
				record.session.sessionId,
			);
		}
		return this.launchPrepared(options, record, effective, launch);
	}

	/**
	 * First delivery: nothing has been created yet, so a pre-existing branch or
	 * destination is the caller's mistake to report, not a resource to adopt.
	 */
	private async createRecordedWorktree(
		record: WorktreeOperationRecord,
	): Promise<WorktreeOperationRecord> {
		let commit: string;
		try {
			commit = await this.managedWorktrees.resolveBase(
				record.repositoryRoot,
				record.worktree.selectedBaseRef,
			);
		} catch (error) {
			return this.failManagedBeforeCreation(record, error);
		}
		if (commit !== record.worktree.selectedBaseCommit) {
			return this.failManagedBeforeCreation(
				record,
				new ManagedWorktreeError(
					"STALE_WORKTREE_BASE",
					"The selected worktree base changed before creation",
				),
			);
		}
		try {
			await this.managedWorktrees.create(
				record.repositoryRoot,
				record.worktree.destination,
				record.worktree.selectedBaseCommit,
				record.requestedBranch,
				record.worktree.ownershipToken ?? "",
			);
		} catch (error) {
			if (
				error instanceof ManagedWorktreeError &&
				(error.code === "INVALID_BRANCH" || error.code === "BRANCH_EXISTS")
			) {
				return this.failManagedBeforeCreation(record, error);
			}
			// Creation failed partway: only provably absent resources allow a clean
			// failure. Anything left behind is retained with the path or branch it is.
			const truth = await this.managedWorktrees.inspectRecorded(this.recordedWorktree(record));
			if (truth.status === "absent") return this.failManagedBeforeCreation(record, error);
			return this.failWorktree(
				record,
				"OPERATION_RETAINED",
				describeError(error),
				undefined,
				undefined,
				truth.status !== "branch_only",
			);
		}
		return this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "worktree_created",
			updatedAt: Date.now(),
		})) as WorktreeOperationRecord;
	}

	/**
	 * Retransmission at `recorded`: a lost creation response can leave exactly the
	 * deterministic worktree this operation asked for. Adopt only that.
	 */
	private async adoptOrCreateWorktree(
		record: WorktreeOperationRecord,
	): Promise<WorktreeOperationRecord> {
		const truth = await this.managedWorktrees.inspectRecorded(this.recordedWorktree(record));
		if (truth.status === "absent") return this.createRecordedWorktree(record);
		if (truth.status !== "exact") {
			return this.failFromTruth(record, truth);
		}
		return this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "worktree_created",
			updatedAt: Date.now(),
		})) as WorktreeOperationRecord;
	}

	/**
	 * The one place a prepared operation becomes a session.
	 *
	 * Both modes share the durable session boundaries, the terminal result, and
	 * the launch-failure classification, so neither can drift from the other.
	 */
	private async launchPrepared(
		options: RunOptions & { projectStart: ProjectStartRequest },
		prepared: ProjectStartOperationRecord,
		effective: SessionExecutionState,
		launch: LaunchProjectSession,
	): Promise<RunResult> {
		const operationId = prepared.operationId;
		let record = prepared;
		if (record.phase !== "launch_requested" && record.phase !== "session_recorded") {
			record = this.journal.update(operationId, (current) => ({
				...current,
				phase: "launch_requested",
				updatedAt: Date.now(),
			}));
		}
		const recorded = record.session;
		const control: ProjectSessionLaunchControl = {
			...(recorded ? { session: recorded } : {}),
			recordSession: (session) => this.recordDurableSession(operationId, session, effective),
			recordRuntimeLaunchRequested: () => {
				this.journal.update(operationId, (current) => ({
					...current,
					phase: "runtime_launch_requested",
					updatedAt: Date.now(),
				}));
			},
		};
		const context: SessionStartContext = {
			originProjectPath: record.originProjectPath,
			execution: effective,
			launch: control,
		};

		let launched: RunResult;
		try {
			if (record.mode === "worktree") {
				const { resumeSessionId: _resumeSessionId, ...freshOptions } = options;
				launched = await launch({ ...freshOptions, workspace: effective.directory }, context);
			} else {
				launched = await launch(options, context);
			}
		} catch (error) {
			return this.failLaunch(operationId, record, error, effective);
		}

		const current = this.journal.get(operationId) ?? record;
		const recordedSession = current.session ?? this.durableSessionFor(launched, effective);
		const liveRuntimeSessionId = this.sessionManager.get(launched.sessionId)?.runtimeSessionId;
		const session: DurableProjectSession = liveRuntimeSessionId
			? { ...recordedSession, runtimeSessionId: liveRuntimeSessionId }
			: recordedSession;
		const result: RunResult = {
			...launched,
			operationId,
			originProjectPath: record.originProjectPath,
			execution: effective,
		};
		this.journal.update(operationId, (existing) => ({
			...existing,
			phase: "session_started",
			updatedAt: Date.now(),
			session,
			result,
		}));
		this.bindDurableSessionPersistence(operationId, session.sessionId);
		return result;
	}

	private recordDurableSession(
		operationId: string,
		session: Session,
		execution: SessionExecutionState,
	): void {
		const durable: DurableProjectSession = {
			sessionId: session.id,
			runId: session.runId,
			workspaceId: session.workspace.id,
			createdAt: session.startedAt,
			execution,
			recoveryState: "resumable",
			...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
		};
		this.journal.update(operationId, (current) => ({
			...current,
			phase: "session_recorded",
			updatedAt: Date.now(),
			session: durable,
		}));
		this.bindDurableSessionPersistence(operationId, session.id);
	}

	/**
	 * A launcher that records nothing still produced exactly one session, and the
	 * terminal record must name it. Production launches go through
	 * `BaseExecutor`, which records the identity at its durable boundary instead.
	 */
	private durableSessionFor(
		launched: RunResult,
		execution: SessionExecutionState,
	): DurableProjectSession {
		const live = this.sessionManager.get(launched.sessionId);
		return {
			sessionId: launched.sessionId,
			runId: launched.runId,
			workspaceId: live?.workspace.id ?? launched.runId,
			createdAt: live?.startedAt ?? Date.now(),
			execution,
			recoveryState: "resumable",
			...(live?.runtimeSessionId ? { runtimeSessionId: live.runtimeSessionId } : {}),
		};
	}

	private bindDurableSessionPersistence(operationId: string, sessionId: string): void {
		this.sessionManager.bindRuntimeSessionPersistence(sessionId, (_id, runtimeSessionId) => {
			const current = this.journal.get(operationId);
			if (!current?.session || current.session.runtimeSessionId === runtimeSessionId) return;
			this.journal.update(operationId, (record) =>
				record.session
					? {
							...record,
							session: { ...record.session, runtimeSessionId },
							updatedAt: Date.now(),
						}
					: record,
			);
		});
		this.sessionManager.bindRecoveryStatePersistence(sessionId, (_id, recoveryState) => {
			const current = this.journal.get(operationId);
			if (!current?.session || current.session.recoveryState === recoveryState) return;
			this.journal.update(operationId, (record) =>
				record.session
					? {
							...record,
							session: { ...record.session, recoveryState },
							updatedAt: Date.now(),
						}
					: record,
			);
		});
	}

	private async failLaunch(
		operationId: string,
		prepared: ProjectStartOperationRecord,
		error: unknown,
		effective: SessionExecutionState,
	): Promise<never> {
		const record = this.journal.get(operationId) ?? prepared;
		const message = describeError(error);
		const createdSessionId =
			(error instanceof ExecutorStartError ? error.sessionId : undefined) ??
			record.session?.sessionId;
		if (record.mode === "worktree") {
			// Only a worktree this operation created, never launched and never
			// recorded a session for can be removed. A failure that names a created
			// session is launch evidence, so the worktree is kept even when it is
			// otherwise exact and clean.
			if (
				record.phase === "launch_requested" &&
				!record.session &&
				createdSessionId === undefined &&
				record.recordVersion === 2
			) {
				return this.rollbackWorktree(record, "RUNTIME_LAUNCH_FAILED", message);
			}
			return this.failWorktree(
				record,
				"RUNTIME_LAUNCH_FAILED",
				message,
				effective,
				createdSessionId,
			);
		}
		const retainedBranch = record.requestedBranch ?? undefined;
		return this.fail(
			record,
			retainedBranch ? "retained" : "failed",
			"RUNTIME_LAUNCH_FAILED",
			message,
			retainedBranch,
			createdSessionId,
			effective,
		);
	}

	private failAmbiguousLaunch(record: ProjectStartOperationRecord): never {
		const message = "Runtime launch may already have started; the operation will not launch again";
		if (record.mode === "worktree") {
			return this.failWorktree(
				record,
				"OPERATION_RETAINED",
				message,
				record.session?.execution,
				record.session?.sessionId,
			);
		}
		return this.fail(
			record,
			"retained",
			"OPERATION_RETAINED",
			message,
			record.requestedBranch ?? undefined,
			record.session?.sessionId,
			record.session?.execution ?? this.bestKnownExecution(record),
		);
	}

	/**
	 * A terminal operation is immutable: replay exactly what was recorded and
	 * create nothing.
	 */
	private replayTerminal(record: ProjectStartOperationRecord): RunResult | undefined {
		if (record.phase === "failed" || record.phase === "retained") {
			if (!record.failure) {
				throw new ProjectStartError("OPERATION_RETAINED", "Operation has no replayable result");
			}
			throw terminalError(record.failure);
		}
		if (record.phase === "session_started") {
			if (!record.result) {
				throw new ProjectStartError("OPERATION_RETAINED", "Operation has no replayable result");
			}
			return record.result;
		}
		return undefined;
	}

	private recordedWorktree(record: WorktreeOperationRecord): RecordedManagedWorktree {
		return {
			repositoryRoot: record.repositoryRoot,
			destination: record.worktree.destination,
			selectedBaseRef: record.worktree.selectedBaseRef,
			selectedBaseCommit: record.worktree.selectedBaseCommit,
			projectRelativePath: record.worktree.projectRelativePath,
			requestedBranch: record.requestedBranch,
			ownershipToken: record.worktree.ownershipToken ?? null,
		};
	}

	private describeTruth(truth: ManagedWorktreeTruth): string {
		switch (truth.status) {
			case "changed":
			case "uncertain":
				return `The recorded worktree could not be confirmed: ${truth.reason}`;
			case "branch_only":
				return "The requested branch exists without its worktree; nothing was reused or deleted";
			case "absent":
				return "The recorded worktree is no longer present; nothing was reused or deleted. Start again to prepare a new one";
			default:
				return "The recorded worktree was retained";
		}
	}

	/**
	 * End an operation on inspection truth that cannot advance, naming only the
	 * resources that actually exist: a provably absent worktree retains nothing,
	 * and branch-only residue retains the branch rather than a missing path.
	 *
	 * `prefix` carries the failure that brought the operation here — a runtime
	 * launch error, say — so the caller reads both what went wrong and what the
	 * machine found when it looked.
	 */
	private failFromTruth(
		record: WorktreeOperationRecord,
		truth: ManagedWorktreeTruth,
		code = "OPERATION_RETAINED",
		prefix?: string,
	): never {
		const message = prefix
			? `${sentence(prefix)} ${this.describeTruth(truth)}`
			: this.describeTruth(truth);
		if (truth.status === "absent") {
			// Nothing survives, so this is a changed machine rather than retained
			// state: `OPERATION_RETAINED` would send the phone to inspect a
			// directory that is gone, while this code already reads as
			// "project changed, refresh and start again".
			return this.failTerminal(record, "STALE_PROJECT_STATE", message);
		}
		// `changed` spans both a destination the owner can still inspect and one
		// that is provably gone with only its branch left elsewhere, so the
		// inspection says which rather than the message being pattern-matched.
		const retainsPath =
			truth.status === "changed" ? truth.retainsDestination : truth.status !== "branch_only";
		return this.failWorktree(record, code, message, undefined, undefined, retainsPath);
	}

	/**
	 * Rollback of an exact, clean, unlaunched worktree. Intent is durable before
	 * the first destructive command and the proof is repeated inside it.
	 */
	private async rollbackWorktree(
		record: WorktreeOperationRecord,
		code: string,
		message: string,
	): Promise<never> {
		const truth = await this.managedWorktrees.inspectRecorded(this.recordedWorktree(record));
		// The same reporting rules as any other non-advancing truth: name only the
		// resources that exist, and say what the inspection found rather than
		// leaving the caller with the launch error alone.
		if (truth.status !== "exact") {
			return this.failFromTruth(record, truth, code, message);
		}
		const blocked = rollbackBlockedBy(truth);
		if (blocked) {
			return this.failWorktree(
				record,
				code,
				`${sentence(message)} The worktree at ${record.worktree.destination} was kept: ${blocked}`,
			);
		}
		const requested = this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "rollback_requested",
			updatedAt: Date.now(),
			rollback: { requestedAt: Date.now(), code, message },
		})) as WorktreeOperationRecord;
		return this.finishRollback(requested);
	}

	/**
	 * Continue a durably intended rollback from wherever it stopped. Every step
	 * re-proves before acting; a changed or uncertain remainder is retained.
	 */
	private async finishRollback(record: WorktreeOperationRecord): Promise<never> {
		const intent = record.rollback;
		if (!intent) {
			return this.failWorktree(
				record,
				"OPERATION_RETAINED",
				"Rollback intent is missing; the worktree was retained",
			);
		}
		const recorded = this.recordedWorktree(record);
		let current = record;
		if (current.phase === "rollback_requested") {
			// The removal may already have run and only its phase write been lost.
			// A provably absent worktree advances; it is not a reason to retain.
			const before = await this.managedWorktrees.inspectRecorded(recorded);
			const alreadyGone = before.status === "absent" || before.status === "branch_only";
			const removal = alreadyGone
				? ({ status: "removed" } as const)
				: await this.managedWorktrees.rollbackExact(recorded);
			if (removal.status === "retained") {
				return this.failWorktree(
					current,
					intent.code,
					`${intent.message} The worktree at ${recorded.destination} was kept: ${removal.reason}`,
				);
			}
			current = this.journal.update(current.operationId, (existing) => ({
				...existing,
				phase: "worktree_removed",
				updatedAt: Date.now(),
			})) as WorktreeOperationRecord;
		}
		const branch = await this.managedWorktrees.deleteRollbackBranch(recorded);
		if (branch.status === "retained") {
			return this.failWorktree(
				current,
				intent.code,
				`${intent.message} The worktree was removed, but the branch ${recorded.requestedBranch} was kept: ${branch.reason}`,
				undefined,
				undefined,
				false,
			);
		}
		const details: ProjectStartFailureDetails = {
			operationId: current.operationId,
			phase: "failed",
			originProjectPath: current.originProjectPath,
		};
		this.journal.update(current.operationId, (existing) => {
			const { rollback: _rollback, result: _result, ...rest } = existing;
			return {
				...rest,
				phase: "failed",
				updatedAt: Date.now(),
				failure: { code: intent.code, message: intent.message, details },
			};
		});
		throw new ProjectStartError(intent.code, intent.message, details);
	}

	private failManagedBeforeCreation(record: WorktreeOperationRecord, error: unknown): never {
		return this.failTerminal(
			record,
			error instanceof ManagedWorktreeError ? error.code : "WORKTREE_CREATE_FAILED",
			describeError(error),
		);
	}

	/** Terminal failure with no request-owned resource left behind to report. */
	private failTerminal(record: ProjectStartOperationRecord, code: string, message: string): never {
		const details: ProjectStartFailureDetails = {
			operationId: record.operationId,
			phase: "failed",
			originProjectPath: record.originProjectPath,
		};
		const failure = { code, message, details };
		this.journal.update(record.operationId, (current) => {
			const { rollback: _rollback, result: _result, ...rest } = current;
			return { ...rest, phase: "failed", updatedAt: Date.now(), failure };
		});
		throw new ProjectStartError(code, message, details);
	}

	private failWorktree(
		record: ProjectStartOperationRecord,
		code: string,
		message: string,
		effectiveState?: SessionExecutionState,
		createdSessionId?: string,
		retainPath = true,
	): never {
		if (record.mode !== "worktree") {
			throw new ProjectStartError(code, message);
		}
		const details: ProjectStartFailureDetails = {
			operationId: record.operationId,
			phase: "retained",
			originProjectPath: record.originProjectPath,
			...(retainPath ? { retainedWorktreePath: record.worktree.destination } : {}),
			...(record.requestedBranch ? { retainedBranch: record.requestedBranch } : {}),
			...(effectiveState ? { effectiveState } : {}),
			...(createdSessionId ? { createdSessionId } : {}),
		};
		const failure = { code, message, details };
		this.journal.update(record.operationId, (current) => {
			const { rollback: _rollback, result: _result, ...rest } = current;
			return { ...rest, phase: "retained", updatedAt: Date.now(), failure };
		});
		throw new ProjectStartError(code, message, details);
	}

	private async createAndActivateBranch(
		record: ProjectStartOperationRecord,
		preparation: Extract<ProjectStartRequest["preparation"], { type: "create_branch" }>,
		state: ProjectStartState,
		isReplay: boolean,
	): Promise<ProjectStartState> {
		if (!state.git) {
			return this.fail(
				record,
				"failed",
				"GIT_UNAVAILABLE",
				"This project is not in a Git working repository",
			);
		}
		if (state.git.head === null) {
			return this.fail(
				record,
				"failed",
				"UNBORN_HEAD",
				"Create an initial commit before creating a session branch",
			);
		}
		if (
			state.git.head !== preparation.expectedHead ||
			state.git.branch !== preparation.expectedBranch
		) {
			return this.fail(
				record,
				"failed",
				"STALE_PROJECT_STATE",
				"The project checkout no longer matches the presented commit and branch",
			);
		}

		const valid = await this.git(
			record.originProjectPath,
			["check-ref-format", "--branch", preparation.newBranch],
			true,
		);
		if (valid.exitCode !== 0) {
			return this.fail(
				record,
				"failed",
				"INVALID_BRANCH",
				`Invalid branch name: ${preparation.newBranch}`,
			);
		}
		const ref = `refs/heads/${preparation.newBranch}`;
		const exists = await this.git(
			record.originProjectPath,
			["show-ref", "--verify", "--quiet", ref],
			true,
		);
		if (exists.exitCode === 0) {
			if (isReplay) {
				return this.fail(
					record,
					"retained",
					"OPERATION_RETAINED",
					"The requested branch exists while its recorded creation phase is uncertain",
					preparation.newBranch,
					undefined,
					executionFor(state),
				);
			}
			return this.fail(
				record,
				"failed",
				"BRANCH_EXISTS",
				`Local branch already exists: ${preparation.newBranch}`,
			);
		}
		if (exists.exitCode !== 1) {
			throw this.gitFailure("Failed to check whether the requested branch exists");
		}

		const inProgressOperation = await this.findInProgressGitOperation(record.originProjectPath);
		if (inProgressOperation) {
			return this.fail(
				record,
				"failed",
				"REPOSITORY_OPERATION_IN_PROGRESS",
				`Finish or abort the in-progress ${inProgressOperation} operation before creating a session branch`,
			);
		}

		const transaction = await this.git(
			record.originProjectPath,
			["update-ref", "--stdin"],
			true,
			`verify HEAD ${preparation.expectedHead}\ncreate ${ref} ${preparation.expectedHead}\n`,
		);
		if (transaction.exitCode !== 0) {
			return this.fail(
				record,
				"failed",
				"STALE_PROJECT_STATE",
				"The checkout changed or the branch became unavailable before creation",
			);
		}
		this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "branch_created",
			updatedAt: Date.now(),
		}));
		return this.resumeBranchActivation(
			this.journal.get(record.operationId) ?? record,
			await this.inspectPostMutationState(this.journal.get(record.operationId) ?? record),
		);
	}

	private async resumeBranchActivation(
		record: ProjectStartOperationRecord,
		state: ProjectStartState,
	): Promise<ProjectStartState> {
		if (
			!record.repositoryRoot ||
			!record.requestedBranch ||
			!record.observedHead ||
			!state.git ||
			state.git.head !== record.observedHead ||
			state.git.branch !== record.observedBranch
		) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The created branch or checkout no longer matches the recorded operation",
				record.requestedBranch ?? undefined,
				undefined,
				state.git ? executionFor(state) : undefined,
			);
		}
		const ref = `refs/heads/${record.requestedBranch}`;
		const tip = await this.git(record.originProjectPath, ["rev-parse", "--verify", ref], true);
		if (tip.exitCode !== 0 || trimLine(tip.stdout) !== record.observedHead) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The created branch tip no longer matches the recorded commit",
				record.requestedBranch,
				undefined,
				executionFor(state),
			);
		}
		const inProgressOperation = await this.findInProgressGitOperation(record.originProjectPath);
		if (inProgressOperation) {
			return this.fail(
				record,
				"retained",
				"REPOSITORY_OPERATION_IN_PROGRESS",
				`The branch was created, but an in-progress ${inProgressOperation} operation must finish before it can be activated`,
				record.requestedBranch,
				undefined,
				executionFor(state),
			);
		}
		const activated = await this.git(
			record.originProjectPath,
			["symbolic-ref", "-m", "codemote project-folder branch start", "HEAD", ref],
			true,
		);
		if (activated.exitCode !== 0) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The branch was created but could not be activated",
				record.requestedBranch,
				undefined,
				executionFor(state),
			);
		}
		const activeState = await this.inspectPostMutationState(record);
		await this.verifyActivatedBranch(record, activeState);
		this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "branch_checked_out",
			updatedAt: Date.now(),
		}));
		return activeState;
	}

	private async verifyActivatedBranch(
		record: ProjectStartOperationRecord,
		state: ProjectStartState,
	): Promise<void> {
		if (
			!record.requestedBranch ||
			!record.observedHead ||
			!state.git ||
			state.git.head !== record.observedHead ||
			state.git.branch !== record.requestedBranch ||
			state.git.detached
		) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The active branch no longer matches the prepared operation",
				record.requestedBranch ?? undefined,
				undefined,
				state.git ? executionFor(state) : undefined,
			);
		}
		const tip = await this.git(
			record.originProjectPath,
			["rev-parse", "--verify", `refs/heads/${record.requestedBranch}`],
			true,
		);
		if (tip.exitCode !== 0 || trimLine(tip.stdout) !== record.observedHead) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The active branch tip no longer matches the prepared commit",
				record.requestedBranch,
				undefined,
				executionFor(state),
			);
		}
	}

	private async findInProgressGitOperation(cwd: string): Promise<string | null> {
		const gitDirectoryResult = await this.git(cwd, ["rev-parse", "--absolute-git-dir"], true);
		if (gitDirectoryResult.exitCode !== 0) {
			throw this.gitFailure("Failed to inspect repository operation state");
		}
		const gitDirectory = trimLine(gitDirectoryResult.stdout);
		if (!isAbsolute(gitDirectory)) {
			throw this.gitFailure("Failed to inspect repository operation state");
		}
		for (const marker of GIT_OPERATION_MARKERS) {
			try {
				await stat(resolve(gitDirectory, marker.path));
				return marker.operation;
			} catch (error) {
				if (!isMissingPath(error)) {
					throw this.gitFailure("Failed to inspect repository operation state");
				}
			}
		}
		return null;
	}

	private fail(
		record: ProjectStartOperationRecord,
		phase: "failed" | "retained",
		code: ProjectStartErrorCode,
		message: string,
		retainedBranch?: string,
		createdSessionId?: string,
		effectiveState?: SessionExecutionState,
	): never {
		const details: ProjectStartFailureDetails = {
			operationId: record.operationId,
			phase,
			originProjectPath: record.originProjectPath,
			...(effectiveState ? { effectiveState } : {}),
			...(retainedBranch ? { retainedBranch } : {}),
			...(createdSessionId ? { createdSessionId } : {}),
		};
		const failure: ProjectStartJournalFailure = { code, message, details };
		this.journal.update(record.operationId, (current) => {
			const { result: _result, rollback: _rollback, ...rest } = current;
			return {
				...rest,
				phase,
				updatedAt: Date.now(),
				failure,
			};
		});
		throw new ProjectStartError(code, message, details);
	}

	private async inspectPostMutationState(
		record: ProjectStartOperationRecord,
	): Promise<ProjectStartState> {
		const bestKnown = this.bestKnownExecution(record);
		if (!this.registry.get(record.originProjectPath)) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The project is no longer registered; the prepared operation will not launch",
				record.requestedBranch ?? undefined,
				record.result?.sessionId ?? record.session?.sessionId,
				bestKnown,
			);
		}

		let git: GitCheckoutState | null;
		try {
			await this.requireDirectory(record.originProjectPath);
			// A non-Git project has no Git truth to reconcile; requiring it here
			// would retain a prepared start that never touched a repository.
			git =
				record.repositoryRoot === null
					? null
					: await this.inspectGit(record.originProjectPath, true);
		} catch (error) {
			if (error instanceof ProjectStartError) {
				return this.fail(
					record,
					"retained",
					"OPERATION_RETAINED",
					"The prepared project could not be inspected; the operation will not launch",
					record.requestedBranch ?? undefined,
					record.result?.sessionId ?? record.session?.sessionId,
					bestKnown,
				);
			}
			throw error;
		}
		// Only an operation that recorded a repository can lose one. A project that
		// was never in Git has nothing to reconcile and must still resume.
		if (record.repositoryRoot !== null && !git) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The prepared project is no longer a Git working repository",
				record.requestedBranch ?? undefined,
				record.result?.sessionId ?? record.session?.sessionId,
				bestKnown,
			);
		}
		return {
			originProjectPath: record.originProjectPath,
			mode: "project_folder",
			directory: record.originProjectPath,
			git,
			worktree: null,
		};
	}

	private bestKnownExecution(record: ProjectStartOperationRecord): SessionExecutionState {
		if (record.failure?.details?.effectiveState) {
			return record.failure.details.effectiveState;
		}
		if (record.result?.execution) return record.result.execution;
		if (record.session) return record.session.execution;
		const branch =
			record.requestedBranch && record.phase !== "branch_created"
				? record.requestedBranch
				: record.observedBranch;
		return {
			directory: record.originProjectPath,
			mode: "project_folder",
			git: record.repositoryRoot
				? {
						repositoryRoot: record.repositoryRoot,
						head: record.observedHead,
						branch,
						detached: record.observedHead !== null && branch === null,
					}
				: null,
		};
	}

	private normalizeOptions(
		options: RunOptions,
	): RunOptions & { projectStart: ProjectStartRequest } {
		const request = options.projectStart;
		if (!request || typeof request !== "object") {
			throw new ProjectStartError("INVALID_PROJECT_START", "Project start request is required");
		}
		if (
			typeof request.operationId !== "string" ||
			request.operationId.length === 0 ||
			typeof request.originProjectPath !== "string" ||
			!isAbsolute(request.originProjectPath) ||
			(request.mode !== "project_folder" && request.mode !== "worktree")
		) {
			throw new ProjectStartError("INVALID_PROJECT_START", "Invalid project start request");
		}
		const originProjectPath = resolve(request.originProjectPath);
		if (resolve(options.workspace) !== originProjectPath) {
			throw new ProjectStartError(
				"INVALID_PROJECT_START",
				"Project start workspace must match the registered origin",
			);
		}
		if (options.resumeSessionId !== undefined) {
			throw new ProjectStartError(
				"INVALID_PROJECT_START",
				"Project-aware starts must create a fresh runtime session",
			);
		}
		const preparation = request.preparation;
		if (!preparation || typeof preparation !== "object") {
			throw new ProjectStartError("INVALID_PROJECT_START", "Invalid project preparation");
		}
		if (request.mode === "worktree") {
			if (
				preparation.type !== "create_worktree" ||
				typeof preparation.baseRef !== "string" ||
				!(
					/^refs\/heads\/[^\s]+$/u.test(preparation.baseRef) ||
					/^refs\/remotes\/[^/\s]+\/[^\s]+$/u.test(preparation.baseRef)
				) ||
				preparation.baseRef.endsWith("/HEAD") ||
				typeof preparation.expectedCommit !== "string" ||
				!/^[0-9a-fA-F]{40,64}$/u.test(preparation.expectedCommit) ||
				!(
					preparation.newBranch === null ||
					(typeof preparation.newBranch === "string" && preparation.newBranch.length > 0)
				)
			) {
				throw new ProjectStartError("INVALID_PROJECT_START", "Invalid worktree preparation");
			}
			return {
				...options,
				workspace: originProjectPath,
				projectStart: {
					operationId: request.operationId,
					originProjectPath,
					mode: "worktree",
					preparation: {
						type: "create_worktree",
						baseRef: preparation.baseRef,
						expectedCommit: preparation.expectedCommit.toLowerCase(),
						newBranch: preparation.newBranch,
					},
				},
			};
		}
		let normalizedPreparation: Extract<
			ProjectStartRequest,
			{ mode: "project_folder" }
		>["preparation"];
		if (preparation.type === "none") {
			if (
				"newBranch" in preparation ||
				"expectedHead" in preparation ||
				"expectedBranch" in preparation
			) {
				throw new ProjectStartError("INVALID_PROJECT_START", "Invalid no-branch preparation");
			}
			normalizedPreparation = { type: "none" };
		} else if (
			preparation.type === "create_branch" &&
			typeof preparation.newBranch === "string" &&
			preparation.newBranch.length > 0 &&
			typeof preparation.expectedHead === "string" &&
			preparation.expectedHead.length > 0 &&
			(preparation.expectedBranch === null ||
				(typeof preparation.expectedBranch === "string" && preparation.expectedBranch.length > 0))
		) {
			normalizedPreparation = {
				type: "create_branch",
				newBranch: preparation.newBranch,
				expectedHead: preparation.expectedHead,
				expectedBranch: preparation.expectedBranch,
			};
		} else {
			throw new ProjectStartError("INVALID_PROJECT_START", "Invalid branch preparation");
		}
		return {
			...options,
			workspace: originProjectPath,
			projectStart: {
				operationId: request.operationId,
				originProjectPath,
				mode: "project_folder",
				preparation: normalizedPreparation,
			},
		};
	}

	private fingerprint(options: RunOptions & { projectStart: ProjectStartRequest }): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					runtime: options.profile,
					workspace: options.workspace,
					initialPrompt: options.initialPrompt,
					model: options.model ?? null,
					temperature: options.temperature ?? null,
					maxTokens: options.maxTokens ?? null,
					projectStart: options.projectStart,
				}),
			)
			.digest("hex");
	}

	private requireRegisteredPath(projectPath: string): string {
		if (typeof projectPath !== "string" || !isAbsolute(projectPath)) {
			throw new ProjectStartError("INVALID_PROJECT_START", "Project path must be absolute");
		}
		const normalized = resolve(projectPath);
		if (!this.registry.get(normalized)) {
			throw new ProjectStartError(
				"PROJECT_NOT_REGISTERED",
				`Project is not registered: ${normalized}`,
			);
		}
		return normalized;
	}

	private async requireDirectory(projectPath: string): Promise<void> {
		try {
			if (!(await stat(projectPath)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new ProjectStartError(
				"PROJECT_PATH_UNAVAILABLE",
				`Project folder is unavailable: ${projectPath}`,
			);
		}
	}

	private async inspectGit(
		projectPath: string,
		requireGit: boolean,
		signal?: AbortSignal,
	): Promise<GitCheckoutState | null> {
		let inside: GitCommandResult;
		try {
			inside = await this.runGit(
				projectPath,
				["rev-parse", "--is-inside-work-tree"],
				undefined,
				signal,
			);
		} catch (error) {
			if (error instanceof GitProcessError && error.kind === "unavailable" && !requireGit) {
				return null;
			}
			throw this.mapGitError(error);
		}
		if (inside.exitCode !== 0) {
			if (isNotRepository(inside)) return null;
			throw this.gitFailure("Failed to inspect the project working tree");
		}
		if (trimLine(inside.stdout) !== "true") return null;

		const bare = await this.git(
			projectPath,
			["rev-parse", "--is-bare-repository"],
			requireGit,
			undefined,
			signal,
		);
		if (bare.exitCode !== 0) throw this.gitFailure("Failed to inspect repository type");
		if (trimLine(bare.stdout) === "true") return null;

		const rootResult = await this.git(
			projectPath,
			["rev-parse", "--show-toplevel"],
			requireGit,
			undefined,
			signal,
		);
		if (rootResult.exitCode !== 0) throw this.gitFailure("Failed to locate repository root");
		const repositoryRoot = resolve(trimLine(rootResult.stdout));

		const headResult = await this.git(
			projectPath,
			["rev-parse", "--verify", "HEAD"],
			requireGit,
			undefined,
			signal,
		);
		let head: string | null;
		if (headResult.exitCode === 0) head = trimLine(headResult.stdout);
		else if (headResult.exitCode === 128) head = null;
		else throw this.gitFailure("Failed to inspect repository HEAD");

		const branchResult = await this.git(
			projectPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			requireGit,
			undefined,
			signal,
		);
		let branch: string | null;
		if (branchResult.exitCode === 0) branch = trimLine(branchResult.stdout);
		else if (branchResult.exitCode === 1) branch = null;
		else throw this.gitFailure("Failed to inspect repository branch");

		return {
			repositoryRoot,
			head,
			branch,
			detached: head !== null && branch === null,
		};
	}

	private async git(
		cwd: string,
		args: string[],
		requireGit: boolean,
		input?: string,
		signal?: AbortSignal,
	): Promise<GitCommandResult> {
		try {
			return await this.runGit(cwd, args, input, signal);
		} catch (error) {
			if (error instanceof GitProcessError && error.kind === "unavailable" && !requireGit) {
				return { exitCode: 127, stdout: "", stderr: "Git unavailable" };
			}
			throw this.mapGitError(error);
		}
	}

	private mapGitError(error: unknown): ProjectStartError {
		if (error instanceof GitProcessError) {
			if (error.kind === "unavailable") {
				return new ProjectStartError("GIT_UNAVAILABLE", "Git is unavailable on this machine");
			}
			if (error.kind === "timeout") {
				return new ProjectStartError("GIT_TIMEOUT", "Git inspection timed out");
			}
			if (error.kind === "aborted") {
				return new ProjectStartError("OPERATION_ABORTED", "Project start inspection was aborted");
			}
		}
		return this.gitFailure("Git inspection failed");
	}

	private gitFailure(message: string): ProjectStartError {
		return new ProjectStartError("GIT_COMMAND_FAILED", message);
	}

	private mapManagedError(error: unknown): ProjectStartError {
		if (error instanceof ManagedWorktreeError) {
			return new ProjectStartError(error.code, error.message);
		}
		return new ProjectStartError(
			"WORKTREE_DESTINATION_UNAVAILABLE",
			error instanceof Error ? error.message : String(error),
		);
	}

	private mapManagedGitError(error: unknown): ProjectStartError {
		return error instanceof ManagedWorktreeError
			? new ProjectStartError(error.code, error.message)
			: this.mapGitError(error);
	}

	private async withRepositoryLock<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.repositoryTails.get(key) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const tail = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const queued = previous.then(() => tail);
		this.repositoryTails.set(key, queued);
		await previous;
		try {
			return await task();
		} finally {
			release?.();
			if (this.repositoryTails.get(key) === queued) this.repositoryTails.delete(key);
		}
	}
}
