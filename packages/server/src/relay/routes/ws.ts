import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { PairingCodeService } from "../services/codes.js";
import type { RoomManager } from "../services/rooms.js";
import type { TrustedPairingsStore } from "../services/trusted-pairings.js";

/**
 * WebSocket message format
 * All messages follow this structure for the relay protocol
 */
export interface WsMessage {
	/** Message type */
	type: "register" | "pair" | "resume" | "unpair" | "message";
	/** Sender's device identifier */
	deviceId?: string;
	/** Device type (mobile app or uplink companion) */
	deviceType?: "mobile" | "uplink";
	/** Canonical onboarding token: 6-digit numeric PIN */
	pin?: string;
	/** Back-compat onboarding token field */
	pairingCode?: string;
	/** Previously paired uplink identity (room id) */
	uplinkDeviceId?: string;
	/** Message payload (plaintext JSON over TLS) */
	payload?: unknown;
}

interface RegisterWebSocketRoutesOptions {
	trustedPairings?: TrustedPairingsStore;
}

interface PairingRateLimiterConfig {
	maxAttempts: number;
	windowMs: number;
	backoffMs: number[];
	lockoutMs: number;
}

interface PairingAttemptRecord {
	failedAttempts: number;
	lastAttemptAt: number;
	lockedUntil?: number;
}

interface PairingRateLimitResult {
	allowed: boolean;
	waitMs?: number;
	message?: string;
}

class BurstRateLimiter {
	private readonly attempts = new Map<string, { windowStartAt: number; count: number }>();
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly maxEntries: number;
	private lastPruneAt = 0;

	constructor(options: { maxAttempts: number; windowMs: number; maxEntries?: number }) {
		this.maxAttempts = options.maxAttempts;
		this.windowMs = options.windowMs;
		this.maxEntries = options.maxEntries ?? 5000;
	}

	private prune(now: number): void {
		if (now - this.lastPruneAt < this.windowMs && this.attempts.size <= this.maxEntries) {
			return;
		}
		this.lastPruneAt = now;

		for (const [clientIP, record] of this.attempts) {
			if (now - record.windowStartAt > this.windowMs) {
				this.attempts.delete(clientIP);
			}
		}

		if (this.attempts.size <= this.maxEntries) return;
		let toDelete = this.attempts.size - this.maxEntries;
		for (const clientIP of this.attempts.keys()) {
			this.attempts.delete(clientIP);
			toDelete -= 1;
			if (toDelete <= 0) return;
		}
	}

	check(clientIP: string): PairingRateLimitResult {
		const now = Date.now();
		this.prune(now);
		const record = this.attempts.get(clientIP);
		if (!record || now - record.windowStartAt > this.windowMs) {
			this.attempts.set(clientIP, { windowStartAt: now, count: 1 });
			return { allowed: true };
		}

		const count = record.count + 1;
		record.count = count;
		if (count > this.maxAttempts) {
			return {
				allowed: false,
				waitMs: record.windowStartAt + this.windowMs - now,
				message: "Too many requests",
			};
		}

		return { allowed: true };
	}
}

class PairingRateLimiter {
	private readonly attempts = new Map<string, PairingAttemptRecord>();
	private readonly config: PairingRateLimiterConfig;

	constructor(config: PairingRateLimiterConfig) {
		this.config = config;
	}

	check(clientIP: string): PairingRateLimitResult {
		const now = Date.now();
		const record = this.attempts.get(clientIP);

		if (!record) {
			return { allowed: true };
		}

		if (record.lockedUntil !== undefined) {
			if (now < record.lockedUntil) {
				const waitMs = record.lockedUntil - now;
				return {
					allowed: false,
					waitMs,
					message: `Too many failed attempts. Locked out for ${Math.ceil(waitMs / 1000)}s`,
				};
			}

			// Lockout expired
			this.attempts.delete(clientIP);
			return { allowed: true };
		}

		if (now - record.lastAttemptAt > this.config.windowMs) {
			this.attempts.delete(clientIP);
			return { allowed: true };
		}

		if (record.failedAttempts <= 0) {
			return { allowed: true };
		}

		const backoffIndex = Math.min(record.failedAttempts - 1, this.config.backoffMs.length - 1);
		const backoffDelay = this.config.backoffMs[backoffIndex];
		if (backoffDelay === undefined) {
			return { allowed: true };
		}

		const elapsed = now - record.lastAttemptAt;
		if (elapsed < backoffDelay) {
			const waitMs = backoffDelay - elapsed;
			return {
				allowed: false,
				waitMs,
				message: `Too many attempts. Wait ${Math.ceil(waitMs / 1000)}s before retrying`,
			};
		}

		return { allowed: true };
	}

	record(clientIP: string, success: boolean): void {
		const now = Date.now();
		const existing = this.attempts.get(clientIP);

		if (success) {
			this.attempts.delete(clientIP);
			return;
		}

		if (!existing || now - existing.lastAttemptAt > this.config.windowMs) {
			this.attempts.set(clientIP, { failedAttempts: 1, lastAttemptAt: now });
			return;
		}

		const failedAttempts = existing.failedAttempts + 1;
		const next: PairingAttemptRecord = { failedAttempts, lastAttemptAt: now };

		if (failedAttempts >= this.config.maxAttempts) {
			next.lockedUntil = now + this.config.lockoutMs;
		}

		this.attempts.set(clientIP, next);
	}

	reset(clientIP: string): void {
		this.attempts.delete(clientIP);
	}
}

function extractClientIP(request: unknown): string {
	const req = request as {
		ip?: string;
		socket?: { remoteAddress?: string | null };
		headers?: { [key: string]: string | string[] | undefined };
	};

	if (typeof req.ip === "string" && req.ip.length > 0) {
		return req.ip;
	}

	const forwarded = req.headers?.["x-forwarded-for"];
	const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (typeof forwardedValue === "string" && forwardedValue.length > 0) {
		return forwardedValue.split(",")[0]?.trim() || forwardedValue;
	}

	return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Register WebSocket routes on the Fastify app
 *
 * Protocol flow:
 * 1. Uplink sends 'register' -> receives PIN
 * 2. Mobile sends 'pair' with PIN -> both receive 'paired' notification
 * 3. Either can send 'message' -> forwarded to other room members
 *
 * @param app - Fastify instance with websocket plugin registered
 * @param rooms - Room manager for tracking connections
 * @param codes - Pairing code service for code generation/validation
 */
export function registerWebSocketRoutes(
	app: FastifyInstance,
	rooms: RoomManager,
	codes: PairingCodeService,
	options: RegisterWebSocketRoutesOptions = {},
): void {
	const { trustedPairings } = options;
	const pairingRateLimiter = new PairingRateLimiter({
		maxAttempts: 5,
		windowMs: 60_000,
		backoffMs: [1000, 2000, 4000, 8000],
		lockoutMs: 60_000,
	});

	const registerRateLimiter = new BurstRateLimiter({ maxAttempts: 20, windowMs: 60_000 });

	// In-process memory of successful mobile<->uplink pairings.
	// This enables resume-after-relaunch without storing or reusing a PIN.
	const pairedMobilesByUplink = new Map<string, Set<string>>();

	function handleConnection(socket: WebSocket, clientIP: string): void {
		let clientDeviceId: string | null = null;

		socket.on("message", (data) => {
			try {
				const rawData = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
				const msg = JSON.parse(rawData.toString()) as WsMessage;
				handleMessage(socket, msg, rawData);
			} catch {
				socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
			}
		});

		socket.on("close", () => {
			if (clientDeviceId) {
				rooms.leave(clientDeviceId);
			}
		});

		function handleMessage(ws: WebSocket, msg: WsMessage, rawData: Buffer): void {
			switch (msg.type) {
				case "register": {
					// Uplink registration creates/refreshes a pairing code.
					if (!msg.deviceId || msg.deviceType !== "uplink") {
						ws.send(JSON.stringify({ type: "error", message: "Invalid registration" }));
						return;
					}

					const rateLimit = registerRateLimiter.check(clientIP);
					if (!rateLimit.allowed) {
						ws.send(
							JSON.stringify({
								type: "error",
								message: rateLimit.message ?? "Too many requests",
								waitMs: rateLimit.waitMs,
							}),
						);
						return;
					}

					clientDeviceId = msg.deviceId;
					const code = codes.create(msg.deviceId);

					// Uplink room id == uplink device id.
					rooms.join(msg.deviceId, {
						ws,
						deviceId: msg.deviceId,
						type: "uplink",
					});

					ws.send(
						JSON.stringify({
							type: "registered",
							// Back-compat for old clients
							pairingCode: code,
							// Canonical field
							pin: code,
						}),
					);
					break;
				}

				case "pair": {
					if (!msg.deviceId || msg.deviceType !== "mobile") {
						ws.send(JSON.stringify({ type: "error", message: "Invalid pairing request" }));
						return;
					}

					const token = (msg.pin ?? msg.pairingCode)?.replaceAll(" ", "").trim();
					if (!token) {
						ws.send(JSON.stringify({ type: "error", message: "Invalid pairing request" }));
						return;
					}

					const rateLimit = pairingRateLimiter.check(clientIP);
					if (!rateLimit.allowed) {
						ws.send(
							JSON.stringify({
								type: "error",
								message: rateLimit.message ?? "Too many attempts",
								waitMs: rateLimit.waitMs,
							}),
						);
						return;
					}

					const uplinkDeviceId = codes.consume(token, msg.deviceId);
					pairingRateLimiter.record(clientIP, Boolean(uplinkDeviceId));

					if (!uplinkDeviceId) {
						ws.send(JSON.stringify({ type: "error", message: "Invalid or expired PIN" }));
						return;
					}

					clientDeviceId = msg.deviceId;
					const pairedSet = pairedMobilesByUplink.get(uplinkDeviceId) ?? new Set<string>();
					pairedSet.add(msg.deviceId);
					pairedMobilesByUplink.set(uplinkDeviceId, pairedSet);
					trustedPairings?.markPaired(uplinkDeviceId, msg.deviceId);

					rooms.join(uplinkDeviceId, {
						ws,
						deviceId: msg.deviceId,
						type: "mobile",
					});

					ws.send(
						JSON.stringify({
							type: "paired",
							uplinkDeviceId,
						}),
					);

					rooms.broadcast(
						msg.deviceId,
						JSON.stringify({
							type: "paired",
							uplinkDeviceId,
							mobileDeviceId: msg.deviceId,
						}),
					);
					break;
				}

				case "resume": {
					if (!msg.deviceId || msg.deviceType !== "mobile" || !msg.uplinkDeviceId) {
						ws.send(JSON.stringify({ type: "error", message: "Invalid resume request" }));
						return;
					}

					const allowedFromMemory =
						pairedMobilesByUplink.get(msg.uplinkDeviceId)?.has(msg.deviceId) ?? false;
					const allowedFromStore =
						trustedPairings?.isTrusted(msg.uplinkDeviceId, msg.deviceId) ?? false;
					const allowMemoryFallback =
						!(trustedPairings?.isEnabled() ?? false) ||
						(trustedPairings?.hasPersistenceFailure() ?? false);
					const allowed = allowedFromStore || (allowMemoryFallback && allowedFromMemory);

					if (!allowed) {
						ws.send(JSON.stringify({ type: "error", message: "Not paired" }));
						return;
					}

					const resumeSource = allowedFromStore ? "persisted" : "memory";
					const pairedSet = pairedMobilesByUplink.get(msg.uplinkDeviceId) ?? new Set<string>();
					pairedSet.add(msg.deviceId);
					pairedMobilesByUplink.set(msg.uplinkDeviceId, pairedSet);
					app.log.info(
						`[relay] resume_allowed source=${resumeSource} uplink=${msg.uplinkDeviceId.slice(0, 8)} mobile=${msg.deviceId.slice(0, 8)}`,
					);

					if (allowedFromStore) {
						trustedPairings?.markSeen(msg.uplinkDeviceId, msg.deviceId);
					} else if (allowMemoryFallback && trustedPairings?.isEnabled()) {
						// Persistence write failures should not break current-process resume.
						// Try to recover durable state opportunistically once resumed.
						trustedPairings?.markPaired(msg.uplinkDeviceId, msg.deviceId);
					}

					clientDeviceId = msg.deviceId;
					rooms.join(msg.uplinkDeviceId, {
						ws,
						deviceId: msg.deviceId,
						type: "mobile",
					});

					ws.send(
						JSON.stringify({
							type: "paired",
							uplinkDeviceId: msg.uplinkDeviceId,
						}),
					);

					rooms.broadcast(
						msg.deviceId,
						JSON.stringify({
							type: "paired",
							uplinkDeviceId: msg.uplinkDeviceId,
							mobileDeviceId: msg.deviceId,
						}),
					);
					break;
				}

				case "unpair": {
					if (!msg.deviceId || msg.deviceType !== "mobile" || !msg.uplinkDeviceId) {
						ws.send(JSON.stringify({ type: "error", message: "Invalid unpair request" }));
						return;
					}

					const pairedSet = pairedMobilesByUplink.get(msg.uplinkDeviceId);
					const removedFromMemory = pairedSet?.delete(msg.deviceId) ?? false;
					if (pairedSet && pairedSet.size === 0) {
						pairedMobilesByUplink.delete(msg.uplinkDeviceId);
					}
					const removedFromStore =
						trustedPairings?.revoke(msg.uplinkDeviceId, msg.deviceId) ?? false;
					app.log.info(
						`[relay] unpair mobile=${msg.deviceId.slice(0, 8)} uplink=${msg.uplinkDeviceId.slice(0, 8)} removed_memory=${removedFromMemory} removed_store=${removedFromStore}`,
					);

					rooms.broadcast(
						msg.deviceId,
						JSON.stringify({
							type: "unpaired",
							uplinkDeviceId: msg.uplinkDeviceId,
							mobileDeviceId: msg.deviceId,
						}),
					);
					rooms.leave(msg.deviceId);

					ws.send(
						JSON.stringify({
							type: "unpaired",
							uplinkDeviceId: msg.uplinkDeviceId,
							mobileDeviceId: msg.deviceId,
						}),
					);
					break;
				}

				case "message": {
					if (!clientDeviceId) {
						ws.send(JSON.stringify({ type: "error", message: "Not registered" }));
						return;
					}

					// Forward raw JSON payload as-is.
					rooms.broadcast(clientDeviceId, rawData.toString());
					break;
				}

				default: {
					ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
				}
			}
		}
	}

	// Support both `ws://host:port` and `ws://host:port/ws`
	app.get("/", { websocket: true }, (socket, request) => {
		handleConnection(socket as WebSocket, extractClientIP(request));
	});
	app.get("/ws", { websocket: true }, (socket, request) => {
		handleConnection(socket as WebSocket, extractClientIP(request));
	});
}
