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

export interface ProjectStartJournalFailure {
	code: string;
	message: string;
	details?: ProjectStartFailureDetails;
}

export interface ProjectStartOperationRecord {
	operationId: string;
	fingerprint: string;
	mode: "project_folder";
	originProjectPath: string;
	runtime: RuntimeType;
	repositoryRoot: string | null;
	observedHead: string | null;
	observedBranch: string | null;
	requestedBranch: string | null;
	phase: ProjectStartPhase;
	createdAt: number;
	updatedAt: number;
	result?: RunResult;
	failure?: ProjectStartJournalFailure;
}

type ProjectStartJournalErrorCode =
	| "INVALID_PROJECT_START_JOURNAL"
	| "PROJECT_START_JOURNAL_IO"
	| "OPERATION_CONFLICT"
	| "OPERATION_NOT_FOUND";

interface ProjectStartJournalFile {
	version: 1;
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

function phase(value: unknown): ProjectStartPhase {
	if (
		value === "recorded" ||
		value === "branch_created" ||
		value === "branch_checked_out" ||
		value === "launch_requested" ||
		value === "session_started" ||
		value === "failed" ||
		value === "retained"
	) {
		return value;
	}
	return invalid("Invalid journal field: phase");
}

function parseExecution(value: unknown): SessionExecutionState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid journal result execution");
	}
	const candidate = value as Record<string, unknown>;
	if (candidate["mode"] !== "project_folder") invalid("Invalid journal result execution mode");
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
	return {
		directory: absolutePath(candidate["directory"], "directory"),
		mode: "project_folder",
		git,
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

function parseRecord(value: unknown): ProjectStartOperationRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid("Invalid project start operation record");
	}
	const candidate = value as Record<string, unknown>;
	if (candidate["mode"] !== "project_folder") invalid("Invalid journal field: mode");
	const repositoryRoot =
		candidate["repositoryRoot"] === null
			? null
			: absolutePath(candidate["repositoryRoot"], "repositoryRoot");
	const record: ProjectStartOperationRecord = {
		operationId: requiredString(candidate["operationId"], "operationId"),
		fingerprint: requiredString(candidate["fingerprint"], "fingerprint"),
		mode: "project_folder",
		originProjectPath: absolutePath(candidate["originProjectPath"], "originProjectPath"),
		runtime: runtime(candidate["runtime"]),
		repositoryRoot,
		observedHead: nullableString(candidate["observedHead"], "observedHead"),
		observedBranch: nullableString(candidate["observedBranch"], "observedBranch"),
		requestedBranch: nullableString(candidate["requestedBranch"], "requestedBranch"),
		phase: phase(candidate["phase"]),
		createdAt: timestamp(candidate["createdAt"], "createdAt"),
		updatedAt: timestamp(candidate["updatedAt"], "updatedAt"),
	};
	if (candidate["result"] !== undefined) record.result = parseResult(candidate["result"]);
	if (candidate["failure"] !== undefined) record.failure = parseFailure(candidate["failure"]);
	const hasResult = record.result !== undefined;
	const hasFailure = record.failure !== undefined;
	if (hasResult !== (record.phase === "session_started")) {
		invalid("Journal result must exist only for a started session");
	}
	if (hasFailure !== (record.phase === "failed" || record.phase === "retained")) {
		invalid("Journal failure must exist only for a failed or retained operation");
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
		record.requestedBranch !== null &&
		(record.phase === "branch_created" ||
			record.phase === "branch_checked_out" ||
			record.phase === "launch_requested" ||
			record.phase === "session_started" ||
			record.phase === "retained") &&
		(record.repositoryRoot === null || record.observedHead === null)
	) {
		invalid("Branch operation is missing its repository or commit");
	}
	if (
		(record.phase === "branch_created" || record.phase === "branch_checked_out") &&
		record.requestedBranch === null
	) {
		invalid("Prepared branch phase is missing its requested branch");
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
		const execution = record.result.execution;
		if (!execution || execution.directory !== record.originProjectPath) {
			invalid("Successful journal record has an inconsistent execution directory");
		}
		if (record.repositoryRoot === null) {
			if (execution.git !== null) {
				invalid("Successful non-Git journal record contains Git execution state");
			}
		} else {
			const expectedBranch = record.requestedBranch ?? record.observedBranch;
			if (
				!execution.git ||
				execution.git.repositoryRoot !== record.repositoryRoot ||
				execution.git.head !== record.observedHead ||
				execution.git.branch !== expectedBranch ||
				execution.git.detached !== (execution.git.head !== null && execution.git.branch === null)
			) {
				invalid("Successful journal record has inconsistent Git execution state");
			}
		}
	}
	if (
		record.failure &&
		(!record.failure.details ||
			record.failure.details.operationId !== record.operationId ||
			record.failure.details.originProjectPath !== record.originProjectPath ||
			record.failure.details.phase !== record.phase)
	) {
		invalid("Terminal journal record has inconsistent failure details");
	}
	if (
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
	return record;
}

function parseFile(value: unknown): ProjectStartOperationRecord[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return invalid();
	}
	const candidate = value as Record<string, unknown>;
	if (candidate["version"] !== 1 || !Array.isArray(candidate["operations"])) invalid();
	const ids = new Set<string>();
	return candidate["operations"].map((value) => {
		const record = parseRecord(value);
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
		phase: record.phase,
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
		const updated = parseRecord(mutate(cloneRecord(current)));
		if (updated.operationId !== operationId) {
			throw new ProjectStartJournalError(
				"OPERATION_CONFLICT",
				"Project start operation ID cannot change",
			);
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
			version: 1,
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
