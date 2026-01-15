// Shared types for Guild Remote

export const VERSION = "0.1.0";

// Error types
export {
	GuildRemoteError,
	SessionNotFoundError,
	SessionNotActiveError,
	ExecutorError,
	ExecutorNotFoundError,
	WorkspaceNotFoundError,
	PairingCodeInvalidError,
	NotConnectedError,
} from "./errors.js";

// Runtime types
export type RuntimeType = "opencode" | "claude" | "codex" | "gemini";

// Session status
export type SessionStatus = "starting" | "running" | "idle" | "ended" | "error";

// Unified stream event types
export type StreamEventType =
	| "session.output"
	| "session.status"
	| "attention.required"
	| "artifact.created"
	| "git.diff_updated";

export interface StreamEvent {
	type: StreamEventType;
	timestamp: number;
	sessionId: string;
	payload: unknown;
}

// Executor interface types
export interface RunOptions {
	profile: RuntimeType;
	workspace: string;
	initialPrompt: string;
}

export interface RunResult {
	runId: string;
	sessionId: string;
}

export interface Artifacts {
	summary: string;
	changes: string[];
	evidence: string[];
	decisions: string[];
}
