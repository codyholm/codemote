import { WorkspaceNotFoundError } from "@codemote/common";
import { type SimpleGit, simpleGit } from "simple-git";
import type { Workspace, WorkspaceConfig } from "./types.js";

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
