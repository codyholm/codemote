/**
 * Server Integration - Bundles relay + uplink in one process
 *
 * `npx codemote` runs a single Node.js process that starts:
 * - Relay server (pairing + message routing)
 * - Uplink server (runtime orchestration + repo operations)
 * - Bridge (uplink “device” registration + protocol translation)
 *
 * ARCHITECTURE:
 * ┌─────────────────────────────────────────┐
 * │         Combined Server Process         │
 * ├─────────────────────────────────────────┤
 * │  ┌──────────────┐    ┌──────────────┐  │
 * │  │ Relay Server │    │    Uplink    │  │
 * │  │   (WS API)   │◄──►│   Service    │  │
 * │  └──────────────┘    └──────────────┘  │
 * │         ▲                                │
 * │         │ WebSocket                     │
 * │  ┌──────┴────────┐                      │
 * │  │ PIN Manager   │                      │
 * │  │ Rate Limiter  │                      │
 * │  └───────────────┘                      │
 * └─────────────────────────────────────────┘
 *          ▲
 *          │ Mobile connects via PIN
 *          │
 *     📱 Mobile App
 *
 * NOTES:
 * - Pairing PINs are issued and validated by the relay (`PairingCodeService`).
 * - Trusted devices persist to `~/.codemote/trusted-pairings.json` by default.
 * - Transport is WSS by default using a self-signed cert under `~/.codemote/tls/`.
 */

import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import {
	type RelayServerConfig,
	type RuntimeType,
	type SessionStatus,
	type TrustedPairingRecord,
	type UplinkConfig,
	UplinkServer,
	createRelayServer,
} from "@codemote/server";
import { startRelayUplinkBridge } from "./bridge.js";
import { ensureLocalTLS, fetchRelayTlsPin } from "./tls.js";

export interface ServerConfig {
	/** Port for the relay server */
	port: number;
	/** Callback when PIN is regenerated */
	onPINRegenerate?: (pin: string) => void;
	/** Callback when a client successfully connects */
	onClientConnected?: () => void;
	/** Callback when a session status event is observed */
	onSessionStatus?: (info: {
		sessionId: string;
		runtime: RuntimeType;
		status: SessionStatus;
	}) => void;
	/** Public local relay URL advertised to mobile clients (for endpoint hints) */
	advertisedRelayUrl?: string;
	/** Remote hosted relay URL (outbound uplink mode) */
	remoteRelayUrl?: string;
	/** Additional hosted endpoint URL hint to advertise */
	hostedEndpointUrl?: string;
	/** Optional path to machine-readable status JSON */
	statusFilePath?: string;
	/** Repository path for uplink */
	repoPath?: string;
	/** Runtime types to enable in uplink */
	runtimes?: RuntimeType[];
	/** Override path for trusted pairings store */
	pairingStorePath?: string;
}

export interface ServerHandle {
	/** Canonical onboarding token (6-digit numeric PIN) */
	pin: string;
	/** Back-compat alias for older consumers */
	pairingCode: string;
	/** Stable device ID used by the uplink bridge */
	uplinkDeviceId: string;
	/** @deprecated alias of uplinkDeviceId for back-compat */
	uplinkPublicKey: string;
	/** WebSocket URL for clients */
	url: string;
	/** Stop the server */
	stop: () => Promise<void>;
	/** Get current relay stats */
	getStats: () => Promise<RelayStats>;
	/** Manually refresh PIN (re-register with relay) */
	regeneratePIN: () => Promise<void>;
	/** Start a new runtime session from the terminal */
	startSession: (runtime: RuntimeType, prompt: string) => Promise<{ sessionId: string }>;
	/** List trusted mobile devices for the current uplink */
	listTrustedDevices: () => Promise<TrustedPairingRecord[]>;
	/** Revoke one trusted mobile device for the current uplink */
	revokeTrustedDevice: (mobileDeviceId: string) => Promise<boolean>;
	/** Revoke all trusted mobile devices for the current uplink */
	revokeAllTrustedDevices: () => Promise<number>;
}

interface RelayStats {
	rooms: number;
	connections: number;
	version: string;
}

/**
 * Start a combined relay + uplink server with PIN-based pairing
 *
 * This creates a single-process server that:
 * 1. Runs a relay server for mobile-uplink communication (port)
 * 2. Runs an uplink server for code execution (port + 1)
 * 3. Manages PIN lifecycle with auto-regeneration
 * 4. Provides rate limiting for pairing attempts
 *
 * CURRENT LIMITATIONS:
 * - Uplink doesn't automatically register with relay (manual connection needed)
 * - PIN validation not fully integrated (relay uses its own pairing codes)
 * - Connection callbacks not yet implemented
 *
 * USAGE:
 * ```typescript
 * const server = await startServer({
 *   port: 8080,
 *   onPINRegenerate: (pin) => console.log(`New PIN: ${pin}`),
 *   onClientConnected: () => console.log('Client connected!'),
 * });
 *
 * // Use `server.pin` for UI/QR display. Avoid printing it to stdout logs.
 * console.log(`Mobile connects to: ${server.url}`);
 *
 * // Later...
 * await server.stop();
 * ```
 *
 * @param config - Server configuration
 * @returns Server handle for control and monitoring
 */
export function resolveEncryptionMode(raw: string | undefined): "off" | "opportunistic" {
	const value = raw ?? "off";
	if (value === "required") {
		console.warn(
			'[Server] CODEMOTE_ENCRYPTION="required" is not yet implemented, using "opportunistic"',
		);
		return "opportunistic";
	}
	if (value === "off" || value === "opportunistic") {
		return value;
	}
	console.warn(`[Server] Invalid CODEMOTE_ENCRYPTION "${value}", falling back to "off"`);
	return "off";
}

export function parseKeyRotationInterval(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		console.warn(`[Server] Invalid CODEMOTE_KEY_ROTATION_INTERVAL_MS: "${raw}", ignoring`);
		return undefined;
	}
	if (parsed < 0) {
		console.warn(
			`[Server] Negative CODEMOTE_KEY_ROTATION_INTERVAL_MS: ${parsed}, treating as disabled`,
		);
		return 0;
	}
	return parsed;
}

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
	const {
		port,
		onPINRegenerate,
		onClientConnected,
		onSessionStatus,
		advertisedRelayUrl,
		remoteRelayUrl,
		hostedEndpointUrl,
		statusFilePath,
		repoPath,
		runtimes,
		pairingStorePath,
	} = config;
	const remoteRelayTarget = normalizeRelayWsUrl(remoteRelayUrl);
	const hostedEndpointTarget = normalizeRelayWsUrl(hostedEndpointUrl);
	const remoteRelayProvided = Boolean(remoteRelayUrl?.trim());
	const hostedEndpointProvided = Boolean(hostedEndpointUrl?.trim());
	if (remoteRelayProvided && !remoteRelayTarget) {
		throw new Error(
			`[Server] Invalid remote relay URL "${remoteRelayUrl}". Expected ws:// or wss://`,
		);
	}
	if (hostedEndpointProvided && !hostedEndpointTarget) {
		throw new Error(
			`[Server] Invalid hosted endpoint URL "${hostedEndpointUrl}". Expected ws:// or wss://`,
		);
	}
	const localRelayEnabled = !remoteRelayTarget;

	const tlsDisableRequested =
		process.env["GUILD_REMOTE_DISABLE_TLS"] === "1" ||
		process.env["GUILD_REMOTE_DISABLE_TLS"] === "true";
	const allowInsecure =
		process.env["GUILD_REMOTE_ALLOW_INSECURE"] === "1" ||
		process.env["GUILD_REMOTE_ALLOW_INSECURE"] === "true";
	const tlsDisabled =
		tlsDisableRequested && allowInsecure && process.env["NODE_ENV"] !== "production";
	if (tlsDisableRequested && !tlsDisabled) {
		console.warn(
			"[Server] Refusing to disable TLS without GUILD_REMOTE_ALLOW_INSECURE=1 and NODE_ENV!=production",
		);
	}
	const wsScheme = tlsDisabled ? "ws" : "wss";

	// Canonical pairing token is issued by the relay on register.
	let currentPIN = "";
	const tlsInfo = localRelayEnabled && !tlsDisabled ? await ensureLocalTLS() : undefined;
	const relayCertPem = tlsInfo ? await readFile(tlsInfo.certPath) : undefined;
	let relayTlsPin = tlsInfo?.tlsPin;
	if (!localRelayEnabled && remoteRelayTarget?.startsWith("wss://")) {
		try {
			relayTlsPin = await fetchRelayTlsPin(remoteRelayTarget);
		} catch (error) {
			console.warn(
				`[Server] Unable to derive hosted relay TLS pin: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	if (tlsInfo) {
		const daysRemaining = Math.floor((tlsInfo.certValidToMs - Date.now()) / (24 * 60 * 60 * 1000));
		if (tlsInfo.status === "regenerated") {
			console.warn(
				`[Server] TLS certificate regenerated (${tlsInfo.regenerateReason ?? "unknown"}); re-pair iOS (Forget Server)`,
			);
		} else if (tlsInfo.status === "generated") {
			console.log("[Server] TLS certificate created; scan QR to pair");
		} else if (daysRemaining <= 30) {
			console.warn(
				`[Server] TLS certificate expires in ${daysRemaining} day(s); when it rotates you'll need to re-pair`,
			);
		}
	}

	let relay: Awaited<ReturnType<typeof createRelayServer>> | null = null;

	if (localRelayEnabled) {
		const relayConfig: Partial<RelayServerConfig> = {
			port,
			host: "0.0.0.0",
			...(pairingStorePath ? { pairingStorePath } : {}),
			...(tlsInfo ? { tls: { keyPath: tlsInfo.keyPath, certPath: tlsInfo.certPath } } : {}),
		};

		relay = await createRelayServer(relayConfig);
		await relay.start();
		console.log(`[Server] Relay started on port ${port}`);
	} else {
		console.log(`[Server] Remote relay mode enabled: ${remoteRelayTarget}`);
	}

	// Start the uplink server on next port
	const uplinkConfig: Partial<UplinkConfig> = {
		port: port + 1,
		host: "127.0.0.1",
		repoPath: repoPath || process.cwd(),
	};
	if (runtimes) {
		uplinkConfig.runtimes = runtimes;
	}

	const uplink = new UplinkServer(uplinkConfig);
	await uplink.start();

	console.log(`[Server] Uplink started on port ${port + 1}`);

	const statusState: {
		running: boolean;
		mode: "local" | "remote";
		startedAt: string;
		pin: string;
		uplinkDeviceId?: string;
		relayUrl?: string;
		tlsPin?: string;
		mobileConnected: boolean;
		lastSession?: {
			sessionId: string;
			runtime: RuntimeType;
			status: SessionStatus;
			updatedAt: string;
		};
		stoppedAt?: string;
		availableRuntimes?: string[];
		modelCounts?: Record<string, number>;
		cacheRefreshedAt?: string;
	} = {
		running: true,
		mode: localRelayEnabled ? "local" : "remote",
		startedAt: new Date().toISOString(),
		pin: "",
		...(relayTlsPin ? { tlsPin: relayTlsPin } : {}),
		mobileConnected: false,
	};

	const writeStatus = async (patch: Partial<typeof statusState>): Promise<void> => {
		Object.assign(statusState, patch);
		if (!statusFilePath) {
			return;
		}
		await mkdir(dirname(statusFilePath), { recursive: true });
		await writeFile(statusFilePath, `${JSON.stringify(statusState, null, 2)}\n`, "utf8");
	};
	const writeStatusSafely = (patch: Partial<typeof statusState>, context: string): void => {
		void writeStatus(patch).catch((error) => {
			console.warn(
				`[Server] Failed to write status snapshot (${context}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
	};

	// Write initial cache state from uplink probe results
	const initialCache = uplink.getCacheSnapshot();
	writeStatusSafely(
		{
			availableRuntimes: initialCache.availableRuntimes,
			modelCounts: initialCache.modelCounts,
			cacheRefreshedAt: initialCache.refreshedAt,
		},
		"initial_cache",
	);

	// Watch for signal file to trigger cache refresh from external processes
	const refreshSignalPath = statusFilePath
		? join(dirname(statusFilePath), "refresh-requested")
		: null;
	const REFRESH_POLL_MS = 1000;

	if (refreshSignalPath) {
		// If the server previously crashed before deleting the signal file,
		// this triggers an immediate refresh on restart -- intentional behavior
		// to ensure stale cache state doesn't persist across restarts.
		watchFile(refreshSignalPath, { interval: REFRESH_POLL_MS }, async (curr) => {
			if (curr.size > 0 || curr.mtimeMs > 0) {
				console.log("[Server] Cache refresh requested via signal file");
				try {
					await uplink.refreshCaches();
					const snap = uplink.getCacheSnapshot();
					writeStatusSafely(
						{
							availableRuntimes: snap.availableRuntimes,
							modelCounts: snap.modelCounts,
							cacheRefreshedAt: snap.refreshedAt,
						},
						"cache_refresh",
					);
				} catch (err) {
					console.warn("[Server] Cache refresh failed:", err);
				}
				await unlink(refreshSignalPath).catch(() => {});
			}
		});
	}

	// Connect an uplink "device" to the relay and bridge messages to the uplink server
	const bridgeRelayUrl = remoteRelayTarget ?? `${wsScheme}://127.0.0.1:${port}`;
	const bridgeHostedEndpointUrl = remoteRelayTarget ?? hostedEndpointTarget;
	const statusRelayUrl = localRelayEnabled
		? (advertisedRelayUrl ?? bridgeRelayUrl)
		: bridgeRelayUrl;
	const encryptionMode = resolveEncryptionMode(process.env["CODEMOTE_ENCRYPTION"]);
	const keyRotationIntervalMs = parseKeyRotationInterval(
		process.env["CODEMOTE_KEY_ROTATION_INTERVAL_MS"],
	);
	const bridge = await startRelayUplinkBridge({
		relayUrl: bridgeRelayUrl,
		...(localRelayEnabled && relayCertPem ? { relayWsOptions: { ca: relayCertPem } } : {}),
		uplinkUrl: `ws://127.0.0.1:${port + 1}`,
		repoPath: uplinkConfig.repoPath ?? process.cwd(),
		...(advertisedRelayUrl ? { localEndpointUrl: advertisedRelayUrl } : {}),
		...(bridgeHostedEndpointUrl ? { hostedEndpointUrl: bridgeHostedEndpointUrl } : {}),
		...(process.env["GUILD_REMOTE_DEBUG"] ? { log: (message) => console.log(message) } : {}),
		encryptionMode,
		...(keyRotationIntervalMs !== undefined ? { keyRotationIntervalMs } : {}),
		onPairingCode: (pin) => {
			currentPIN = pin;
			writeStatusSafely(
				{
					pin,
					relayUrl: statusRelayUrl,
					...(relayTlsPin ? { tlsPin: relayTlsPin } : {}),
				},
				"pairing_code",
			);
			onPINRegenerate?.(pin);
		},
		onMobilePaired: () => {
			writeStatusSafely({ mobileConnected: true }, "mobile_paired");
			onClientConnected?.();
		},
		onMobileDisconnected: () => {
			writeStatusSafely({ mobileConnected: false }, "mobile_disconnected");
		},
		onSessionStatus: (info) => {
			writeStatusSafely(
				{
					lastSession: { ...info, updatedAt: new Date().toISOString() },
				},
				"session_status",
			);
			onSessionStatus?.(info);
		},
	});

	currentPIN = bridge.pairingCode;
	await writeStatus({
		pin: currentPIN,
		uplinkDeviceId: bridge.uplinkDeviceId,
		relayUrl: statusRelayUrl,
		...(relayTlsPin ? { tlsPin: relayTlsPin } : {}),
	});

	const fetchLocalRelayStats = async (): Promise<{
		rooms: number;
		connections: number;
		version: string;
	}> =>
		new Promise((resolve, reject) => {
			const request = (tlsDisabled ? http : https).request(
				{
					method: "GET",
					host: "localhost",
					port,
					path: "/health",
					...(relayCertPem ? { ca: relayCertPem, servername: "localhost" } : {}),
				},
				(res) => {
					if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`Health check failed: ${res.statusCode ?? "unknown"}`));
						return;
					}

					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => {
						try {
							const parsed = JSON.parse(body) as {
								rooms: number;
								connections: number;
								version: string;
							};
							resolve(parsed);
						} catch (err) {
							reject(err instanceof Error ? err : new Error(String(err)));
						}
					});
				},
			);
			request.on("error", (err) => reject(err));
			request.end();
		});

	const mobileConnectionPoll =
		localRelayEnabled && statusFilePath
			? setInterval(() => {
					void fetchLocalRelayStats()
						.then((stats) => {
							const mobileConnected = stats.connections > 1;
							if (statusState.mobileConnected !== mobileConnected) {
								writeStatusSafely({ mobileConnected }, "mobile_connection_poll");
							}
						})
						.catch(() => {
							// Ignore transient local relay health failures.
						});
				}, 1000)
			: null;
	mobileConnectionPoll?.unref?.();

	console.log("[Server] Pairing PIN ready (redacted)");

	return {
		get pin() {
			return currentPIN;
		},

		get pairingCode() {
			return currentPIN;
		},

		uplinkDeviceId: bridge.uplinkDeviceId,
		uplinkPublicKey: bridge.uplinkPublicKey,

		url: localRelayEnabled ? `${wsScheme}://localhost:${port}` : bridgeRelayUrl,

		async stop() {
			console.log("[Server] Stopping servers...");
			if (refreshSignalPath) {
				unwatchFile(refreshSignalPath);
			}
			if (mobileConnectionPoll) {
				clearInterval(mobileConnectionPoll);
			}
			await bridge.stop();
			await Promise.all([relay?.stop(), uplink.stop()]);
			await writeStatus({ running: false, stoppedAt: new Date().toISOString() });
			console.log("[Server] Stopped");
		},

		async getStats(): Promise<RelayStats> {
			if (!localRelayEnabled || !relay) {
				return {
					rooms: 0,
					connections: 0,
					version: "remote-relay",
				};
			}

			try {
				const data = await fetchLocalRelayStats();
				return {
					rooms: data.rooms,
					connections: data.connections,
					version: data.version,
				};
			} catch (error) {
				throw new Error(
					`Failed to get relay stats: ${error instanceof Error ? error.message : "unknown error"}`,
				);
			}
		},

		async regeneratePIN() {
			currentPIN = await bridge.refreshPairingCode();
		},

		async startSession(runtime: RuntimeType, prompt: string) {
			return bridge.startSession(runtime, prompt);
		},

		async listTrustedDevices() {
			if (!relay) {
				return [];
			}
			return relay.listTrustedDevices(bridge.uplinkDeviceId);
		},

		async revokeTrustedDevice(mobileDeviceId: string) {
			if (!relay) {
				return false;
			}
			return relay.revokeTrustedDevice(bridge.uplinkDeviceId, mobileDeviceId);
		},

		async revokeAllTrustedDevices() {
			if (!relay) {
				return 0;
			}
			return relay.revokeAllTrustedDevices(bridge.uplinkDeviceId);
		},
	};
}
function normalizeRelayWsUrl(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}

	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return null;
	}

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}
