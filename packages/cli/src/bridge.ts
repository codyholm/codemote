import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { WebSocket } from "ws";

import { WS_MAX_PAYLOAD_BYTES } from "./messageLimits.js";
import type { EncryptedPayload } from "./protocol.js";
import { ReplayGuard } from "./replayProtection.js";
import { validateEncryptedPayload } from "./validateEncryptedPayload.js";

import type {
	RuntimeType,
	SessionStatus,
	StreamEvent,
	UplinkCommand,
	UplinkResponse,
} from "@guild-remote/uplink";

interface RelayRegisteredMessage {
	type: "registered";
	pairingCode: string;
	pin?: string;
}

interface RelayPairedMessage {
	type: "paired";
	uplinkPublicKey?: string;
	mobilePublicKey?: string;
}

interface RelayMessageMessage {
	type: "message";
	payload: EncryptedPayload;
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

interface NewSessionMessage {
	type: "new_session";
	runtime: RuntimeType;
	prompt: string;
}

type MobileInboundMessage = ApprovalResponseMessage | SendPromptMessage | NewSessionMessage;

type MobileOutboundMessage =
	| SessionListMessage
	| SessionOutputMessage
	| SessionStatusMessage
	| ApprovalRequestMessage;

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
	uplinkPublicKey: string;
	refreshPairingCode: () => Promise<string>;
	stop: () => Promise<void>;
}

class UplinkWsClient {
	private ws: WebSocket;
	private pending: Array<{
		expectedType: UplinkResponse["type"];
		resolve: (msg: UplinkResponse) => void;
		reject: (err: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];

	constructor(
		ws: WebSocket,
		private readonly onEvent: (event: StreamEvent) => void,
	) {
		this.ws = ws;

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

	async startRun(profile: RuntimeType, workspace: string, initialPrompt: string) {
		return this.sendAndWait({
			type: "start_run",
			payload: { profile, workspace, initialPrompt },
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

	async listSessions() {
		return this.sendAndWait({ type: "list_sessions" });
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

	private handleMessage(data: WebSocket.RawData) {
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

	private rejectAll(err: Error) {
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
		default:
			return "error";
	}
}

export async function startRelayUplinkBridge(
	config: RelayUplinkBridgeConfig,
): Promise<RelayUplinkBridgeHandle> {
	const { relayUrl, relayWsOptions, uplinkUrl, repoPath, onPairingCode, onMobilePaired, log } =
		config;

	const uplinkKeyPair = nacl.box.keyPair();
	const uplinkPublicKey = Buffer.from(uplinkKeyPair.publicKey).toString("base64");

	const sessions = new Map<string, SessionInfo>();
	const approvalRequests = new Map<string, { sessionId: string }>();
	const replayGuard = new ReplayGuard();
	let mobilePublicKey: string | null = null;

	const relayWs = relayWsOptions
		? new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES, ...relayWsOptions })
		: new WebSocket(relayUrl, { maxPayload: WS_MAX_PAYLOAD_BYTES });
	await waitForOpen(relayWs);

	let pairingCode = await registerWithRelay(relayWs, uplinkPublicKey);
	onPairingCode?.(pairingCode);
	log?.("[Bridge] Registered with relay (pairing code redacted)");

	const uplinkClient = await UplinkWsClient.connect(uplinkUrl, (event) => {
		void handleUplinkEvent(event);
	});

	relayWs.on("message", (data: WebSocket.RawData) => {
		void handleRelayMessage(data);
	});

	relayWs.on("close", () => {
		log?.("[Bridge] Relay WebSocket closed");
	});

	relayWs.on("error", (err: unknown) => {
		log?.(`[Bridge] Relay WebSocket error: ${String(err)}`);
	});

	function protocolViolation(reason: string) {
		log?.(`[Bridge] Protocol violation: ${reason}; closing relay socket`);
		try {
			relayWs.close(1008, "Protocol violation");
		} catch {
			// ignore
		}
	}

	async function handleRelayMessage(data: WebSocket.RawData) {
		let raw: unknown;
		try {
			raw = JSON.parse(data.toString());
		} catch {
			protocolViolation("invalid_json");
			return;
		}

		if (typeof raw !== "object" || raw === null) {
			protocolViolation("message_not_object");
			return;
		}

		const type = (raw as { type?: unknown }).type;
		if (typeof type !== "string") {
			protocolViolation("missing_type");
			return;
		}

		const msg = raw as RelayInboundMessage;

		if (msg.type === "registered") {
			pairingCode = msg.pin ?? msg.pairingCode;
			onPairingCode?.(pairingCode);
			return;
		}

		if (msg.type === "paired") {
			if (msg.mobilePublicKey) {
				mobilePublicKey = msg.mobilePublicKey;
				onMobilePaired?.();
				log?.("[Bridge] Mobile paired");
				sendSessionList();
			}
			return;
		}

		if (msg.type === "message") {
			const payloadCheck = validateEncryptedPayload((raw as { payload?: unknown }).payload);
			if (!payloadCheck.ok) {
				protocolViolation(payloadCheck.reason);
				return;
			}

			const replayCheck = replayGuard.check(payloadCheck.value);
			if (!replayCheck.ok) {
				log?.(`[Bridge] Rejected replayed/stale mobile message (${replayCheck.reason})`);
				return;
			}

			const decoded = decryptFromMobile(payloadCheck.value);
			if (!decoded) {
				log?.("[Bridge] Failed to decrypt message");
				return;
			}

			await handleMobileMessage(decoded);
			return;
		}

		if (msg.type === "error") {
			log?.("[Bridge] Relay error (redacted)");
		}
	}

	async function handleMobileMessage(message: MobileInboundMessage) {
		switch (message.type) {
			case "new_session": {
				await handleNewSession(message);
				return;
			}
			case "send_prompt": {
				await uplinkClient.sendInput(message.sessionId, message.prompt);
				return;
			}
			case "approval_response": {
				await handleApprovalResponse(message);
				return;
			}
		}
	}

	async function handleNewSession(message: NewSessionMessage) {
		try {
			const started = await uplinkClient.startRun(message.runtime, repoPath, message.prompt);
			if (started.type !== "run_started") {
				throw new Error("Unexpected start_run response");
			}

			const sessionId = started.payload.sessionId;
			sessions.set(sessionId, {
				id: sessionId,
				runtime: message.runtime,
				status: "starting",
				createdAt: Date.now(),
			});
			sendSessionList();
		} catch (error) {
			log?.(
				`[Bridge] Failed to start session: ${error instanceof Error ? error.message : String(error)}`,
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

	async function handleApprovalResponse(message: ApprovalResponseMessage) {
		const pending = approvalRequests.get(message.requestId);
		if (!pending) {
			return;
		}

		approvalRequests.delete(message.requestId);
		await uplinkClient.sendInput(pending.sessionId, message.approved ? "y" : "n");
	}

	async function handleUplinkEvent(event: StreamEvent) {
		if (!mobilePublicKey) {
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

	function sendSessionList() {
		const sessionsList = Array.from(sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
		sendToMobile({ type: "session_list", sessions: sessionsList });
	}

	function decryptFromMobile(payload: EncryptedPayload): MobileInboundMessage | null {
		let senderPublicKey: Buffer;
		let nonce: Buffer;
		let ciphertext: Buffer;
		try {
			senderPublicKey = Buffer.from(payload.senderPublicKey, "base64");
			nonce = Buffer.from(payload.nonce, "base64");
			ciphertext = Buffer.from(payload.ciphertext, "base64");
		} catch {
			return null;
		}

		if (senderPublicKey.length !== 32) return null;
		if (nonce.length !== 24) return null;

		const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, uplinkKeyPair.secretKey);
		if (!plaintext) {
			return null;
		}

		let decoded: { type: string; [key: string]: unknown };
		try {
			decoded = JSON.parse(Buffer.from(plaintext).toString("utf8")) as {
				type: string;
				[key: string]: unknown;
			};
		} catch {
			return null;
		}

		if (
			decoded.type !== "new_session" &&
			decoded.type !== "send_prompt" &&
			decoded.type !== "approval_response"
		) {
			return null;
		}

		return decoded as unknown as MobileInboundMessage;
	}

	function sendToMobile(message: MobileOutboundMessage) {
		if (!mobilePublicKey) {
			return;
		}

		const plaintext = Buffer.from(JSON.stringify(message), "utf8");
		const nonce = randomBytes(24);
		const recipientPublicKey = Buffer.from(mobilePublicKey, "base64");
		const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, uplinkKeyPair.secretKey);

		const payload: EncryptedPayload = {
			senderPublicKey: uplinkPublicKey,
			ciphertext: Buffer.from(ciphertext).toString("base64"),
			nonce: Buffer.from(nonce).toString("base64"),
			timestamp: Date.now(),
		};

		relayWs.send(JSON.stringify({ type: "message", payload }));
	}

	async function refreshPairingCode(): Promise<string> {
		pairingCode = await registerWithRelay(relayWs, uplinkPublicKey);
		onPairingCode?.(pairingCode);
		log?.("[Bridge] Refreshed PIN (redacted)");
		return pairingCode;
	}

	return {
		pairingCode,
		uplinkPublicKey,
		refreshPairingCode,
		stop: async () => {
			await uplinkClient.close();
			if (relayWs.readyState === WebSocket.OPEN) {
				relayWs.close();
			}
		},
	};
}

async function registerWithRelay(relayWs: WebSocket, uplinkPublicKey: string): Promise<string> {
	relayWs.send(
		JSON.stringify({
			type: "register",
			publicKey: uplinkPublicKey,
			deviceType: "uplink",
		}),
	);

	const registered = await waitForRelayMessage(relayWs, "registered", 10_000);
	if (registered.type !== "registered") {
		throw new Error("Unexpected relay response during registration");
	}

	return registered.pin ?? registered.pairingCode;
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
				const msg = JSON.parse(data.toString()) as RelayInboundMessage;
				if (msg.type === expectedType) {
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

async function waitForOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", (err: unknown) => reject(err));
	});
}
