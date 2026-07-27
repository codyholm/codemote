import type {
	ModelInfo,
	PendingAttention,
	ProjectStateAggregate,
	RunOptions,
	RunResult,
	RuntimeType,
	SessionStatus,
	StreamEvent,
} from "@codemote/common";

// Re-export common types
export type {
	ModelInfo,
	PendingAttention,
	ProjectStateAggregate,
	RunOptions,
	RunResult,
	RuntimeType,
	SessionStatus,
	StreamEvent,
};

/**
 * Workspace configuration for a session runtime.
 * Sessions execute in the current working directory; no branch/worktree orchestration.
 */
export interface WorkspaceConfig {
	/** Repository/workspace root path */
	repoPath: string;
	/** Stable workspace identifier */
	workspaceId: string;
}

/**
 * Active workspace state
 */
export interface Workspace {
	/** Workspace identifier */
	id: string;
	/** Working directory for this workspace */
	workingDir: string;
	/** When workspace was created */
	createdAt: number;
}

/**
 * A directory entry returned by list_directory
 */
export interface DirectoryEntry {
	name: string;
	isDirectory: boolean;
	isGitRepo: boolean;
}

/**
 * Session state
 */
export interface Session {
	/** Unique session ID */
	id: string;
	/** Run ID (may differ from session ID) */
	runId: string;
	/** Runtime-native session ID used for resume (e.g. Claude session_id) */
	runtimeSessionId?: string;
	/** Which runtime this session uses */
	runtime: RuntimeType;
	/** Current status */
	status: SessionStatus;
	/** Associated workspace */
	workspace: Workspace;
	/** When session started */
	startedAt: number;
	/** When session ended (if ended) */
	endedAt: number | null;
	/** Last activity timestamp */
	lastActivityAt: number;
	/** When `status` last actually changed, as opposed to was re-written. */
	statusChangedAt: number;
	/** Outstanding decision blocking this session. Cleared when answered or on a
	 * terminal/idle transition. Explicitly `| undefined` so the clear can assign
	 * rather than `delete`, which Biome's noDelete rule rejects. */
	attention?: PendingAttention | undefined;
}

/**
 * Git status summary for a workspace
 */
export interface GitStatusSummary {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
}

/**
 * Optional request-ID envelope for correlating commands with responses.
 * When present on a command, the server echoes it back on the response.
 */
export interface RequestEnvelope {
	requestId?: string;
}

/**
 * Command sent to Uplink via WebSocket
 */
export type UplinkCommand =
	| ({ type: "start_run"; payload: RunOptions } & RequestEnvelope)
	| ({ type: "send_input"; payload: { sessionId: string; input: string } } & RequestEnvelope)
	| ({ type: "stop"; payload: { sessionId: string } } & RequestEnvelope)
	| ({
			type: "get_diff";
			payload: { sessionId: string; scope: "staged" | "unstaged" | "all" };
	  } & RequestEnvelope)
	| ({ type: "git_status"; payload: { sessionId: string } } & RequestEnvelope)
	| ({ type: "git_pull"; payload: { sessionId: string } } & RequestEnvelope)
	| ({ type: "git_push"; payload: { sessionId: string } } & RequestEnvelope)
	| ({ type: "git_worktree_add"; payload: { sessionId: string; branch: string } } & RequestEnvelope)
	| ({
			type: "git_submit_pr";
			payload: { sessionId: string; title?: string; body?: string };
	  } & RequestEnvelope)
	| ({ type: "list_sessions" } & RequestEnvelope)
	| ({ type: "get_project_state" } & RequestEnvelope)
	| ({ type: "list_models"; payload: { profile: RuntimeType } } & RequestEnvelope)
	| ({ type: "list_directory"; payload: { path?: string } } & RequestEnvelope)
	| ({ type: "list_runtimes" } & RequestEnvelope)
	| ({ type: "ping" } & RequestEnvelope)
	| ({ type: "refresh_cache" } & RequestEnvelope);

/**
 * Response from Uplink via WebSocket
 */
export type UplinkResponse =
	| ({ type: "run_started"; payload: RunResult } & RequestEnvelope)
	| ({ type: "input_sent"; payload: { sessionId: string } } & RequestEnvelope)
	| ({ type: "stopped"; payload: { sessionId: string } } & RequestEnvelope)
	| ({ type: "diff"; payload: { sessionId: string; diff: string } } & RequestEnvelope)
	| ({
			type: "git_status_result";
			payload: { sessionId: string; status: GitStatusSummary };
	  } & RequestEnvelope)
	| ({ type: "git_pull_result"; payload: { sessionId: string; summary: string } } & RequestEnvelope)
	| ({ type: "git_push_result"; payload: { sessionId: string; summary: string } } & RequestEnvelope)
	| ({
			type: "git_worktree_result";
			payload: { sessionId: string; path: string; branch: string };
	  } & RequestEnvelope)
	| ({ type: "git_pr_result"; payload: { sessionId: string; url: string } } & RequestEnvelope)
	| ({ type: "sessions"; payload: Session[] } & RequestEnvelope)
	| ({ type: "project_state"; payload: ProjectStateAggregate } & RequestEnvelope)
	// Deliberately a different type string from "project_state". The bridge falls
	// back to matching an uncorrelated message against a pending request's expected
	// response type, so an unsolicited broadcast sharing that string would resolve
	// the wrong waiter and the real reply would then be dropped.
	| ({ type: "project_state_push"; payload: ProjectStateAggregate } & RequestEnvelope)
	| ({
			type: "model_list";
			payload: { runtime: RuntimeType; models: ModelInfo[] };
	  } & RequestEnvelope)
	| ({ type: "pong" } & RequestEnvelope)
	| ({
			type: "directory_listing";
			payload: { path: string; entries: DirectoryEntry[] };
	  } & RequestEnvelope)
	| ({ type: "runtime_list"; payload: { runtimes: RuntimeType[] } } & RequestEnvelope)
	| ({
			type: "cache_refreshed";
			payload: { availableRuntimes: RuntimeType[]; modelCounts: Record<string, number> };
	  } & RequestEnvelope)
	| ({ type: "error"; payload: { message: string; code: string } } & RequestEnvelope)
	| ({ type: "event"; payload: StreamEvent } & RequestEnvelope);

/**
 * Runtime-specific configurations
 */
export interface RuntimeConfigs {
	opencode?: {
		opencodePath?: string;
		extraArgs?: string[];
	};
	claude?: {
		claudePath?: string;
		extraArgs?: string[];
		dangerouslySkipPermissions?: boolean;
		permissionMode?:
			| "acceptEdits"
			| "bypassPermissions"
			| "default"
			| "delegate"
			| "dontAsk"
			| "plan";
	};
	codex?: {
		codexPath?: string;
		sandbox?: "read-only" | "workspace-write" | "danger-full-access";
		approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
		outputSchema?: string | null;
	};
	gemini?: {
		geminiPath?: string;
		extraArgs?: string[];
	};
}

/**
 * Uplink server configuration
 */
export interface UplinkConfig {
	/** WebSocket server port */
	port: number;
	/** Host to bind to */
	host: string;
	/** Repository root path */
	repoPath: string;
	/** Available runtime profiles */
	runtimes: RuntimeType[];
	/** Runtime-specific configurations */
	runtimeConfigs?: RuntimeConfigs;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: UplinkConfig = {
	port: 9876,
	host: "127.0.0.1",
	repoPath: process.cwd(),
	runtimes: ["opencode", "claude", "codex", "gemini"],
};
