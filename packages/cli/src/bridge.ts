import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

import { WS_MAX_PAYLOAD_BYTES } from "./messageLimits.js";
import { detectTailscaleEndpoint } from "./tailscale.js";

import type {
	RuntimeType,
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
	| RelayMessageMessage
	| RelayErrorMessage;

interface SessionInfo {
	id: string;
	runtime: RuntimeType;
	status: SessionStatus;
	createdAt: number;
	runtimeSessionId?: string;
	workspace?: string;
}

interface SessionListMessage {
	type: "session_list";
	sessions: SessionInfo[];
}

interface SessionOutputMessage {
	type: "session_output";
	sessionId: string;
	text: string;
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
	kind: "tailscale";
	url: string;
}

interface DeviceInfoMessage {
	type: "device_info";
	uplinkDeviceId: string;
	endpoints: DeviceEndpointMessage[];
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
	resumeSessionId?: string;
	workspace?: string;
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
}

type MobileInboundMessage =
	| ApprovalResponseMessage
	| SendPromptMessage
	| StopMessage
	| NewSessionMessage
	| GetDiffMessage
	| ListDirectoryMessage;

type MobileOutboundMessage =
	| SessionListMessage
	| SessionOutputMessage
	| SessionStatusMessage
	| ApprovalRequestMessage
	| DiffMessage
	| DeviceInfoMessage
	| DirectoryListingMessage;

const AUTO_RESUME_RUNTIMES: ReadonlySet<RuntimeType> = new Set(["claude", "opencode"]);

export interface RelayUplinkBridgeConfig {
	relayUrl: string;
	relayWsOptions?: WebSocket.ClientOptions;
	uplinkUrl: string;
	repoPath: string;
	onPairingCode?: (code: string) => void;
	onMobilePaired?: () => void;
	log?: (message: string) => void;
}

export interface RelayUplinkBridgeHandle {
	pairingCode: string;
	uplinkDeviceId: string;
	/** @deprecated alias of uplinkDeviceId for back-compat */
	uplinkPublicKey: string;
	startSession: (runtime: RuntimeType, prompt: string) => Promise<{ sessionId: string }>;
	refreshPairingCode: () => Promise<string>;
	stop: () => Promise<void>;
}

const DEVICE_ID_PATH = join(homedir(), ".codemote", "device-id");

class UplinkWsClient {
	private readonly pending: Array<{
		expectedType: UplinkResponse["type"];
		resolve: (msg: UplinkResponse) => void;
		reject: (err: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];

	constructor(
		private readonly ws: WebSocket,
		private readonly onEvent: (event: StreamEvent) => void,
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
	): Promise<UplinkWsClient> {
		const ws = new WebSocket(uplinkUrl);
		await waitForOpen(ws);
		return new UplinkWsClient(ws, onEvent);
	}

	async startRun(
		profile: RuntimeType,
		workspace: string,
		initialPrompt: string,
		resumeSessionId?: string,
	) {
		const payload = {
			profile,
			workspace,
			initialPrompt,
			...(resumeSessionId ? { resumeSessionId } : {}),
		};
		return this.sendAndWait({
			type: "start_run",
			payload,
		});
	}

	async sendInput(sessionId: string, input: string) {
		return this.sendAndWait({
			type: "send_input",
			payload: { sessionId, input },
		});
	}

	async stopSession(sessionId: string) {
		return this.sendAndWait({
			type: "stop",
			payload: { sessionId },
		});
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

	async listDirectory(path?: string) {
		return this.sendAndWait({
			type: "list_directory",
			payload: { ...(path ? { path } : {}) },
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

		if (msg.type === "error") {
			const waiter = this.pending.shift();
			if (waiter) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error(msg.payload.message));
			}
			return;
		}

		const waiter = this.pending.shift();
		if (!waiter) {
			return;
		}

		clearTimeout(waiter.timeout);
		if (msg.type !== waiter.expectedType) {
			waiter.reject(new Error(`Unexpected uplink response: ${msg.type}`));
			return;
		}

		waiter.resolve(msg);
	}

	private sendAndWait(command: UplinkCommand): Promise<UplinkResponse> {
		const expectedType = expectedResponseType(command.type);

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Timed out waiting for uplink response: ${expectedType}`));
			}, 20_000);

			this.pending.push({ expectedType, resolve, reject, timeout });
			this.ws.send(JSON.stringify(command));
		});
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
}

function expectedResponseType(commandType: UplinkCommand["type"]): UplinkResponse["type"] {
	switch (commandType) {
		case "ping":
			return "pong";
		case "list_sessions":
			return "sessions";
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
		default:
			return "error";
	}
}

export async function startRelayUplinkBridge(
	config: RelayUplinkBridgeConfig,
): Promise<RelayUplinkBridgeHandle> {
	const { relayUrl, relayWsOptions, uplinkUrl, repoPath, onPairingCode, onMobilePaired, log } =
		config;

	const uplinkDeviceId = await getOrCreateUplinkDeviceId();
	const relayPort = relayPortFromURL(relayUrl);
	const relaySecure = relayUrl.startsWith("wss://");

	const sessions = new Map<string, SessionInfo>();
	const approvalRequests = new Map<string, { sessionId: string }>();
	let mobileDeviceId: string | null = null;
	let pairingCode = "";

	const relayWs = relayWsOptions
		? new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES, ...relayWsOptions })
		: new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES });
	await waitForOpen(relayWs);

	pairingCode = await registerWithRelay(relayWs, uplinkDeviceId);
	onPairingCode?.(pairingCode);
	log?.("[Bridge] Registered with relay (pairing code redacted)");

	const uplinkClient = await UplinkWsClient.connect(uplinkUrl, (event) => {
		void handleUplinkEvent(event);
	});
	await syncSessionsFromUplink();

	relayWs.on("message", (data: WebSocket.RawData) => {
		void handleRelayMessage(data);
	});

	relayWs.on("close", () => {
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
					mobileDeviceId = relayMessage.mobileDeviceId;
					onMobilePaired?.();
					log?.("[Bridge] Mobile paired");
					await syncSessionsFromUplink();
					sendSessionList();
					void sendDeviceInfoToMobile();
				}
				return;

			case "message": {
				const decoded = decodeMobileInbound(relayMessage.payload);
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
				await uplinkClient.sendInput(message.sessionId, message.prompt);
				return;
			case "stop":
				await uplinkClient.stopSession(message.sessionId);
				return;
			case "get_diff":
				await handleGetDiff(message);
				return;
			case "list_directory":
				await handleListDirectory(message);
				return;
			case "approval_response":
				await handleApprovalResponse(message);
				return;
		}
	}

	async function handleNewSession(message: NewSessionMessage): Promise<void> {
		const resumeSessionId = resolveResumeSessionId(message);
		try {
			await startAndTrackSession(
				message.runtime,
				message.prompt,
				resumeSessionId,
				message.workspace,
			);
		} catch (error) {
			let sessionStartError: unknown = error;
			if (resumeSessionId) {
				log?.(
					`[Bridge] Resume failed for ${message.runtime} session ${resumeSessionId}: ${
						error instanceof Error ? error.message : String(error)
					}; retrying with a fresh session`,
				);
				try {
					await startAndTrackSession(message.runtime, message.prompt, undefined, message.workspace);
					return;
				} catch (fallbackError) {
					sessionStartError = fallbackError;
				}
			}

			log?.(
				`[Bridge] Failed to start session: ${
					sessionStartError instanceof Error ? sessionStartError.message : String(sessionStartError)
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

	function resolveResumeSessionId(message: NewSessionMessage): string | undefined {
		if (!AUTO_RESUME_RUNTIMES.has(message.runtime)) {
			return undefined;
		}
		if (message.resumeSessionId && message.resumeSessionId.trim().length > 0) {
			return message.resumeSessionId.trim();
		}

		const latestRuntimeSession = Array.from(sessions.values())
			.filter((session) => session.runtime === message.runtime && !!session.runtimeSessionId)
			.sort((a, b) => b.createdAt - a.createdAt)[0];
		return latestRuntimeSession?.runtimeSessionId;
	}

	async function startAndTrackSession(
		runtime: RuntimeType,
		prompt: string,
		resumeSessionId?: string,
		workspace?: string,
	): Promise<{ sessionId: string }> {
		const started = await uplinkClient.startRun(
			runtime,
			workspace || repoPath,
			prompt,
			resumeSessionId,
		);
		if (started.type !== "run_started") {
			throw new Error("Unexpected start_run response");
		}

		const sessionId = started.payload.sessionId;
		sessions.set(sessionId, {
			id: sessionId,
			runtime,
			status: "starting",
			createdAt: Date.now(),
			...(resumeSessionId ? { runtimeSessionId: resumeSessionId } : {}),
			...(workspace ? { workspace } : {}),
		});
		sendSessionList();
		return { sessionId };
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
		await uplinkClient.sendInput(pending.sessionId, message.approved ? "y" : "n");
	}

	async function handleUplinkEvent(event: StreamEvent): Promise<void> {
		if (!mobileDeviceId) {
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
			case "session.status": {
				const payload = event.payload as { status?: SessionStatus };
				const status = payload.status ?? "running";
				const session = sessions.get(event.sessionId);
				if (session) {
					session.status = status;
				} else {
					sessions.set(event.sessionId, {
						id: event.sessionId,
						runtime: "opencode",
						status,
						createdAt: Date.now(),
					});
				}

				sendToMobile({
					type: "session_status",
					sessionId: event.sessionId,
					status,
				});
				await syncSessionRuntimeMetadata(event.sessionId);
				sendSessionList();
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
			log?.(
				`[Bridge] Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
			);
			sendToMobile({
				type: "directory_listing",
				path: message.path ?? "",
				entries: [],
			});
		}
	}

	function sendSessionList(): void {
		const sessionsList = Array.from(sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
		log?.(
			`[Bridge] sendSessionList: ${sessionsList.length} sessions, mobileDeviceId=${mobileDeviceId ? "set" : "null"}`,
		);
		sendToMobile({ type: "session_list", sessions: sessionsList });
	}

	function sendToMobile(message: MobileOutboundMessage): void {
		if (!mobileDeviceId) {
			log?.(`[Bridge] sendToMobile: skipped (no mobileDeviceId), type=${message.type}`);
			return;
		}

		log?.(`[Bridge] sendToMobile: type=${message.type}`);
		relayWs.send(JSON.stringify({ type: "message", payload: message }));
	}

	function toSessionInfo(session: {
		id: string;
		runtime: RuntimeType;
		status: SessionStatus;
		startedAt?: number;
		createdAt?: number;
		runtimeSessionId?: string;
		workspace?: { workingDir: string };
	}): SessionInfo {
		return {
			id: session.id,
			runtime: session.runtime,
			status: session.status,
			createdAt: session.createdAt ?? session.startedAt ?? Date.now(),
			...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
			...(session.workspace ? { workspace: session.workspace.workingDir } : {}),
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
		const tailscaleEndpoint = await detectTailscaleEndpoint({
			port: relayPort,
			secure: relaySecure,
		});
		if (!tailscaleEndpoint) {
			return;
		}

		sendToMobile({
			type: "device_info",
			uplinkDeviceId,
			endpoints: [{ kind: "tailscale", url: tailscaleEndpoint.url }],
		});
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
		startSession,
		refreshPairingCode,
		stop: async () => {
			await uplinkClient.close();
			if (relayWs.readyState === WebSocket.OPEN) {
				relayWs.close();
			}
		},
	};
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

function decodeMobileInbound(payload: unknown): MobileInboundMessage | null {
	if (typeof payload !== "object" || payload === null) {
		return null;
	}

	const type = (payload as { type?: unknown }).type;
	if (type === "new_session") {
		const runtime = (payload as { runtime?: unknown }).runtime;
		const prompt = (payload as { prompt?: unknown }).prompt;
		const resumeSessionId = (payload as { resumeSessionId?: unknown }).resumeSessionId;
		const workspace = (payload as { workspace?: unknown }).workspace;
		if (
			(runtime === "opencode" ||
				runtime === "claude" ||
				runtime === "codex" ||
				runtime === "gemini") &&
			typeof prompt === "string"
		) {
			const msg: NewSessionMessage = { type: "new_session", runtime, prompt };
			if (typeof resumeSessionId === "string" && resumeSessionId.trim().length > 0) {
				msg.resumeSessionId = resumeSessionId.trim();
			}
			if (typeof workspace === "string" && workspace.trim().length > 0) {
				msg.workspace = workspace.trim();
			}
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

	if (type === "list_directory") {
		const path = (payload as { path?: unknown }).path;
		const msg: ListDirectoryMessage = { type: "list_directory" };
		if (typeof path === "string" && path.trim().length > 0) {
			msg.path = path.trim();
		}
		return msg;
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
