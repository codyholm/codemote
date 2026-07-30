import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitWorktreeBase, WorktreeStartState } from "@codemote/common";
import type { GitCommandResult, GitCommandRunner } from "./projectStart.js";

export type ManagedWorktreeErrorCode =
	| "INVALID_WORKTREE_BASE"
	| "STALE_WORKTREE_BASE"
	| "INVALID_BRANCH"
	| "BRANCH_EXISTS"
	| "UNSAFE_WORKTREE_DESTINATION"
	| "WORKTREE_DESTINATION_UNAVAILABLE"
	| "WORKTREE_CREATE_FAILED"
	| "WORKTREE_PROJECT_PATH_MISSING"
	| "WORKTREE_PROJECT_PATH_UNSAFE";

export class ManagedWorktreeError extends Error {
	constructor(
		readonly code: ManagedWorktreeErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ManagedWorktreeError";
	}
}

export interface ManagedWorktreePlan {
	destination: string;
	projectRelativePath: string;
}

function line(value: string): string {
	return value.replace(/[\r\n]+$/u, "");
}

function contained(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function qualified(ref: string): Pick<GitWorktreeBase, "kind" | "qualifiedName"> | null {
	if (ref.startsWith("refs/heads/")) {
		return { kind: "local", qualifiedName: `local/${ref.slice("refs/heads/".length)}` };
	}
	if (ref.startsWith("refs/remotes/")) {
		const name = ref.slice("refs/remotes/".length);
		if (name.endsWith("/HEAD")) return null;
		return { kind: "remote", qualifiedName: `remote/${name}` };
	}
	return null;
}

function isSelectableBaseRef(ref: string): boolean {
	return /^refs\/heads\/[^\s]+$/u.test(ref) || /^refs\/remotes\/[^/\s]+\/[^\s]+$/u.test(ref);
}

async function nearestExisting(path: string): Promise<string> {
	let candidate = resolve(path);
	for (;;) {
		try {
			await lstat(candidate);
			return candidate;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw error;
			candidate = parent;
		}
	}
}

export class ManagedWorktreeService {
	constructor(
		private readonly runGit: GitCommandRunner,
		private readonly managedRoot: string,
	) {}

	async listBases(repositoryRoot: string): Promise<WorktreeStartState> {
		const result = await this.git(repositoryRoot, [
			"for-each-ref",
			"--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00%(symref)",
			"refs/heads",
			"refs/remotes",
		]);
		const candidates: Array<GitWorktreeBase & { upstream: string }> = [];
		const symbolicDefaults: Array<{ ref: string; target: string }> = [];
		for (const row of result.stdout.split("\n")) {
			if (!row) continue;
			const [ref, commit, objectType, upstream = "", symref = ""] = row.split("\0");
			if (!ref) throw new ManagedWorktreeError("INVALID_WORKTREE_BASE", "Malformed Git ref output");
			if (symref) {
				if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) {
					symbolicDefaults.push({ ref, target: symref });
				}
				continue;
			}
			const presentation = qualified(ref);
			if (!presentation || objectType !== "commit" || !commit) continue;
			candidates.push({ ref, commit, upstream, ...presentation });
		}

		const localByUpstream = new Map<string, Array<GitWorktreeBase & { upstream: string }>>();
		for (const candidate of candidates) {
			if (candidate.kind !== "local" || !candidate.upstream) continue;
			const values = localByUpstream.get(candidate.upstream) ?? [];
			values.push(candidate);
			localByUpstream.set(candidate.upstream, values);
		}
		const representative = new Map<string, string>();
		const bases = candidates.filter((candidate) => {
			if (candidate.kind !== "remote") return true;
			const tracking = (localByUpstream.get(candidate.ref) ?? [])
				.filter((local) => local.commit === candidate.commit)
				.sort((a, b) => a.ref.localeCompare(b.ref));
			if (tracking[0]) {
				representative.set(candidate.ref, tracking[0].ref);
				return false;
			}
			return true;
		});
		bases.sort(
			(a, b) => a.qualifiedName.localeCompare(b.qualifiedName) || a.ref.localeCompare(b.ref),
		);
		const available = new Set(bases.map((base) => base.ref));
		const mappedDefault = (target: string): string | null => {
			const mapped = representative.get(target) ?? target;
			return available.has(mapped) ? mapped : null;
		};
		const origin = symbolicDefaults.find(({ ref }) => ref === "refs/remotes/origin/HEAD");
		let defaultBaseRef = origin ? mappedDefault(origin.target) : null;
		if (!defaultBaseRef) {
			const defaults = symbolicDefaults
				.map(({ target }) => mappedDefault(target))
				.filter((value): value is string => value !== null);
			defaultBaseRef = defaults.length === 1 ? (defaults[0] ?? null) : null;
		}
		return {
			bases: bases.map(({ upstream: _upstream, ...base }) => base),
			defaultBaseRef,
		};
	}

	async resolveBase(repositoryRoot: string, ref: string): Promise<string> {
		if (!isSelectableBaseRef(ref) || ref.endsWith("/HEAD")) {
			throw new ManagedWorktreeError("INVALID_WORKTREE_BASE", "Worktree base must be a branch ref");
		}
		const result = await this.runGit(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
		if (result.exitCode !== 0 || !line(result.stdout)) {
			throw new ManagedWorktreeError(
				"INVALID_WORKTREE_BASE",
				`Worktree base is unavailable: ${ref}`,
			);
		}
		return line(result.stdout);
	}

	async plan(
		repositoryRoot: string,
		originProjectPath: string,
		operationId: string,
	): Promise<ManagedWorktreePlan> {
		const canonicalRepository = await realpath(repositoryRoot);
		const canonicalOrigin = await realpath(originProjectPath);
		if (!contained(canonicalRepository, canonicalOrigin)) {
			throw new ManagedWorktreeError(
				"WORKTREE_PROJECT_PATH_UNSAFE",
				"Registered project is outside its source repository",
			);
		}
		await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
		const canonicalRoot = await realpath(this.managedRoot);
		const prefix =
			basename(canonicalRepository)
				.replace(/[^a-zA-Z0-9._-]+/gu, "-")
				.replace(/^-+|-+$/gu, "")
				.slice(0, 48) || "repository";
		const digest = createHash("sha256")
			.update(canonicalRepository)
			.update("\0")
			.update(operationId)
			.digest("hex");
		const destination = join(canonicalRoot, `${prefix}-${digest}`);
		await this.assertSafeDestination(canonicalRepository, destination);
		return {
			destination,
			projectRelativePath: relative(canonicalRepository, canonicalOrigin),
		};
	}

	async assertSafeDestination(repositoryRoot: string, destination: string): Promise<void> {
		try {
			await lstat(destination);
			throw new ManagedWorktreeError(
				"WORKTREE_DESTINATION_UNAVAILABLE",
				`Managed worktree destination already exists: ${destination}`,
			);
		} catch (error) {
			if (
				error instanceof ManagedWorktreeError ||
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			) {
				throw error;
			}
		}
		const ancestor = await nearestExisting(destination);
		const canonicalDestination = join(
			await realpath(ancestor),
			relative(ancestor, resolve(destination)),
		);
		const worktrees = await this.git(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
		const common = await this.git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
		const unsafe = [resolve(repositoryRoot, line(common.stdout))];
		for (const field of worktrees.stdout.split("\0")) {
			if (field.startsWith("worktree "))
				unsafe.push(await realpath(field.slice("worktree ".length)));
		}
		if (unsafe.some((path) => contained(path, canonicalDestination))) {
			throw new ManagedWorktreeError(
				"UNSAFE_WORKTREE_DESTINATION",
				"Managed destination is inside a checkout or Git metadata",
			);
		}
		const unrelated = await this.runGit(ancestor, ["rev-parse", "--show-toplevel"]);
		if (unrelated.exitCode === 0) {
			throw new ManagedWorktreeError(
				"UNSAFE_WORKTREE_DESTINATION",
				"Managed destination is inside an unrelated repository",
			);
		}
	}

	async create(
		repositoryRoot: string,
		destination: string,
		commit: string,
		newBranch: string | null,
	): Promise<void> {
		await this.assertSafeDestination(repositoryRoot, destination);
		if (newBranch) {
			const valid = await this.runGit(repositoryRoot, ["check-ref-format", "--branch", newBranch]);
			if (valid.exitCode !== 0) {
				throw new ManagedWorktreeError("INVALID_BRANCH", `Invalid branch name: ${newBranch}`);
			}
			const exists = await this.runGit(repositoryRoot, [
				"show-ref",
				"--verify",
				"--quiet",
				`refs/heads/${newBranch}`,
			]);
			if (exists.exitCode === 0) {
				throw new ManagedWorktreeError(
					"BRANCH_EXISTS",
					`Local branch already exists: ${newBranch}`,
				);
			}
			if (exists.exitCode !== 1) {
				throw new ManagedWorktreeError("WORKTREE_CREATE_FAILED", "Failed to inspect branch");
			}
		}
		const args = newBranch
			? ["worktree", "add", "-b", newBranch, destination, commit]
			: ["worktree", "add", "--detach", destination, commit];
		const created = await this.runGit(repositoryRoot, args);
		if (created.exitCode !== 0) {
			throw new ManagedWorktreeError(
				"WORKTREE_CREATE_FAILED",
				line(created.stderr) || "Git could not create the managed worktree",
			);
		}
	}

	async mapProject(destination: string, relativePath: string): Promise<string> {
		const candidate = resolve(destination, relativePath);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(candidate);
		} catch {
			throw new ManagedWorktreeError(
				"WORKTREE_PROJECT_PATH_MISSING",
				"Registered project path is missing from the selected base",
			);
		}
		if (!info.isDirectory()) {
			throw new ManagedWorktreeError(
				"WORKTREE_PROJECT_PATH_MISSING",
				"Registered project path is not a directory in the selected base",
			);
		}
		const canonicalRoot = await realpath(destination);
		const canonicalProject = await realpath(candidate);
		if (!contained(canonicalRoot, canonicalProject)) {
			throw new ManagedWorktreeError(
				"WORKTREE_PROJECT_PATH_UNSAFE",
				"Registered project path escapes the managed worktree",
			);
		}
		return canonicalProject;
	}

	private async git(cwd: string, args: string[]): Promise<GitCommandResult> {
		const result = await this.runGit(cwd, args);
		if (result.exitCode !== 0) {
			throw new ManagedWorktreeError("INVALID_WORKTREE_BASE", "Failed to inspect local Git refs");
		}
		return result;
	}
}
