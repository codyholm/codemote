// Shared types for Codemote

export const VERSION = "0.1.0";

// Error types
export {
	GuildRemoteError,
	SessionNotFoundError,
	SessionNotActiveError,
	WorkspaceNotFoundError,
} from "./errors.js";

// Runtime types
export type RuntimeType = "opencode" | "claude" | "codex" | "gemini";

export interface ModelInfo {
	id: string;
	label: string;
}

export const RUNTIME_MODELS: Record<RuntimeType, ModelInfo[]> = {
	claude: [
		{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{ id: "claude-opus-4-6", label: "Opus 4.6" },
		{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
	],
	opencode: [
		{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
		{ id: "gpt-4.1", label: "GPT-4.1" },
		{ id: "o4-mini", label: "o4-mini" },
	],
	codex: [
		{ id: "o4-mini", label: "o4-mini" },
		{ id: "o3", label: "o3" },
		{ id: "gpt-4.1", label: "GPT-4.1" },
	],
	gemini: [
		{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
		{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
	],
};

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
