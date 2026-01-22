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

import { type RelayServerConfig, createRelayServer } from "@guild-remote/relay";
import { type RuntimeType, type UplinkConfig, UplinkServer } from "@guild-remote/uplink";
import { startRelayUplinkBridge } from "./bridge.js";

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

	// Canonical pairing token is issued by the relay on register.
	let currentPIN = "";

	// Start the relay server
	const relayConfig: Partial<RelayServerConfig> = {
		port,
		host: "0.0.0.0",
		...(dbPath ? { dbPath } : {}),
	};

	const relay = await createRelayServer(relayConfig);
	await relay.start();

	console.log(`[Server] Relay started on port ${port}`);

	// Start the uplink server on next port
	const uplinkConfig: Partial<UplinkConfig> = {
		port: port + 1,
		host: "127.0.0.1",
		repoPath: repoPath || process.cwd(),
		runtimes: (runtimes || []) as RuntimeType[],
	};

	const uplink = new UplinkServer(uplinkConfig);
	await uplink.start();

	console.log(`[Server] Uplink started on port ${port + 1}`);

	// Connect an uplink "device" to the relay and bridge messages to the uplink server
	const bridge = await startRelayUplinkBridge({
		relayUrl: `ws://127.0.0.1:${port}`,
		uplinkUrl: `ws://127.0.0.1:${port + 1}`,
		repoPath: uplinkConfig.repoPath ?? process.cwd(),
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

		url: `ws://localhost:${port}`,

		async stop() {
			console.log("[Server] Stopping servers...");
			await bridge.stop();
			await Promise.all([relay.stop(), uplink.stop()]);
			console.log("[Server] Stopped");
		},

		async getStats(): Promise<RelayStats> {
			try {
				const response = await fetch(`http://localhost:${port}/health`);
				if (!response.ok) {
					throw new Error(`Health check failed: ${response.status}`);
				}
				const data = (await response.json()) as {
					rooms: number;
					connections: number;
					version: string;
				};
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
	};
}
