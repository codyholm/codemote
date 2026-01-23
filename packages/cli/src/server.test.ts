/**
 * Tests for server integration
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type ServerHandle, startServer } from "./server.js";

describe("Server Integration", () => {
	let server: ServerHandle | null = null;
	const testPort = 18080; // Use high port to avoid conflicts

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
	});

	describe("startServer", () => {
		it("should start both relay and uplink servers", async () => {
			server = await startServer({
				port: testPort,
			});

			expect(server).toBeDefined();
			expect(server.pin).toMatch(/^\d{6}$/);
			expect(server.pairingCode).toMatch(/^\d{6}$/);
			expect(server.uplinkPublicKey).toBeDefined();
			expect(server.url).toBe(`wss://localhost:${testPort}`);
		});

		it("should generate a valid PIN", async () => {
			server = await startServer({
				port: testPort + 10,
			});

			const pin = server.pin;
			expect(pin).toMatch(/^\d{6}$/);
			expect(pin.length).toBe(6);
		});

		it("should call onPINRegenerate callback", async () => {
			const pins: string[] = [];

			server = await startServer({
				port: testPort + 20,
				onPINRegenerate: (pin) => {
					pins.push(pin);
				},
			});

			expect(server.pin).toMatch(/^\d{6}$/);
			expect(pins.length).toBeGreaterThanOrEqual(1);
			expect(pins.at(-1)).toBe(server.pin);
		});

		it("should provide stats endpoint", async () => {
			server = await startServer({
				port: testPort + 30,
			});

			const stats = await server.getStats();

			expect(stats).toBeDefined();
			// The combined server starts an internal uplink bridge connection.
			expect(stats.rooms).toBeGreaterThanOrEqual(1);
			expect(stats.connections).toBeGreaterThanOrEqual(1);
			expect(stats.version).toBeDefined();
		});

		it("should allow manual PIN regeneration", async () => {
			server = await startServer({
				port: testPort + 40,
			});

			const originalPIN = server.pin;
			await server.regeneratePIN();
			const newPIN = server.pin;

			expect(originalPIN).toMatch(/^\d{6}$/);
			expect(newPIN).toMatch(/^\d{6}$/);
		});

		it("does not crash when receiving malformed encrypted payloads", async () => {
			const prevDisable = process.env["GUILD_REMOTE_DISABLE_TLS"];
			const prevAllow = process.env["GUILD_REMOTE_ALLOW_INSECURE"];
			process.env["GUILD_REMOTE_DISABLE_TLS"] = "1";
			process.env["GUILD_REMOTE_ALLOW_INSECURE"] = "1";
			try {
				server = await startServer({ port: testPort + 35 });

				const mobileWs = new WebSocket(`ws://127.0.0.1:${testPort + 35}/ws`);
				await waitForOpen(mobileWs);

				const pairPromise = waitForMessageOfType(mobileWs, "paired");
				mobileWs.send(
					JSON.stringify({
						type: "pair",
						publicKey: "mobile-test-key-456",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await pairPromise;

				// Relay will forward this raw message to the internal bridge.
				mobileWs.send(JSON.stringify({ type: "message", payload: {} }));

				// Server should remain healthy.
				const stats = await server.getStats();
				expect(stats.rooms).toBeGreaterThanOrEqual(1);
				expect(stats.connections).toBeGreaterThanOrEqual(1);

				mobileWs.close();
			} finally {
				process.env["GUILD_REMOTE_DISABLE_TLS"] = prevDisable;
				process.env["GUILD_REMOTE_ALLOW_INSECURE"] = prevAllow;
			}
		});
	});

	describe("server lifecycle", () => {
		it("should stop gracefully", async () => {
			server = await startServer({
				port: testPort + 60,
			});

			await expect(server.stop()).resolves.not.toThrow();
			server = null; // Prevent double cleanup
		});

		it("should handle multiple start/stop cycles", async () => {
			// Start first instance
			server = await startServer({
				port: testPort + 70,
			});
			await server.stop();

			// Start second instance (same port should work after stop)
			server = await startServer({
				port: testPort + 70,
			});
			await server.stop();

			server = null; // Prevent double cleanup
		});
	});

	describe("configuration", () => {
		it("should accept custom repo path", async () => {
			server = await startServer({
				port: testPort + 80,
				repoPath: process.cwd(), // Use valid path
			});

			expect(server).toBeDefined();
		});

		it("should accept custom database path", async () => {
			server = await startServer({
				port: testPort + 90,
				dbPath: ":memory:",
			});

			expect(server).toBeDefined();
		});

		it("should accept runtime configuration", async () => {
			server = await startServer({
				port: testPort + 100,
				runtimes: ["opencode", "claude"],
			});

			expect(server).toBeDefined();
		});
	});
});

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		ws.once("open", resolve);
		ws.once("error", reject);
		setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
	});
}

function waitForMessageOfType(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const handler = (data: WebSocket.RawData) => {
			const msg = JSON.parse(data.toString());
			if (msg.type === type) {
				ws.off("message", handler);
				resolve(msg);
			}
		};
		ws.on("message", handler);
		setTimeout(() => {
			ws.off("message", handler);
			reject(new Error(`WebSocket message timeout waiting for type: ${type}`));
		}, 5000);
	});
}
