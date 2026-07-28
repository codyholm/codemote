// @codemote/server — Combined relay + uplink package

// ── Relay exports ──────────────────────────────────────────────
export { createRelayServer, type RelayServerConfig } from "./relay/server.js";
export { PairingCodeService } from "./relay/services/codes.js";
export { RoomManager } from "./relay/services/rooms.js";
export {
	TrustedPairingsStore,
	type TrustedPairingRecord,
} from "./relay/services/trusted-pairings.js";
export type { RelayEnvelope, PairingSession, ConnectedClient } from "./relay/index.js";
export { RELAY_VERSION } from "./relay/index.js";

// ── Uplink exports ─────────────────────────────────────────────
export { UplinkServer } from "./uplink/server.js";
export { SessionManager } from "./uplink/session.js";
export { WorkspaceManager } from "./uplink/workspace.js";
export { EventBus, createEvent } from "./uplink/events.js";
export { BaseExecutor } from "./uplink/executor.js";
export { MockExecutor } from "./uplink/mock-executor.js";
export {
	OpenCodeExecutor,
	ClaudeExecutor,
	CodexExecutor,
	GeminiExecutor,
} from "./uplink/executors/index.js";
export type {
	OpenCodeConfig,
	ClaudeConfig,
	CodexConfig,
	GeminiConfig,
} from "./uplink/executors/index.js";
export { DEFAULT_CONFIG } from "./uplink/types.js";
export { loadConfig, validateConfig } from "./uplink/config.js";
export { SmokeTestHarness, runAllSmokeTests } from "./uplink/smoke/index.js";
export type { SmokeTestConfig, SmokeTestResult } from "./uplink/smoke/index.js";

// ── Speech exports ─────────────────────────────────────────────
export {
	createSpeechServer,
	// Renamed at package level so a bare `isLoopbackHost` cannot be mistaken
	// for uplink's identically named predicate.
	isLoopbackHost as isSpeechLoopbackHost,
	loadSpeechConfig,
	speechEnabled,
	speechPortOverride,
	SpeechError,
} from "./speech/index.js";
export type {
	EngineStatus,
	SpeechConfig,
	SpeechDiscoveryFile,
	SpeechHealth,
	SpeechServerHandle,
	WavInfo,
} from "./speech/index.js";

// ── Types (re-exported from uplink/types + common) ─────────────
export type {
	ModelInfo,
	PendingAttention,
	ProjectStateAggregate,
	RegisteredProject,
	RuntimeType,
	SessionStatus,
	StreamEvent,
	RunOptions,
	RunResult,
	WorkspaceConfig,
	Workspace,
	DirectoryEntry,
	Session,
	UplinkCommand,
	UplinkResponse,
	UplinkConfig,
	RuntimeConfigs,
} from "./uplink/types.js";
