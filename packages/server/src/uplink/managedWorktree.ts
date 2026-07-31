import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitCheckoutState, GitWorktreeBase, WorktreeStartState } from "@codemote/common";
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

/** The immutable ownership tuple a journal record holds for one worktree. */
export interface RecordedManagedWorktree {
	repositoryRoot: string;
	destination: string;
	selectedBaseRef: string;
	selectedBaseCommit: string;
	projectRelativePath: string;
	requestedBranch: string | null;
}

export type ManagedWorktreeMapping =
	| { ok: true; directory: string }
	| { ok: false; code: ManagedWorktreeErrorCode; message: string };

/**
 * Exhaustive classification of current Git and filesystem truth against a
 * recorded worktree. Anything that cannot be established is `uncertain`, never
 * `absent` and never clean.
 */
export type ManagedWorktreeTruth =
	| { status: "absent" }
	/** Registration and directory are provably gone; the exact branch remains. */
	| { status: "branch_only" }
	| { status: "changed"; reason: string }
	| { status: "uncertain"; reason: string }
	| {
			status: "exact";
			git: GitCheckoutState;
			mapping: ManagedWorktreeMapping;
			selectedBaseMatches: boolean;
			clean: boolean;
	  };

export type ManagedWorktreeRemoval = { status: "removed" } | { status: "retained"; reason: string };

interface WorktreeRegistration {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function line(value: string): string {
	return value.replace(/[\r\n]+$/u, "");
}

/** Whether `child` is `parent` itself or lies beneath it, on canonical paths. */
export function containedIn(parent: string, child: string): boolean {
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
		if (!containedIn(canonicalRepository, canonicalOrigin)) {
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
		if (unsafe.some((path) => containedIn(path, canonicalDestination))) {
			throw new ManagedWorktreeError(
				"UNSAFE_WORKTREE_DESTINATION",
				"Managed destination is inside a checkout or Git metadata",
			);
		}
		const unrelated = await this.runGit(ancestor, [
			"rev-parse",
			"--is-inside-work-tree",
			"--is-inside-git-dir",
			"--is-bare-repository",
		]);
		if (unrelated.exitCode === 0) {
			const membership = line(unrelated.stdout).split(/\r?\n/u);
			if (
				membership.length !== 3 ||
				membership.some((value) => value !== "true" && value !== "false")
			) {
				throw new ManagedWorktreeError(
					"WORKTREE_DESTINATION_UNAVAILABLE",
					"Git returned invalid destination membership state",
				);
			}
			if (!membership.includes("true")) return;
			throw new ManagedWorktreeError(
				"UNSAFE_WORKTREE_DESTINATION",
				"Managed destination is inside an unrelated repository",
			);
		}
		if (unrelated.exitCode !== 128) {
			throw new ManagedWorktreeError(
				"WORKTREE_DESTINATION_UNAVAILABLE",
				"Git could not validate the managed destination",
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

	/**
	 * Compare current truth with a recorded worktree without touching anything.
	 *
	 * `exact` means every immutable value the record owns still matches: the
	 * canonical destination is registered exactly once to the recorded source
	 * repository, at the recorded commit, in the recorded attached or detached
	 * state. Everything else is `changed`, `absent`, `branch_only` or `uncertain`.
	 */
	async inspectRecorded(recorded: RecordedManagedWorktree): Promise<ManagedWorktreeTruth> {
		const branchRef = recorded.requestedBranch ? `refs/heads/${recorded.requestedBranch}` : null;
		try {
			const registrations = await this.listRegistrations(recorded.repositoryRoot);
			const canonicalDestination = await this.canonicalOrNull(recorded.destination);
			const normalizedDestination = resolve(recorded.destination);
			// The recorded destination is canonical by construction, so a path that
			// now resolves elsewhere is a substitution — even when it lands on
			// another registered worktree at the same commit and branch. Adopting,
			// launching into or removing through it would act on the wrong checkout.
			if (canonicalDestination !== null && canonicalDestination !== normalizedDestination) {
				return {
					status: "changed",
					reason: `The recorded worktree destination ${normalizedDestination} now resolves to ${canonicalDestination}`,
				};
			}
			const registered = await this.findRegistration(
				registrations,
				recorded.destination,
				canonicalDestination,
			);
			const tip = branchRef ? await this.refTip(recorded.repositoryRoot, branchRef) : null;

			if (!registered) {
				if (canonicalDestination) {
					return {
						status: "changed",
						reason: `A directory exists at ${recorded.destination} without a matching worktree registration`,
					};
				}
				if (registrations.some((entry) => branchRef !== null && entry.branch === branchRef)) {
					return {
						status: "changed",
						reason: `The requested branch is checked out in another worktree: ${recorded.requestedBranch}`,
					};
				}
				if (tip === null) return { status: "absent" };
				if (tip !== recorded.selectedBaseCommit) {
					return {
						status: "changed",
						reason: `The requested branch moved away from the recorded commit: ${recorded.requestedBranch}`,
					};
				}
				return { status: "branch_only" };
			}

			// The directory is gone but Git still registers it. Say exactly that,
			// rather than letting the next command fail on the missing directory and
			// report an unhelpful inspection error. Nothing here removes the stale
			// registration; clearing it is the owner's call.
			if (!canonicalDestination) {
				return {
					status: "changed",
					reason: `The recorded worktree directory ${recorded.destination} is missing while ${recorded.repositoryRoot} still registers it; \`git worktree prune\` clears the stale registration once you are sure the directory is gone for good`,
				};
			}

			const mismatch = this.registrationMismatch(recorded, registered, branchRef, tip);
			if (mismatch) return { status: "changed", reason: mismatch };
			const common = await this.commonGitDirectory(recorded.destination);
			const sourceCommon = await this.commonGitDirectory(recorded.repositoryRoot);
			if (common !== sourceCommon) {
				return {
					status: "changed",
					reason: "The recorded worktree belongs to a different repository",
				};
			}

			const selectedBase = await this.refTip(
				recorded.repositoryRoot,
				`${recorded.selectedBaseRef}^{commit}`,
			);
			const status = await this.git(recorded.destination, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--ignored=matching",
			]);
			return {
				status: "exact",
				git: {
					repositoryRoot: recorded.destination,
					head: recorded.selectedBaseCommit,
					branch: recorded.requestedBranch,
					detached: recorded.requestedBranch === null,
				},
				mapping: await this.inspectMapping(recorded),
				selectedBaseMatches: selectedBase === recorded.selectedBaseCommit,
				clean: status.stdout === "",
			};
		} catch (error) {
			return { status: "uncertain", reason: describe(error) };
		}
	}

	/**
	 * Remove an exact, clean, unlaunched worktree after proving it again.
	 *
	 * Git's own non-force removal is the only deletion used: it refuses to remove
	 * a worktree with local modifications, so the proof and the command agree.
	 */
	async rollbackExact(recorded: RecordedManagedWorktree): Promise<ManagedWorktreeRemoval> {
		const proof = await this.inspectRecorded(recorded);
		if (proof.status !== "exact") {
			return {
				status: "retained",
				reason:
					proof.status === "changed" || proof.status === "uncertain"
						? proof.reason
						: "The recorded worktree is no longer present as recorded",
			};
		}
		if (!proof.mapping.ok) return { status: "retained", reason: proof.mapping.message };
		if (!proof.selectedBaseMatches) {
			return { status: "retained", reason: "The selected base no longer resolves as recorded" };
		}
		if (!proof.clean) {
			return { status: "retained", reason: "The worktree contains local changes" };
		}

		let removal: GitCommandResult;
		try {
			removal = await this.runGit(recorded.repositoryRoot, [
				"worktree",
				"remove",
				recorded.destination,
			]);
		} catch (error) {
			return { status: "retained", reason: describe(error) };
		}
		if (removal.exitCode !== 0) {
			return {
				status: "retained",
				reason: line(removal.stderr) || "Git could not remove the managed worktree",
			};
		}
		const after = await this.inspectRecorded(recorded);
		if (after.status === "absent" || after.status === "branch_only") return { status: "removed" };
		return {
			status: "retained",
			reason:
				after.status === "changed" || after.status === "uncertain"
					? after.reason
					: "The worktree registration or directory survived removal",
		};
	}

	/**
	 * Delete only the request-owned branch, and only while it still points at the
	 * commit this operation created it from.
	 */
	async deleteRollbackBranch(recorded: RecordedManagedWorktree): Promise<ManagedWorktreeRemoval> {
		if (!recorded.requestedBranch) return { status: "removed" };
		const ref = `refs/heads/${recorded.requestedBranch}`;
		try {
			const tip = await this.refTip(recorded.repositoryRoot, ref);
			if (tip === null) return { status: "removed" };
			if (tip !== recorded.selectedBaseCommit) {
				return {
					status: "retained",
					reason: `The branch moved away from the recorded commit: ${recorded.requestedBranch}`,
				};
			}
			const deleted = await this.runGit(recorded.repositoryRoot, [
				"update-ref",
				"-d",
				ref,
				recorded.selectedBaseCommit,
			]);
			if (deleted.exitCode !== 0) {
				return {
					status: "retained",
					reason: line(deleted.stderr) || "Git could not delete the request-owned branch",
				};
			}
			if ((await this.refTip(recorded.repositoryRoot, ref)) !== null) {
				return { status: "retained", reason: "The request-owned branch survived deletion" };
			}
			return { status: "removed" };
		} catch (error) {
			return { status: "retained", reason: describe(error) };
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
		if (!containedIn(canonicalRoot, canonicalProject)) {
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

	/**
	 * Parse `git worktree list --porcelain -z` into canonical registrations.
	 *
	 * Records are NUL-terminated attributes ending with an empty attribute. Every
	 * record must name a worktree path; attributes this recovery does not consume
	 * (`bare`, `locked`, `prunable`, later additions) are ignored rather than
	 * treated as corruption, because none of them can make a worktree look
	 * present, exact or clean when it is not.
	 */
	private async listRegistrations(repositoryRoot: string): Promise<WorktreeRegistration[]> {
		const result = await this.git(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
		const registrations: WorktreeRegistration[] = [];
		let current: WorktreeRegistration | null = null;
		for (const field of result.stdout.split("\0")) {
			if (field === "") {
				if (current) registrations.push(current);
				current = null;
				continue;
			}
			if (field.startsWith("worktree ")) {
				if (current) {
					throw new ManagedWorktreeError("WORKTREE_CREATE_FAILED", "Malformed Git worktree list");
				}
				current = {
					path: resolve(field.slice("worktree ".length)),
					head: null,
					branch: null,
					detached: false,
				};
				continue;
			}
			if (!current) {
				throw new ManagedWorktreeError("WORKTREE_CREATE_FAILED", "Malformed Git worktree list");
			}
			if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
			else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
			else if (field === "detached") current.detached = true;
		}
		if (current) registrations.push(current);
		return registrations;
	}

	private registrationMismatch(
		recorded: RecordedManagedWorktree,
		registration: WorktreeRegistration,
		branchRef: string | null,
		tip: string | null,
	): string | null {
		if (registration.head !== recorded.selectedBaseCommit) {
			return "The recorded worktree is no longer at its selected commit";
		}
		if (registration.branch !== branchRef) {
			return "The recorded worktree is checked out on a different branch";
		}
		if (registration.detached !== (branchRef === null)) {
			return "The recorded worktree changed between attached and detached";
		}
		if (branchRef !== null && tip !== recorded.selectedBaseCommit) {
			return `The requested branch moved away from the recorded commit: ${recorded.requestedBranch}`;
		}
		return null;
	}

	private async inspectMapping(recorded: RecordedManagedWorktree): Promise<ManagedWorktreeMapping> {
		try {
			return {
				ok: true,
				directory: await this.mapProject(recorded.destination, recorded.projectRelativePath),
			};
		} catch (error) {
			if (error instanceof ManagedWorktreeError) {
				return { ok: false, code: error.code, message: error.message };
			}
			throw error;
		}
	}

	private async commonGitDirectory(cwd: string): Promise<string> {
		const result = await this.git(cwd, ["rev-parse", "--git-common-dir"]);
		const value = line(result.stdout);
		if (!value) {
			throw new ManagedWorktreeError(
				"WORKTREE_CREATE_FAILED",
				"Git returned no common directory for the recorded worktree",
			);
		}
		return realpath(resolve(cwd, value));
	}

	private async refTip(repositoryRoot: string, ref: string): Promise<string | null> {
		const result = await this.runGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", ref]);
		if (result.exitCode === 1) return null;
		if (result.exitCode !== 0) {
			throw new ManagedWorktreeError(
				"WORKTREE_CREATE_FAILED",
				`Failed to resolve ${ref} in the source repository`,
			);
		}
		const value = line(result.stdout);
		if (!/^[0-9a-f]{40,64}$/u.test(value)) {
			throw new ManagedWorktreeError(
				"WORKTREE_CREATE_FAILED",
				`Git returned an unusable commit for ${ref}`,
			);
		}
		return value;
	}

	/**
	 * Match a registration by literal path first, then by canonical path, so a
	 * registration whose directory is already gone is still found. A registration
	 * that cannot be canonicalised is skipped rather than allowed to make an
	 * unrelated worktree's state uncertain.
	 */
	private async findRegistration(
		registrations: WorktreeRegistration[],
		destination: string,
		canonicalDestination: string | null,
	): Promise<WorktreeRegistration | undefined> {
		const literal = resolve(destination);
		const direct = registrations.find((entry) => entry.path === literal);
		if (direct || canonicalDestination === null) return direct;
		for (const entry of registrations) {
			try {
				if ((await realpath(entry.path)) === canonicalDestination) return entry;
			} catch {
				// A registration whose own path cannot be resolved is not this one.
			}
		}
		return undefined;
	}

	/**
	 * The canonical path, or null only when nothing exists there at all. A
	 * dangling symlink throws rather than reading as absent.
	 */
	private async canonicalOrNull(path: string): Promise<string | null> {
		try {
			await lstat(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
		return realpath(path);
	}
}
