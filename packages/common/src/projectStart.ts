export interface GitCheckoutState {
	repositoryRoot: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
}

export interface ProjectStartState {
	originProjectPath: string;
	mode: "project_folder";
	directory: string;
	git: GitCheckoutState | null;
	worktree: WorktreeStartState | null;
}

export interface GitWorktreeBase {
	ref: string;
	qualifiedName: string;
	kind: "local" | "remote";
	commit: string;
}

export interface WorktreeStartState {
	bases: GitWorktreeBase[];
	defaultBaseRef: string | null;
}

export type ProjectFolderStartPreparation =
	| { type: "none" }
	| {
			type: "create_branch";
			newBranch: string;
			expectedHead: string;
			expectedBranch: string | null;
	  };

export interface ProjectFolderStartRequest {
	operationId: string;
	originProjectPath: string;
	mode: "project_folder";
	preparation: ProjectFolderStartPreparation;
}

export interface ManagedWorktreeStartRequest {
	operationId: string;
	originProjectPath: string;
	mode: "worktree";
	preparation: {
		type: "create_worktree";
		baseRef: string;
		expectedCommit: string;
		newBranch: string | null;
	};
}

export type ProjectStartRequest = ProjectFolderStartRequest | ManagedWorktreeStartRequest;
export type ProjectStartPreparation = ProjectFolderStartPreparation;

export interface ProjectFolderExecutionState {
	directory: string;
	mode: "project_folder";
	git: GitCheckoutState | null;
}

export interface ManagedWorktreeExecutionState {
	directory: string;
	mode: "worktree";
	git: GitCheckoutState;
	worktree: {
		path: string;
		baseRef: string;
		baseCommit: string;
	};
}

export type SessionExecutionState = ProjectFolderExecutionState | ManagedWorktreeExecutionState;

export type ProjectStartPhase =
	| "recorded"
	| "branch_created"
	| "branch_checked_out"
	| "worktree_created"
	| "worktree_ready"
	| "launch_requested"
	| "session_started"
	| "failed"
	| "retained";

export interface ProjectStartFailureDetails {
	operationId: string;
	phase: ProjectStartPhase;
	originProjectPath: string;
	effectiveState?: SessionExecutionState;
	retainedBranch?: string;
	retainedWorktreePath?: string;
	createdSessionId?: string;
}
