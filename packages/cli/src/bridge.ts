import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { WebSocket } from "ws";

import { decodeBase64, decrypt, encodeBase64, encrypt, generateKeyPair } from "./encryption.js";
import type { KeyPair } from "./encryption.js";
import { WS_MAX_PAYLOAD_BYTES } from "./messageLimits.js";
import type {
	EncryptedPayload,
	EncryptionAccept,
	EncryptionOffer,
	EncryptionRotate,
	EncryptionRotateAck,
} from "./protocol.js";
import { ReplayGuard } from "./replayProtection.js";
import { detectTailscaleEndpoint } from "./tailscale.js";
import { validateEncryptedPayload } from "./validateEncryptedPayload.js";

import type {
	ModelInfo,
	ProjectStartFailureDetails,
	ProjectStartRequest,
	ProjectStartState,
	ProjectStateAggregate,
	RuntimeType,
	SessionExecutionState,
	SessionStatus,
	StreamEvent,
	UplinkCommand,
	UplinkResponse,
} from "@codemote/server";

interface RelayRegisteredMessage {
	type: "registered";
	pairingCode?: string;
	pin?: string;
}

interface RelayPairedMessage {
	type: "paired";
	uplinkDeviceId?: string;
	mobileDeviceId?: string;
}

interface RelayUnpairedMessage {
	type: "unpaired";
	uplinkDeviceId?: string;
	mobileDeviceId?: string;
}

interface RelayMobileDisconnectedMessage {
	type: "mobile_disconnected";
	uplinkDeviceId?: string;
	mobileDeviceId?: string;
}

interface RelayMessageMessage {
	type: "message";
	payload?: unknown;
}

interface RelayErrorMessage {
	type: "error";
	message: string;
}

type RelayInboundMessage =
	| RelayRegisteredMessage
	| RelayPairedMessage
	| RelayUnpairedMessage
	| RelayMobileDisconnectedMessage
	| RelayMessageMessage
	| RelayErrorMessage;

interface SessionInfo {
	id: string;
	runtime: RuntimeType;
	status: SessionStatus;
	createdAt: number;
	runtimeSessionId?: string;
	workspace?: string;
	originProjectPath?: string;
	execution?: SessionExecutionState;
}

interface SessionListMessage {
	type: "session_list";
	sessions: SessionInfo[];
}

interface ModelListMessage {
	type: "model_list";
	runtime: RuntimeType;
	models: ModelInfo[];
}

interface RuntimeListMessage {
	type: "runtime_list";
	runtimes: RuntimeType[];
}

interface SessionOutputMessage {
	type: "session_output";
	sessionId: string;
	text: string;
}

interface SessionMessageMessage {
	type: "session_message";
	sessionId: string;
	role: "assistant" | "user";
	content: string;
}

interface SessionToolCallMessage {
	type: "session_tool_call";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	arguments?: string;
}

interface SessionToolResultMessage {
	type: "session_tool_result";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	output?: string;
	error?: string;
}

interface SessionStatusMessage {
	type: "session_status";
	sessionId: string;
	status: SessionStatus;
}

interface ApprovalRequestInfo {
	id: string;
	action: string;
	description: string;
	details?: string | null;
}

interface ApprovalRequestMessage {
	type: "approval_request";
	sessionId: string;
	request: ApprovalRequestInfo;
}

interface DiffMessage {
	type: "diff";
	sessionId: string;
	diff: string;
}

interface DeviceEndpointMessage {
	kind: "local" | "tailscale" | "hosted";
	url: string;
}

interface DeviceInfoMessage {
	type: "device_info";
	uplinkDeviceId: string;
	endpoints: DeviceEndpointMessage[];
	availableRuntimes?: RuntimeType[];
}

interface RequestDeviceInfoMessage {
	type: "request_device_info";
}

interface ApprovalResponseMessage {
	type: "approval_response";
	sessionId: string;
	requestId: string;
	approved: boolean;
}

interface SendPromptMessage {
	type: "send_prompt";
	sessionId: string;
	prompt: string;
}

interface StopMessage {
	type: "stop";
	sessionId: string;
}

interface NewSessionMessage {
	type: "new_session";
	runtime: RuntimeType;
	prompt: string;
	workspace?: string;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	projectStart?: ProjectStartRequest;
}

interface ListModelsMessage {
	type: "list_models";
	runtime: RuntimeType;
}

interface ListRuntimesMessage {
	type: "list_runtimes";
}

interface GetProjectStateMessage {
	type: "get_project_state";
}

interface GetProjectStartStateMessage {
	type: "get_project_start_state";
	projectPath: string;
}

interface AddProjectMessage {
	type: "add_project";
	name: string;
	path: string;
}

interface ListProjectsMessage {
	type: "list_projects";
}

interface RenameProjectMessage {
	type: "rename_project";
	path: string;
	name: string;
}

interface RemoveProjectMessage {
	type: "remove_project";
	path: string;
}

interface ProjectStateMessage {
	type: "project_state";
	state: ProjectStateAggregate;
}

interface ProjectStartStateMessage {
	type: "project_start_state";
	projectPath: string;
	state?: ProjectStartState;
	error?: { code: string; message: string };
}

type SessionStartResultMessage =
	| {
			type: "session_start_result";
			operationId: string;
			success: true;
			sessionId: string;
			originProjectPath: string;
			execution: SessionExecutionState;
	  }
	| {
			type: "session_start_result";
			operationId: string;
			success: false;
			code: string;
			message: string;
			details?: ProjectStartFailureDetails;
	  };

interface SessionStartUnresolvedMessage {
	type: "session_start_unresolved";
	operationId: string;
	retryable: true;
	code: "UPLINK_RESPONSE_TIMEOUT" | "UPLINK_RESPONSE_UNRESOLVED";
	message: string;
}

interface ProjectRegistryResultMessage {
	type: "project_registry_result";
	operation: "add" | "rename" | "remove";
	path: string;
	success: boolean;
	error?: string;
}

type DiffScope = "staged" | "unstaged" | "all";

interface GetDiffMessage {
	type: "get_diff";
	sessionId: string;
	scope: DiffScope;
}

interface ListDirectoryMessage {
	type: "list_directory";
	path?: string;
}

interface DirectoryListingMessage {
	type: "directory_listing";
	path: string;
	entries: Array<{ name: string; isDirectory: boolean; isGitRepo: boolean }>;
	error?: string;
}

interface GitStatusMessage {
	type: "git_status";
	sessionId: string;
}

interface GitStatusResultMessage {
	type: "git_status_result";
	sessionId: string;
	status: {
		branch: string;
		ahead: number;
		behind: number;
		staged: number;
		unstaged: number;
		untracked: number;
	};
}

interface GitPullMessage {
	type: "git_pull";
	sessionId: string;
}

interface GitPullResultMessage {
	type: "git_pull_result";
	sessionId: string;
	summary: string;
}

interface GitPushMessage {
	type: "git_push";
	sessionId: string;
}

interface GitPushResultMessage {
	type: "git_push_result";
	sessionId: string;
	summary: string;
}

interface GitWorktreeAddMessage {
	type: "git_worktree_add";
	sessionId: string;
	branch: string;
}

interface GitWorktreeResultMessage {
	type: "git_worktree_result";
	sessionId: string;
	path: string;
	branch: string;
}

interface GitSubmitPRMessage {
	type: "git_submit_pr";
	sessionId: string;
	title?: string;
	body?: string;
}

interface GitPRResultMessage {
	type: "git_pr_result";
	sessionId: string;
	url: string;
}

type MobileInboundMessage =
	| ApprovalResponseMessage
	| SendPromptMessage
	| StopMessage
	| NewSessionMessage
	| ListModelsMessage
	| ListRuntimesMessage
	| GetProjectStateMessage
	| GetProjectStartStateMessage
	| AddProjectMessage
	| ListProjectsMessage
	| RenameProjectMessage
	| RemoveProjectMessage
	| GetDiffMessage
	| RequestDeviceInfoMessage
	| ListDirectoryMessage
	| GitStatusMessage
	| GitPullMessage
	| GitPushMessage
	| GitWorktreeAddMessage
	| GitSubmitPRMessage;

type MobileOutboundMessage =
	| SessionListMessage
	| ModelListMessage
	| SessionOutputMessage
	| SessionMessageMessage
	| SessionToolCallMessage
	| SessionToolResultMessage
	| SessionStatusMessage
	| ApprovalRequestMessage
	| DiffMessage
	| DeviceInfoMessage
	| DirectoryListingMessage
	| GitStatusResultMessage
	| GitPullResultMessage
	| GitPushResultMessage
	| GitWorktreeResultMessage
	| RuntimeListMessage
	| ProjectStateMessage
	| ProjectStartStateMessage
	| SessionStartResultMessage
	| SessionStartUnresolvedMessage
	| ProjectRegistryResultMessage
	| GitPRResultMessage;

export interface RelayUplinkBridgeConfig {
	relayUrl: string;
	relayWsOptions?: WebSocket.ClientOptions;
	uplinkUrl: string;
	repoPath: string;
	/**
	 * Preferred local endpoint URL that should be advertised back to mobile clients.
	 * Example: wss://192.168.1.25:8080/ws
	 */
	localEndpointUrl?: string;
	/**
	 * Hosted endpoint URL that should be advertised when remote relay mode is enabled.
	 */
	hostedEndpointUrl?: string;
	/**
	 * Optional decoder for end-to-end encrypted relay payloads.
	 * When omitted, encrypted payloads are rejected after validation + replay checks.
	 */
	decryptEncryptedPayload?: (payload: EncryptedPayload) => unknown;
	/**
	 * E2E encryption mode for relay traffic.
	 * - "off": No encryption (default for local/Tailscale)
	 * - "opportunistic": Offer encryption, fall back to plaintext if peer doesn't respond
	 * - "required": Not yet implemented (server.ts normalizes to "opportunistic")
	 */
	encryptionMode?: "off" | "opportunistic" | "required";
	/** How often to rotate E2E keys in ms. 0 disables rotation. Default: 30 minutes. */
	keyRotationIntervalMs?: number;
	onPairingCode?: (code: string) => void;
	onMobilePaired?: () => void;
	onMobileDisconnected?: () => void;
	onSessionStatus?: (info: {
		sessionId: string;
		runtime: RuntimeType;
		status: SessionStatus;
	}) => void;
	onProjectState?: (state: ProjectStateAggregate) => void;
	log?: (message: string) => void;
}

export interface RelayUplinkBridgeHandle {
	pairingCode: string;
	uplinkDeviceId: string;
	/** @deprecated alias of uplinkDeviceId for back-compat */
	uplinkPublicKey: string;
	/**
	 * Base64-encoded NaCl public key for E2E encryption.
	 * Undefined when encryption is not enabled.
	 */
	encryptionPublicKey?: string | undefined;
	startSession: (runtime: RuntimeType, prompt: string) => Promise<{ sessionId: string }>;
	refreshPairingCode: () => Promise<string>;
	stop: () => Promise<void>;
}

const DEVICE_ID_PATH = join(homedir(), ".codemote", "device-id");

class UplinkRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: ProjectStartFailureDetails,
	) {
		super(message);
		this.name = "UplinkRequestError";
	}
}

class UplinkResponseTimeoutError extends Error {
	constructor(readonly expectedType: UplinkResponse["type"]) {
		super(`Timed out waiting for uplink response: ${expectedType}`);
		this.name = "UplinkResponseTimeoutError";
	}
}

class UplinkWsClient {
	private readonly pending: Array<{
		requestId: string;
		expectedType: UplinkResponse["type"];
		resolve: (msg: UplinkResponse) => void;
		reject: (err: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];
	private commandQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly ws: WebSocket,
		private readonly onEvent: (event: StreamEvent) => void,
		private readonly onProjectState?: (state: ProjectStateAggregate) => void,
		private readonly log?: (message: string) => void,
	) {
		ws.on("message", (data: WebSocket.RawData) => {
			this.handleMessage(data);
		});

		ws.on("close", () => {
			this.rejectAll(new Error("Uplink WebSocket closed"));
		});

		ws.on("error", (err: unknown) => {
			this.rejectAll(err instanceof Error ? err : new Error(String(err)));
		});
	}

	static async connect(
		uplinkUrl: string,
		onEvent: (event: StreamEvent) => void,
		onProjectState?: (state: ProjectStateAggregate) => void,
		log?: (message: string) => void,
	): Promise<UplinkWsClient> {
		const ws = new WebSocket(uplinkUrl);
		await waitForOpen(ws);
		return new UplinkWsClient(ws, onEvent, onProjectState, log);
	}

	async startRun(
		profile: RuntimeType,
		workspace: string,
		initialPrompt: string,
		resumeSessionId?: string,
		model?: string,
		temperature?: number,
		maxTokens?: number,
		projectStart?: ProjectStartRequest,
	) {
		const normalizedModel = typeof model === "string" ? model.trim() : "";
		const payload = {
			profile,
			workspace,
			initialPrompt,
			...(resumeSessionId ? { resumeSessionId } : {}),
			...(normalizedModel ? { model: normalizedModel } : {}),
			...(typeof temperature === "number" && temperature >= 0 ? { temperature } : {}),
			...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
			...(projectStart ? { projectStart } : {}),
		};
		return this.sendAndWait({
			type: "start_run",
			payload,
		});
	}

	async sendInput(sessionId: string, input: string, options?: { bypassQueue?: boolean }) {
		return this.sendAndWait(
			{
				type: "send_input",
				payload: { sessionId, input },
			},
			options,
		);
	}

	async stopSession(sessionId: string) {
		return this.sendAndWait(
			{
				type: "stop",
				payload: { sessionId },
			},
			{ bypassQueue: true },
		);
	}

	async getDiff(sessionId: string, scope: DiffScope) {
		return this.sendAndWait({
			type: "get_diff",
			payload: { sessionId, scope },
		});
	}

	async listSessions() {
		return this.sendAndWait({
			type: "list_sessions",
		});
	}

	async getProjectState() {
		// Bypasses the serialized command queue. This is a pure read with no ordering
		// dependency on any other command, and it runs on the pair path - queued, a
		// slow or unanswered state read would stall every user action behind it for
		// the full command timeout.
		return this.sendAndWait({ type: "get_project_state" }, { bypassQueue: true });
	}

	async getProjectStartState(projectPath: string) {
		return this.sendAndWait(
			{ type: "get_project_start_state", payload: { projectPath } },
			{ bypassQueue: true },
		);
	}

	async addProject(name: string, path: string) {
		return this.sendAndWait(
			{
				type: "add_project",
				payload: { name, path },
			},
			{ bypassQueue: true },
		);
	}

	async listProjects() {
		return this.sendAndWait({ type: "list_projects" }, { bypassQueue: true });
	}

	async renameProject(path: string, name: string) {
		return this.sendAndWait(
			{
				type: "rename_project",
				payload: { path, name },
			},
			{ bypassQueue: true },
		);
	}

	async removeProject(path: string) {
		return this.sendAndWait(
			{
				type: "remove_project",
				payload: { path },
			},
			{ bypassQueue: true },
		);
	}

	async listModels(profile: RuntimeType) {
		return this.sendAndWait({
			type: "list_models",
			payload: { profile },
		});
	}

	async listRuntimes() {
		return this.sendAndWait({
			type: "list_runtimes",
		});
	}

	async listDirectory(path?: string) {
		return this.sendAndWait({
			type: "list_directory",
			payload: { ...(path ? { path } : {}) },
		});
	}

	async gitStatus(sessionId: string) {
		return this.sendAndWait({
			type: "git_status",
			payload: { sessionId },
		});
	}

	async gitPull(sessionId: string) {
		return this.sendAndWait({
			type: "git_pull",
			payload: { sessionId },
		});
	}

	async gitPush(sessionId: string) {
		return this.sendAndWait({
			type: "git_push",
			payload: { sessionId },
		});
	}

	async gitWorktreeAdd(sessionId: string, branch: string) {
		return this.sendAndWait({
			type: "git_worktree_add",
			payload: { sessionId, branch },
		});
	}

	async gitSubmitPR(sessionId: string, title?: string, body?: string) {
		return this.sendAndWait({
			type: "git_submit_pr",
			payload: { sessionId, ...(title ? { title } : {}), ...(body ? { body } : {}) },
		});
	}

	async close(): Promise<void> {
		if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
			return;
		}

		await new Promise<void>((resolve) => {
			this.ws.once("close", () => resolve());
			this.ws.close();
		});
	}

	private handleMessage(data: WebSocket.RawData): void {
		const msg = JSON.parse(data.toString()) as UplinkResponse;

		if (msg.type === "event") {
			this.onEvent(msg.payload);
			return;
		}

		// Must short-circuit before any correlation. Every other type falls through to
		// the pending-request matcher below, which - for a message with no requestId -
		// matches on expectedType alone. An unsolicited broadcast reaching that code
		// would resolve some other in-flight request with the wrong message, and the
		// genuine response would then be dropped as an unknown requestId.
		if (msg.type === "project_state_push") {
			// onProjectState is a public config callback supplied by a consumer, so a
			// throw is not hypothetical; unguarded it would escape handleMessage into
			// the ws EventEmitter. onEvent is insulated by its own `void handle...()`.
			try {
				this.onProjectState?.(msg.payload);
			} catch (error) {
				this.log?.(
					`[Bridge] project_state_push handler threw: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			return;
		}

		if (msg.type === "error") {
			const errorRequestId = msg.requestId;
			let waiter: (typeof this.pending)[number] | undefined;
			if (errorRequestId) {
				const idx = this.pending.findIndex((entry) => entry.requestId === errorRequestId);
				if (idx >= 0) {
					waiter = this.pending.splice(idx, 1)[0];
				}
			}
			if (!waiter) {
				if (!errorRequestId) {
					// Pre-requestId fallback: error responses from older servers lack requestId,
					// so pop the most recent waiter. Safe because queued commands serialize,
					// and queue-bypassing commands (stopSession, sendInput) will carry requestId
					// once both sides support it.
					waiter = this.pending.pop();
				} else {
					// Orphaned/late error with an unknown requestId; ignore to avoid
					// rejecting the wrong pending request.
					console.warn(
						"Bridge received error for unknown requestId:",
						errorRequestId,
						"-",
						msg.payload.message,
					);
					return;
				}
			}
			if (waiter) {
				clearTimeout(waiter.timeout);
				waiter.reject(
					new UplinkRequestError(msg.payload.code, msg.payload.message, msg.payload.details),
				);
			}
			return;
		}

		let waiterIndex = -1;
		const responseId = msg.requestId;
		if (responseId) {
			waiterIndex = this.pending.findIndex((entry) => entry.requestId === responseId);
			if (waiterIndex < 0) {
				console.warn(
					"Bridge received response for unknown requestId:",
					responseId,
					"type:",
					msg.type,
				);
				return;
			}
		} else {
			waiterIndex = this.pending.findIndex((entry) => entry.expectedType === msg.type);
		}
		if (waiterIndex < 0) {
			return;
		}
		const [waiter] = this.pending.splice(waiterIndex, 1);
		if (!waiter) return;

		clearTimeout(waiter.timeout);
		if (msg.type !== waiter.expectedType) {
			waiter.reject(new Error(`Unexpected uplink response: ${msg.type}`));
			return;
		}

		waiter.resolve(msg);
	}

	private sendAndWait(
		command: UplinkCommand,
		options?: { bypassQueue?: boolean },
	): Promise<UplinkResponse> {
		if (options?.bypassQueue) {
			return this.sendAndWaitImmediate(command);
		}
		return this.enqueueCommand(() => this.sendAndWaitImmediate(command));
	}

	private rejectAll(err: Error): void {
		while (this.pending.length > 0) {
			const waiter = this.pending.shift();
			if (!waiter) {
				continue;
			}
			clearTimeout(waiter.timeout);
			waiter.reject(err);
		}
	}

	private enqueueCommand(run: () => Promise<UplinkResponse>): Promise<UplinkResponse> {
		const queued = this.commandQueue.then(run, run);
		this.commandQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private sendAndWaitImmediate(command: UplinkCommand): Promise<UplinkResponse> {
		const requestId = randomUUID();
		const expectedType = expectedResponseType(command.type);
		const timeoutMs = commandTimeoutFor(command.type);
		const taggedCommand = { ...command, requestId };

		return new Promise((resolve, reject) => {
			const waiter: {
				requestId: string;
				expectedType: UplinkResponse["type"];
				resolve: (msg: UplinkResponse) => void;
				reject: (err: Error) => void;
				timeout: ReturnType<typeof setTimeout>;
			} = {
				requestId,
				expectedType,
				resolve,
				reject,
				timeout: setTimeout(() => {
					// Remove timed-out waiter so a late response can't poison subsequent commands.
					const idx = this.pending.indexOf(waiter);
					if (idx >= 0) {
						this.pending.splice(idx, 1);
					}
					reject(new UplinkResponseTimeoutError(expectedType));
				}, timeoutMs),
			};
			this.pending.push(waiter);
			this.ws.send(JSON.stringify(taggedCommand));
		});
	}
}

function expectedResponseType(commandType: UplinkCommand["type"]): UplinkResponse["type"] {
	switch (commandType) {
		case "ping":
			return "pong";
		case "list_sessions":
			return "sessions";
		case "get_project_state":
		case "list_projects":
			return "project_state";
		case "get_project_start_state":
			return "project_start_state";
		case "add_project":
		case "rename_project":
		case "remove_project":
			return "project_registry_result";
		case "list_models":
			return "model_list";
		case "list_runtimes":
			return "runtime_list";
		case "start_run":
			return "run_started";
		case "send_input":
			return "input_sent";
		case "stop":
			return "stopped";
		case "get_diff":
			return "diff";
		case "list_directory":
			return "directory_listing";
		case "git_status":
			return "git_status_result";
		case "git_pull":
			return "git_pull_result";
		case "git_push":
			return "git_push_result";
		case "git_worktree_add":
			return "git_worktree_result";
		case "git_submit_pr":
			return "git_pr_result";
		case "refresh_cache":
			return "cache_refreshed";
		default:
			return "error";
	}
}

function commandTimeoutFor(commandType: UplinkCommand["type"]): number {
	const defaultMs = 20_000;
	const longRunningDefaultMs = 120_000;
	const globalOverride = parseTimeoutOverride(process.env["CODEMOTE_UPLINK_COMMAND_TIMEOUT_MS"]);
	const longOverride = parseTimeoutOverride(process.env["CODEMOTE_UPLINK_LONG_COMMAND_TIMEOUT_MS"]);

	const baseMs = globalOverride ?? defaultMs;
	const longRunningMs = longOverride ?? Math.max(baseMs, longRunningDefaultMs);

	switch (commandType) {
		case "start_run":
		case "send_input":
			return longRunningMs;
		case "add_project":
		case "list_projects":
		case "rename_project":
		case "remove_project":
			return baseMs;
		default:
			return baseMs;
	}
}

function parseTimeoutOverride(raw: string | undefined): number | undefined {
	if (!raw) {
		return undefined;
	}

	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

export async function startRelayUplinkBridge(
	config: RelayUplinkBridgeConfig,
): Promise<RelayUplinkBridgeHandle> {
	const {
		relayUrl,
		relayWsOptions,
		uplinkUrl,
		repoPath,
		localEndpointUrl,
		hostedEndpointUrl,
		decryptEncryptedPayload: decryptEncryptedPayloadOverride,
		encryptionMode: configEncryptionMode,
		onPairingCode,
		onMobilePaired,
		onMobileDisconnected,
		onSessionStatus,
		onProjectState,
		log,
	} = config;

	const uplinkDeviceId = await getOrCreateUplinkDeviceId();

	// E2E encryption state
	let encryptionKeys: KeyPair | undefined;
	let remotePublicKey: Uint8Array | undefined;
	let encryptionPublicKeyBase64: string | undefined;
	const encryptionMode = configEncryptionMode ?? "off";

	if (encryptionMode !== "off") {
		encryptionKeys = generateKeyPair();
		encryptionPublicKeyBase64 = encodeBase64(encryptionKeys.publicKey);
		log?.(`[Bridge] E2E encryption mode: ${encryptionMode}, keypair generated`);
	}

	// Key rotation state
	const DEFAULT_KEY_ROTATION_INTERVAL_MS = 30 * 60 * 1000;
	const ROTATION_TIMEOUT_MS = 30_000;
	// Identity safety net during transition: the bridge validates that the sender's
	// key matches a known peer (current or previous). After handleRotateAck() switches
	// encryptionKeys, the bridge cannot decrypt messages encrypted with the OLD shared
	// secret because the old secretKey is discarded. WebSocket ordering guarantees no
	// iOS message encrypted with old keys arrives after the ack (the ack is the last
	// message iOS sends with old keys). The 60-second timer is a safety margin, not
	// a decryption fallback.
	let previousRemotePublicKey: Uint8Array | undefined;
	let rotationPendingKeys: KeyPair | undefined;
	let rotationTimer: ReturnType<typeof setInterval> | undefined;
	let rotationTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let rotationCleanupTimer: ReturnType<typeof setTimeout> | undefined;

	function clearRotationTimer(): void {
		if (rotationTimer) {
			clearInterval(rotationTimer);
			rotationTimer = undefined;
		}
	}

	function clearRotationTimeout(): void {
		if (rotationTimeoutTimer) {
			clearTimeout(rotationTimeoutTimer);
			rotationTimeoutTimer = undefined;
		}
	}

	function scheduleRotationTimer(): void {
		clearRotationTimer();
		const intervalMs = config.keyRotationIntervalMs ?? DEFAULT_KEY_ROTATION_INTERVAL_MS;
		if (intervalMs <= 0 || encryptionMode === "off") return;
		rotationTimer = setInterval(() => {
			void initiateKeyRotation();
		}, intervalMs);
	}

	function initiateKeyRotation(): void {
		if (rotationPendingKeys) return; // rotation already in progress
		if (!remotePublicKey || !encryptionKeys) return; // encryption not active

		rotationPendingKeys = generateKeyPair();
		const rotatePayload: EncryptionRotate = {
			type: "encryption_rotate",
			publicKey: encodeBase64(rotationPendingKeys.publicKey),
		};
		const plainJson = JSON.stringify(rotatePayload);
		const encryptedPayload = encrypt(
			plainJson,
			remotePublicKey,
			encryptionKeys.secretKey,
			encryptionKeys.publicKey,
		);
		relayWs.send(JSON.stringify({ type: "message", payload: encryptedPayload }));
		log?.("[Bridge] Key rotation initiated");

		rotationTimeoutTimer = setTimeout(() => {
			log?.("[Bridge] Key rotation timed out, reverting");
			rotationPendingKeys = undefined;
			rotationTimeoutTimer = undefined;
		}, ROTATION_TIMEOUT_MS);
	}

	function handleRotateAck(ack: EncryptionRotateAck): void {
		if (typeof ack.publicKey !== "string") {
			log?.("[Bridge] encryption_rotate_ack: missing or invalid publicKey");
			return;
		}
		let peerKey: Uint8Array;
		try {
			peerKey = decodeBase64(ack.publicKey);
		} catch {
			log?.("[Bridge] encryption_rotate_ack: failed to decode publicKey");
			return;
		}
		if (peerKey.length !== 32) {
			log?.(`[Bridge] encryption_rotate_ack: invalid key length ${peerKey.length}`);
			return;
		}
		if (!rotationPendingKeys) {
			log?.("[Bridge] encryption_rotate_ack: no pending rotation, ignoring stale ack");
			return;
		}

		clearRotationTimeout();
		previousRemotePublicKey = remotePublicKey;
		remotePublicKey = peerKey;
		encryptionKeys = rotationPendingKeys;
		encryptionPublicKeyBase64 = encodeBase64(rotationPendingKeys.publicKey);
		rotationPendingKeys = undefined;
		log?.("[Bridge] Key rotation complete");

		if (rotationCleanupTimer) clearTimeout(rotationCleanupTimer);
		rotationCleanupTimer = setTimeout(() => {
			rotationCleanupTimer = undefined;
			previousRemotePublicKey = undefined;
		}, 60_000);

		scheduleRotationTimer();
	}

	// Wire automatic decryption — closure checks current remotePublicKey at call time
	const decryptEncryptedPayload =
		decryptEncryptedPayloadOverride ??
		(encryptionMode !== "off"
			? (payload: EncryptedPayload): unknown => {
					if (!encryptionKeys || !remotePublicKey) {
						throw new Error("Encryption keys not yet exchanged");
					}
					const senderPubKey = decodeBase64(payload.senderPublicKey);
					const matchesCurrent = timingSafeEqual(
						Buffer.from(senderPubKey),
						Buffer.from(remotePublicKey),
					);
					const matchesPrevious = previousRemotePublicKey
						? timingSafeEqual(Buffer.from(senderPubKey), Buffer.from(previousRemotePublicKey))
						: false;
					if (!matchesCurrent && !matchesPrevious) {
						throw new Error("Sender public key does not match expected peer");
					}
					const plaintext = decrypt(payload, senderPubKey, encryptionKeys.secretKey);
					return JSON.parse(plaintext) as unknown;
				}
			: undefined);

	const sessions = new Map<string, SessionInfo>();
	const approvalRequests = new Map<string, { sessionId: string }>();
	const replayGuard = new ReplayGuard();
	const mobileDeviceIds = new Set<string>();
	let pairingCode = "";

	const relayWs = relayWsOptions
		? new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES, ...relayWsOptions })
		: new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES });
	await waitForOpen(relayWs);

	pairingCode = await registerWithRelay(relayWs, uplinkDeviceId);
	onPairingCode?.(pairingCode);
	log?.("[Bridge] Registered with relay (pairing code redacted)");

	const uplinkClient = await UplinkWsClient.connect(
		uplinkUrl,
		(event) => {
			void handleUplinkEvent(event);
		},
		(state) => {
			// The consumer callback is an observer; forwarding to mobile is the product
			// behavior. Guarding it separately keeps a broken consumer from silently
			// starving the phone of state - the outer guard in handleMessage catches the
			// throw but would skip the send with it.
			try {
				onProjectState?.(state);
			} catch (error) {
				log?.(
					`[Bridge] onProjectState consumer threw: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			// sendToMobile already no-ops when no mobile is paired.
			sendToMobile({ type: "project_state", state });
		},
		log,
	);
	await syncSessionsFromUplink();

	relayWs.on("message", (data: WebSocket.RawData) => {
		void handleRelayMessage(data).catch((error) => {
			log?.(
				`[Bridge] Failed to handle relay message: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
	});

	function markMobilePaired(deviceId: string): void {
		const hadAny = mobileDeviceIds.size > 0;
		mobileDeviceIds.add(deviceId);
		if (!hadAny) {
			onMobilePaired?.();
		}
	}

	function markMobileDisconnected(deviceId?: string): void {
		const hadAny = mobileDeviceIds.size > 0;
		if (!hadAny) return;
		if (deviceId) {
			mobileDeviceIds.delete(deviceId);
		} else {
			mobileDeviceIds.clear();
		}
		if (hadAny && mobileDeviceIds.size === 0) {
			onMobileDisconnected?.();
		}
	}

	relayWs.on("close", () => {
		markMobileDisconnected();
		log?.("[Bridge] Relay WebSocket closed");
	});

	relayWs.on("error", (err: unknown) => {
		log?.(`[Bridge] Relay WebSocket error: ${String(err)}`);
	});

	function rawDataToBuffer(data: WebSocket.RawData): Buffer {
		if (typeof data === "string") return Buffer.from(data, "utf8");
		if (data instanceof Buffer) return data;
		if (data instanceof ArrayBuffer) return Buffer.from(data);
		if (Array.isArray(data)) return Buffer.concat(data);
		return Buffer.from(data as unknown as ArrayBuffer);
	}

	function dropMessage(reason: string): void {
		log?.(`[Bridge] Dropped relay message: ${reason}`);
	}

	async function handleRelayMessage(data: WebSocket.RawData): Promise<void> {
		let raw: unknown;
		try {
			raw = JSON.parse(rawDataToBuffer(data).toString("utf8"));
		} catch {
			dropMessage("invalid_json");
			return;
		}

		const relayMessage = decodeRelayInbound(raw);
		if (!relayMessage) {
			dropMessage("invalid_relay_message");
			return;
		}

		switch (relayMessage.type) {
			case "registered":
				pairingCode = relayMessage.pin ?? relayMessage.pairingCode ?? pairingCode;
				onPairingCode?.(pairingCode);
				return;

			case "paired":
				if (relayMessage.mobileDeviceId) {
					markMobilePaired(relayMessage.mobileDeviceId);
					log?.("[Bridge] Mobile paired");
					await syncSessionsFromUplink();
					sendSessionList();
					void sendDeviceInfoToMobile();
					// The push is change-detected against a server-global signature, so a
					// mobile pairing mid-life would otherwise see nothing until the next
					// state change somewhere. REQ-15 is "reflects real state on open".
					void handleGetProjectState();

					// Clear stale encryption + rotation state from previous pairing
					if (encryptionMode !== "off") {
						remotePublicKey = undefined;
						previousRemotePublicKey = undefined;
						rotationPendingKeys = undefined;
						clearRotationTimer();
						clearRotationTimeout();
						if (rotationCleanupTimer) {
							clearTimeout(rotationCleanupTimer);
							rotationCleanupTimer = undefined;
						}
						encryptionKeys = generateKeyPair();
						encryptionPublicKeyBase64 = encodeBase64(encryptionKeys.publicKey);
						log?.("[Bridge] Rotated encryption keypair for new pairing");
					}

					// Offer E2E encryption if enabled
					if (encryptionMode !== "off" && encryptionKeys && encryptionPublicKeyBase64) {
						log?.("[Bridge] Sending encryption_offer to mobile");
						sendToMobileRaw({
							type: "encryption_offer",
							publicKey: encryptionPublicKeyBase64,
						} satisfies EncryptionOffer);
					}
				}
				return;

			case "unpaired":
			case "mobile_disconnected":
				markMobileDisconnected(relayMessage.mobileDeviceId);
				log?.(
					relayMessage.type === "unpaired"
						? "[Bridge] Mobile unpaired"
						: "[Bridge] Mobile disconnected",
				);
				return;

			case "message": {
				// Handle key exchange messages before encryption/decryption
				if (
					typeof relayMessage.payload === "object" &&
					relayMessage.payload !== null &&
					"type" in relayMessage.payload
				) {
					const innerType = (relayMessage.payload as { type: string }).type;
					if (innerType === "encryption_accept" && encryptionKeys) {
						const acceptPayload = relayMessage.payload as EncryptionAccept;
						if (typeof acceptPayload.publicKey !== "string") {
							log?.("[Bridge] encryption_accept: missing or invalid publicKey");
							return;
						}
						let peerKey: Uint8Array;
						try {
							peerKey = decodeBase64(acceptPayload.publicKey);
						} catch {
							log?.("[Bridge] encryption_accept: failed to decode publicKey");
							return;
						}
						if (peerKey.length !== 32) {
							log?.(`[Bridge] encryption_accept: invalid key length ${peerKey.length}`);
							return;
						}
						remotePublicKey = peerKey;
						log?.("[Bridge] E2E encryption activated (received encryption_accept)");
						scheduleRotationTimer();
						return;
					}
				}

				let inboundPayload: unknown = relayMessage.payload;
				const encrypted = validateEncryptedPayload(relayMessage.payload);
				if (encrypted.ok) {
					const replayCheck = replayGuard.check(encrypted.value);
					if (!replayCheck.ok) {
						dropMessage(`encrypted_payload_rejected_${replayCheck.reason}`);
						return;
					}
					if (!decryptEncryptedPayload) {
						dropMessage("encrypted_payload_no_decoder");
						return;
					}
					try {
						inboundPayload = decryptEncryptedPayload(encrypted.value);
					} catch {
						dropMessage("encrypted_payload_decode_failed");
						return;
					}

					// Check for rotation control messages after decryption
					if (
						typeof inboundPayload === "object" &&
						inboundPayload !== null &&
						"type" in inboundPayload
					) {
						const controlType = (inboundPayload as { type: string }).type;
						if (controlType === "encryption_rotate_ack") {
							handleRotateAck(inboundPayload as EncryptionRotateAck);
							return;
						}
						if (controlType === "encryption_rotate") {
							log?.("[Bridge] Ignoring encryption_rotate from mobile (bridge is sole initiator)");
							return;
						}
					}
				}

				const decoded = decodeMobileInbound(inboundPayload);
				if (!decoded) {
					dropMessage("invalid_mobile_message");
					return;
				}
				await handleMobileMessage(decoded);
				return;
			}

			case "error":
				log?.("[Bridge] Relay error (redacted)");
				return;
		}
	}

	async function handleMobileMessage(message: MobileInboundMessage): Promise<void> {
		switch (message.type) {
			case "new_session":
				await handleNewSession(message);
				return;
			case "send_prompt":
				await handleSendPrompt(message);
				return;
			case "stop":
				await handleStop(message);
				return;
			case "get_diff":
				await handleGetDiff(message);
				return;
			case "request_device_info":
				void sendDeviceInfoToMobile();
				return;
			case "git_status":
				await handleGitStatus(message);
				return;
			case "git_pull":
				await handleGitPull(message);
				return;
			case "git_push":
				await handleGitPush(message);
				return;
			case "git_worktree_add":
				await handleGitWorktreeAdd(message);
				return;
			case "git_submit_pr":
				await handleGitSubmitPR(message);
				return;
			case "list_models":
				await handleListModels(message);
				return;
			case "list_runtimes":
				await handleListRuntimes();
				return;
			case "get_project_state":
				await handleGetProjectState();
				return;
			case "get_project_start_state":
				await handleGetProjectStartState(message);
				return;
			case "add_project":
				await handleProjectMutation("add", message.path, () =>
					uplinkClient.addProject(message.name, message.path),
				);
				return;
			case "list_projects":
				await handleListProjects();
				return;
			case "rename_project":
				await handleProjectMutation("rename", message.path, () =>
					uplinkClient.renameProject(message.path, message.name),
				);
				return;
			case "remove_project":
				await handleProjectMutation("remove", message.path, () =>
					uplinkClient.removeProject(message.path),
				);
				return;
			case "list_directory":
				await handleListDirectory(message);
				return;
			case "approval_response":
				await handleApprovalResponse(message);
				return;
		}
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function hydrateSessionFromUplink(sessionId: string): Promise<SessionInfo | undefined> {
		const existing = sessions.get(sessionId);
		if (existing) {
			return existing;
		}
		try {
			const response = await uplinkClient.listSessions();
			if (response.type !== "sessions") {
				return undefined;
			}
			const fromUplink = response.payload.find((session) => session.id === sessionId);
			if (!fromUplink) {
				return undefined;
			}
			const hydrated = toSessionInfo(fromUplink);
			sessions.set(sessionId, hydrated);
			return hydrated;
		} catch (error) {
			log?.(
				`[Bridge] Failed to hydrate session ${sessionId} metadata: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return undefined;
		}
	}

	async function notifySessionCommandFailure(
		sessionId: string,
		action: string,
		error: unknown,
	): Promise<void> {
		const message = errorMessage(error);
		log?.(`[Bridge] ${action} failed for session ${sessionId}: ${message}`);
		const hydrated = await hydrateSessionFromUplink(sessionId);
		if (hydrated) {
			hydrated.status = "error";
		}
		sendToMobile({
			type: "session_status",
			sessionId,
			status: "error",
		});
		sendToMobile({
			type: "session_output",
			sessionId,
			text: `${action} failed. ${message}`,
		});
		if (hydrated) {
			sendSessionList();
		}
	}

	async function handleSendPrompt(message: SendPromptMessage): Promise<void> {
		try {
			await uplinkClient.sendInput(message.sessionId, message.prompt);
		} catch (error) {
			await notifySessionCommandFailure(message.sessionId, "Send prompt", error);
		}
	}

	async function handleStop(message: StopMessage): Promise<void> {
		try {
			await uplinkClient.stopSession(message.sessionId);
		} catch (error) {
			await notifySessionCommandFailure(message.sessionId, "Stop session", error);
		}
	}

	async function handleNewSession(message: NewSessionMessage): Promise<void> {
		try {
			const result = await startAndTrackSession(
				message.runtime,
				message.prompt,
				message.workspace,
				message.model,
				message.temperature,
				message.maxTokens,
				message.projectStart,
			);
			if (message.projectStart) {
				if (!result.originProjectPath || !result.execution) {
					throw new Error("Project-aware start omitted effective state");
				}
				sendToMobile({
					type: "session_start_result",
					operationId: message.projectStart.operationId,
					success: true,
					sessionId: result.sessionId,
					originProjectPath: result.originProjectPath,
					execution: result.execution,
				});
			}
		} catch (error) {
			if (message.projectStart) {
				if (!(error instanceof UplinkRequestError)) {
					log?.(
						`[Bridge] Project start ${message.projectStart.operationId} remains unresolved: ${errorMessage(error)}`,
					);
					sendToMobile({
						type: "session_start_unresolved",
						operationId: message.projectStart.operationId,
						retryable: true,
						code:
							error instanceof UplinkResponseTimeoutError
								? "UPLINK_RESPONSE_TIMEOUT"
								: "UPLINK_RESPONSE_UNRESOLVED",
						message: errorMessage(error),
					});
					return;
				}
				log?.(
					`[Bridge] Project start ${message.projectStart.operationId} failed: ${error.message}`,
				);
				sendToMobile({
					type: "session_start_result",
					operationId: message.projectStart.operationId,
					success: false,
					code: error.code,
					message: error.message,
					...(error.details ? { details: error.details } : {}),
				});
				return;
			}

			log?.(
				`[Bridge] Failed to start session: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			const errorId = `error-${Date.now()}`;
			sessions.set(errorId, {
				id: errorId,
				runtime: message.runtime,
				status: "error",
				createdAt: Date.now(),
			});
			sendSessionList();
			sendToMobile({
				type: "session_output",
				sessionId: errorId,
				text: "Failed to start session. Check the terminal logs.",
			});
		}
	}

	async function startAndTrackSession(
		runtime: RuntimeType,
		prompt: string,
		workspace?: string,
		model?: string,
		temperature?: number,
		maxTokens?: number,
		projectStart?: ProjectStartRequest,
	): Promise<{
		sessionId: string;
		originProjectPath?: string;
		execution?: SessionExecutionState;
	}> {
		const effectiveWorkspace = projectStart?.originProjectPath ?? workspace ?? repoPath;
		const started = await uplinkClient.startRun(
			runtime,
			effectiveWorkspace,
			prompt,
			undefined,
			model,
			temperature,
			maxTokens,
			projectStart,
		);
		if (started.type !== "run_started") {
			throw new Error("Unexpected start_run response");
		}

		const sessionId = started.payload.sessionId;
		const existing = sessions.get(sessionId);
		const status = existing?.status ?? "starting";
		const runtimeSessionId = existing?.runtimeSessionId;
		const originProjectPath = started.payload.originProjectPath ?? existing?.originProjectPath;
		const execution = started.payload.execution ?? existing?.execution;
		const workspacePath =
			execution?.directory ?? existing?.workspace ?? workspace ?? projectStart?.originProjectPath;
		sessions.set(sessionId, {
			id: sessionId,
			runtime,
			status,
			createdAt: existing?.createdAt ?? Date.now(),
			...(runtimeSessionId ? { runtimeSessionId } : {}),
			...(workspacePath ? { workspace: workspacePath } : {}),
			...(originProjectPath ? { originProjectPath } : {}),
			...(execution ? { execution } : {}),
		});
		sendSessionList();
		return {
			sessionId,
			...(originProjectPath ? { originProjectPath } : {}),
			...(execution ? { execution } : {}),
		};
	}

	async function startSession(
		runtime: RuntimeType,
		prompt: string,
	): Promise<{ sessionId: string }> {
		const cleanPrompt = prompt.trim();
		if (cleanPrompt.length === 0) {
			throw new Error("Prompt is required");
		}

		return startAndTrackSession(runtime, cleanPrompt);
	}

	async function handleApprovalResponse(message: ApprovalResponseMessage): Promise<void> {
		const pending = approvalRequests.get(message.requestId);
		if (!pending) {
			return;
		}

		approvalRequests.delete(message.requestId);
		try {
			await uplinkClient.sendInput(pending.sessionId, message.approved ? "y" : "n", {
				bypassQueue: true,
			});
		} catch (error) {
			await notifySessionCommandFailure(pending.sessionId, "Approval response", error);
		}
	}

	async function handleUplinkEvent(event: StreamEvent): Promise<void> {
		const hasConnectedMobiles = mobileDeviceIds.size > 0;
		if (!hasConnectedMobiles && event.type !== "session.status") {
			return;
		}

		switch (event.type) {
			case "session.output": {
				const payload = event.payload as { text?: string };
				sendToMobile({
					type: "session_output",
					sessionId: event.sessionId,
					text: payload.text ?? "",
				});
				return;
			}
			case "session.message": {
				const payload = event.payload as {
					role?: string;
					content?: string;
					parentToolUseId?: string;
				};
				if (payload.parentToolUseId) return;
				sendToMobile({
					type: "session_message",
					sessionId: event.sessionId,
					role: (payload.role as "assistant" | "user") ?? "assistant",
					content: payload.content ?? "",
				});
				return;
			}
			case "session.tool_call": {
				const payload = event.payload as {
					toolCallId?: string;
					toolName?: string;
					arguments?: string;
					parentToolUseId?: string;
				};
				if (payload.parentToolUseId) return;
				const msg: SessionToolCallMessage = {
					type: "session_tool_call",
					sessionId: event.sessionId,
					toolCallId: payload.toolCallId ?? "",
					toolName: payload.toolName ?? "unknown",
				};
				if (payload.arguments !== undefined) {
					msg.arguments = payload.arguments;
				}
				sendToMobile(msg);
				return;
			}
			case "session.tool_result": {
				const payload = event.payload as {
					toolCallId?: string;
					toolName?: string;
					output?: string;
					error?: string;
					parentToolUseId?: string;
				};
				if (payload.parentToolUseId) return;
				const msg: SessionToolResultMessage = {
					type: "session_tool_result",
					sessionId: event.sessionId,
					toolCallId: payload.toolCallId ?? "",
					toolName: payload.toolName ?? "unknown",
				};
				if (payload.output !== undefined) {
					msg.output = payload.output;
				}
				if (payload.error !== undefined) {
					msg.error = payload.error;
				}
				sendToMobile(msg);
				return;
			}
			case "session.status": {
				const payload = event.payload as { status?: SessionStatus };
				const status = payload.status ?? "running";
				const session =
					(await hydrateSessionFromUplink(event.sessionId)) ?? sessions.get(event.sessionId);
				if (session) {
					session.status = status;
				} else {
					log?.(
						`[Bridge] Received session.status for unknown session ${event.sessionId}; skipping synthetic session creation`,
					);
				}

				sendToMobile({
					type: "session_status",
					sessionId: event.sessionId,
					status,
				});
				const runtime = sessions.get(event.sessionId)?.runtime;
				if (runtime) {
					onSessionStatus?.({
						sessionId: event.sessionId,
						runtime,
						status,
					});
					await syncSessionRuntimeMetadata(event.sessionId);
					sendSessionList();
				}
				return;
			}
			case "attention.required": {
				const payload = event.payload as {
					reason?: string;
					details?: { action?: string; description?: string; [key: string]: unknown };
				};
				const requestId = `req-${event.timestamp}-${Math.random().toString(16).slice(2)}`;
				approvalRequests.set(requestId, { sessionId: event.sessionId });

				sendToMobile({
					type: "approval_request",
					sessionId: event.sessionId,
					request: {
						id: requestId,
						action: payload.details?.action ?? payload.reason ?? "unknown",
						description: payload.details?.description ?? "Approval required",
						details:
							payload.details && Object.keys(payload.details).length > 0
								? JSON.stringify(payload.details)
								: null,
					},
				});
				return;
			}
			default:
				return;
		}
	}

	async function handleGetDiff(message: GetDiffMessage): Promise<void> {
		try {
			const response = await uplinkClient.getDiff(message.sessionId, message.scope);
			if (response.type !== "diff") {
				throw new Error("Unexpected get_diff response");
			}

			sendToMobile({
				type: "diff",
				sessionId: response.payload.sessionId,
				diff: response.payload.diff,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to get diff: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "diff",
				sessionId: message.sessionId,
				diff: `Failed to get diff. ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async function handleListModels(message: ListModelsMessage): Promise<void> {
		const requestedRuntime = message.runtime;
		try {
			const response = await uplinkClient.listModels(requestedRuntime);
			if (response.type !== "model_list") {
				throw new Error("Unexpected list_models response");
			}
			if (response.payload.runtime !== requestedRuntime) {
				throw new Error(
					`Unexpected list_models runtime: requested ${requestedRuntime}, received ${response.payload.runtime}`,
				);
			}

			sendToMobile({
				type: "model_list",
				runtime: requestedRuntime,
				models: response.payload.models,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to list models: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "model_list",
				runtime: requestedRuntime,
				models: [],
			});
		}
	}

	async function handleListRuntimes(): Promise<void> {
		try {
			const response = await uplinkClient.listRuntimes();
			if (response.type !== "runtime_list") {
				throw new Error("Unexpected list_runtimes response");
			}

			sendToMobile({
				type: "runtime_list",
				runtimes: response.payload.runtimes,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to list runtimes: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "runtime_list",
				runtimes: [],
			});
		}
	}

	async function handleGetProjectState(): Promise<void> {
		try {
			const response = await uplinkClient.getProjectState();
			if (response.type !== "project_state") {
				throw new Error("Unexpected get_project_state response");
			}

			sendToMobile({ type: "project_state", state: response.payload });
		} catch (error) {
			// Deliberately no fallback message, unlike list_runtimes which answers with
			// an empty list. An empty aggregate is not a neutral default here: it reads
			// as "no projects, nothing needs you", which would make the assistant report
			// all-clear and suppress notifications while the real state is unknown.
			// Staying silent lets the caller's request time out and surface a failure
			// instead of being told something false.
			log?.(
				`[Bridge] Failed to get project state: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async function handleGetProjectStartState(message: GetProjectStartStateMessage): Promise<void> {
		try {
			const response = await uplinkClient.getProjectStartState(message.projectPath);
			if (response.type !== "project_start_state") {
				throw new Error("Unexpected get_project_start_state response");
			}
			sendToMobile({
				type: "project_start_state",
				projectPath: message.projectPath,
				state: response.payload,
			});
		} catch (error) {
			const requestError =
				error instanceof UplinkRequestError
					? error
					: new UplinkRequestError("COMMAND_FAILED", errorMessage(error));
			log?.(
				`[Bridge] Failed to inspect project start state for ${message.projectPath}: ${requestError.message}`,
			);
			sendToMobile({
				type: "project_start_state",
				projectPath: message.projectPath,
				error: { code: requestError.code, message: requestError.message },
			});
		}
	}

	async function handleListProjects(): Promise<void> {
		try {
			const response = await uplinkClient.listProjects();
			if (response.type !== "project_state") {
				throw new Error("Unexpected list_projects response");
			}

			sendToMobile({ type: "project_state", state: response.payload });
		} catch (error) {
			log?.(
				`[Bridge] Failed to list projects: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async function handleProjectMutation(
		operation: "add" | "rename" | "remove",
		requestedPath: string,
		send: () => Promise<UplinkResponse>,
	): Promise<void> {
		try {
			const response = await send();
			if (response.type !== "project_registry_result" || response.payload.operation !== operation) {
				throw new Error(`Unexpected ${operation}_project response`);
			}

			sendToMobile({
				type: "project_registry_result",
				operation,
				path: response.payload.path,
				success: true,
			});
		} catch (error) {
			const reason = errorMessage(error);
			log?.(`[Bridge] Failed to ${operation} project: ${reason}`);
			sendToMobile({
				type: "project_registry_result",
				operation,
				path: requestedPath,
				success: false,
				error: reason,
			});
		}
	}

	async function handleListDirectory(message: ListDirectoryMessage): Promise<void> {
		try {
			const response = await uplinkClient.listDirectory(message.path);
			if (response.type !== "directory_listing") {
				throw new Error("Unexpected list_directory response");
			}

			sendToMobile({
				type: "directory_listing",
				path: response.payload.path,
				entries: response.payload.entries,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			log?.(`[Bridge] Failed to list directory: ${reason}`);
			sendToMobile({
				type: "directory_listing",
				path: message.path ?? "",
				entries: [],
				error: reason,
			});
		}
	}

	async function handleGitStatus(message: GitStatusMessage): Promise<void> {
		try {
			const response = await uplinkClient.gitStatus(message.sessionId);
			if (response.type !== "git_status_result") {
				throw new Error("Unexpected git_status response");
			}
			sendToMobile({
				type: "git_status_result",
				sessionId: response.payload.sessionId,
				status: response.payload.status,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to get git status: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "git_status_result",
				sessionId: message.sessionId,
				status: {
					branch: "unknown",
					ahead: 0,
					behind: 0,
					staged: 0,
					unstaged: 0,
					untracked: 0,
				},
			});
		}
	}

	async function handleGitPull(message: GitPullMessage): Promise<void> {
		try {
			const response = await uplinkClient.gitPull(message.sessionId);
			if (response.type !== "git_pull_result") {
				throw new Error("Unexpected git_pull response");
			}
			sendToMobile({
				type: "git_pull_result",
				sessionId: response.payload.sessionId,
				summary: response.payload.summary,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to git pull: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "git_pull_result",
				sessionId: message.sessionId,
				summary: `Pull failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async function handleGitPush(message: GitPushMessage): Promise<void> {
		try {
			const response = await uplinkClient.gitPush(message.sessionId);
			if (response.type !== "git_push_result") {
				throw new Error("Unexpected git_push response");
			}
			sendToMobile({
				type: "git_push_result",
				sessionId: response.payload.sessionId,
				summary: response.payload.summary,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to git push: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "git_push_result",
				sessionId: message.sessionId,
				summary: `Push failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async function handleGitWorktreeAdd(message: GitWorktreeAddMessage): Promise<void> {
		try {
			const response = await uplinkClient.gitWorktreeAdd(message.sessionId, message.branch);
			if (response.type !== "git_worktree_result") {
				throw new Error("Unexpected git_worktree_add response");
			}
			sendToMobile({
				type: "git_worktree_result",
				sessionId: response.payload.sessionId,
				path: response.payload.path,
				branch: response.payload.branch,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "git_worktree_result",
				sessionId: message.sessionId,
				path: "",
				branch: `Failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async function handleGitSubmitPR(message: GitSubmitPRMessage): Promise<void> {
		try {
			const response = await uplinkClient.gitSubmitPR(
				message.sessionId,
				message.title,
				message.body,
			);
			if (response.type !== "git_pr_result") {
				throw new Error("Unexpected git_submit_pr response");
			}
			sendToMobile({
				type: "git_pr_result",
				sessionId: response.payload.sessionId,
				url: response.payload.url,
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to submit PR: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "git_pr_result",
				sessionId: message.sessionId,
				url: `Failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	function sendSessionList(): void {
		const sessionsList = Array.from(sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
		log?.(
			`[Bridge] sendSessionList: ${sessionsList.length} sessions, mobileCount=${mobileDeviceIds.size}`,
		);
		sendToMobile({ type: "session_list", sessions: sessionsList });
	}

	function sendToMobile(message: MobileOutboundMessage): void {
		if (mobileDeviceIds.size === 0) {
			log?.(`[Bridge] sendToMobile: skipped (no paired mobiles), type=${message.type}`);
			return;
		}

		if (message.type === "session_message") {
			const preview = message.content.replace(/\s+/g, " ").trim().slice(0, 120);
			log?.(
				`[Bridge] sendToMobile: type=session_message sessionId=${message.sessionId} role=${message.role} len=${message.content.length} preview=${preview}`,
			);
		} else if (message.type === "session_output") {
			const preview = message.text.replace(/\s+/g, " ").trim().slice(0, 120);
			log?.(
				`[Bridge] sendToMobile: type=session_output sessionId=${message.sessionId} len=${message.text.length} preview=${preview}`,
			);
		} else if (message.type === "session_status") {
			log?.(
				`[Bridge] sendToMobile: type=session_status sessionId=${message.sessionId} status=${message.status}`,
			);
		} else {
			log?.(`[Bridge] sendToMobile: type=${message.type}`);
		}
		const plainJson = JSON.stringify(message);
		if (encryptionKeys && remotePublicKey) {
			const encryptedPayload = encrypt(
				plainJson,
				remotePublicKey,
				encryptionKeys.secretKey,
				encryptionKeys.publicKey,
			);
			relayWs.send(JSON.stringify({ type: "message", payload: encryptedPayload }));
		} else {
			relayWs.send(JSON.stringify({ type: "message", payload: message }));
		}
	}

	/** Send a raw (unencrypted) message to mobile. Used for key exchange. */
	function sendToMobileRaw(payload: Record<string, unknown>): void {
		if (mobileDeviceIds.size === 0) {
			log?.("[Bridge] sendToMobileRaw: skipped (no paired mobiles)");
			return;
		}
		relayWs.send(JSON.stringify({ type: "message", payload }));
	}

	function toSessionInfo(session: {
		id: string;
		runtime: RuntimeType;
		status: SessionStatus;
		startedAt?: number;
		createdAt?: number;
		runtimeSessionId?: string;
		workspace?: { workingDir: string };
		originProjectPath?: string;
		execution?: SessionExecutionState;
	}): SessionInfo {
		return {
			id: session.id,
			runtime: session.runtime,
			status: session.status,
			createdAt: session.createdAt ?? session.startedAt ?? Date.now(),
			...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
			...(session.workspace ? { workspace: session.workspace.workingDir } : {}),
			...(session.originProjectPath ? { originProjectPath: session.originProjectPath } : {}),
			...(session.execution ? { execution: session.execution } : {}),
		};
	}

	async function syncSessionsFromUplink(): Promise<void> {
		try {
			const response = await uplinkClient.listSessions();
			if (response.type !== "sessions") {
				return;
			}
			sessions.clear();
			for (const session of response.payload) {
				sessions.set(session.id, toSessionInfo(session));
			}
		} catch (error) {
			log?.(
				`[Bridge] Failed to sync sessions from uplink: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	async function syncSessionRuntimeMetadata(sessionId: string): Promise<void> {
		const existing = sessions.get(sessionId);
		if (!existing || existing.runtimeSessionId) {
			return;
		}

		try {
			const response = await uplinkClient.listSessions();
			if (response.type !== "sessions") {
				return;
			}
			const fromUplink = response.payload.find((session) => session.id === sessionId);
			if (!fromUplink?.runtimeSessionId) {
				return;
			}
			existing.runtimeSessionId = fromUplink.runtimeSessionId;
		} catch (error) {
			log?.(
				`[Bridge] Failed to sync runtime metadata: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	async function sendDeviceInfoToMobile(): Promise<void> {
		try {
			const endpoints: DeviceEndpointMessage[] = [];

			const normalizedLocal = normalizeEndpointUrl(localEndpointUrl);
			if (normalizedLocal) {
				endpoints.push({ kind: "local", url: normalizedLocal });
			}

			if (normalizedLocal) {
				const tailscaleEndpoint = await detectTailscaleEndpoint({
					port: relayPortFromURL(normalizedLocal),
					secure: normalizedLocal.startsWith("wss://"),
				});
				if (tailscaleEndpoint) {
					endpoints.push({ kind: "tailscale", url: tailscaleEndpoint.url });
				}
			}

			const normalizedHosted = normalizeEndpointUrl(hostedEndpointUrl);
			if (normalizedHosted) {
				endpoints.push({ kind: "hosted", url: normalizedHosted });
			}

			if (endpoints.length === 0) {
				return;
			}

			let availableRuntimes: RuntimeType[] | undefined;
			try {
				const rtResponse = await uplinkClient.listRuntimes();
				if (rtResponse.type === "runtime_list") {
					availableRuntimes = rtResponse.payload.runtimes;
				}
			} catch {
				// Don't fail device info if runtimes query fails
			}

			// Outgoing endpoints replace all previously-known endpoints on the mobile side.
			sendToMobile({
				type: "device_info",
				uplinkDeviceId,
				endpoints,
				...(availableRuntimes ? { availableRuntimes } : {}),
			});
		} catch (error) {
			log?.(
				`[Bridge] Failed to send device info: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async function refreshPairingCode(): Promise<string> {
		pairingCode = await registerWithRelay(relayWs, uplinkDeviceId);
		onPairingCode?.(pairingCode);
		log?.("[Bridge] Refreshed PIN (redacted)");
		return pairingCode;
	}

	return {
		pairingCode,
		uplinkDeviceId,
		uplinkPublicKey: uplinkDeviceId,
		get encryptionPublicKey() {
			return encryptionPublicKeyBase64;
		},
		startSession,
		refreshPairingCode,
		stop: async () => {
			clearRotationTimer();
			clearRotationTimeout();
			if (rotationCleanupTimer) {
				clearTimeout(rotationCleanupTimer);
				rotationCleanupTimer = undefined;
			}
			await uplinkClient.close();
			if (relayWs.readyState === WebSocket.OPEN) {
				relayWs.close();
			}
		},
	};
}

function normalizeEndpointUrl(value: string | undefined): string | null {
	if (!value) {
		return null;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}

	try {
		return new URL(trimmed).toString();
	} catch {
		return null;
	}
}

async function getOrCreateUplinkDeviceId(): Promise<string> {
	try {
		const existing = (await readFile(DEVICE_ID_PATH, "utf8")).trim();
		if (existing.length > 0) {
			return existing;
		}
	} catch {
		// ignore
	}

	const created = randomUUID();
	await mkdir(dirname(DEVICE_ID_PATH), { recursive: true });
	await writeFile(DEVICE_ID_PATH, `${created}\n`, "utf8");
	return created;
}

function relayPortFromURL(relayUrl: string): number {
	const parsed = new URL(relayUrl);
	if (parsed.port) {
		return Number.parseInt(parsed.port, 10);
	}
	return parsed.protocol === "wss:" ? 443 : 80;
}

async function registerWithRelay(relayWs: WebSocket, uplinkDeviceId: string): Promise<string> {
	relayWs.send(
		JSON.stringify({
			type: "register",
			deviceId: uplinkDeviceId,
			deviceType: "uplink",
		}),
	);

	const registered = await waitForRelayMessage(relayWs, "registered", 10_000);
	if (registered.type !== "registered") {
		throw new Error("Unexpected relay response during registration");
	}

	return registered.pin ?? registered.pairingCode ?? "";
}

async function waitForRelayMessage(
	relayWs: WebSocket,
	expectedType: string,
	timeoutMs: number,
): Promise<RelayInboundMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for relay message: ${expectedType}`));
		}, timeoutMs);

		const handler = (data: WebSocket.RawData) => {
			try {
				const parsed = JSON.parse(data.toString()) as unknown;
				const msg = decodeRelayInbound(parsed);
				if (msg && msg.type === expectedType) {
					clearTimeout(timeout);
					relayWs.off("message", handler);
					resolve(msg);
				}
			} catch {
				// ignore
			}
		};

		relayWs.on("message", handler);
	});
}

function decodeRelayInbound(raw: unknown): RelayInboundMessage | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const type = (raw as { type?: unknown }).type;
	if (type === "registered") {
		const pin = (raw as { pin?: unknown }).pin;
		const pairingCode = (raw as { pairingCode?: unknown }).pairingCode;
		if (typeof pin !== "string" && typeof pairingCode !== "string") {
			return null;
		}
		return {
			type: "registered",
			...(typeof pin === "string" ? { pin } : {}),
			...(typeof pairingCode === "string" ? { pairingCode } : {}),
		};
	}
	if (type === "paired") {
		const uplinkDeviceId = (raw as { uplinkDeviceId?: unknown }).uplinkDeviceId;
		const mobileDeviceId = (raw as { mobileDeviceId?: unknown }).mobileDeviceId;
		return {
			type: "paired",
			...(typeof uplinkDeviceId === "string" ? { uplinkDeviceId } : {}),
			...(typeof mobileDeviceId === "string" ? { mobileDeviceId } : {}),
		};
	}
	if (type === "unpaired" || type === "mobile_disconnected") {
		const uplinkDeviceId = (raw as { uplinkDeviceId?: unknown }).uplinkDeviceId;
		const mobileDeviceId = (raw as { mobileDeviceId?: unknown }).mobileDeviceId;
		return {
			type,
			...(typeof uplinkDeviceId === "string" ? { uplinkDeviceId } : {}),
			...(typeof mobileDeviceId === "string" ? { mobileDeviceId } : {}),
		};
	}
	if (type === "message") {
		return {
			type: "message",
			payload: (raw as { payload?: unknown }).payload,
		};
	}
	if (type === "error") {
		const message = (raw as { message?: unknown }).message;
		if (typeof message !== "string") {
			return null;
		}
		return { type: "error", message };
	}
	return null;
}

function decodeProjectStartRequest(value: unknown): ProjectStartRequest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	const operationId = candidate["operationId"];
	const originProjectPath = candidate["originProjectPath"];
	const preparationValue = candidate["preparation"];
	if (
		typeof operationId !== "string" ||
		operationId.length === 0 ||
		typeof originProjectPath !== "string" ||
		!isAbsolute(originProjectPath) ||
		(candidate["mode"] !== "project_folder" && candidate["mode"] !== "worktree") ||
		typeof preparationValue !== "object" ||
		preparationValue === null ||
		Array.isArray(preparationValue)
	) {
		return null;
	}

	const preparation = preparationValue as Record<string, unknown>;
	if (candidate["mode"] === "worktree") {
		if (
			preparation["type"] !== "create_worktree" ||
			typeof preparation["baseRef"] !== "string" ||
			!(
				/^refs\/heads\/[^\s]+$/u.test(preparation["baseRef"]) ||
				/^refs\/remotes\/[^/\s]+\/[^\s]+$/u.test(preparation["baseRef"])
			) ||
			preparation["baseRef"].endsWith("/HEAD") ||
			typeof preparation["expectedCommit"] !== "string" ||
			!/^[0-9a-fA-F]{40,64}$/u.test(preparation["expectedCommit"]) ||
			!(
				preparation["newBranch"] === null ||
				(typeof preparation["newBranch"] === "string" && preparation["newBranch"].length > 0)
			) ||
			Object.keys(preparation).some(
				(key) => !["type", "baseRef", "expectedCommit", "newBranch"].includes(key),
			)
		) {
			return null;
		}
		return {
			operationId,
			originProjectPath,
			mode: "worktree",
			preparation: {
				type: "create_worktree",
				baseRef: preparation["baseRef"],
				expectedCommit: preparation["expectedCommit"],
				newBranch: preparation["newBranch"],
			},
		};
	}
	if (preparation["type"] === "none") {
		if (
			"newBranch" in preparation ||
			"expectedHead" in preparation ||
			"expectedBranch" in preparation
		) {
			return null;
		}
		return {
			operationId,
			originProjectPath,
			mode: "project_folder",
			preparation: { type: "none" },
		};
	}
	if (
		preparation["type"] !== "create_branch" ||
		typeof preparation["newBranch"] !== "string" ||
		preparation["newBranch"].length === 0 ||
		typeof preparation["expectedHead"] !== "string" ||
		preparation["expectedHead"].length === 0 ||
		!(
			preparation["expectedBranch"] === null ||
			(typeof preparation["expectedBranch"] === "string" &&
				preparation["expectedBranch"].length > 0)
		)
	) {
		return null;
	}
	return {
		operationId,
		originProjectPath,
		mode: "project_folder",
		preparation: {
			type: "create_branch",
			newBranch: preparation["newBranch"],
			expectedHead: preparation["expectedHead"],
			expectedBranch: preparation["expectedBranch"],
		},
	};
}

/** Exported for testing only — not re-exported from index.ts. */
export function decodeMobileInbound(payload: unknown): MobileInboundMessage | null {
	if (typeof payload !== "object" || payload === null) {
		return null;
	}

	const type = (payload as { type?: unknown }).type;
	if (type === "new_session") {
		const runtime = (payload as { runtime?: unknown }).runtime;
		const prompt = (payload as { prompt?: unknown }).prompt;
		const workspace = (payload as { workspace?: unknown }).workspace;
		const model = (payload as { model?: unknown }).model;
		const temperature = (payload as { temperature?: unknown }).temperature;
		const maxTokens = (payload as { maxTokens?: unknown }).maxTokens;
		const projectStartValue = (payload as { projectStart?: unknown }).projectStart;
		if (
			(runtime === "opencode" ||
				runtime === "claude" ||
				runtime === "codex" ||
				runtime === "gemini") &&
			typeof prompt === "string"
		) {
			const projectStart =
				projectStartValue === undefined ? undefined : decodeProjectStartRequest(projectStartValue);
			if (projectStartValue !== undefined && !projectStart) return null;
			const msg: NewSessionMessage = { type: "new_session", runtime, prompt };
			if (typeof workspace === "string" && workspace.trim().length > 0) {
				msg.workspace = workspace.trim();
			}
			if (typeof model === "string" && model.trim().length > 0) {
				msg.model = model.trim();
			}
			if (
				typeof temperature === "number" &&
				Number.isFinite(temperature) &&
				temperature >= 0 &&
				temperature <= 2
			) {
				msg.temperature = temperature;
			}
			if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) {
				msg.maxTokens = maxTokens;
			}
			if (projectStart) msg.projectStart = projectStart;
			return msg;
		}
		return null;
	}

	if (type === "send_prompt") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		const prompt = (payload as { prompt?: unknown }).prompt;
		if (typeof sessionId === "string" && typeof prompt === "string") {
			return { type: "send_prompt", sessionId, prompt };
		}
		return null;
	}

	if (type === "stop") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === "string") {
			return { type: "stop", sessionId };
		}
		return null;
	}

	if (type === "get_diff") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		const scope = (payload as { scope?: unknown }).scope;
		if (
			typeof sessionId === "string" &&
			(scope === "staged" || scope === "unstaged" || scope === "all")
		) {
			return { type: "get_diff", sessionId, scope };
		}
		return null;
	}

	if (type === "request_device_info") {
		return { type: "request_device_info" };
	}

	if (type === "approval_response") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		const requestId = (payload as { requestId?: unknown }).requestId;
		const approved = (payload as { approved?: unknown }).approved;
		if (
			typeof sessionId === "string" &&
			typeof requestId === "string" &&
			typeof approved === "boolean"
		) {
			return { type: "approval_response", sessionId, requestId, approved };
		}
		return null;
	}

	if (type === "list_models") {
		const runtime = (payload as { runtime?: unknown }).runtime;
		if (
			runtime === "opencode" ||
			runtime === "claude" ||
			runtime === "codex" ||
			runtime === "gemini"
		) {
			return { type: "list_models", runtime };
		}
		return null;
	}

	if (type === "list_runtimes") {
		return { type: "list_runtimes" };
	}

	if (type === "get_project_state") {
		return { type: "get_project_state" };
	}

	if (type === "get_project_start_state") {
		const projectPath = (payload as { projectPath?: unknown }).projectPath;
		if (typeof projectPath === "string" && projectPath.length > 0) {
			return { type: "get_project_start_state", projectPath };
		}
		return null;
	}

	if (type === "add_project") {
		const name = (payload as { name?: unknown }).name;
		const path = (payload as { path?: unknown }).path;
		if (typeof name === "string" && typeof path === "string") {
			return { type: "add_project", name: name.trim(), path };
		}
		return null;
	}

	if (type === "list_projects") {
		return { type: "list_projects" };
	}

	if (type === "rename_project") {
		const path = (payload as { path?: unknown }).path;
		const name = (payload as { name?: unknown }).name;
		if (typeof path === "string" && typeof name === "string") {
			return { type: "rename_project", path, name: name.trim() };
		}
		return null;
	}

	if (type === "remove_project") {
		const path = (payload as { path?: unknown }).path;
		if (typeof path === "string") {
			return { type: "remove_project", path };
		}
		return null;
	}

	if (type === "list_directory") {
		const path = (payload as { path?: unknown }).path;
		const msg: ListDirectoryMessage = { type: "list_directory" };
		if (typeof path === "string" && path.trim().length > 0) {
			msg.path = path.trim();
		}
		return msg;
	}

	if (type === "git_status") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === "string") {
			return { type: "git_status", sessionId };
		}
		return null;
	}

	if (type === "git_pull") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === "string") {
			return { type: "git_pull", sessionId };
		}
		return null;
	}

	if (type === "git_push") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === "string") {
			return { type: "git_push", sessionId };
		}
		return null;
	}

	if (type === "git_worktree_add") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		const branch = (payload as { branch?: unknown }).branch;
		if (typeof sessionId === "string" && typeof branch === "string") {
			return { type: "git_worktree_add", sessionId, branch };
		}
		return null;
	}

	if (type === "git_submit_pr") {
		const sessionId = (payload as { sessionId?: unknown }).sessionId;
		const title = (payload as { title?: unknown }).title;
		const body = (payload as { body?: unknown }).body;
		if (typeof sessionId === "string") {
			return {
				type: "git_submit_pr",
				sessionId,
				...(typeof title === "string" ? { title } : {}),
				...(typeof body === "string" ? { body } : {}),
			};
		}
		return null;
	}

	return null;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", (err: unknown) => reject(err));
	});
}
