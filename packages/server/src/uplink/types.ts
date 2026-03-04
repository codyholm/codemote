import type {
	ModelInfo,
	RunOptions,
	RunResult,
	RuntimeType,
	SessionStatus,
	StreamEvent,
} from "@codemote/common";

// Re-export common types
export type { ModelInfo, RunOptions, RunResult, RuntimeType, SessionStatus, StreamEvent };

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
 * Command sent to Uplink via WebSocket
 */
export type UplinkCommand =
	| { type: "start_run"; payload: RunOptions }
	| { type: "send_input"; payload: { sessionId: string; input: string } }
	| { type: "stop"; payload: { sessionId: string } }
	| {
			type: "get_diff";
			payload: { sessionId: string; scope: "staged" | "unstaged" | "all" };
	  }
	| { type: "git_status"; payload: { sessionId: string } }
	| { type: "git_pull"; payload: { sessionId: string } }
	| { type: "git_push"; payload: { sessionId: string } }
	| { type: "git_worktree_add"; payload: { sessionId: string; branch: string } }
	| {
			type: "git_submit_pr";
			payload: { sessionId: string; title?: string; body?: string };
	  }
	| { type: "list_sessions" }
	| { type: "list_models"; payload: { profile: RuntimeType } }
	| { type: "list_directory"; payload: { path?: string } }
	| { type: "list_runtimes" }
	| { type: "ping" };

/**
 * Response from Uplink via WebSocket
 */
export type UplinkResponse =
	| { type: "run_started"; payload: RunResult }
	| { type: "input_sent"; payload: { sessionId: string } }
	| { type: "stopped"; payload: { sessionId: string } }
	| { type: "diff"; payload: { sessionId: string; diff: string } }
	| {
			type: "git_status_result";
			payload: { sessionId: string; status: GitStatusSummary };
	  }
	| { type: "git_pull_result"; payload: { sessionId: string; summary: string } }
	| { type: "git_push_result"; payload: { sessionId: string; summary: string } }
	| {
			type: "git_worktree_result";
			payload: { sessionId: string; path: string; branch: string };
	  }
	| { type: "git_pr_result"; payload: { sessionId: string; url: string } }
	| { type: "sessions"; payload: Session[] }
	| { type: "model_list"; payload: { runtime: RuntimeType; models: ModelInfo[] } }
	| { type: "pong" }
	| { type: "directory_listing"; payload: { path: string; entries: DirectoryEntry[] } }
	| { type: "runtime_list"; payload: { runtimes: RuntimeType[] } }
	| { type: "error"; payload: { message: string; code: string } }
	| { type: "event"; payload: StreamEvent };

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
