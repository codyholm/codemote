/**
 * Tests for server integration
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
