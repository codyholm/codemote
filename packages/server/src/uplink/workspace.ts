import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceNotFoundError } from "@codemote/common";
import { type SimpleGit, simpleGit } from "simple-git";
import type { GitStatusSummary, Workspace, WorkspaceConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Manages runtime workspaces.
 *
 * Sessions run directly in the provided repo path; branch/worktree orchestration is intentionally out of
 * scope for the Codemote runtime path.
 */
export class WorkspaceManager {
	private readonly gitByDir = new Map<string, SimpleGit>();
	private readonly workspaces = new Map<string, Workspace>();

	constructor(private readonly repoPath: string) {}

	/**
	 * Create a workspace for a session.
	 */
	async create(config: WorkspaceConfig): Promise<Workspace> {
		const workingDir = config.repoPath || this.repoPath;
		const workspace: Workspace = {
			id: config.workspaceId,
			workingDir,
			createdAt: Date.now(),
		};
		this.workspaces.set(workspace.id, workspace);
		return workspace;
	}

	/**
	 * Get an existing workspace.
	 */
	get(id: string): Workspace | undefined {
		return this.workspaces.get(id);
	}

	/**
	 * Remove a workspace from memory.
	 */
	async remove(id: string): Promise<void> {
		this.workspaces.delete(id);
	}

	/**
	 * Get git diff for a workspace.
	 */
	async getDiff(id: string, scope: "staged" | "unstaged" | "all"): Promise<string> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		const workspaceGit = this.gitForDir(workspace.workingDir);
		switch (scope) {
			case "staged":
				return workspaceGit.diff(["--cached"]);
			case "unstaged":
				return workspaceGit.diff();
			case "all": {
				const staged = await workspaceGit.diff(["--cached"]);
				const unstaged = await workspaceGit.diff();
				return `${staged}\n${unstaged}`.trim();
			}
		}
	}

	/**
	 * Get git status summary for a workspace.
	 */
	async getStatus(id: string): Promise<GitStatusSummary> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		const workspaceGit = this.gitForDir(workspace.workingDir);
		const status = await workspaceGit.status();

		return {
			branch: status.current ?? "HEAD",
			ahead: status.ahead,
			behind: status.behind,
			staged: status.staged.length,
			unstaged: status.modified.length + status.deleted.length,
			untracked: status.not_added.length,
		};
	}

	/**
	 * Pull from remote.
	 */
	async pull(id: string): Promise<string> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		const workspaceGit = this.gitForDir(workspace.workingDir);
		const result = await workspaceGit.pull();

		if (
			result.summary.changes === 0 &&
			result.summary.insertions === 0 &&
			result.summary.deletions === 0
		) {
			return "Already up to date.";
		}
		return `Pulled ${result.summary.changes} file(s): +${result.summary.insertions} -${result.summary.deletions}`;
	}

	/**
	 * Push to remote. Sets upstream if not configured.
	 */
	async push(id: string): Promise<string> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		const workspaceGit = this.gitForDir(workspace.workingDir);
		const status = await workspaceGit.status();
		const branch = status.current ?? "HEAD";

		try {
			await workspaceGit.push();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("no upstream") || msg.includes("has no upstream")) {
				const remotes = await workspaceGit.getRemotes();
				const remote = remotes[0]?.name ?? "origin";
				await workspaceGit.push(["-u", remote, branch]);
			} else {
				throw err;
			}
		}

		return `Pushed ${branch} to remote.`;
	}

	/**
	 * Create a new worktree with a new branch.
	 */
	async addWorktree(id: string, branch: string): Promise<{ path: string; branch: string }> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		if (!/^[a-zA-Z][a-zA-Z0-9._\-/]*$/.test(branch)) {
			throw new Error("Invalid branch name. Use letters, numbers, dots, hyphens, or slashes.");
		}

		const repoName = basename(workspace.workingDir);
		const safeBranch = branch.replace(/\//g, "-");
		const worktreePath = join(dirname(workspace.workingDir), `${repoName}-${safeBranch}`);

		const workspaceGit = this.gitForDir(workspace.workingDir);
		await workspaceGit.raw(["worktree", "add", worktreePath, "-b", branch]);

		return { path: worktreePath, branch };
	}

	/**
	 * Create a pull request using the `gh` CLI.
	 */
	async submitPR(id: string, title?: string, body?: string): Promise<string> {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new WorkspaceNotFoundError(id);

		// Validate input lengths
		if (title && title.length > 256) {
			throw new Error("PR title must be 256 characters or fewer.");
		}
		if (body && body.length > 10_000) {
			throw new Error("PR body must be 10,000 characters or fewer.");
		}

		// Check gh is available
		try {
			await execFileAsync("gh", ["--version"]);
		} catch {
			throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com");
		}

		// Push first
		await this.push(id);

		// Create PR
		const args = ["pr", "create"];
		if (title) {
			args.push("--title", title);
		}
		if (body) {
			args.push("--body", body);
		}
		if (!title && !body) {
			args.push("--fill");
		}

		const { stdout } = await execFileAsync("gh", args, {
			cwd: workspace.workingDir,
		});

		return stdout.trim();
	}

	/**
	 * List all active workspaces.
	 */
	list(): Workspace[] {
		return Array.from(this.workspaces.values());
	}

	private gitForDir(dir: string): SimpleGit {
		const existing = this.gitByDir.get(dir);
		if (existing) {
			return existing;
		}
		const created = simpleGit(dir);
		this.gitByDir.set(dir, created);
		return created;
	}
}
