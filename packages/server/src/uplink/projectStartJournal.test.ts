import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ManagedWorktreeOperationRecord,
	type ProjectFolderStartOperationRecord,
	ProjectStartJournal,
	ProjectStartJournalError,
	type ProjectStartOperationRecord,
} from "./projectStartJournal.js";

describe("ProjectStartJournal", () => {
	let fixtureDir: string;
	let journalPath: string;

	beforeEach(async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "project-start-journal-test-"));
		journalPath = join(fixtureDir, "state", "operations.json");
	});

	afterEach(async () => {
		await rm(fixtureDir, { recursive: true, force: true });
	});

	function record(
		overrides: Partial<ProjectFolderStartOperationRecord> = {},
	): ProjectFolderStartOperationRecord {
		return {
			operationId: "operation-1",
			fingerprint: "fingerprint-1",
			recordVersion: 2,
			mode: "project_folder",
			originProjectPath: join(fixtureDir, "project"),
			runtime: "codex",
			repositoryRoot: join(fixtureDir, "project"),
			observedHead: "abc123",
			observedBranch: "main",
			requestedBranch: "feature/session",
			phase: "recorded",
			createdAt: 1000,
			updatedAt: 1000,
			...overrides,
		};
	}

	function expectJournalError(
		action: () => unknown,
		code: ProjectStartJournalError["code"],
	): ProjectStartJournalError {
		try {
			action();
			throw new Error(`Expected ${code}`);
		} catch (error) {
			expect(error).toBeInstanceOf(ProjectStartJournalError);
			expect((error as ProjectStartJournalError).code).toBe(code);
			return error as ProjectStartJournalError;
		}
	}

	function terminalResult(branch = "feature/session") {
		return {
			runId: "run-1",
			sessionId: "session-1",
			operationId: "operation-1",
			originProjectPath: join(fixtureDir, "project"),
			execution: {
				directory: join(fixtureDir, "project"),
				mode: "project_folder" as const,
				git: {
					repositoryRoot: join(fixtureDir, "project"),
					head: "abc123",
					branch,
					detached: false,
				},
			},
		};
	}

	function durableSession() {
		return {
			sessionId: "session-1",
			runId: "run-1",
			workspaceId: "workspace-1",
			createdAt: 1500,
			execution: {
				directory: join(fixtureDir, "project"),
				mode: "project_folder" as const,
				git: {
					repositoryRoot: join(fixtureDir, "project"),
					head: "abc123",
					branch: "feature/session",
					detached: false,
				},
			},
		};
	}

	function worktreeSession() {
		const destination = join(fixtureDir, "managed", "source-operation");
		return {
			sessionId: "worktree-session-1",
			runId: "worktree-run-1",
			workspaceId: "worktree-workspace-1",
			createdAt: 1500,
			execution: {
				directory: join(destination, "packages", "nested"),
				mode: "worktree" as const,
				git: {
					repositoryRoot: destination,
					head: "abc123",
					branch: "feature/worktree",
					detached: false,
				},
				worktree: { path: destination, baseRef: "refs/heads/main", baseCommit: "abc123" },
			},
		};
	}

	function terminalFailure(phase: "failed" | "retained") {
		return {
			code: "OPERATION_RETAINED",
			message: "Operation did not complete",
			details: {
				operationId: "operation-1",
				phase,
				originProjectPath: join(fixtureDir, "project"),
			},
		};
	}

	function worktreeRecord(): ManagedWorktreeOperationRecord {
		const originProjectPath = join(fixtureDir, "source", "packages", "nested");
		const repositoryRoot = join(fixtureDir, "source");
		const destination = join(fixtureDir, "managed", "source-operation");
		return {
			operationId: "worktree-1",
			fingerprint: "fingerprint-worktree",
			recordVersion: 2,
			mode: "worktree",
			originProjectPath,
			runtime: "codex",
			repositoryRoot,
			observedHead: "abc123",
			observedBranch: "main",
			requestedBranch: "feature/worktree",
			worktree: {
				destination,
				selectedBaseRef: "refs/heads/main",
				selectedBaseCommit: "abc123",
				projectRelativePath: join("packages", "nested"),
			},
			phase: "retained",
			createdAt: 1000,
			updatedAt: 2000,
			failure: {
				code: "RUNTIME_LAUNCH_FAILED",
				message: "Runtime failed",
				details: {
					operationId: "worktree-1",
					phase: "retained",
					originProjectPath,
					retainedBranch: "feature/worktree",
					retainedWorktreePath: destination,
					effectiveState: {
						directory: join(destination, "packages", "nested"),
						mode: "worktree",
						git: {
							repositoryRoot: destination,
							head: "abc123",
							branch: "feature/worktree",
							detached: false,
						},
						worktree: {
							path: destination,
							baseRef: "refs/heads/main",
							baseCommit: "abc123",
						},
					},
				},
			},
		};
	}

	it("round trips records and returns defensive copies", () => {
		const first = new ProjectStartJournal(journalPath);
		first.create(record());
		const fetched = first.get("operation-1");
		expect(fetched).toEqual(record());
		if (fetched) fetched.phase = "retained";
		expect(first.get("operation-1")?.phase).toBe("recorded");
		expect(new ProjectStartJournal(journalPath).list()).toEqual([record()]);
	});

	it("looks up the same operation ID and rejects duplicate creation", () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(record());

		expect(journal.get("operation-1")?.fingerprint).toBe("fingerprint-1");
		expect(journal.get("missing")).toBeUndefined();
		expectJournalError(
			() => journal.create(record({ fingerprint: "changed" })),
			"OPERATION_CONFLICT",
		);
	});

	it("atomically updates a complete record", async () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(record({ phase: "runtime_launch_requested", session: durableSession() }));
		journal.update("operation-1", (current) => ({
			...current,
			phase: "session_started",
			updatedAt: 2000,
			session: durableSession(),
			result: {
				runId: "run-1",
				sessionId: "session-1",
				operationId: "operation-1",
				originProjectPath: current.originProjectPath,
				execution: {
					directory: current.originProjectPath,
					mode: "project_folder",
					git: {
						repositoryRoot: current.originProjectPath,
						head: "abc123",
						branch: "feature/session",
						detached: false,
					},
				},
			},
		}));

		const persisted = JSON.parse(await readFile(journalPath, "utf8")) as {
			version: number;
			operations: ProjectStartOperationRecord[];
		};
		expect(persisted.version).toBe(2);
		expect(persisted.operations[0]?.result?.sessionId).toBe("session-1");
		expect(persisted.operations[0]?.session?.workspaceId).toBe("workspace-1");
		expect(existsSync(`${journalPath}.tmp`)).toBe(false);
	});

	it("keeps landed version-1 records readable without rewriting or crediting them", async () => {
		const legacy = { ...record(), phase: "launch_requested" as const };
		const { recordVersion: _recordVersion, ...withoutVersion } = legacy;
		const legacyWorktree = { ...worktreeRecord() };
		const { recordVersion: _worktreeVersion, ...worktreeWithoutVersion } = legacyWorktree;
		const document = JSON.stringify({
			version: 1,
			operations: [withoutVersion, worktreeWithoutVersion],
		});
		await mkdir(dirname(journalPath), { recursive: true });
		await writeFile(journalPath, document, "utf8");

		const journal = new ProjectStartJournal(journalPath);

		// A launch this build did not record cannot be credited with the session
		// boundary it never had.
		expect(journal.get("operation-1")?.recordVersion).toBe(1);
		expect(journal.get("worktree-1")?.recordVersion).toBe(1);
		expect(journal.get("worktree-1")?.phase).toBe("retained");
		expect(await readFile(journalPath, "utf8")).toBe(document);

		journal.update("operation-1", (current) => ({ ...current, updatedAt: 3000 }));
		expect(journal.get("operation-1")?.recordVersion).toBe(1);
		journal.update("operation-1", (current) => ({
			...current,
			phase: "retained",
			updatedAt: 4000,
			failure: terminalFailure("retained"),
		}));
		expect(journal.get("operation-1")?.recordVersion).toBe(2);
		expect((JSON.parse(await readFile(journalPath, "utf8")) as { version: number }).version).toBe(
			2,
		);
	});

	it("keeps a landed version-1 successful record loadable and replayable", async () => {
		const { recordVersion: _recordVersion, ...legacy } = record({ phase: "session_started" });
		await mkdir(dirname(journalPath), { recursive: true });
		await writeFile(
			journalPath,
			JSON.stringify({ version: 1, operations: [{ ...legacy, result: terminalResult() }] }),
			"utf8",
		);

		const loaded = new ProjectStartJournal(journalPath).get("operation-1");

		// The landed writer recorded no durable session, so requiring one here
		// would make a completed operation unreadable after the upgrade.
		expect(loaded?.recordVersion).toBe(1);
		expect(loaded?.phase).toBe("session_started");
		expect(loaded?.session).toBeUndefined();
		expect(loaded?.result?.sessionId).toBe("session-1");

		// This writer's own successful records must still carry that identity.
		await writeFile(
			journalPath,
			JSON.stringify({
				version: 2,
				operations: [{ ...record({ phase: "session_started" }), result: terminalResult() }],
			}),
			"utf8",
		);
		expectJournalError(() => new ProjectStartJournal(journalPath), "INVALID_PROJECT_START_JOURNAL");
	});

	it("rejects a phase change that skips a durable boundary or reopens a terminal record", () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(record());

		expectJournalError(
			() =>
				journal.update("operation-1", (current) => ({
					...current,
					phase: "session_recorded",
					session: durableSession(),
					updatedAt: 2000,
				})),
			"INVALID_PROJECT_START_JOURNAL",
		);
		expect(journal.get("operation-1")?.phase).toBe("recorded");

		for (const phase of ["branch_created", "branch_checked_out", "launch_requested"] as const) {
			journal.update("operation-1", (current) => ({ ...current, phase, updatedAt: 2000 }));
		}
		journal.update("operation-1", (current) => ({
			...current,
			phase: "session_recorded",
			session: durableSession(),
			updatedAt: 2000,
		}));
		expectJournalError(
			() =>
				journal.update("operation-1", (current) => ({
					...current,
					phase: "session_started",
					result: terminalResult(),
					updatedAt: 3000,
				})),
			"INVALID_PROJECT_START_JOURNAL",
		);
		journal.update("operation-1", (current) => ({
			...current,
			phase: "runtime_launch_requested",
			updatedAt: 3000,
		}));
		journal.update("operation-1", (current) => ({
			...current,
			phase: "session_started",
			result: terminalResult(),
			updatedAt: 4000,
		}));

		// A late runtime-native ID is the same phase written again, which is allowed.
		journal.update("operation-1", (current) =>
			current.session
				? {
						...current,
						session: { ...current.session, runtimeSessionId: "runtime-native-1" },
						updatedAt: 5000,
					}
				: current,
		);
		expect(journal.get("operation-1")?.session?.runtimeSessionId).toBe("runtime-native-1");

		expectJournalError(
			() =>
				journal.update("operation-1", (current) => {
					const { result: _result, ...rest } = current;
					return {
						...rest,
						phase: "retained",
						updatedAt: 6000,
						failure: terminalFailure("retained"),
					};
				}),
			"INVALID_PROJECT_START_JOURNAL",
		);
		expect(journal.get("operation-1")?.phase).toBe("session_started");
		expect(journal.get("operation-1")?.result?.sessionId).toBe("session-1");
	});

	it("rejects version-2 phases and payloads inside a version-1 file", async () => {
		await mkdir(dirname(journalPath), { recursive: true });
		const rejected: unknown[] = [
			{ version: 1, operations: [{ ...record(), phase: "session_recorded" }] },
			{ version: 1, operations: [{ ...record(), phase: "runtime_launch_requested" }] },
			{
				version: 1,
				operations: [{ ...record(), phase: "recorded", session: durableSession() }],
			},
		];

		for (const document of rejected) {
			await writeFile(journalPath, JSON.stringify(document), "utf8");
			expectJournalError(
				() => new ProjectStartJournal(journalPath),
				"INVALID_PROJECT_START_JOURNAL",
			);
		}
	});

	it("binds a durable session to the phase and execution that own it", async () => {
		await mkdir(dirname(journalPath), { recursive: true });
		const invalid: unknown[] = [
			// Session identity is required from the moment it exists.
			{ version: 2, operations: [{ ...record(), phase: "session_recorded" }] },
			{ version: 2, operations: [{ ...record(), phase: "runtime_launch_requested" }] },
			// ...and cannot exist before it.
			{ version: 2, operations: [{ ...record(), phase: "recorded", session: durableSession() }] },
			{
				version: 2,
				operations: [{ ...record(), phase: "launch_requested", session: durableSession() }],
			},
			// The session must describe the same execution as its operation.
			{
				version: 2,
				operations: [
					{
						...record(),
						phase: "session_recorded",
						session: {
							...durableSession(),
							execution: {
								...durableSession().execution,
								directory: join(fixtureDir, "elsewhere"),
							},
						},
					},
				],
			},
			// A terminal result must name the session that produced it.
			{
				version: 2,
				operations: [
					{
						...record(),
						phase: "session_started",
						session: durableSession(),
						result: { ...terminalResult(), sessionId: "other-session" },
					},
				],
			},
		];

		for (const document of invalid) {
			await writeFile(journalPath, JSON.stringify(document), "utf8");
			expectJournalError(
				() => new ProjectStartJournal(journalPath),
				"INVALID_PROJECT_START_JOURNAL",
			);
		}
	});

	it("accepts rollback intent only for an unlaunched Worktree operation", async () => {
		await mkdir(dirname(journalPath), { recursive: true });
		const intent = { requestedAt: 2000, code: "RUNTIME_LAUNCH_FAILED", message: "Runtime failed" };
		const rolling = { ...worktreeRecord(), phase: "rollback_requested" as const, rollback: intent };
		const { failure: _failure, ...rollingWithoutFailure } = rolling;
		const invalid: unknown[] = [
			// A Project-folder operation never rolls back.
			{ version: 2, operations: [{ ...record(), phase: "rollback_requested", rollback: intent }] },
			// Rollback intent cannot exist outside a rollback phase.
			{ version: 2, operations: [{ ...worktreeRecord(), rollback: intent }] },
			// A rollback phase without its intent has lost the failure to report.
			{
				version: 2,
				operations: [{ ...worktreeRecord(), phase: "worktree_removed", failure: undefined }],
			},
			// A launched operation is never eligible.
			{
				version: 2,
				operations: [{ ...rollingWithoutFailure, session: worktreeSession() }],
			},
		];

		for (const document of invalid) {
			await writeFile(journalPath, JSON.stringify(document), "utf8");
			expectJournalError(
				() => new ProjectStartJournal(journalPath),
				"INVALID_PROJECT_START_JOURNAL",
			);
		}

		await writeFile(
			journalPath,
			JSON.stringify({ version: 2, operations: [rollingWithoutFailure] }),
			"utf8",
		);
		expect(new ProjectStartJournal(journalPath).get("worktree-1")?.rollback).toEqual(intent);
	});

	it("preserves retained failure details", () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(
			record({
				phase: "retained",
				failure: {
					code: "BRANCH_RETAINED",
					message: "Runtime failed after branch activation",
					details: {
						operationId: "operation-1",
						phase: "retained",
						originProjectPath: join(fixtureDir, "project"),
						retainedBranch: "feature/session",
						createdSessionId: "session-1",
						effectiveState: {
							directory: join(fixtureDir, "project"),
							mode: "project_folder",
							git: {
								repositoryRoot: join(fixtureDir, "project"),
								head: "abc123",
								branch: "feature/session",
								detached: false,
							},
						},
					},
				},
			}),
		);

		expect(new ProjectStartJournal(journalPath).get("operation-1")?.failure).toEqual(
			record({
				phase: "retained",
				failure: {
					code: "BRANCH_RETAINED",
					message: "Runtime failed after branch activation",
					details: {
						operationId: "operation-1",
						phase: "retained",
						originProjectPath: join(fixtureDir, "project"),
						retainedBranch: "feature/session",
						createdSessionId: "session-1",
						effectiveState: {
							directory: join(fixtureDir, "project"),
							mode: "project_folder",
							git: {
								repositoryRoot: join(fixtureDir, "project"),
								head: "abc123",
								branch: "feature/session",
								detached: false,
							},
						},
					},
				},
			}).failure,
		);
	});

	it("round trips internally consistent Worktree ownership and retained state", () => {
		const expected = worktreeRecord();
		const journal = new ProjectStartJournal(journalPath);
		journal.create(expected);

		expect(new ProjectStartJournal(journalPath).get("worktree-1")).toMatchObject({
			mode: "worktree",
			phase: "retained",
			worktree: {
				destination: expected.worktree.destination,
				projectRelativePath: join("packages", "nested"),
			},
			failure: { details: { retainedWorktreePath: expected.worktree.destination } },
		});
	});

	it("rejects mismatched Worktree failure ownership and failed resource claims", async () => {
		const withExecutionMutation = (
			mutate: (
				execution: Extract<
					NonNullable<
						NonNullable<ManagedWorktreeOperationRecord["failure"]>["details"]
					>["effectiveState"],
					{ mode: "worktree" }
				>,
			) => void,
		): ManagedWorktreeOperationRecord => {
			const value = worktreeRecord();
			const execution = value.failure?.details?.effectiveState;
			if (execution?.mode !== "worktree") throw new Error("Expected Worktree effective state");
			mutate(execution);
			return value;
		};
		const mismatchedOwnership = [
			withExecutionMutation((execution) => {
				execution.directory = join(execution.worktree.path, "other");
			}),
			withExecutionMutation((execution) => {
				execution.worktree.path = join(fixtureDir, "other-worktree");
			}),
			withExecutionMutation((execution) => {
				execution.worktree.baseRef = "refs/heads/other";
			}),
			withExecutionMutation((execution) => {
				execution.worktree.baseCommit = "different";
			}),
			withExecutionMutation((execution) => {
				execution.git.repositoryRoot = join(fixtureDir, "other-worktree");
			}),
			withExecutionMutation((execution) => {
				execution.git.head = "different";
			}),
			withExecutionMutation((execution) => {
				execution.git.branch = "feature/other";
			}),
			withExecutionMutation((execution) => {
				execution.git.detached = true;
			}),
		];

		const failedWithResources = worktreeRecord();
		failedWithResources.phase = "failed";
		if (!failedWithResources.failure?.details) throw new Error("Expected Worktree failure");
		failedWithResources.failure.details.phase = "failed";

		const retainedWithoutResources = worktreeRecord();
		if (!retainedWithoutResources.failure?.details) throw new Error("Expected Worktree failure");
		const {
			retainedBranch: _retainedBranch,
			retainedWorktreePath: _retainedWorktreePath,
			effectiveState: _effectiveState,
			...detailsWithoutResources
		} = retainedWithoutResources.failure.details;
		retainedWithoutResources.failure = {
			...retainedWithoutResources.failure,
			details: detailsWithoutResources,
		};

		for (const invalidRecord of [
			...mismatchedOwnership,
			failedWithResources,
			retainedWithoutResources,
		]) {
			await mkdir(dirname(journalPath), { recursive: true });
			await writeFile(
				journalPath,
				JSON.stringify({ version: 1, operations: [invalidRecord] }),
				"utf8",
			);
			expectJournalError(
				() => new ProjectStartJournal(journalPath),
				"INVALID_PROJECT_START_JOURNAL",
			);
		}
	});

	it("writes private parent and file permissions where supported", async () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(record());

		if (process.platform !== "win32") {
			expect((await stat(dirname(journalPath))).mode & 0o777).toBe(0o700);
			expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
		}
	});

	it("recovers the last good Windows-style backup when the target is missing", async () => {
		const backupPath = `${journalPath}.bak`;
		await mkdir(dirname(journalPath), { recursive: true });
		await writeFile(backupPath, JSON.stringify({ version: 2, operations: [record()] }), "utf8");

		const journal = new ProjectStartJournal(journalPath);

		expect(journal.get("operation-1")).toEqual(record());
		expect(existsSync(journalPath)).toBe(true);
		expect(existsSync(backupPath)).toBe(false);
	});

	it("fails closed on invalid schemas and missing terminal payloads", async () => {
		await mkdir(dirname(journalPath), { recursive: true });
		const invalidDocuments: unknown[] = [
			null,
			{},
			{ version: 3, operations: [] },
			{ version: 1, operations: "invalid" },
			{ version: 1, operations: [{ ...record(), mode: "worktree" }] },
			{ version: 1, operations: [{ ...record(), phase: "session_started" }] },
			{ version: 1, operations: [{ ...record(), phase: "retained" }] },
			{
				version: 1,
				operations: [{ ...record(), result: terminalResult() }],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						phase: "launch_requested",
						failure: {
							...terminalFailure("retained"),
							details: {
								...terminalFailure("retained").details,
								phase: "launch_requested",
							},
						},
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						phase: "session_started",
						result: terminalResult("wrong-branch"),
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						phase: "session_started",
						result: {
							...terminalResult(),
							execution: {
								...terminalResult().execution,
								git: {
									...terminalResult().execution.git,
									detached: true,
								},
							},
						},
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						phase: "failed",
						failure: { code: "FAILED", message: "Missing details" },
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						phase: "branch_created",
						requestedBranch: null,
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						repositoryRoot: null,
						observedHead: null,
					},
				],
			},
			{
				version: 1,
				operations: [
					{
						...record(),
						updatedAt: 999,
					},
				],
			},
			{ version: 1, operations: [record(), record()] },
		];

		for (const document of invalidDocuments) {
			await writeFile(journalPath, JSON.stringify(document), "utf8");
			expectJournalError(
				() => new ProjectStartJournal(journalPath),
				"INVALID_PROJECT_START_JOURNAL",
			);
		}
	});

	it("keeps memory and target unchanged when replacement cannot be written", async () => {
		const journal = new ProjectStartJournal(journalPath);
		journal.create(record());
		const goodFile = await readFile(journalPath, "utf8");
		await mkdir(`${journalPath}.tmp`);

		const error = expectJournalError(
			() =>
				journal.update("operation-1", (current) => ({
					...current,
					updatedAt: 2000,
				})),
			"PROJECT_START_JOURNAL_IO",
		);
		expect(error.details).toMatchObject({
			operationId: "operation-1",
			phase: "recorded",
			originProjectPath: join(fixtureDir, "project"),
		});
		expect(journal.get("operation-1")?.updatedAt).toBe(1000);
		expect(await readFile(journalPath, "utf8")).toBe(goodFile);
	});
});
