/**
 * Server Integration - Bundles relay + uplink in one process
 *
 * Combines the relay server and uplink service into a single process
 * with PIN-based pairing that integrates rate limiting and validation.
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
 * CURRENT STATUS:
 * - ✅ Both servers start successfully
 * - ✅ PIN management and rate limiting implemented
 * - ⚠️ PIN validation not yet integrated into relay (needs relay changes)
 * - ⚠️ Uplink doesn't auto-connect to relay (needs connection logic)
 *
 * NEEDED RELAY CHANGES:
 * 1. Accept `pin` field in pair messages (in addition to `pairingCode`)
 * 2. Support custom validation function in RelayServerConfig
 * 3. Expose RoomManager events for connection callbacks
 */

import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { type RelayServerConfig, createRelayServer } from "@codemote/relay";
import { type RuntimeType, type UplinkConfig, UplinkServer } from "@codemote/uplink";
import { startRelayUplinkBridge } from "./bridge.js";
import { ensureLocalTLS } from "./tls.js";

export interface ServerConfig {
	/** Port for the relay server */
	port: number;
	/** Callback when PIN is regenerated */
	onPINRegenerate?: (pin: string) => void;
	/** Callback when a client successfully connects */
	onClientConnected?: () => void;
	/** Path to SQLite database (optional) */
	dbPath?: string;
	/** Repository path for uplink */
	repoPath?: string;
	/** Runtime types to enable in uplink */
	runtimes?: RuntimeType[];
}

export interface ServerHandle {
	/** Canonical onboarding token (6-digit numeric PIN) */
	pin: string;
	/** Back-compat alias for older consumers */
	pairingCode: string;
	/** Public key used by the uplink bridge */
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
export async function startServer(config: ServerConfig): Promise<ServerHandle> {
	const { port, onPINRegenerate, onClientConnected, dbPath, repoPath, runtimes } = config;

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
	const tlsInfo = tlsDisabled ? undefined : await ensureLocalTLS();
	const relayCertPem = tlsInfo ? await readFile(tlsInfo.certPath) : undefined;
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

	// Start the relay server
	const relayConfig: Partial<RelayServerConfig> = {
		port,
		host: "0.0.0.0",
		...(dbPath ? { dbPath } : {}),
		...(tlsInfo ? { tls: { keyPath: tlsInfo.keyPath, certPath: tlsInfo.certPath } } : {}),
	};

	const relay = await createRelayServer(relayConfig);
	await relay.start();

	console.log(`[Server] Relay started on port ${port}`);

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

	// Connect an uplink "device" to the relay and bridge messages to the uplink server
	const bridge = await startRelayUplinkBridge({
		relayUrl: `${wsScheme}://127.0.0.1:${port}`,
		...(relayCertPem ? { relayWsOptions: { ca: relayCertPem } } : {}),
		uplinkUrl: `ws://127.0.0.1:${port + 1}`,
		repoPath: uplinkConfig.repoPath ?? process.cwd(),
		...(process.env["GUILD_REMOTE_DEBUG"] ? { log: (message) => console.log(message) } : {}),
		onPairingCode: (pin) => {
			currentPIN = pin;
			onPINRegenerate?.(pin);
		},
		onMobilePaired: () => onClientConnected?.(),
	});

	currentPIN = bridge.pairingCode;

	console.log("[Server] Pairing PIN ready (redacted)");

	return {
		get pin() {
			return currentPIN;
		},

		get pairingCode() {
			return currentPIN;
		},

		uplinkPublicKey: bridge.uplinkPublicKey,

		url: `${wsScheme}://localhost:${port}`,

		async stop() {
			console.log("[Server] Stopping servers...");
			await bridge.stop();
			await Promise.all([relay.stop(), uplink.stop()]);
			console.log("[Server] Stopped");
		},

		async getStats(): Promise<RelayStats> {
			try {
				const data = await new Promise<{
					rooms: number;
					connections: number;
					version: string;
				}>((resolve, reject) => {
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
	};
}
