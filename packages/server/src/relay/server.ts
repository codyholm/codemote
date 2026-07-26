import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { RELAY_VERSION } from "./index.js";
import { registerWebSocketRoutes } from "./routes/ws.js";
import { PairingCodeService } from "./services/codes.js";
import { RoomManager, type RoomStats } from "./services/rooms.js";
import { type TrustedPairingRecord, TrustedPairingsStore } from "./services/trusted-pairings.js";

export interface RelayServerTLSConfig {
	key?: string | Buffer;
	cert?: string | Buffer;
	keyPath?: string;
	certPath?: string;
}

/**
 * Configuration for the relay server
 */
/** Relay stats with the relay version attached, as reported by the server handle. */
export interface RelayStatsSnapshot extends RoomStats {
	version: string;
}

export interface RelayServerConfig {
	/** Port to listen on (default: 8080) */
	port: number;
	/** Host to bind to (default: 0.0.0.0) */
	host: string;
	/** Path to trusted pairings store JSON file */
	pairingStorePath?: string;
	/** Optional TLS config (enables HTTPS/WSS) */
	tls?: RelayServerTLSConfig;
	/**
	 * Called whenever room membership changes, with the resulting stats.
	 * Lets callers track connection state from events instead of polling.
	 */
	onConnectionsChanged?: (stats: RoomStats) => void;
}

const DEFAULT_CONFIG: RelayServerConfig = {
	port: 8080,
	host: "0.0.0.0",
};

/**
 * Create a relay server instance
 *
 * @param config - Server configuration options
 * @returns Server instance with start/stop methods
 */
export async function createRelayServer(config: Partial<RelayServerConfig> = {}) {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	let https: { key: string | Buffer; cert: string | Buffer } | undefined;
	if (cfg.tls) {
		const key = cfg.tls.key ?? (cfg.tls.keyPath ? readFileSync(cfg.tls.keyPath) : undefined);
		const cert = cfg.tls.cert ?? (cfg.tls.certPath ? readFileSync(cfg.tls.certPath) : undefined);
		if (!key || !cert) {
			throw new Error(
				"TLS is configured but key/cert are missing. Provide tls.key+tls.cert or tls.keyPath+tls.certPath.",
			);
		}
		https = { key, cert };
	}

	const app = Fastify({
		logger: true,
		...(https ? { https } : {}),
	});

	// Register plugins
	// Limit individual websocket message size to reduce memory/CPU DoS.
	await app.register(websocket, {
		options: {
			maxPayload: 256 * 1024,
		},
	});

	// Minimal hardening for the small HTTP surface.
	app.addHook("onSend", async (_req, reply, payload) => {
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("X-Frame-Options", "DENY");
		reply.header("Referrer-Policy", "no-referrer");
		return payload;
	});

	// Initialize services
	const codes = new PairingCodeService();
	const rooms = new RoomManager(
		cfg.onConnectionsChanged ? { onChange: cfg.onConnectionsChanged } : {},
	);
	const trustedPairingsEnabled = !["0", "false"].includes(
		(process.env["CODEMOTE_TRUSTED_PAIRINGS"] ?? "").toLowerCase(),
	);
	const pairingStorePath =
		cfg.pairingStorePath ??
		process.env["CODEMOTE_PAIRING_STORE_PATH"] ??
		join(homedir(), ".codemote", "trusted-pairings.json");
	const trustedPairings = new TrustedPairingsStore({
		filePath: pairingStorePath,
		enabled: trustedPairingsEnabled,
		log: (message) => app.log.warn(message),
	});
	if (trustedPairingsEnabled) {
		app.log.info(
			`[relay] trusted-pair-store path=${pairingStorePath} loaded_records=${trustedPairings.recordCount()}`,
		);
	} else {
		app.log.info("[relay] trusted-pair-store disabled");
	}

	// Health check endpoint.
	// logLevel: "silent" keeps liveness probes out of the request log — they are
	// high-frequency and low-information, and logging them buries real events.
	app.get("/health", { logLevel: "silent" }, async () => {
		const stats = rooms.stats();
		return {
			status: "ok",
			version: RELAY_VERSION,
			rooms: stats.rooms,
			connections: stats.connections,
		};
	});

	// Register WebSocket routes
	registerWebSocketRoutes(app, rooms, codes, { trustedPairings });

	// Cleanup interval for expired pairing codes (every 60 seconds)
	const cleanupInterval = setInterval(() => {
		const removed = codes.cleanup();
		if (removed > 0) {
			app.log.info(`Cleaned up ${removed} expired pairing codes`);
		}
	}, 60000);

	// Lifecycle hooks
	app.addHook("onClose", () => {
		clearInterval(cleanupInterval);
	});

	return {
		app,
		/** Current room/connection counts plus relay version, read in-process. */
		stats: (): RelayStatsSnapshot => ({ ...rooms.stats(), version: RELAY_VERSION }),
		listTrustedDevices: (uplinkDeviceId: string): TrustedPairingRecord[] =>
			trustedPairings.listForUplink(uplinkDeviceId),
		revokeTrustedDevice: (uplinkDeviceId: string, mobileDeviceId: string): boolean =>
			trustedPairings.revoke(uplinkDeviceId, mobileDeviceId),
		revokeAllTrustedDevices: (uplinkDeviceId: string): number =>
			trustedPairings.revokeAllForUplink(uplinkDeviceId),
		/**
		 * Start the server
		 */
		start: async () => {
			await app.listen({ port: cfg.port, host: cfg.host });
			app.log.info(`Relay server listening on ${cfg.host}:${cfg.port}`);
		},
		/**
		 * Stop the server gracefully
		 */
		stop: async () => {
			await app.close();
		},
	};
}
