// Shared types for Codemote

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
	| "session.message"
	| "session.tool_call"
	| "session.tool_result"
	| "session.status"
	| "attention.required"
	| "git.diff_updated";

export interface StreamEvent {
	type: StreamEventType;
	timestamp: number;
	sessionId: string;
	payload: unknown;
}

export interface MessagePayload {
	role: "assistant" | "user";
	content: string;
	parentToolUseId?: string;
}

export interface ToolCallPayload {
	toolCallId: string;
	toolName: string;
	arguments?: string;
	parentToolUseId?: string;
}

export interface ToolResultPayload {
	toolCallId: string;
	toolName: string;
	output?: string;
	error?: string;
	parentToolUseId?: string;
}

// Executor interface types
export interface RunOptions {
	profile: RuntimeType;
	workspace: string;
	initialPrompt: string;
	resumeSessionId?: string;
	model?: string;
}

export interface RunResult {
	runId: string;
	sessionId: string;
}
