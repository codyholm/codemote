// Uplink - Local companion service for Codemote

// Types
export type {
	RuntimeType,
	SessionExecutionState,
	SessionStatus,
	StreamEvent,
	RegisteredProject,
	ProjectStartFailureDetails,
	ProjectStartRequest,
	ProjectStartState,
	GitWorktreeBase,
	ManagedWorktreeExecutionState,
	ManagedWorktreeStartRequest,
	WorktreeStartState,
	RunOptions,
	RunResult,
	WorkspaceConfig,
	Workspace,
	DirectoryEntry,
	GitStatusSummary,
	Session,
	SessionStartContext,
	UplinkCommand,
	UplinkResponse,
	RequestEnvelope,
	UplinkConfig,
	RuntimeConfigs,
} from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";

// Core managers
export { WorkspaceManager } from "./workspace.js";
export { SessionManager } from "./session.js";
export { EventBus, createEvent } from "./events.js";

// Executor framework
export { BaseExecutor } from "./executor.js";
export { MockExecutor } from "./mock-executor.js";

// Executors
export {
	OpenCodeExecutor,
	ClaudeExecutor,
	CodexExecutor,
	GeminiExecutor,
} from "./executors/index.js";
export type { OpenCodeConfig, ClaudeConfig, CodexConfig, GeminiConfig } from "./executors/index.js";

// Server
export { UplinkServer } from "./server.js";
export { ManagedWorktreeService } from "./managedWorktree.js";

// Config
export { loadConfig, validateConfig } from "./config.js";

// Smoke testing
export { SmokeTestHarness, runAllSmokeTests } from "./smoke/index.js";
export type { SmokeTestConfig, SmokeTestResult } from "./smoke/index.js";
