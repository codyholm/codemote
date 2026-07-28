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
	costTier?: "low" | "medium" | "high";
	capabilityTier?: "basic" | "standard" | "advanced";
}

export const RUNTIME_MODELS: Record<RuntimeType, ModelInfo[]> = {
	claude: [
		{ id: "sonnet", label: "Sonnet", costTier: "medium", capabilityTier: "standard" },
		{ id: "opus", label: "Opus", costTier: "high", capabilityTier: "advanced" },
		{ id: "haiku", label: "Haiku", costTier: "low", capabilityTier: "basic" },
	],
	opencode: [
		{
			id: "anthropic/claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
			provider: "anthropic",
			costTier: "medium",
			capabilityTier: "standard",
		},
		{
			id: "anthropic/claude-opus-4-6",
			label: "Claude Opus 4.6",
			provider: "anthropic",
			costTier: "high",
			capabilityTier: "advanced",
		},
		{
			id: "openai/gpt-5.3-codex",
			label: "GPT 5.3 Codex",
			provider: "openai",
			costTier: "medium",
			capabilityTier: "standard",
		},
		{
			id: "openai/gpt-5.2-codex",
			label: "GPT 5.2 Codex",
			provider: "openai",
			costTier: "low",
			capabilityTier: "standard",
		},
		{
			id: "google/gemini-2.5-flash",
			label: "Gemini 2.5 Flash",
			provider: "google",
			costTier: "low",
			capabilityTier: "basic",
		},
		{
			id: "google/gemini-2.5-pro",
			label: "Gemini 2.5 Pro",
			provider: "google",
			costTier: "medium",
			capabilityTier: "standard",
		},
	],
	codex: [
		{ id: "gpt-5.3-codex", label: "GPT 5.3 Codex", costTier: "medium", capabilityTier: "standard" },
		{ id: "gpt-5.2-codex", label: "GPT 5.2 Codex", costTier: "low", capabilityTier: "standard" },
		{ id: "gpt-5.2", label: "GPT 5.2", costTier: "low", capabilityTier: "basic" },
	],
	gemini: [
		{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", costTier: "low", capabilityTier: "basic" },
		{
			id: "gemini-2.5-pro",
			label: "Gemini 2.5 Pro",
			costTier: "medium",
			capabilityTier: "standard",
		},
		{
			id: "gemini-3-flash-preview",
			label: "Gemini 3 Flash (Preview)",
			costTier: "low",
			capabilityTier: "standard",
		},
		{
			id: "gemini-3.1-pro-preview",
			label: "Gemini 3.1 Pro (Preview)",
			costTier: "medium",
			capabilityTier: "advanced",
		},
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
	temperature?: number;
	maxTokens?: number;
}

export interface RunResult {
	runId: string;
	sessionId: string;
}

// Config types
export type { CodemoteConfig, RuntimeSettings } from "./config.js";

// Project state aggregate types
export type {
	PendingAttention,
	ProjectSessionState,
	ProjectState,
	ProjectStateAggregate,
	RegisteredProject,
	SessionAttentionState,
} from "./projectState.js";
export {
	ATTENTION_DESCRIPTION_MAX,
	ATTENTION_RANK,
	PROJECT_STATE_MAX_BYTES,
	PROJECT_STATE_MAX_PROJECTS,
	PROJECT_STATE_MAX_SESSIONS,
	attentionForSession,
} from "./projectState.js";
