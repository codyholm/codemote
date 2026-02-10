import { readFileSync } from "node:fs";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createDatabase } from "./db/schema.js";
import { RELAY_VERSION } from "./index.js";
import { registerWebSocketRoutes } from "./routes/ws.js";
import { PairingCodeService } from "./services/codes.js";
import { RoomManager } from "./services/rooms.js";

export interface RelayServerTLSConfig {
	key?: string | Buffer;
	cert?: string | Buffer;
	keyPath?: string;
	certPath?: string;
}

/**
 * Configuration for the relay server
 */
export interface RelayServerConfig {
	/** Port to listen on (default: 8080) */
	port: number;
	/** Host to bind to (default: 0.0.0.0) */
	host: string;
	/** Path to SQLite database file (default: relay.db in cwd) */
	dbPath?: string;
	/** Optional TLS config (enables HTTPS/WSS) */
	tls?: RelayServerTLSConfig;
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
	const db = createDatabase(cfg.dbPath);
	const codes = new PairingCodeService(db);
	const rooms = new RoomManager();

	// Health check endpoint
	app.get("/health", async () => {
		const stats = rooms.stats();
		return {
			status: "ok",
			version: RELAY_VERSION,
			rooms: stats.rooms,
			connections: stats.connections,
		};
	});

	// Register WebSocket routes
	registerWebSocketRoutes(app, rooms, codes);

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
		db.close();
	});

	return {
		app,
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
