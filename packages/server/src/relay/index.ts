// Relay server for Codemote

import type { StreamEvent } from "@codemote/common";

export type { StreamEvent };

// Server exports
export { createRelayServer, type RelayServerConfig } from "./server.js";

// Service exports
export { PairingCodeService } from "./services/codes.js";
export { RoomManager } from "./services/rooms.js";
export {
	TrustedPairingsStore,
	type TrustedPairingRecord,
} from "./services/trusted-pairings.js";

/**
 * Generic relay message envelope.
 * Payloads are forwarded as JSON between connected devices.
 */
export interface RelayEnvelope {
	/** Unique message ID */
	id: string;
	/** Sender device identifier */
	senderDeviceId: string;
	/** Forwarded payload */
	payload: unknown;
	/** Timestamp */
	timestamp: number;
}

/**
 * Pairing session between mobile and uplink
 */
export interface PairingSession {
	/** Short pairing code (6 chars) */
	pairingCode: string;
	/** Session expiry */
	expiresAt: number;
	/** Whether pairing is complete */
	paired: boolean;
}

/**
 * Connected client (mobile or uplink)
 */
export interface ConnectedClient {
	/** Client ID */
	id: string;
	/** Client type */
	type: "mobile" | "uplink";
	/** Stable device ID */
	deviceId: string;
	/** Connected at timestamp */
	connectedAt: number;
}

export const RELAY_VERSION = "0.1.0";
