import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
import type { ProjectRegistry } from "./projectRegistry.js";
import type {
	ProjectStartJournal,
	ProjectStartJournalFailure,
	ProjectStartOperationRecord,
} from "./projectStartJournal.js";
import type { SessionManager } from "./session.js";
import type { SessionStartContext } from "./types.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_MAX_BYTES = 64 * 1024;
const GIT_TERMINATE_GRACE_MS = 100;
const GIT_REAP_TIMEOUT_MS = 1_000;

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
) => Promise<GitCommandResult>;

export interface ProjectStartCoordinatorOptions {
	journal: ProjectStartJournal;
	registry: ProjectRegistry;
	sessionManager: SessionManager;
	runGit?: GitCommandRunner;
}

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
	| "GIT_COMMAND_FAILED"
	| "INVALID_BRANCH"
	| "BRANCH_EXISTS"
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
		readonly kind: "unavailable" | "timeout" | "output_limit" | "spawn",
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
	return environment;
}

export function runGitCommand(
	cwd: string,
	args: string[],
	input?: string,
): Promise<GitCommandResult> {
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

function terminalError(failure: ProjectStartJournalFailure): ProjectStartError {
	return new ProjectStartError(failure.code, failure.message, failure.details);
}

export class ProjectStartCoordinator {
	private readonly journal: ProjectStartJournal;
	private readonly registry: ProjectRegistry;
	private readonly sessionManager: SessionManager;
	private readonly runGit: GitCommandRunner;
	private readonly inFlight = new Map<string, InFlightOperation>();
	private readonly repositoryTails = new Map<string, Promise<void>>();

	constructor(options: ProjectStartCoordinatorOptions) {
		this.journal = options.journal;
		this.registry = options.registry;
		this.sessionManager = options.sessionManager;
		this.runGit = options.runGit ?? runGitCommand;
	}

	async inspect(projectPath: string): Promise<ProjectStartState> {
		const normalizedPath = this.requireRegisteredPath(projectPath);
		await this.requireDirectory(normalizedPath);
		const git = await this.inspectGit(normalizedPath, false);
		return {
			originProjectPath: normalizedPath,
			mode: "project_folder",
			directory: normalizedPath,
			git,
		};
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
				this.reconcileAndLaunch(options, existing, launch, true),
			);
		}

		const state = await this.inspect(request.originProjectPath);
		const now = Date.now();
		record = this.journal.create({
			operationId: request.operationId,
			fingerprint,
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

	private async reconcileAndLaunch(
		options: RunOptions & { projectStart: ProjectStartRequest },
		initialRecord: ProjectStartOperationRecord,
		launch: LaunchProjectSession,
		isReplay: boolean,
	): Promise<RunResult> {
		let record = this.journal.get(initialRecord.operationId) ?? initialRecord;
		const request = options.projectStart;

		if (record.phase === "failed" || record.phase === "retained") {
			if (!record.failure) {
				throw new ProjectStartError("OPERATION_RETAINED", "Operation has no replayable result");
			}
			throw terminalError(record.failure);
		}
		if (record.phase === "session_started") {
			if (record.result && this.sessionManager.get(record.result.sessionId)) return record.result;
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The recorded session is no longer present; the operation will not launch again",
				record.requestedBranch ?? undefined,
				record.result?.sessionId,
			);
		}
		if (record.phase === "launch_requested") {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"Runtime launch may already have started; the operation will not launch again",
				record.requestedBranch ?? undefined,
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
		} else if (record.phase === "branch_checked_out") {
			await this.verifyActivatedBranch(record, state);
		}

		const effective = executionFor(state);
		record = this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "launch_requested",
			updatedAt: Date.now(),
		}));

		let launched: RunResult;
		try {
			launched = await launch(options, {
				originProjectPath: record.originProjectPath,
				execution: effective,
			});
		} catch (error) {
			const createdSessionId = error instanceof ExecutorStartError ? error.sessionId : undefined;
			const message = error instanceof Error ? error.message : String(error);
			if (record.requestedBranch) {
				return this.fail(
					record,
					"retained",
					"RUNTIME_LAUNCH_FAILED",
					message,
					record.requestedBranch,
					createdSessionId,
					effective,
				);
			}
			return this.fail(
				record,
				"failed",
				"RUNTIME_LAUNCH_FAILED",
				message,
				undefined,
				createdSessionId,
				effective,
			);
		}

		const result: RunResult = {
			...launched,
			operationId: record.operationId,
			originProjectPath: record.originProjectPath,
			execution: effective,
		};
		this.journal.update(record.operationId, (current) => ({
			...current,
			phase: "session_started",
			updatedAt: Date.now(),
			result,
		}));
		return result;
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
			const { result: _result, ...rest } = current;
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
				record.result?.sessionId,
				bestKnown,
			);
		}

		let git: GitCheckoutState | null;
		try {
			await this.requireDirectory(record.originProjectPath);
			git = await this.inspectGit(record.originProjectPath, true);
		} catch (error) {
			if (error instanceof ProjectStartError) {
				return this.fail(
					record,
					"retained",
					"OPERATION_RETAINED",
					"The prepared project could not be inspected; the operation will not launch",
					record.requestedBranch ?? undefined,
					record.result?.sessionId,
					bestKnown,
				);
			}
			throw error;
		}
		if (!git) {
			return this.fail(
				record,
				"retained",
				"OPERATION_RETAINED",
				"The prepared project is no longer a Git working repository",
				record.requestedBranch ?? undefined,
				record.result?.sessionId,
				bestKnown,
			);
		}
		return {
			originProjectPath: record.originProjectPath,
			mode: "project_folder",
			directory: record.originProjectPath,
			git,
		};
	}

	private bestKnownExecution(record: ProjectStartOperationRecord): SessionExecutionState {
		if (record.failure?.details?.effectiveState) {
			return record.failure.details.effectiveState;
		}
		if (record.result?.execution) return record.result.execution;
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
			request.mode !== "project_folder" ||
			typeof request.originProjectPath !== "string" ||
			!isAbsolute(request.originProjectPath)
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
		let normalizedPreparation: ProjectStartRequest["preparation"];
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
	): Promise<GitCheckoutState | null> {
		let inside: GitCommandResult;
		try {
			inside = await this.runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
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

		const bare = await this.git(projectPath, ["rev-parse", "--is-bare-repository"], requireGit);
		if (bare.exitCode !== 0) throw this.gitFailure("Failed to inspect repository type");
		if (trimLine(bare.stdout) === "true") return null;

		const rootResult = await this.git(projectPath, ["rev-parse", "--show-toplevel"], requireGit);
		if (rootResult.exitCode !== 0) throw this.gitFailure("Failed to locate repository root");
		const repositoryRoot = resolve(trimLine(rootResult.stdout));

		const headResult = await this.git(projectPath, ["rev-parse", "--verify", "HEAD"], requireGit);
		let head: string | null;
		if (headResult.exitCode === 0) head = trimLine(headResult.stdout);
		else if (headResult.exitCode === 128) head = null;
		else throw this.gitFailure("Failed to inspect repository HEAD");

		const branchResult = await this.git(
			projectPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			requireGit,
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
	): Promise<GitCommandResult> {
		try {
			return await this.runGit(cwd, args, input);
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
		}
		return this.gitFailure("Git inspection failed");
	}

	private gitFailure(message: string): ProjectStartError {
		return new ProjectStartError("GIT_COMMAND_FAILED", message);
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
