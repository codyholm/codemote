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
}

export type ProjectStartPreparation =
	| { type: "none" }
	| {
			type: "create_branch";
			newBranch: string;
			expectedHead: string;
			expectedBranch: string | null;
	  };

export interface ProjectStartRequest {
	operationId: string;
	originProjectPath: string;
	mode: "project_folder";
	preparation: ProjectStartPreparation;
}

export interface SessionExecutionState {
	directory: string;
	mode: "project_folder";
	git: GitCheckoutState | null;
}

export type ProjectStartPhase =
	| "recorded"
	| "branch_created"
	| "branch_checked_out"
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
	createdSessionId?: string;
}
