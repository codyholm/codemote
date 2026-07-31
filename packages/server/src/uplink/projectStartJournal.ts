import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	ProjectStartFailureDetails,
	ProjectStartPhase,
	RunResult,
	RuntimeType,
	SessionExecutionState,
} from "@codemote/common";
import {
	restrictDirPermissions,
	restrictFilePermissions,
} from "../relay/services/win-permissions.js";
import type { DurableProjectSession } from "./types.js";

export interface ProjectStartJournalFailure {
	code: string;
	message: string;
	details?: ProjectStartFailureDetails;
}

/**
 * Intent to remove an exact, clean, unlaunched managed worktree, plus the
 * original launch failure the operation ends with once rollback completes.
 */
export interface ProjectStartRollbackIntent {
	requestedAt: number;
	code: string;
	message: string;
}

/**
 * Server-internal phases. The mobile protocol keeps the landed
 * `ProjectStartPhase`; the session, runtime-launch and rollback boundaries below
 * exist only in the journal and are reported to a caller as `failed`/`retained`.
 */
export type ProjectStartJournalPhase =
	| ProjectStartPhase
	| "session_recorded"
	| "runtime_launch_requested"
	| "rollback_requested"
	| "worktree_removed";

interface ProjectStartOperationBase {
	operationId: string;
	fingerprint: string;
	/**
	 * Which writer last recorded this record's phase. A landed version-1
	 * `launch_requested` may already have entered runtime code, because that build
	 * had no boundary between preparation and the runtime call; a version-2 one
	 * provably has not.
	 */
	recordVersion: 1 | 2;
	originProjectPath: string;
	runtime: RuntimeType;
	repositoryRoot: string | null;
	observedHead: string | null;
	observedBranch: string | null;
	requestedBranch: string | null;
	phase: ProjectStartJournalPhase;
	createdAt: number;
	updatedAt: number;
	session?: DurableProjectSession;
	rollback?: ProjectStartRollbackIntent;
	result?: RunResult;
	failure?: ProjectStartJournalFailure;
}

export interface ProjectFolderStartOperationRecord extends ProjectStartOperationBase {
	mode: "project_folder";
}

export interface ManagedWorktreeOperationRecord extends ProjectStartOperationBase {
	mode: "worktree";
	repositoryRoot: string;
	worktree: {
		destination: string;
		selectedBaseRef: string;
		selectedBaseCommit: string;
		projectRelativePath: string;
	};
}

export type ProjectStartOperationRecord =
	| ProjectFolderStartOperationRecord
	| ManagedWorktreeOperationRecord;

type ProjectStartJournalErrorCode =
	| "INVALID_PROJECT_START_JOURNAL"
	| "PROJECT_START_JOURNAL_IO"
	| "OPERATION_CONFLICT"
	| "OPERATION_NOT_FOUND";

type ProjectStartJournalVersion = 1 | 2;

interface ProjectStartJournalFile {
	version: 2;
	operations: ProjectStartOperationRecord[];
}

export class ProjectStartJournalError extends Error {
	constructor(
		readonly code: ProjectStartJournalErrorCode,
		message: string,
		readonly details?: ProjectStartFailureDetails,
	) {
		super(message);
		this.name = "ProjectStartJournalError";
	}
}

function invalid(message = "Invalid project start operation journal"): never {
	throw new ProjectStartJournalError("INVALID_PROJECT_START_JOURNAL", message);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(`Invalid journal field: ${field}`);
	return value;
}

function nullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requiredString(value, field);
}

function absolutePath(value: unknown, field: string): string {
	const path = requiredString(value, field);
	if (!isAbsolute(path)) invalid(`Invalid journal field: ${field}`);
	return resolve(path);
}

function timestamp(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		invalid(`Invalid journal field: ${field}`);
	}
	return value;
}

function runtime(value: unknown): RuntimeType {
	if (value === "opencode" || value === "claude" || value === "codex" || value === "gemini") {
		return value;
	}
	return invalid("Invalid journal field: runtime");
}

function isMobilePhase(value: unknown): value is ProjectStartPhase {
	return (
		value === "recorded" ||
		value === "branch_created" ||
		value === "branch_checked_out" ||
		value === "worktree_created" ||
		value === "worktree_ready" ||
		value === "launch_requested" ||
		value === "session_started" ||
		value === "failed" ||
		value === "retained"
	);
}

function phase(value: unknown): ProjectStartPhase {
	if (isMobilePhase(value)) return value;
	return invalid("Invalid journal field: phase");
}

function journalPhase(
	value: unknown,
	version: ProjectStartJournalVersion,
): ProjectStartJournalPhase {
	if (isMobilePhase(value)) return value;
	if (
		version === 2 &&
		(value === "session_recorded" ||
			value === "runtime_launch_requested" ||
			value === "rollback_requested" ||
			value === "worktree_removed")
	) {
		return value;
	}
	return invalid("Invalid journal field: phase");
}

/**
 * Every phase change this writer is allowed to record, keyed by current phase.
 * Re-recording the same phase is always allowed; it is how a record is
 * re-timestamped or given a late runtime-native session ID.
 *
 * The table exists so no future path can skip a durable boundary: a session
 * cannot appear without a prepared launch, a runtime launch cannot be recorded
 * without a session, and a terminal record can never be reopened. Loading is
 * unaffected, so records written by older builds stay readable.
 */
const ALLOWED_TRANSITIONS: Record<ProjectStartJournalPhase, readonly ProjectStartJournalPhase[]> = {
	recorded: ["branch_created", "worktree_created", "launch_requested", "failed", "retained"],
	branch_created: ["branch_checked_out", "failed", "retained"],
	branch_checked_out: ["launch_requested", "failed", "retained"],
	worktree_created: ["worktree_ready", "failed", "retained"],
	worktree_ready: ["launch_requested", "failed", "retained"],
	// `session_started` direct from here covers a launch callback that recorded
	// no session of its own; it still ends as exactly one recorded session.
	launch_requested: [
		"session_recorded",
		"session_started",
		"rollback_requested",
		"failed",
		"retained",
	],
	session_recorded: ["runtime_launch_requested", "failed", "retained"],
	runtime_launch_requested: ["session_started", "failed", "retained"],
	rollback_requested: ["worktree_removed", "failed", "retained"],
	worktree_removed: ["failed", "retained"],
	session_started: [],
	failed: [],
	retained: [],
};

/**
 * The phase a caller is allowed to see. Internal boundaries collapse onto the
 * landed protocol value that carries the same meaning for the phone.
 */
export function mobilePhase(value: ProjectStartJournalPhase): ProjectStartPhase {
	switch (value) {
		case "session_recorded":
		case "runtime_launch_requested":
			return "launch_requested";
		case "rollback_requested":
		case "worktree_removed":
			return "retained";
		default:
			return value;
	}
}

function parseExecution(value: unknown): SessionExecutionState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal result execution");
	}
	const candidate = value as Record<string, unknown>;
	if (candidate["mode"] !== "project_folder" && candidate["mode"] !== "worktree") {
		invalid("Invalid journal result execution mode");
	}
	const gitValue = candidate["git"];
	let git: SessionExecutionState["git"] = null;
	if (gitValue !== null) {
		if (!gitValue || typeof gitValue !== "object" || Array.isArray(gitValue)) {
			return invalid("Invalid journal result Git state");
		}
		const gitCandidate = gitValue as Record<string, unknown>;
		if (typeof gitCandidate["detached"] !== "boolean") {
			return invalid("Invalid journal result Git detached state");
		}
		const head = nullableString(gitCandidate["head"], "head");
		const branch = nullableString(gitCandidate["branch"], "branch");
		const detached = gitCandidate["detached"];
		if (detached !== (head !== null && branch === null)) {
			return invalid("Invalid journal result Git checkout state");
		}
		git = {
			repositoryRoot: absolutePath(gitCandidate["repositoryRoot"], "repositoryRoot"),
			head,
			branch,
			detached,
		};
	}
	const base = {
		directory: absolutePath(candidate["directory"], "directory"),
		git,
	};
	if (candidate["mode"] === "project_folder") return { ...base, mode: "project_folder" };
	if (!git) return invalid("Invalid Worktree journal result Git state");
	const worktreeValue = candidate["worktree"];
	if (!worktreeValue || typeof worktreeValue !== "object" || Array.isArray(worktreeValue)) {
		return invalid("Invalid Worktree journal result ownership");
	}
	const worktree = worktreeValue as Record<string, unknown>;
	return {
		directory: base.directory,
		git,
		mode: "worktree",
		worktree: {
			path: absolutePath(worktree["path"], "execution.worktree.path"),
			baseRef: requiredString(worktree["baseRef"], "execution.worktree.baseRef"),
			baseCommit: requiredString(worktree["baseCommit"], "execution.worktree.baseCommit"),
		},
	};
}

function parseResult(value: unknown): RunResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal terminal result");
	}
	const candidate = value as Record<string, unknown>;
	const result: RunResult = {
		runId: requiredString(candidate["runId"], "result.runId"),
		sessionId: requiredString(candidate["sessionId"], "result.sessionId"),
	};
	if (candidate["operationId"] !== undefined) {
		result.operationId = requiredString(candidate["operationId"], "result.operationId");
	}
	if (candidate["originProjectPath"] !== undefined) {
		result.originProjectPath = absolutePath(
			candidate["originProjectPath"],
			"result.originProjectPath",
		);
	}
	if (candidate["execution"] !== undefined)
		result.execution = parseExecution(candidate["execution"]);
	return result;
}

function parseSession(value: unknown): DurableProjectSession {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal durable session");
	}
	const candidate = value as Record<string, unknown>;
	const session: DurableProjectSession = {
		sessionId: requiredString(candidate["sessionId"], "session.sessionId"),
		runId: requiredString(candidate["runId"], "session.runId"),
		workspaceId: requiredString(candidate["workspaceId"], "session.workspaceId"),
		createdAt: timestamp(candidate["createdAt"], "session.createdAt"),
		execution: parseExecution(candidate["execution"]),
	};
	if (candidate["runtimeSessionId"] !== undefined) {
		session.runtimeSessionId = requiredString(
			candidate["runtimeSessionId"],
			"session.runtimeSessionId",
		);
	}
	return session;
}

function parseRollback(value: unknown): ProjectStartRollbackIntent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal rollback intent");
	}
	const candidate = value as Record<string, unknown>;
	return {
		requestedAt: timestamp(candidate["requestedAt"], "rollback.requestedAt"),
		code: requiredString(candidate["code"], "rollback.code"),
		message: requiredString(candidate["message"], "rollback.message"),
	};
}

function parseFailureDetails(value: unknown): ProjectStartFailureDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal failure details");
	}
	const candidate = value as Record<string, unknown>;
	const details: ProjectStartFailureDetails = {
		operationId: requiredString(candidate["operationId"], "failure.operationId"),
		phase: phase(candidate["phase"]),
		originProjectPath: absolutePath(candidate["originProjectPath"], "failure.originProjectPath"),
	};
	if (candidate["effectiveState"] !== undefined) {
		details.effectiveState = parseExecution(candidate["effectiveState"]);
	}
	if (candidate["retainedBranch"] !== undefined) {
		details.retainedBranch = requiredString(candidate["retainedBranch"], "failure.retainedBranch");
	}
	if (candidate["retainedWorktreePath"] !== undefined) {
		details.retainedWorktreePath = absolutePath(
			candidate["retainedWorktreePath"],
			"failure.retainedWorktreePath",
		);
	}
	if (candidate["createdSessionId"] !== undefined) {
		details.createdSessionId = requiredString(
			candidate["createdSessionId"],
			"failure.createdSessionId",
		);
	}
	return details;
}

function parseFailure(value: unknown): ProjectStartJournalFailure {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal terminal failure");
	}
	const candidate = value as Record<string, unknown>;
	const failure: ProjectStartJournalFailure = {
		code: requiredString(candidate["code"], "failure.code"),
		message: requiredString(candidate["message"], "failure.message"),
	};
	if (candidate["details"] !== undefined) {
		failure.details = parseFailureDetails(candidate["details"]);
	}
	return failure;
}

function isConsistentWorktreeExecution(
	record: ManagedWorktreeOperationRecord,
	execution: SessionExecutionState,
): boolean {
	return (
		execution.mode === "worktree" &&
		execution.directory ===
			resolve(record.worktree.destination, record.worktree.projectRelativePath) &&
		execution.worktree.path === record.worktree.destination &&
		execution.worktree.baseRef === record.worktree.selectedBaseRef &&
		execution.worktree.baseCommit === record.worktree.selectedBaseCommit &&
		execution.git.repositoryRoot === record.worktree.destination &&
		execution.git.head === record.worktree.selectedBaseCommit &&
		execution.git.branch === record.requestedBranch &&
		execution.git.detached === (record.requestedBranch === null)
	);
}

function recordVersion(value: unknown, version: ProjectStartJournalVersion): 1 | 2 {
	if (version === 1) return 1;
	if (value === undefined || value === 2) return 2;
	if (value === 1) return 1;
	return invalid("Invalid journal field: recordVersion");
}

/**
 * One rule for every execution tuple a record can own, so a durable session and
 * the terminal result it produced cannot describe different directories.
 */
function assertConsistentExecution(
	record: ProjectStartOperationRecord,
	execution: SessionExecutionState | undefined,
): void {
	if (!execution || execution.mode !== record.mode) {
		invalid("Journal record has an inconsistent execution mode");
	}
	if (record.mode === "worktree") {
		if (!isConsistentWorktreeExecution(record, execution)) {
			invalid("Worktree journal record has inconsistent ownership");
		}
		return;
	}
	if (execution.directory !== record.originProjectPath) {
		invalid("Journal record has an inconsistent execution directory");
	}
	if (record.repositoryRoot === null) {
		if (execution.git !== null) {
			invalid("Non-Git journal record contains Git execution state");
		}
		return;
	}
	const expectedBranch = record.requestedBranch ?? record.observedBranch;
	if (
		!execution.git ||
		execution.git.repositoryRoot !== record.repositoryRoot ||
		execution.git.head !== record.observedHead ||
		execution.git.branch !== expectedBranch ||
		execution.git.detached !== (execution.git.head !== null && execution.git.branch === null)
	) {
		invalid("Journal record has inconsistent Git execution state");
	}
}

function parseRecord(
	value: unknown,
	version: ProjectStartJournalVersion = 2,
): ProjectStartOperationRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid project start operation record");
	}
	const candidate = value as Record<string, unknown>;
	if (candidate["mode"] !== "project_folder" && candidate["mode"] !== "worktree") {
		invalid("Invalid journal field: mode");
	}
	const repositoryRoot =
		candidate["repositoryRoot"] === null
			? null
			: absolutePath(candidate["repositoryRoot"], "repositoryRoot");
	const parsedVersion = recordVersion(candidate["recordVersion"], version);
	const common = {
		operationId: requiredString(candidate["operationId"], "operationId"),
		fingerprint: requiredString(candidate["fingerprint"], "fingerprint"),
		recordVersion: parsedVersion,
		originProjectPath: absolutePath(candidate["originProjectPath"], "originProjectPath"),
		runtime: runtime(candidate["runtime"]),
		repositoryRoot,
		observedHead: nullableString(candidate["observedHead"], "observedHead"),
		observedBranch: nullableString(candidate["observedBranch"], "observedBranch"),
		requestedBranch: nullableString(candidate["requestedBranch"], "requestedBranch"),
		phase: journalPhase(candidate["phase"], parsedVersion),
		createdAt: timestamp(candidate["createdAt"], "createdAt"),
		updatedAt: timestamp(candidate["updatedAt"], "updatedAt"),
	};
	let record: ProjectStartOperationRecord;
	if (candidate["mode"] === "project_folder") {
		record = { ...common, mode: "project_folder" };
	} else {
		if (!repositoryRoot) invalid("Worktree operation is missing its source repository");
		const value = candidate["worktree"];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return invalid("Invalid Worktree ownership record");
		}
		const worktree = value as Record<string, unknown>;
		const projectRelativePath = worktree["projectRelativePath"];
		if (typeof projectRelativePath !== "string") {
			invalid("Invalid journal field: worktree.projectRelativePath");
		}
		if (isAbsolute(projectRelativePath) || projectRelativePath.split(/[\\/]/u).includes("..")) {
			invalid("Invalid Worktree project relative path");
		}
		record = {
			...common,
			mode: "worktree",
			repositoryRoot,
			worktree: {
				destination: absolutePath(worktree["destination"], "worktree.destination"),
				selectedBaseRef: requiredString(worktree["selectedBaseRef"], "worktree.selectedBaseRef"),
				selectedBaseCommit: requiredString(
					worktree["selectedBaseCommit"],
					"worktree.selectedBaseCommit",
				),
				projectRelativePath,
			},
		};
	}
	if (candidate["session"] !== undefined) record.session = parseSession(candidate["session"]);
	if (candidate["rollback"] !== undefined) record.rollback = parseRollback(candidate["rollback"]);
	if (candidate["result"] !== undefined) record.result = parseResult(candidate["result"]);
	if (candidate["failure"] !== undefined) record.failure = parseFailure(candidate["failure"]);
	const hasResult = record.result !== undefined;
	const hasFailure = record.failure !== undefined;
	const isTerminal = record.phase === "failed" || record.phase === "retained";
	if (hasResult !== (record.phase === "session_started")) {
		invalid("Journal result must exist only for a started session");
	}
	if (hasFailure !== isTerminal) {
		invalid("Journal failure must exist only for a failed or retained operation");
	}
	const carriesSession =
		record.phase === "session_recorded" ||
		record.phase === "runtime_launch_requested" ||
		record.phase === "session_started";
	// Only this writer's records are required to carry a session. A landed
	// version-1 success recorded its result before durable session identity
	// existed, and must stay loadable and replayable after the upgrade.
	if (carriesSession && record.recordVersion === 2 && !record.session) {
		invalid("Journal phase is missing its durable session identity");
	}
	if (record.session && !carriesSession && !isTerminal) {
		invalid("Journal phase cannot carry a durable session identity");
	}
	const requiresRollback =
		record.phase === "rollback_requested" || record.phase === "worktree_removed";
	if (requiresRollback !== (record.rollback !== undefined)) {
		invalid("Journal rollback intent must exist only for a rollback phase");
	}
	if (requiresRollback && (record.mode !== "worktree" || record.session)) {
		invalid("Only an unlaunched Worktree operation can record rollback intent");
	}
	if (record.updatedAt < record.createdAt) {
		invalid("Journal update timestamp precedes creation");
	}
	if (
		record.repositoryRoot === null &&
		(record.observedHead !== null || record.observedBranch !== null)
	) {
		invalid("Non-Git journal record contains Git state");
	}
	if (
		record.mode === "project_folder" &&
		record.requestedBranch !== null &&
		(record.phase === "branch_created" ||
			record.phase === "branch_checked_out" ||
			record.phase === "launch_requested" ||
			record.phase === "session_recorded" ||
			record.phase === "runtime_launch_requested" ||
			record.phase === "session_started" ||
			record.phase === "retained") &&
		(record.repositoryRoot === null || record.observedHead === null)
	) {
		invalid("Branch operation is missing its repository or commit");
	}
	if (
		record.mode === "project_folder" &&
		(record.phase === "branch_created" || record.phase === "branch_checked_out") &&
		record.requestedBranch === null
	) {
		invalid("Prepared branch phase is missing its requested branch");
	}
	if (
		(record.mode === "worktree" &&
			(record.phase === "branch_created" || record.phase === "branch_checked_out")) ||
		(record.mode === "project_folder" &&
			(record.phase === "worktree_created" ||
				record.phase === "worktree_ready" ||
				record.phase === "rollback_requested" ||
				record.phase === "worktree_removed"))
	) {
		invalid("Journal phase does not match its start mode");
	}
	if (
		record.result &&
		(record.result.operationId !== record.operationId ||
			record.result.originProjectPath !== record.originProjectPath ||
			record.result.execution === undefined)
	) {
		invalid("Successful journal record has inconsistent project start metadata");
	}
	if (record.result) {
		assertConsistentExecution(record, record.result.execution);
		if (
			record.session &&
			(record.session.sessionId !== record.result.sessionId ||
				record.session.runId !== record.result.runId)
		) {
			invalid("Successful journal record has an inconsistent durable session identity");
		}
	}
	if (record.session) assertConsistentExecution(record, record.session.execution);
	if (
		record.failure &&
		(!record.failure.details ||
			record.failure.details.operationId !== record.operationId ||
			record.failure.details.originProjectPath !== record.originProjectPath ||
			record.failure.details.phase !== mobilePhase(record.phase))
	) {
		invalid("Terminal journal record has inconsistent failure details");
	}
	if (
		record.mode === "project_folder" &&
		record.failure?.details?.effectiveState &&
		record.failure.details.effectiveState.directory !== record.originProjectPath
	) {
		invalid("Terminal journal record has an inconsistent execution directory");
	}
	if (
		record.failure?.details?.retainedBranch &&
		record.failure.details.retainedBranch !== record.requestedBranch
	) {
		invalid("Terminal journal record has an inconsistent retained branch");
	}
	if (
		record.mode === "worktree" &&
		record.failure?.details?.retainedWorktreePath &&
		record.failure.details.retainedWorktreePath !== record.worktree.destination
	) {
		invalid("Terminal journal record has an inconsistent retained worktree");
	}
	if (
		record.mode === "worktree" &&
		record.failure?.details?.effectiveState &&
		!isConsistentWorktreeExecution(record, record.failure.details.effectiveState)
	) {
		invalid("Terminal Worktree record has inconsistent ownership");
	}
	if (
		record.mode === "worktree" &&
		record.phase === "failed" &&
		record.failure?.details &&
		(record.failure.details.retainedBranch !== undefined ||
			record.failure.details.retainedWorktreePath !== undefined ||
			record.failure.details.effectiveState !== undefined ||
			record.failure.details.createdSessionId !== undefined)
	) {
		invalid("Failed Worktree record claims retained resources");
	}
	if (record.mode === "worktree" && record.phase === "retained" && record.failure?.details) {
		const details = record.failure.details;
		if (
			(record.requestedBranch === null && details.retainedWorktreePath === undefined) ||
			((details.effectiveState !== undefined || details.createdSessionId !== undefined) &&
				details.retainedWorktreePath === undefined) ||
			(details.retainedBranch === undefined && details.retainedWorktreePath === undefined)
		) {
			invalid("Retained Worktree record is missing retained resource ownership");
		}
	}
	return record;
}

function parseFile(value: unknown): ProjectStartOperationRecord[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid();
	}
	const candidate = value as Record<string, unknown>;
	const version = candidate["version"];
	if ((version !== 1 && version !== 2) || !Array.isArray(candidate["operations"])) invalid();
	const ids = new Set<string>();
	return candidate["operations"].map((value) => {
		const record = parseRecord(value, version === 1 ? 1 : 2);
		if (ids.has(record.operationId)) invalid(`Duplicate operation ID: ${record.operationId}`);
		ids.add(record.operationId);
		return record;
	});
}

function cloneRecord(record: ProjectStartOperationRecord): ProjectStartOperationRecord {
	return structuredClone(record);
}

function errorDetails(record: ProjectStartOperationRecord): ProjectStartFailureDetails {
	return {
		operationId: record.operationId,
		phase: mobilePhase(record.phase),
		originProjectPath: record.originProjectPath,
	};
}

export class ProjectStartJournal {
	private readonly backupPath: string;
	private operations: ProjectStartOperationRecord[];

	constructor(private readonly filePath: string) {
		this.backupPath = `${filePath}.bak`;
		this.recoverInterruptedReplacement();
		this.operations = this.load();
	}

	list(): ProjectStartOperationRecord[] {
		return this.operations.map(cloneRecord);
	}

	get(operationId: string): ProjectStartOperationRecord | undefined {
		const record = this.operations.find((candidate) => candidate.operationId === operationId);
		return record ? cloneRecord(record) : undefined;
	}

	create(record: ProjectStartOperationRecord): ProjectStartOperationRecord {
		const normalized = parseRecord(record);
		if (this.operations.some((candidate) => candidate.operationId === normalized.operationId)) {
			throw new ProjectStartJournalError(
				"OPERATION_CONFLICT",
				`Project start operation already exists: ${normalized.operationId}`,
			);
		}
		const candidate = [...this.operations, normalized];
		this.persist(candidate, errorDetails(normalized));
		this.operations = candidate;
		return cloneRecord(normalized);
	}

	update(
		operationId: string,
		mutate: (record: ProjectStartOperationRecord) => ProjectStartOperationRecord,
	): ProjectStartOperationRecord {
		const index = this.operations.findIndex((record) => record.operationId === operationId);
		const current = this.operations[index];
		if (index < 0 || !current) {
			throw new ProjectStartJournalError(
				"OPERATION_NOT_FOUND",
				`Project start operation not found: ${operationId}`,
			);
		}
		const mutated = mutate(cloneRecord(current));
		// A phase this writer records carries this writer's guarantees; a record
		// merely re-timestamped keeps the provenance of whoever wrote its phase.
		const updated = parseRecord(
			mutated.phase === current.phase ? mutated : { ...mutated, recordVersion: 2 },
		);
		if (updated.operationId !== operationId) {
			throw new ProjectStartJournalError(
				"OPERATION_CONFLICT",
				"Project start operation ID cannot change",
			);
		}
		if (
			updated.phase !== current.phase &&
			!ALLOWED_TRANSITIONS[current.phase].includes(updated.phase)
		) {
			invalid(`Invalid journal phase transition: ${current.phase} to ${updated.phase}`);
		}
		const candidate = [...this.operations];
		candidate[index] = updated;
		this.persist(candidate, errorDetails(updated));
		this.operations = candidate;
		return cloneRecord(updated);
	}

	private load(): ProjectStartOperationRecord[] {
		if (!existsSync(this.filePath)) return [];
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			throw new ProjectStartJournalError(
				"PROJECT_START_JOURNAL_IO",
				"Failed to read project start operation journal",
			);
		}
		try {
			return parseFile(JSON.parse(raw));
		} catch (error) {
			if (error instanceof ProjectStartJournalError) throw error;
			return invalid();
		}
	}

	private recoverInterruptedReplacement(): void {
		if (existsSync(this.filePath) || !existsSync(this.backupPath)) return;
		try {
			renameSync(this.backupPath, this.filePath);
		} catch {
			throw new ProjectStartJournalError(
				"PROJECT_START_JOURNAL_IO",
				"Failed to recover project start operation journal",
			);
		}
	}

	private persist(
		operations: ProjectStartOperationRecord[],
		details?: ProjectStartFailureDetails,
	): void {
		const file: ProjectStartJournalFile = {
			version: 2,
			operations: operations.map(cloneRecord),
		};
		const tmpPath = `${this.filePath}.tmp`;
		let backupCreated = false;
		try {
			const parent = dirname(this.filePath);
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			restrictDirPermissions(parent);
			writeFileSync(tmpPath, `${JSON.stringify(file, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			restrictFilePermissions(tmpPath);
			chmodSync(tmpPath, 0o600);
			if (process.platform === "win32" && existsSync(this.filePath)) {
				if (existsSync(this.backupPath)) unlinkSync(this.backupPath);
				renameSync(this.filePath, this.backupPath);
				backupCreated = true;
			}
			try {
				renameSync(tmpPath, this.filePath);
			} catch (error) {
				if (backupCreated && !existsSync(this.filePath)) {
					try {
						renameSync(this.backupPath, this.filePath);
					} catch {
						// Constructor recovery owns a backup left by an interrupted replacement.
					}
				}
				throw error;
			}
		} catch {
			throw new ProjectStartJournalError(
				"PROJECT_START_JOURNAL_IO",
				"Failed to persist project start operation journal",
				details,
			);
		}
		if (backupCreated) {
			try {
				unlinkSync(this.backupPath);
			} catch {
				// The new target is authoritative; stale backup cleanup is best effort.
			}
		}
	}
}
