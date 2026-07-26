import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager, type RoomMember } from "./rooms";

// Mock WebSocket - cast to unknown first to avoid strict type checking
const createMockWebSocket = (readyState = 1) =>
	({
		readyState,
		send: vi.fn(),
		close: vi.fn(),
	}) as unknown as WebSocket;

describe("RoomManager", () => {
	let manager: RoomManager;

	beforeEach(() => {
		manager = new RoomManager();
	});

	describe("join", () => {
		it("creates room on first join", () => {
			const ws = createMockWebSocket();
			const member: RoomMember = {
				ws,
				deviceId: "pk_uplink_123",
				type: "uplink",
			};

			manager.join("room-123", member);

			expect(manager.stats().rooms).toBe(1);
			expect(manager.stats().connections).toBe(1);
		});

		it("adds multiple members to the same room", () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();

			const uplink: RoomMember = {
				ws: ws1,
				deviceId: "pk_uplink_123",
				type: "uplink",
			};
			const mobile: RoomMember = {
				ws: ws2,
				deviceId: "pk_mobile_456",
				type: "mobile",
			};

			manager.join("room-123", uplink);
			manager.join("room-123", mobile);

			expect(manager.stats().rooms).toBe(1);
			expect(manager.stats().connections).toBe(2);
			expect(manager.getMembers("room-123")).toHaveLength(2);
		});

		it("creates separate rooms for different room IDs", () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();

			manager.join("room-1", { ws: ws1, deviceId: "pk_1", type: "uplink" });
			manager.join("room-2", { ws: ws2, deviceId: "pk_2", type: "uplink" });

			expect(manager.stats().rooms).toBe(2);
			expect(manager.stats().connections).toBe(2);
		});

		it("tracks room ID for each public key", () => {
			const ws = createMockWebSocket();
			const member: RoomMember = {
				ws,
				deviceId: "pk_test_123",
				type: "uplink",
			};

			manager.join("room-abc", member);

			expect(manager.getRoomId("pk_test_123")).toBe("room-abc");
		});

		it("replaces an existing device socket and closes the stale connection", () => {
			const oldSocket = createMockWebSocket();
			const newSocket = createMockWebSocket();

			manager.join("room-123", { ws: oldSocket, deviceId: "pk_mobile_1", type: "mobile" });
			manager.join("room-123", { ws: newSocket, deviceId: "pk_mobile_1", type: "mobile" });

			const members = manager.getMembers("room-123");
			expect(members).toHaveLength(1);
			expect(members[0]?.ws).toBe(newSocket);
			expect(
				(oldSocket as unknown as { close: ReturnType<typeof vi.fn> }).close,
			).toHaveBeenCalled();
		});
	});

	describe("broadcast", () => {
		it("broadcasts to other members, not the sender", () => {
			const wsUplink = createMockWebSocket();
			const wsMobile = createMockWebSocket();

			const uplink: RoomMember = {
				ws: wsUplink,
				deviceId: "pk_uplink_123",
				type: "uplink",
			};
			const mobile: RoomMember = {
				ws: wsMobile,
				deviceId: "pk_mobile_456",
				type: "mobile",
			};

			manager.join("room-123", uplink);
			manager.join("room-123", mobile);

			// Broadcast from uplink
			manager.broadcast("pk_uplink_123", "encrypted-message");

			// Sender should NOT receive the message
			expect(
				(wsUplink as unknown as { send: ReturnType<typeof vi.fn> }).send,
			).not.toHaveBeenCalled();
			// Other members should receive the message
			expect((wsMobile as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
				"encrypted-message",
			);
		});

		it("does not send to closed connections", () => {
			const wsOpen = createMockWebSocket(1); // OPEN
			const wsClosed = createMockWebSocket(3); // CLOSED

			manager.join("room-123", { ws: wsOpen, deviceId: "pk_sender", type: "uplink" });
			manager.join("room-123", { ws: wsClosed, deviceId: "pk_receiver_closed", type: "mobile" });

			manager.broadcast("pk_sender", "test-message");

			expect(
				(wsClosed as unknown as { send: ReturnType<typeof vi.fn> }).send,
			).not.toHaveBeenCalled();
		});

		it("broadcasts to multiple recipients", () => {
			const wsSender = createMockWebSocket();
			const wsReceiver1 = createMockWebSocket();
			const wsReceiver2 = createMockWebSocket();

			manager.join("room-123", { ws: wsSender, deviceId: "pk_sender", type: "uplink" });
			manager.join("room-123", { ws: wsReceiver1, deviceId: "pk_receiver1", type: "mobile" });
			manager.join("room-123", { ws: wsReceiver2, deviceId: "pk_receiver2", type: "mobile" });

			manager.broadcast("pk_sender", "broadcast-message");

			expect(
				(wsSender as unknown as { send: ReturnType<typeof vi.fn> }).send,
			).not.toHaveBeenCalled();
			expect(
				(wsReceiver1 as unknown as { send: ReturnType<typeof vi.fn> }).send,
			).toHaveBeenCalledWith("broadcast-message");
			expect(
				(wsReceiver2 as unknown as { send: ReturnType<typeof vi.fn> }).send,
			).toHaveBeenCalledWith("broadcast-message");
		});

		it("does nothing for unknown sender", () => {
			manager.broadcast("unknown_key", "message");
			// Should not throw
			expect(manager.stats().rooms).toBe(0);
		});
	});

	describe("leave", () => {
		it("removes member from room", () => {
			const ws = createMockWebSocket();

			manager.join("room-123", { ws, deviceId: "pk_test", type: "uplink" });
			expect(manager.stats().connections).toBe(1);

			manager.leave("pk_test");
			expect(manager.stats().connections).toBe(0);
			expect(manager.getRoomId("pk_test")).toBeUndefined();
		});

		it("removes room when empty", () => {
			const ws = createMockWebSocket();

			manager.join("room-123", { ws, deviceId: "pk_test", type: "uplink" });
			expect(manager.stats().rooms).toBe(1);

			manager.leave("pk_test");
			expect(manager.stats().rooms).toBe(0);
		});

		it("keeps room if other members remain", () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();

			manager.join("room-123", { ws: ws1, deviceId: "pk_member1", type: "uplink" });
			manager.join("room-123", { ws: ws2, deviceId: "pk_member2", type: "mobile" });

			manager.leave("pk_member1");

			expect(manager.stats().rooms).toBe(1);
			expect(manager.stats().connections).toBe(1);
			expect(manager.getMembers("room-123")).toHaveLength(1);
		});

		it("handles leaving non-existent member gracefully", () => {
			manager.leave("nonexistent");
			// Should not throw
			expect(manager.stats().rooms).toBe(0);
		});

		it("ignores stale leave calls when a newer socket already replaced that device", () => {
			const uplink = createMockWebSocket();
			const oldMobileSocket = createMockWebSocket();
			const newMobileSocket = createMockWebSocket();

			manager.join("room-123", { ws: uplink, deviceId: "pk_uplink", type: "uplink" });
			manager.join("room-123", { ws: oldMobileSocket, deviceId: "pk_mobile", type: "mobile" });
			manager.join("room-123", { ws: newMobileSocket, deviceId: "pk_mobile", type: "mobile" });

			manager.leave("pk_mobile", oldMobileSocket);

			expect(manager.getRoomId("pk_mobile")).toBe("room-123");
			expect(manager.getMembers("room-123")).toHaveLength(2);
		});
	});

	describe("stats", () => {
		it("returns correct counts for empty manager", () => {
			const stats = manager.stats();
			expect(stats.rooms).toBe(0);
			expect(stats.connections).toBe(0);
		});

		it("returns correct counts with multiple rooms", () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();
			const ws3 = createMockWebSocket();

			manager.join("room-1", { ws: ws1, deviceId: "pk_1", type: "uplink" });
			manager.join("room-1", { ws: ws2, deviceId: "pk_2", type: "mobile" });
			manager.join("room-2", { ws: ws3, deviceId: "pk_3", type: "uplink" });

			const stats = manager.stats();
			expect(stats.rooms).toBe(2);
			expect(stats.connections).toBe(3);
		});
	});

	describe("getMembers", () => {
		it("returns empty array for non-existent room", () => {
			expect(manager.getMembers("nonexistent")).toEqual([]);
		});

		it("returns all members in a room", () => {
			const ws1 = createMockWebSocket();
			const ws2 = createMockWebSocket();

			manager.join("room-123", { ws: ws1, deviceId: "pk_1", type: "uplink" });
			manager.join("room-123", { ws: ws2, deviceId: "pk_2", type: "mobile" });

			const members = manager.getMembers("room-123");
			expect(members).toHaveLength(2);
			expect(members.map((m) => m.deviceId)).toContain("pk_1");
			expect(members.map((m) => m.deviceId)).toContain("pk_2");
		});
	});

	describe("getRoomId", () => {
		it("returns undefined for unknown public key", () => {
			expect(manager.getRoomId("unknown")).toBeUndefined();
		});

		it("returns room ID for known public key", () => {
			const ws = createMockWebSocket();
			manager.join("room-xyz", { ws, deviceId: "pk_known", type: "uplink" });

			expect(manager.getRoomId("pk_known")).toBe("room-xyz");
		});
	});

	// Callers rely on these notifications to track connection state instead of
	// polling, so a missed or spurious fire shows up as a wrong "mobile connected"
	// indicator that never self-corrects.
	describe("onChange notifications", () => {
		it("fires on join with the resulting stats", () => {
			const onChange = vi.fn();
			const watched = new RoomManager({ onChange });

			watched.join("room-1", { ws: createMockWebSocket(), deviceId: "uplink-1", type: "uplink" });
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenLastCalledWith({ rooms: 1, connections: 1 });

			watched.join("room-1", { ws: createMockWebSocket(), deviceId: "mobile-1", type: "mobile" });
			expect(onChange).toHaveBeenCalledTimes(2);
			expect(onChange).toHaveBeenLastCalledWith({ rooms: 1, connections: 2 });
		});

		it("fires on leave with the resulting stats", () => {
			const onChange = vi.fn();
			const watched = new RoomManager({ onChange });
			watched.join("room-1", { ws: createMockWebSocket(), deviceId: "uplink-1", type: "uplink" });
			watched.join("room-1", { ws: createMockWebSocket(), deviceId: "mobile-1", type: "mobile" });
			onChange.mockClear();

			watched.leave("mobile-1");
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenLastCalledWith({ rooms: 1, connections: 1 });

			// Emptying the room drops it entirely.
			watched.leave("uplink-1");
			expect(onChange).toHaveBeenLastCalledWith({ rooms: 0, connections: 0 });
		});

		it("does not fire when a stale socket's close callback arrives late", () => {
			const onChange = vi.fn();
			const watched = new RoomManager({ onChange });
			const staleWs = createMockWebSocket();
			watched.join("room-1", { ws: staleWs, deviceId: "mobile-1", type: "mobile" });

			// Reconnect replaces the membership with a live socket.
			const liveWs = createMockWebSocket();
			watched.join("room-1", { ws: liveWs, deviceId: "mobile-1", type: "mobile" });
			onChange.mockClear();

			// The old socket's close handler fires afterwards. The device is still
			// connected via liveWs, so this must not report a disconnect.
			watched.leave("mobile-1", staleWs);
			expect(onChange).not.toHaveBeenCalled();
			expect(watched.stats()).toEqual({ rooms: 1, connections: 1 });
		});

		it("does not fire when leaving a device that was never in a room", () => {
			const onChange = vi.fn();
			const watched = new RoomManager({ onChange });

			watched.leave("never-joined");
			expect(onChange).not.toHaveBeenCalled();
		});

		it("keeps room state intact when a listener throws", () => {
			const onChange = vi.fn(() => {
				throw new Error("listener blew up");
			});
			const watched = new RoomManager({ onChange });

			expect(() =>
				watched.join("room-1", {
					ws: createMockWebSocket(),
					deviceId: "uplink-1",
					type: "uplink",
				}),
			).not.toThrow();
			expect(watched.stats()).toEqual({ rooms: 1, connections: 1 });

			expect(() => watched.leave("uplink-1")).not.toThrow();
			expect(watched.stats()).toEqual({ rooms: 0, connections: 0 });
		});
	});
});
