import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedWorktreeError, ManagedWorktreeService } from "./managedWorktree.js";
import { runGitCommand } from "./projectStart.js";

const execFileAsync = promisify(execFile);

describe("ManagedWorktreeService", { timeout: 30_000 }, () => {
	let fixtureRoot: string;
	let repository: string;
	let managedRoot: string;

	async function git(args: string[], cwd = repository): Promise<string> {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		});
		return result.stdout.trim();
	}

	beforeEach(async () => {
		fixtureRoot = await mkdtemp(join(tmpdir(), "managed-worktree-test-"));
		repository = join(fixtureRoot, "source");
		managedRoot = join(fixtureRoot, "managed");
		await mkdir(join(repository, "packages", "nested"), { recursive: true });
		await git(["init", "-b", "main"]);
		await git(["config", "user.name", "Codemote Test"]);
		await git(["config", "user.email", "codemote@example.invalid"]);
		await writeFile(join(repository, "tracked.txt"), "committed\n");
		await writeFile(join(repository, "packages", "nested", "file.txt"), "nested\n");
		await git(["add", "."]);
		await git(["commit", "--no-gpg-sign", "-m", "fixture"]);
	});

	afterEach(async () => {
		await rm(fixtureRoot, { recursive: true, force: true });
	});

	it("reports local-only committed bases with tracking collapse and symbolic default", async () => {
		const head = await git(["rev-parse", "HEAD"]);
		await git(["remote", "add", "origin", "https://example.invalid/unreachable.git"]);
		await git(["update-ref", "refs/remotes/origin/main", head]);
		await git(["config", "branch.main.remote", "origin"]);
		await git(["config", "branch.main.merge", "refs/heads/main"]);
		await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
		await git(["branch", "other"]);
		await git(["update-ref", "refs/remotes/upstream/other", head]);
		await git(["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/other"]);
		const commands: string[][] = [];
		const signal = new AbortController().signal;
		let forwardedSignal: AbortSignal | undefined;
		const service = new ManagedWorktreeService(async (cwd, args, input, receivedSignal) => {
			commands.push(args);
			forwardedSignal = receivedSignal;
			return runGitCommand(cwd, args, input, receivedSignal);
		}, managedRoot);

		const state = await service.listBases(repository, signal);

		expect(state.bases).toEqual(
			expect.arrayContaining([
				{
					ref: "refs/heads/main",
					qualifiedName: "local/main",
					kind: "local",
					commit: head,
				},
				{
					ref: "refs/heads/other",
					qualifiedName: "local/other",
					kind: "local",
					commit: head,
				},
				{
					ref: "refs/remotes/upstream/other",
					qualifiedName: "remote/upstream/other",
					kind: "remote",
					commit: head,
				},
			]),
		);
		expect(state.bases.some(({ ref }) => ref.endsWith("/HEAD"))).toBe(false);
		expect(state.bases.some(({ ref }) => ref === "refs/remotes/origin/main")).toBe(false);
		expect(state.defaultBaseRef).toBe("refs/heads/main");
		expect(commands.flat()).not.toContain("fetch");
		expect(commands.flat()).not.toContain("ls-remote");
		expect(forwardedSignal).toBe(signal);
	});

	it("creates detached and attached worktrees at the recorded commit and maps a nested project", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const nested = join(repository, "packages", "nested");
		const detached = await service.plan(repository, nested, "detached");
		await service.create(repository, detached.destination, commit, null, "detached-owner");
		expect(await service.mapProject(detached.destination, detached.projectRelativePath)).toBe(
			resolve(detached.destination, "packages", "nested"),
		);
		expect(await git(["rev-parse", "HEAD"], detached.destination)).toBe(commit);
		expect(
			await execFileAsync("git", [
				"-C",
				detached.destination,
				"symbolic-ref",
				"--quiet",
				"--short",
				"HEAD",
			]).catch(() => null),
		).toBeNull();

		const attached = await service.plan(repository, repository, "attached");
		await service.create(
			repository,
			attached.destination,
			commit,
			"feature/managed",
			"attached-owner",
		);
		expect(await git(["branch", "--show-current"], attached.destination)).toBe("feature/managed");
		expect(await git(["rev-parse", "refs/heads/feature/managed"])).toBe(commit);
	});

	it("keeps divergent same-named refs and resolves defaults without guessing", async () => {
		const oldCommit = await git(["rev-parse", "HEAD"]);
		await writeFile(join(repository, "tracked.txt"), "second\n");
		await git(["add", "tracked.txt"]);
		await git(["commit", "--no-gpg-sign", "-m", "second"]);
		const current = await git(["rev-parse", "HEAD"]);
		await git(["update-ref", "refs/remotes/origin/main", oldCommit]);
		await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
		await git(["update-ref", "refs/remotes/upstream/trunk", current]);
		await git(["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);

		let state = await service.listBases(repository);
		expect(state.bases).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ref: "refs/heads/main", commit: current }),
				expect.objectContaining({
					ref: "refs/remotes/origin/main",
					commit: oldCommit,
				}),
			]),
		);
		expect(state.defaultBaseRef).toBe("refs/remotes/origin/main");

		await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
		state = await service.listBases(repository);
		expect(state.defaultBaseRef).toBe("refs/remotes/upstream/trunk");

		await git(["update-ref", "refs/remotes/fork/trunk", current]);
		await git(["symbolic-ref", "refs/remotes/fork/HEAD", "refs/remotes/fork/trunk"]);
		state = await service.listBases(repository);
		expect(state.defaultBaseRef).toBeNull();
	});

	it("resolves only exact locally known branch refs", async () => {
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const commit = await git(["rev-parse", "HEAD"]);
		await expect(service.resolveBase(repository, "refs/heads/main")).resolves.toBe(commit);
		await expect(service.resolveBase(repository, "refs/tags/missing")).rejects.toMatchObject({
			code: "INVALID_WORKTREE_BASE",
		});
		await expect(service.resolveBase(repository, "refs/heads/main~0")).rejects.toMatchObject({
			code: "INVALID_WORKTREE_BASE",
		});
	});

	it("rejects a relative managed worktree root", async () => {
		const relativeRoot = new ManagedWorktreeService(runGitCommand, "relative-managed-root");
		await expect(relativeRoot.plan(repository, repository, "relative-root")).rejects.toMatchObject({
			code: "UNSAFE_WORKTREE_DESTINATION",
		});
	});

	it("rejects stale bases, collisions, unrelated repository roots, and missing mappings", async () => {
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const commit = await git(["rev-parse", "HEAD"]);
		const invalidBranch = await service.plan(repository, repository, "invalid-branch");
		await expect(
			service.create(
				repository,
				invalidBranch.destination,
				commit,
				"invalid branch",
				"invalid-owner",
			),
		).rejects.toMatchObject({ code: "INVALID_BRANCH" });
		await git(["branch", "already-exists"]);
		const existingBranch = await service.plan(repository, repository, "existing-branch");
		await expect(
			service.create(
				repository,
				existingBranch.destination,
				commit,
				"already-exists",
				"existing-owner",
			),
		).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
		const plan = await service.plan(repository, repository, "collision");
		await mkdir(plan.destination);
		await expect(service.assertSafeDestination(repository, plan.destination)).rejects.toMatchObject(
			{
				code: "WORKTREE_DESTINATION_UNAVAILABLE",
			},
		);

		const unrelated = join(fixtureRoot, "unrelated");
		await mkdir(unrelated);
		await git(["init", "-b", "main"], unrelated);
		const unsafe = new ManagedWorktreeService(runGitCommand, join(unrelated, "managed"));
		await expect(unsafe.plan(repository, repository, "unsafe")).rejects.toBeInstanceOf(
			ManagedWorktreeError,
		);

		const missing = new ManagedWorktreeService(runGitCommand, join(fixtureRoot, "other-managed"));
		const missingPlan = await missing.plan(repository, repository, "missing");
		await missing.create(repository, missingPlan.destination, commit, null, "missing-owner");
		await expect(missing.mapProject(missingPlan.destination, "absent")).rejects.toMatchObject({
			code: "WORKTREE_PROJECT_PATH_MISSING",
		});

		const outside = join(fixtureRoot, "outside");
		await mkdir(outside);
		await symlink(outside, join(repository, "escape"));
		await git(["add", "escape"]);
		await git(["commit", "--no-gpg-sign", "-m", "escaping symlink"]);
		const escapeCommit = await git(["rev-parse", "HEAD"]);
		const escapePlan = await missing.plan(repository, repository, "escape");
		await missing.create(repository, escapePlan.destination, escapeCommit, null, "escape-owner");
		await expect(missing.mapProject(escapePlan.destination, "escape")).rejects.toMatchObject({
			code: "WORKTREE_PROJECT_PATH_UNSAFE",
		});
	});

	it("classifies recorded worktree truth exhaustively", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const nested = join(repository, "packages", "nested");
		const plan = await service.plan(repository, nested, "truth");
		const recorded = {
			repositoryRoot: repository,
			destination: plan.destination,
			selectedBaseRef: "refs/heads/main",
			selectedBaseCommit: commit,
			projectRelativePath: plan.projectRelativePath,
			requestedBranch: "feature/truth",
			ownershipToken: "truth-owner",
		};

		expect(await service.inspectRecorded(recorded)).toEqual({
			status: "absent",
		});

		await service.create(
			repository,
			recorded.destination,
			commit,
			recorded.requestedBranch,
			recorded.ownershipToken,
		);
		const exact = await service.inspectRecorded(recorded);
		expect(exact).toMatchObject({
			status: "exact",
			git: {
				repositoryRoot: recorded.destination,
				head: commit,
				branch: "feature/truth",
			},
			mapping: {
				ok: true,
				directory: join(recorded.destination, "packages", "nested"),
			},
			selectedBaseMatches: true,
			clean: true,
		});

		// Local changes of any class are visible, so rollback can never claim clean.
		await writeFile(join(recorded.destination, "untracked.txt"), "local\n");
		expect(await service.inspectRecorded(recorded)).toMatchObject({
			status: "exact",
			clean: false,
		});
		await rm(join(recorded.destination, "untracked.txt"));

		// A worktree the operation does not own is changed, never adoptable.
		const otherCommit = await git(["commit-tree", `${commit}^{tree}`, "-p", commit, "-m", "next"]);
		expect(
			await service.inspectRecorded({
				...recorded,
				selectedBaseCommit: otherCommit,
			}),
		).toMatchObject({ status: "changed" });
		expect(await service.inspectRecorded({ ...recorded, requestedBranch: null })).toMatchObject({
			status: "changed",
		});

		// Inspection that cannot complete is uncertain, never absent or clean.
		const failing = new ManagedWorktreeService(async () => {
			throw new Error("git unavailable");
		}, managedRoot);
		expect(await failing.inspectRecorded(recorded)).toMatchObject({
			status: "uncertain",
		});

		// A destination that is provably gone says so, so a caller reporting
		// retained resources does not name a path that no longer exists.
		await git(["worktree", "remove", "--force", recorded.destination]);
		await git(["update-ref", "refs/heads/feature/truth", otherCommit]);
		expect(await service.inspectRecorded(recorded)).toMatchObject({
			status: "changed",
			retainsDestination: false,
		});
	});

	it("refuses to treat a destination symlinked onto another worktree as exact", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const recordedPlan = await service.plan(repository, repository, "recorded");
		const otherPlan = await service.plan(repository, repository, "other");
		const recorded = {
			repositoryRoot: repository,
			destination: recordedPlan.destination,
			selectedBaseRef: "refs/heads/main",
			selectedBaseCommit: commit,
			projectRelativePath: recordedPlan.projectRelativePath,
			requestedBranch: null,
			ownershipToken: "recorded-owner",
		};
		// Two registered worktrees of the same repository, detached at the same
		// commit: by every value except identity, they look interchangeable.
		await service.create(repository, recorded.destination, commit, null, recorded.ownershipToken);
		await service.create(repository, otherPlan.destination, commit, null, "other-owner");
		expect(await service.inspectRecorded(recorded)).toMatchObject({
			status: "exact",
		});

		await rm(recorded.destination, { recursive: true, force: true });
		await symlink(otherPlan.destination, recorded.destination);
		const truth = await service.inspectRecorded(recorded);

		expect(truth.status).toBe("changed");
		if (truth.status !== "changed") throw new Error("Expected changed truth");
		expect(truth.reason).toContain(recorded.destination);
		expect(truth.reason).toContain(otherPlan.destination);

		// Rollback must not act through the link: the other worktree, its
		// registration and its contents are untouched.
		expect(await service.rollbackExact(recorded)).toMatchObject({
			status: "retained",
		});
		expect(existsSync(otherPlan.destination)).toBe(true);
		expect(await git(["worktree", "list", "--porcelain"])).toContain(otherPlan.destination);
		expect(await git(["rev-parse", "HEAD"], otherPlan.destination)).toBe(commit);
	});

	it("classifies a deleted directory that Git still registers, without pruning it", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const plan = await service.plan(repository, repository, "stale");
		const recorded = {
			repositoryRoot: repository,
			destination: plan.destination,
			selectedBaseRef: "refs/heads/main",
			selectedBaseCommit: commit,
			projectRelativePath: plan.projectRelativePath,
			requestedBranch: "feature/stale",
			ownershipToken: "stale-owner",
		};
		await service.create(
			repository,
			recorded.destination,
			commit,
			recorded.requestedBranch,
			recorded.ownershipToken,
		);

		// Deleted the way a person does it: `rm -rf`, no `git worktree prune`.
		await rm(recorded.destination, { recursive: true, force: true });
		const truth = await service.inspectRecorded(recorded);

		// Not absent — Git still holds the registration — and the reason has to name
		// the path and the condition, not surface a generic inspection failure.
		expect(truth.status).toBe("changed");
		if (truth.status !== "changed") throw new Error("Expected changed truth");
		expect(truth.reason).toContain(recorded.destination);
		expect(truth.reason).toContain(repository);
		expect(truth.reason).toContain("git worktree prune");
		expect(truth.reason).not.toContain("Failed to inspect local Git refs");

		// Inspection is read-only: the registration and branch survive untouched.
		expect(await git(["worktree", "list", "--porcelain"])).toContain(recorded.destination);
		expect(await git(["rev-parse", "--verify", "refs/heads/feature/stale"])).toBe(commit);

		// Rollback still refuses, because the proof cannot pass.
		expect(await service.rollbackExact(recorded)).toMatchObject({
			status: "retained",
		});
		expect(await git(["worktree", "list", "--porcelain"])).toContain(recorded.destination);
		expect(await git(["rev-parse", "--verify", "refs/heads/feature/stale"])).toBe(commit);
	});

	it("removes only an exact clean worktree and only its unmoved branch", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const plan = await service.plan(repository, repository, "rollback");
		const recorded = {
			repositoryRoot: repository,
			destination: plan.destination,
			selectedBaseRef: "refs/heads/main",
			selectedBaseCommit: commit,
			projectRelativePath: plan.projectRelativePath,
			requestedBranch: "feature/rollback",
			ownershipToken: "rollback-owner",
		};
		await service.create(
			repository,
			recorded.destination,
			commit,
			recorded.requestedBranch,
			recorded.ownershipToken,
		);

		await writeFile(join(recorded.destination, "tracked.txt"), "dirty\n");
		expect(await service.rollbackExact(recorded)).toMatchObject({
			status: "retained",
		});
		expect(await git(["rev-parse", "--verify", "refs/heads/feature/rollback"])).toBe(commit);
		await git(["checkout", "--", "tracked.txt"], recorded.destination);

		expect(await service.rollbackExact(recorded)).toEqual({
			status: "removed",
		});
		expect(existsSync(recorded.destination)).toBe(false);
		expect(await git(["worktree", "list", "--porcelain"])).not.toContain(recorded.destination);

		// The branch survives a moved tip and is deleted only at the recorded commit.
		const moved = await git(["commit-tree", `${commit}^{tree}`, "-p", commit, "-m", "moved"]);
		await git(["update-ref", "refs/heads/feature/rollback", moved]);
		expect(await service.deleteRollbackBranch(recorded)).toMatchObject({
			status: "retained",
		});
		expect(await git(["rev-parse", "--verify", "refs/heads/feature/rollback"])).toBe(moved);

		await git(["update-ref", "refs/heads/feature/rollback", commit]);
		expect(await service.deleteRollbackBranch(recorded)).toEqual({
			status: "removed",
		});
		await expect(
			execFileAsync("git", [
				"-C",
				repository,
				"rev-parse",
				"--verify",
				"refs/heads/feature/rollback",
			]),
		).rejects.toBeDefined();
		expect(await service.deleteRollbackBranch(recorded)).toEqual({
			status: "removed",
		});
	});

	it("rejects managed roots inside unrelated Git metadata and bare repositories", async () => {
		const unrelated = join(fixtureRoot, "unrelated-metadata");
		await mkdir(unrelated);
		await git(["init", "-b", "main"], unrelated);
		const metadataRoot = join(unrelated, ".git", "objects", "codemote");
		const metadataService = new ManagedWorktreeService(runGitCommand, metadataRoot);

		await expect(
			metadataService.plan(repository, repository, "inside-git-metadata"),
		).rejects.toMatchObject({ code: "UNSAFE_WORKTREE_DESTINATION" });

		const bare = join(fixtureRoot, "unrelated-bare.git");
		await git(["init", "--bare", bare], fixtureRoot);
		const bareRoot = join(bare, "objects", "codemote");
		const bareService = new ManagedWorktreeService(runGitCommand, bareRoot);

		await expect(
			bareService.plan(repository, repository, "inside-bare-repository"),
		).rejects.toMatchObject({ code: "UNSAFE_WORKTREE_DESTINATION" });
	});

	it("keeps a missing worktree registration protected without blocking unrelated destinations", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const stale = await service.plan(repository, repository, "stale-registration");
		await service.create(repository, stale.destination, commit, null, "stale-registration-owner");
		await rm(stale.destination, { recursive: true, force: true });

		const unrelated = join(managedRoot, "unrelated-destination");
		await expect(service.assertSafeDestination(repository, unrelated)).resolves.toBeUndefined();
		await expect(
			service.assertSafeDestination(repository, join(stale.destination, "nested")),
		).rejects.toMatchObject({ code: "UNSAFE_WORKTREE_DESTINATION" });
	});

	it("retains an exact rollback branch that is checked out in another worktree", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const checkout = join(fixtureRoot, "other-checkout");
		await git(["branch", "feature/in-use", commit]);
		await git(["worktree", "add", checkout, "feature/in-use"]);
		const recorded = {
			repositoryRoot: repository,
			destination: join(managedRoot, "removed-worktree"),
			selectedBaseRef: "refs/heads/main",
			selectedBaseCommit: commit,
			projectRelativePath: "",
			requestedBranch: "feature/in-use",
			ownershipToken: null,
		};

		await expect(service.deleteRollbackBranch(recorded)).resolves.toMatchObject({
			status: "retained",
		});
		expect(await git(["rev-parse", "--verify", "refs/heads/feature/in-use"])).toBe(commit);
	});
});
