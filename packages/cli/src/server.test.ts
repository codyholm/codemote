/**
 * Tests for server integration
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { type ServerHandle, startServer } from "./server.js";

// Every test here starts a real relay + uplink + bridge: TLS cert work, Fastify
// listening on several interfaces, then a full teardown. Individually they run in
// roughly 2-5s, which sits close enough to vitest's 5000ms default that a loaded
// full-suite run intermittently trips one — and not always the same one. The
// suite-wide timeout reflects what these tests actually do. A retry wrapper was
// considered and rejected: it would also mask a genuine hang.
describe("Server Integration", { timeout: 30000 }, () => {
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
			expect(server.uplinkDeviceId).toBeDefined();
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

		it("lists and revokes trusted devices through server handle", async () => {
			const prevDisable = process.env["GUILD_REMOTE_DISABLE_TLS"];
			const prevAllow = process.env["GUILD_REMOTE_ALLOW_INSECURE"];
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-test-"));
			process.env["GUILD_REMOTE_DISABLE_TLS"] = "1";
			process.env["GUILD_REMOTE_ALLOW_INSECURE"] = "1";
			try {
				server = await startServer({
					port: testPort + 45,
					pairingStorePath: join(fixtureDir, "trusted-pairings.json"),
				});

				const mobileWs = new WebSocket(`ws://127.0.0.1:${testPort + 45}/ws`);
				await waitForOpen(mobileWs);

				const pairPromise = waitForMessageOfType(mobileWs, "paired");
				mobileWs.send(
					JSON.stringify({
						type: "pair",
						deviceId: "mobile-trusted-1",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await pairPromise;

				const trustedBefore = await server.listTrustedDevices();
				expect(trustedBefore.some((record) => record.mobileDeviceId === "mobile-trusted-1")).toBe(
					true,
				);

				const removed = await server.revokeTrustedDevice("mobile-trusted-1");
				expect(removed).toBe(true);

				const trustedAfter = await server.listTrustedDevices();
				expect(trustedAfter.some((record) => record.mobileDeviceId === "mobile-trusted-1")).toBe(
					false,
				);

				mobileWs.close();
			} finally {
				await rm(fixtureDir, { recursive: true, force: true });
				if (prevDisable === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_DISABLE_TLS");
				} else {
					process.env["GUILD_REMOTE_DISABLE_TLS"] = prevDisable;
				}
				if (prevAllow === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_ALLOW_INSECURE");
				} else {
					process.env["GUILD_REMOTE_ALLOW_INSECURE"] = prevAllow;
				}
			}
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
						deviceId: "mobile-test-device-456",
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
				if (prevDisable === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_DISABLE_TLS");
				} else {
					process.env["GUILD_REMOTE_DISABLE_TLS"] = prevDisable;
				}
				if (prevAllow === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_ALLOW_INSECURE");
				} else {
					process.env["GUILD_REMOTE_ALLOW_INSECURE"] = prevAllow;
				}
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

		// Two full start/stop cycles rather than one, so this is the slowest test here.
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

		it("should accept runtime configuration", async () => {
			server = await startServer({
				port: testPort + 100,
				runtimes: ["opencode", "claude"],
			});

			expect(server).toBeDefined();
		});

		it("writes machine-readable status snapshots", async () => {
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-status-"));
			const statusFilePath = join(fixtureDir, "server-status.json");
			const advertisedRelayUrl = "wss://192.0.2.10:8210/ws";
			try {
				server = await startServer({
					port: testPort + 110,
					statusFilePath,
					advertisedRelayUrl,
				});

				await waitForCondition(async () => {
					try {
						const raw = await readFile(statusFilePath, "utf8");
						const parsed = JSON.parse(raw) as {
							running?: boolean;
							mode?: string;
							pin?: string;
							relayUrl?: string;
							tlsPin?: string;
						};
						return (
							parsed.running === true &&
							parsed.mode === "local" &&
							typeof parsed.pin === "string" &&
							parsed.pin.length === 6 &&
							parsed.relayUrl === advertisedRelayUrl &&
							typeof parsed.tlsPin === "string" &&
							parsed.tlsPin.length === 64
						);
					} catch {
						return false;
					}
				}, 8_000);

				await server.stop();
				server = null;

				const stoppedSnapshot = JSON.parse(await readFile(statusFilePath, "utf8")) as {
					running?: boolean;
					stoppedAt?: string;
				};
				expect(stoppedSnapshot.running).toBe(false);
				expect(typeof stoppedSnapshot.stoppedAt).toBe("string");
			} finally {
				await rm(fixtureDir, { recursive: true, force: true });
			}
		});

		it("resets mobileConnected in status snapshots after mobile disconnect", async () => {
			const prevDisable = process.env["GUILD_REMOTE_DISABLE_TLS"];
			const prevAllow = process.env["GUILD_REMOTE_ALLOW_INSECURE"];
			process.env["GUILD_REMOTE_DISABLE_TLS"] = "1";
			process.env["GUILD_REMOTE_ALLOW_INSECURE"] = "1";

			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-status-disconnect-"));
			const statusFilePath = join(fixtureDir, "server-status.json");
			try {
				server = await startServer({
					port: testPort + 111,
					statusFilePath,
					advertisedRelayUrl: `ws://127.0.0.1:${testPort + 111}/ws`,
				});

				const mobileWs = new WebSocket(`ws://127.0.0.1:${testPort + 111}/ws`);
				await waitForOpen(mobileWs);
				const paired = waitForMessageOfType(mobileWs, "paired");
				mobileWs.send(
					JSON.stringify({
						type: "pair",
						deviceId: "mobile-status-disconnect",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await paired;

				await waitForCondition(async () => {
					try {
						const snapshot = JSON.parse(await readFile(statusFilePath, "utf8")) as {
							mobileConnected?: boolean;
						};
						return snapshot.mobileConnected === true;
					} catch {
						return false;
					}
				}, 8_000);

				mobileWs.close();
				await waitForCondition(async () => {
					try {
						const snapshot = JSON.parse(await readFile(statusFilePath, "utf8")) as {
							mobileConnected?: boolean;
						};
						return snapshot.mobileConnected === false;
					} catch {
						return false;
					}
				}, 8_000);
			} finally {
				await rm(fixtureDir, { recursive: true, force: true });
				if (prevDisable === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_DISABLE_TLS");
				} else {
					process.env["GUILD_REMOTE_DISABLE_TLS"] = prevDisable;
				}
				if (prevAllow === undefined) {
					Reflect.deleteProperty(process.env, "GUILD_REMOTE_ALLOW_INSECURE");
				} else {
					process.env["GUILD_REMOTE_ALLOW_INSECURE"] = prevAllow;
				}
			}
		}, 15_000);

		it("supports remote relay mode with status metadata", async () => {
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-remote-status-"));
			const statusFilePath = join(fixtureDir, "server-status.json");
			const remoteRelay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
			await new Promise<void>((resolve) => remoteRelay.once("listening", () => resolve()));
			const relayAddress = remoteRelay.address();
			if (!relayAddress || typeof relayAddress === "string") {
				throw new Error("Failed to bind remote relay test server");
			}
			const remoteRelayUrl = `ws://127.0.0.1:${relayAddress.port}/ws`;
			let sawRegister = false;

			remoteRelay.on("connection", (socket) => {
				socket.on("message", (raw) => {
					const message = JSON.parse(raw.toString()) as { type?: string };
					if (message.type === "register") {
						sawRegister = true;
						socket.send(JSON.stringify({ type: "registered", pairingCode: "919191" }));
					}
				});
			});

			try {
				server = await startServer({
					port: testPort + 120,
					remoteRelayUrl,
					statusFilePath,
				});

				expect(server.url).toBe(remoteRelayUrl);
				await waitForCondition(async () => {
					if (!sawRegister) return false;
					try {
						const snapshot = JSON.parse(await readFile(statusFilePath, "utf8")) as {
							mode?: string;
							relayUrl?: string;
							running?: boolean;
						};
						const relayUrl = snapshot.relayUrl ?? "";
						return (
							snapshot.mode === "remote" &&
							relayUrl.includes(`127.0.0.1:${relayAddress.port}`) &&
							snapshot.running === true
						);
					} catch {
						return false;
					}
				}, 8_000);
			} finally {
				if (server) {
					await server.stop();
					server = null;
				}
				for (const client of remoteRelay.clients) {
					client.terminate();
				}
				await new Promise<void>((resolve) => remoteRelay.close(() => resolve()));
				await rm(fixtureDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("rejects invalid remote relay URLs", async () => {
			await expect(
				startServer({
					port: testPort + 130,
					remoteRelayUrl: "https://invalid-relay.example.com/ws",
				}),
			).rejects.toThrow(/Invalid remote relay URL/);
		});

		it("rejects invalid hosted endpoint URLs", async () => {
			await expect(
				startServer({
					port: testPort + 131,
					hostedEndpointUrl: "https://invalid-hosted.example.com/ws",
				}),
			).rejects.toThrow(/Invalid hosted endpoint URL/);
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

async function waitForCondition(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs: number,
	intervalMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("Timed out waiting for condition");
}
