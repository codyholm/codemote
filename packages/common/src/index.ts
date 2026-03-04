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
	provider?: string;
}

export const RUNTIME_MODELS: Record<RuntimeType, ModelInfo[]> = {
	claude: [
		{ id: "sonnet", label: "Sonnet" },
		{ id: "opus", label: "Opus" },
		{ id: "haiku", label: "Haiku" },
	],
	opencode: [
		{ id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
		{ id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic" },
		{ id: "openai/gpt-5.3-codex", label: "GPT 5.3 Codex", provider: "openai" },
		{ id: "openai/gpt-5.2-codex", label: "GPT 5.2 Codex", provider: "openai" },
		{ id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
		{ id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
	],
	codex: [
		{ id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
		{ id: "gpt-5.2-codex", label: "GPT 5.2 Codex" },
		{ id: "gpt-5.2", label: "GPT 5.2" },
	],
	gemini: [
		{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
		{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
		{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
		{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
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
