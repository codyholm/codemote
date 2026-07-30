import { execFile } from "node:child_process";
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
		const service = new ManagedWorktreeService(async (cwd, args, input) => {
			commands.push(args);
			return runGitCommand(cwd, args, input);
		}, managedRoot);

		const state = await service.listBases(repository);

		expect(state.bases).toEqual(
			expect.arrayContaining([
				{ ref: "refs/heads/main", qualifiedName: "local/main", kind: "local", commit: head },
				{ ref: "refs/heads/other", qualifiedName: "local/other", kind: "local", commit: head },
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
	});

	it("creates detached and attached worktrees at the recorded commit and maps a nested project", async () => {
		const commit = await git(["rev-parse", "HEAD"]);
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const nested = join(repository, "packages", "nested");
		const detached = await service.plan(repository, nested, "detached");
		await service.create(repository, detached.destination, commit, null);
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
		await service.create(repository, attached.destination, commit, "feature/managed");
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
				expect.objectContaining({ ref: "refs/remotes/origin/main", commit: oldCommit }),
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

	it("rejects stale bases, collisions, unrelated repository roots, and missing mappings", async () => {
		const service = new ManagedWorktreeService(runGitCommand, managedRoot);
		const commit = await git(["rev-parse", "HEAD"]);
		await expect(service.resolveBase(repository, "refs/tags/missing")).rejects.toMatchObject({
			code: "INVALID_WORKTREE_BASE",
		});
		const invalidBranch = await service.plan(repository, repository, "invalid-branch");
		await expect(
			service.create(repository, invalidBranch.destination, commit, "invalid branch"),
		).rejects.toMatchObject({ code: "INVALID_BRANCH" });
		await git(["branch", "already-exists"]);
		const existingBranch = await service.plan(repository, repository, "existing-branch");
		await expect(
			service.create(repository, existingBranch.destination, commit, "already-exists"),
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
		await missing.create(repository, missingPlan.destination, commit, null);
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
		await missing.create(repository, escapePlan.destination, escapeCommit, null);
		await expect(missing.mapProject(escapePlan.destination, "escape")).rejects.toMatchObject({
			code: "WORKTREE_PROJECT_PATH_UNSAFE",
		});
	});
});
