import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectStartRequest, RunOptions, RunResult } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorStartError } from "./executor.js";
import { ProjectRegistry } from "./projectRegistry.js";
import { ProjectStartCoordinator, ProjectStartError, runGitCommand } from "./projectStart.js";
import { ProjectStartJournal, type ProjectStartOperationRecord } from "./projectStartJournal.js";
import { SessionManager } from "./session.js";
import type { SessionStartContext } from "./types.js";

const execFileAsync = promisify(execFile);

describe("ProjectStartCoordinator", { timeout: 30_000 }, () => {
	let fixtureRoot: string;
	let registry: ProjectRegistry;
	let journal: ProjectStartJournal;
	let sessions: SessionManager;

	beforeEach(async () => {
		fixtureRoot = await mkdtemp(join(tmpdir(), "project-start-test-"));
		registry = new ProjectRegistry(join(fixtureRoot, "machine", "projects.json"));
		journal = new ProjectStartJournal(join(fixtureRoot, "machine", "operations.json"));
		sessions = new SessionManager();
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
			...overrides,
		});
	}

	function request(
		project: string,
		operationId: string,
		preparation: ProjectStartRequest["preparation"] = { type: "none" },
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

	function launcher(
		manager = sessions,
		onLaunch?: (options: RunOptions, context: SessionStartContext) => void,
	): (options: RunOptions, context: SessionStartContext) => Promise<RunResult> {
		return async (options, context) => {
			onLaunch?.(options, context);
			const session = manager.create(
				options.profile,
				{ id: `workspace-${manager.list().length}`, workingDir: options.workspace, createdAt: 1 },
				context,
			);
			return { runId: session.runId, sessionId: session.id };
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
	): ProjectStartRequest["preparation"] {
		if (!state.git?.head) throw new Error("Expected committed Git fixture");
		return {
			type: "create_branch",
			newBranch,
			expectedHead: state.git.head,
			expectedBranch: state.git.branch,
		};
	}

	function rewritePhase(operationId: string, phase: ProjectStartOperationRecord["phase"]): void {
		journal.update(operationId, (current) => {
			const { result: _result, failure: _failure, ...rest } = current;
			return { ...rest, phase, updatedAt: Date.now() };
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
		});
		const nestedState = await service.inspect(nested);
		expect(nestedState.originProjectPath).toBe(nested);
		expect(nestedState.directory).toBe(nested);
		expect(nestedState.git?.repositoryRoot).toBe(await git(repo, ["rev-parse", "--show-toplevel"]));
		expect(nestedState.git?.branch).toBe("main");
		expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
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

	it("reconciles branch_checked_out, launch_requested, and session_started phases safely", async () => {
		const repo = await makeGitProject();
		const state = await coordinator().inspect(repo);
		const options = request(repo, "phase-replay", branchPreparation(state, "feature/phase-replay"));
		const first = await coordinator().start(options, launcher());

		rewritePhase("phase-replay", "branch_checked_out");
		const restartedSessions = new SessionManager();
		let launches = 0;
		const resumed = await coordinator({ sessionManager: restartedSessions }).start(
			options,
			launcher(restartedSessions, () => {
				launches++;
			}),
		);
		expect(resumed.sessionId).not.toBe(first.sessionId);
		expect(launches).toBe(1);

		rewritePhase("phase-replay", "launch_requested");
		const retainedLaunch = await expectStartError(
			coordinator({ sessionManager: new SessionManager() }).start(options, launcher()),
			"OPERATION_RETAINED",
		);
		expect(retainedLaunch.details?.phase).toBe("retained");

		const repo2 = await makeGitProject("session-started");
		const options2 = request(repo2, "session-started");
		const activeResult = await coordinator().start(options2, launcher());
		expect(await coordinator().start(options2, launcher())).toEqual(activeResult);
		const restarted = new ProjectStartCoordinator({
			journal,
			registry,
			sessionManager: new SessionManager(),
		});
		const retainedSession = await expectStartError(
			restarted.start(options2, launcher()),
			"OPERATION_RETAINED",
		);
		expect(retainedSession.details?.createdSessionId).toBe(activeResult.sessionId);
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
