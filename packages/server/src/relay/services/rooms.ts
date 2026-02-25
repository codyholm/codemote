import type { WebSocket } from "ws";

const DEBUG =
	process.env["GUILD_REMOTE_DEBUG"] === "1" || process.env["GUILD_REMOTE_DEBUG"] === "true";

function logDebug(message: string): void {
	if (DEBUG) {
		console.log(message);
	}
}

/**
 * A member of a WebSocket room (either mobile or uplink device)
 */
export interface RoomMember {
	ws: WebSocket;
	deviceId: string;
	type: "mobile" | "uplink";
}

/**
 * Manages WebSocket rooms for paired devices.
 *
 * Rooms are identified by the uplink device ID. When a mobile pairs with an uplink,
 * it joins the uplink's room and messages are forwarded to other members in that room.
 */
export class RoomManager {
	// roomId -> members (keyed by deviceId)
	private readonly rooms = new Map<string, Map<string, RoomMember>>();
	// deviceId -> roomId (for quick lookup)
	private readonly deviceToRoom = new Map<string, string>();

	/**
	 * Create or join a room.
	 */
	join(roomId: string, member: RoomMember): void {
		const existingRoomId = this.deviceToRoom.get(member.deviceId);
		if (existingRoomId && existingRoomId !== roomId) {
			this.leave(member.deviceId);
		}

		let room = this.rooms.get(roomId);
		if (!room) {
			room = new Map();
			this.rooms.set(roomId, room);
		}

		const existingMember = room.get(member.deviceId);
		if (existingMember && existingMember.ws !== member.ws) {
			// Replace stale sockets on reconnect so one device ID maps to one live channel.
			try {
				existingMember.ws.close(1000, "Superseded by newer connection");
			} catch {
				// Ignore close failures and continue replacing membership.
			}
		}

		room.set(member.deviceId, member);
		this.deviceToRoom.set(member.deviceId, roomId);
		logDebug(
			`[Room ${roomId.slice(0, 8)}...] ${member.type} joined (${member.deviceId.slice(0, 8)}...)`,
		);
	}

	/**
	 * Remove a member from their room and delete the room if it becomes empty.
	 */
	leave(deviceId: string, expectedSocket?: WebSocket): void {
		const roomId = this.deviceToRoom.get(deviceId);
		if (!roomId) return;

		const room = this.rooms.get(roomId);
		if (room) {
			const currentMember = room.get(deviceId);
			if (expectedSocket && currentMember && currentMember.ws !== expectedSocket) {
				// A newer socket already replaced this device entry; ignore stale close callbacks.
				return;
			}

			room.delete(deviceId);
			if (room.size === 0) {
				this.rooms.delete(roomId);
			}
		}

		this.deviceToRoom.delete(deviceId);
		logDebug(`[Room ${roomId.slice(0, 8)}...] Member left (${deviceId.slice(0, 8)}...)`);
	}

	/**
	 * Get the room ID for a device ID.
	 */
	getRoomId(deviceId: string): string | undefined {
		return this.deviceToRoom.get(deviceId);
	}

	/**
	 * Get all members in a room.
	 */
	getMembers(roomId: string): RoomMember[] {
		const room = this.rooms.get(roomId);
		return room ? Array.from(room.values()) : [];
	}

	/**
	 * Forward a message to all other room members.
	 */
	broadcast(senderDeviceId: string, message: string): void {
		const roomId = this.deviceToRoom.get(senderDeviceId);
		if (!roomId) {
			logDebug(`[Broadcast] No room for sender ${senderDeviceId.slice(0, 8)}...`);
			return;
		}

		const room = this.rooms.get(roomId);
		if (!room) {
			logDebug(`[Broadcast] Room ${roomId.slice(0, 8)}... not found`);
			return;
		}

		for (const [deviceId, member] of room) {
			// Don't send back to sender, and only send to open connections
			if (deviceId !== senderDeviceId && member.ws.readyState === 1) {
				logDebug(
					`[Broadcast] Sending to ${member.type} (${deviceId.slice(0, 8)}...) readyState=${member.ws.readyState}`,
				);
				member.ws.send(message);
			}
		}
	}

	/**
	 * Get room statistics.
	 */
	stats(): { rooms: number; connections: number } {
		let connections = 0;
		for (const room of this.rooms.values()) {
			connections += room.size;
		}
		return { rooms: this.rooms.size, connections };
	}
}
