import type {
	RunOptions,
	RunResult,
	RuntimeType,
	SessionStatus,
	StreamEvent,
} from "@codemote/common";

// Re-export common types
export type { RunOptions, RunResult, RuntimeType, SessionStatus, StreamEvent };

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
	| { type: "list_sessions" }
	| { type: "ping" };

/**
 * Response from Uplink via WebSocket
 */
export type UplinkResponse =
	| { type: "run_started"; payload: RunResult }
	| { type: "input_sent"; payload: { sessionId: string } }
	| { type: "stopped"; payload: { sessionId: string } }
	| { type: "diff"; payload: { sessionId: string; diff: string } }
	| { type: "sessions"; payload: Session[] }
	| { type: "pong" }
	| { type: "error"; payload: { message: string; code: string } }
	| { type: "event"; payload: StreamEvent };

/**
 * Runtime-specific configurations
 */
export interface RuntimeConfigs {
	opencode?: {
		serverUrl?: string;
		username?: string;
		password?: string | null;
		permissionRules?: Array<{
			permission: string;
			pattern: string;
			action: "allow" | "deny" | "ask";
		}>;
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
