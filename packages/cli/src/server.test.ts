/**
 * Tests for server integration
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { ServerConfig, ServerHandle } from "./server.js";

type StartServer = (config: ServerConfig) => Promise<ServerHandle>;
const execFileAsync = promisify(execFile);

// Every test here starts a real relay + uplink + bridge: TLS cert work, Fastify
// listening on several interfaces, then a full teardown. Individually they run in
// roughly 2-5s, which sits close enough to vitest's 5000ms default that a loaded
// full-suite run intermittently trips one — and not always the same one. The
// suite-wide timeout reflects what these tests actually do. A retry wrapper was
// considered and rejected: it would also mask a genuine hang.
describe("Server Integration", { timeout: 30000 }, () => {
	let server: ServerHandle | null = null;
	const testPort = 18080; // Use high port to avoid conflicts
	let speechDir: string;
	let suiteMachineStateDir: string | null = null;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let startServerImplementation: StartServer | null = null;

	beforeAll(async () => {
		originalHome = process.env["HOME"];
		originalUserProfile = process.env["USERPROFILE"];
		suiteMachineStateDir = await mkdtemp(join(tmpdir(), "cli-server-suite-"));
		process.env["HOME"] = suiteMachineStateDir;
		process.env["USERPROFILE"] = suiteMachineStateDir;
		({ startServer: startServerImplementation } = await import("./server.js"));
	}, 30_000);

	afterAll(async () => {
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env["HOME"] = originalHome;
		}
		if (originalUserProfile === undefined) {
			Reflect.deleteProperty(process.env, "USERPROFILE");
		} else {
			process.env["USERPROFILE"] = originalUserProfile;
		}
		if (suiteMachineStateDir) {
			await rm(suiteMachineStateDir, { recursive: true, force: true });
		}
	});

	async function startServer(config: ServerConfig): Promise<ServerHandle> {
		if (!suiteMachineStateDir || !startServerImplementation) {
			throw new Error("Server integration suite state is not initialized");
		}
		return startServerImplementation({
			pairingStorePath: join(suiteMachineStateDir, "trusted-pairings.json"),
			projectRegistryPath: join(suiteMachineStateDir, "projects.json"),
			projectStartJournalPath: join(suiteMachineStateDir, "project-start-operations.json"),
			managedWorktreeRoot: join(suiteMachineStateDir, "managed-worktrees"),
			tlsDir: join(suiteMachineStateDir, "tls"),
			...config,
		});
	}

	// startServer also starts the speech service, which publishes its endpoint to
	// ~/.codemote/speech.json and removes it on stop. Left unredirected, running
	// this suite while `codemote` is up would overwrite and then delete the live
	// file, and `codemote speech status` would report a running service as gone.
	// Speech stays enabled here so the wiring is exercised; only the path moves.
	beforeEach(async () => {
		speechDir = await mkdtemp(join(tmpdir(), "server-test-speech-"));
		vi.stubEnv("CODEMOTE_SPEECH_DISCOVERY_FILE", join(speechDir, "speech.json"));
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		vi.unstubAllEnvs();
		await rm(speechDir, { recursive: true, force: true });
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
			if (!suiteMachineStateDir) {
				throw new Error("Server integration suite state is not initialized");
			}
			const persistedDeviceId = await readFile(
				join(suiteMachineStateDir, ".codemote", "device-id"),
				"utf8",
			);
			expect(persistedDeviceId.trim()).toBe(server.uplinkDeviceId);
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

		it("uses supplied project registry and TLS locations", async () => {
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-state-"));
			const projectRegistryPath = join(fixtureDir, "projects.json");
			const seededProjectPath = join(fixtureDir, "seeded-project");
			const statusFilePath = join(fixtureDir, "server-status.json");
			const tlsDir = join(fixtureDir, "tls");
			let uplinkWs: WebSocket | null = null;

			try {
				await writeFile(
					projectRegistryPath,
					`${JSON.stringify({
						projects: [{ name: "Seeded Project", path: seededProjectPath }],
					})}\n`,
					"utf8",
				);

				server = await startServer({
					port: testPort + 90,
					projectRegistryPath,
					statusFilePath,
					tlsDir,
				});

				uplinkWs = new WebSocket(`ws://127.0.0.1:${testPort + 91}`);
				await waitForOpen(uplinkWs);
				const projectStatePromise = waitForMessageOfType(uplinkWs, "project_state");
				uplinkWs.send(JSON.stringify({ type: "list_projects" }));

				const projectState = await projectStatePromise;
				const payload = projectState["payload"] as {
					projects?: Array<{
						name?: string;
						path?: string;
						registered?: boolean;
					}>;
				};
				expect(payload.projects).toEqual([
					expect.objectContaining({
						name: "Seeded Project",
						path: seededProjectPath,
						registered: true,
					}),
				]);

				expect((await readdir(tlsDir)).sort()).toEqual(["cert.pem", "key.pem"]);
				expect(await readFile(join(tlsDir, "cert.pem"), "utf8")).toContain("BEGIN CERTIFICATE");
				expect(await readFile(join(tlsDir, "key.pem"), "utf8")).toMatch(/BEGIN (RSA )?PRIVATE KEY/);

				const status = JSON.parse(await readFile(statusFilePath, "utf8")) as {
					pin?: string;
					tlsPin?: string;
				};
				expect(status.pin).toMatch(/^\d{6}$/);
				expect(status.tlsPin).toMatch(/^[0-9a-f]{64}$/);
			} finally {
				uplinkWs?.close();
				if (server) {
					await server.stop();
					server = null;
				}
				await rm(fixtureDir, { recursive: true, force: true });
			}
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

		it("replays project-folder and worktree starts across a service restart", async () => {
			vi.stubEnv("GUILD_REMOTE_DISABLE_TLS", "1");
			vi.stubEnv("GUILD_REMOTE_ALLOW_INSECURE", "1");
			vi.stubEnv("CODEMOTE_SPEECH", "0");
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-project-start-"));
			const projectPath = join(fixtureDir, "project");
			const registryPath = join(fixtureDir, "machine", "projects.json");
			const journalPath = join(fixtureDir, "machine", "operations.json");
			const pairingPath = join(fixtureDir, "machine", "trusted-pairings.json");
			const port = testPort + 115;
			await mkdir(projectPath);
			await git(projectPath, ["init", "-b", "main"]);
			await git(projectPath, ["config", "user.name", "Codemote Test"]);
			await git(projectPath, ["config", "user.email", "codemote@example.invalid"]);
			await git(projectPath, ["config", "commit.gpgsign", "false"]);
			await writeFile(join(projectPath, "tracked.txt"), "committed\n", "utf8");
			await git(projectPath, ["add", "tracked.txt"]);
			await git(projectPath, ["commit", "--no-gpg-sign", "-m", "fixture"]);
			const head = await git(projectPath, ["rev-parse", "HEAD"]);
			const start = {
				type: "new_session",
				runtime: "opencode",
				prompt: "restart-safe project start",
				projectStart: {
					operationId: "configured-journal-operation",
					originProjectPath: projectPath,
					mode: "project_folder",
					preparation: {
						type: "create_branch",
						newBranch: "feature/configured-journal",
						expectedHead: head,
						expectedBranch: "main",
					},
				},
			};
			const worktreeStart = {
				type: "new_session",
				runtime: "opencode",
				prompt: "restart-safe worktree start",
				projectStart: {
					operationId: "configured-journal-worktree",
					originProjectPath: projectPath,
					mode: "worktree",
					preparation: {
						type: "create_worktree",
						baseRef: "refs/heads/main",
						expectedCommit: head,
						newBranch: "feature/configured-worktree",
					},
				},
			};
			const config: ServerConfig = {
				port,
				repoPath: fixtureDir,
				runtimes: [],
				projectRegistryPath: registryPath,
				projectStartJournalPath: journalPath,
				managedWorktreeRoot: join(fixtureDir, "managed"),
				pairingStorePath: pairingPath,
			};
			let mobile: WebSocket | null = null;
			try {
				server = await startServer(config);
				mobile = new WebSocket(`ws://127.0.0.1:${port}/ws`);
				await waitForOpen(mobile);
				const firstPaired = waitForMessageOfType(mobile, "paired");
				mobile.send(
					JSON.stringify({
						type: "pair",
						deviceId: "mobile-project-start",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await firstPaired;
				const added = waitForMobilePayloadType(mobile, "project_registry_result");
				mobile.send(
					JSON.stringify({
						type: "message",
						payload: { type: "add_project", name: "Fixture", path: projectPath },
					}),
				);
				await added;

				const firstResultPromise = waitForMobilePayloadType(mobile, "session_start_result");
				mobile.send(JSON.stringify({ type: "message", payload: start }));
				const firstResult = await firstResultPromise;
				expect(firstResult["success"]).toBe(true);
				expect(firstResult["operationId"]).toBe("configured-journal-operation");
				const firstSessionId = firstResult["sessionId"];
				expect(typeof firstSessionId).toBe("string");
				expect(await git(projectPath, ["branch", "--show-current"])).toBe(
					"feature/configured-journal",
				);

				const worktreePromise = waitForMobilePayloadType(mobile, "session_start_result");
				mobile.send(JSON.stringify({ type: "message", payload: worktreeStart }));
				const worktreeResult = await worktreePromise;
				expect(worktreeResult["success"]).toBe(true);
				const worktreeSessionId = worktreeResult["sessionId"];
				const worktreePath = (
					(worktreeResult["execution"] as Record<string, unknown>)["worktree"] as Record<
						string,
						unknown
					>
				)["path"] as string;
				expect(await realpath(dirname(worktreePath))).toBe(
					await realpath(join(fixtureDir, "managed")),
				);

				// Drop the responses and the service, exactly as a lost reply plus a
				// restart would: the phone still holds both operation IDs.
				mobile.close();
				mobile = null;
				await server.stop();
				server = null;

				server = await startServer(config);
				mobile = new WebSocket(`ws://127.0.0.1:${port}/ws`);
				await waitForOpen(mobile);
				const secondPaired = waitForMessageOfType(mobile, "paired");
				mobile.send(
					JSON.stringify({
						type: "pair",
						deviceId: "mobile-project-start",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await secondPaired;

				const replayPromise = waitForMobilePayloadType(mobile, "session_start_result");
				mobile.send(JSON.stringify({ type: "message", payload: start }));
				const replay = await replayPromise;
				expect(replay["success"]).toBe(true);
				expect(replay["sessionId"]).toBe(firstSessionId);
				expect(replay["operationId"]).toBe("configured-journal-operation");

				const worktreeReplayPromise = waitForMobilePayloadType(mobile, "session_start_result");
				mobile.send(JSON.stringify({ type: "message", payload: worktreeStart }));
				const worktreeReplay = await worktreeReplayPromise;
				expect(worktreeReplay["success"]).toBe(true);
				expect(worktreeReplay["sessionId"]).toBe(worktreeSessionId);
				expect(worktreeReplay["execution"]).toEqual(worktreeResult["execution"]);

				expect(await git(projectPath, ["branch", "--show-current"])).toBe(
					"feature/configured-journal",
				);
				expect(await git(projectPath, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
					[
						"refs/heads/feature/configured-journal",
						"refs/heads/feature/configured-worktree",
						"refs/heads/main",
					].join("\n"),
				);
				const registrations = (await git(projectPath, ["worktree", "list", "--porcelain"]))
					.split("\n")
					.filter((line) => line === `worktree ${worktreePath}`);
				expect(registrations).toHaveLength(1);

				const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
					version: number;
					operations: Array<{ phase?: string; result?: { sessionId?: string } }>;
				};
				expect(journal.version).toBe(2);
				expect(journal.operations).toHaveLength(2);
				expect(journal.operations.map((operation) => operation.result?.sessionId).sort()).toEqual(
					[firstSessionId, worktreeSessionId].sort(),
				);
			} finally {
				mobile?.close();
				if (server) {
					await server.stop();
					server = null;
				}
				await rm(fixtureDir, { recursive: true, force: true });
			}
		}, 30_000);

		it("creates a managed worktree beneath the supplied server root", async () => {
			const fixtureDir = await mkdtemp(join(tmpdir(), "cli-server-managed-worktree-"));
			const projectPath = join(fixtureDir, "project");
			const managedRoot = join(fixtureDir, "managed");
			const port = testPort + 118;
			vi.stubEnv("GUILD_REMOTE_DISABLE_TLS", "1");
			vi.stubEnv("GUILD_REMOTE_ALLOW_INSECURE", "1");
			await mkdir(projectPath);
			await git(projectPath, ["init", "-b", "main"]);
			await git(projectPath, ["config", "user.name", "Codemote Test"]);
			await git(projectPath, ["config", "user.email", "codemote@example.invalid"]);
			await writeFile(join(projectPath, "tracked.txt"), "committed\n");
			await git(projectPath, ["add", "tracked.txt"]);
			await git(projectPath, ["commit", "--no-gpg-sign", "-m", "fixture"]);
			const head = await git(projectPath, ["rev-parse", "HEAD"]);
			let mobile: WebSocket | null = null;
			try {
				server = await startServer({
					port,
					repoPath: fixtureDir,
					runtimes: [],
					projectRegistryPath: join(fixtureDir, "machine", "projects.json"),
					projectStartJournalPath: join(fixtureDir, "machine", "operations.json"),
					pairingStorePath: join(fixtureDir, "machine", "pairings.json"),
					managedWorktreeRoot: managedRoot,
				});
				mobile = new WebSocket(`ws://127.0.0.1:${port}/ws`);
				await waitForOpen(mobile);
				const paired = waitForMessageOfType(mobile, "paired");
				mobile.send(
					JSON.stringify({
						type: "pair",
						deviceId: "mobile-managed-worktree",
						pin: server.pin,
						deviceType: "mobile",
					}),
				);
				await paired;
				const added = waitForMobilePayloadType(mobile, "project_registry_result");
				mobile.send(
					JSON.stringify({
						type: "message",
						payload: { type: "add_project", name: "Fixture", path: projectPath },
					}),
				);
				await added;
				const resultPromise = waitForMobilePayloadType(mobile, "session_start_result");
				mobile.send(
					JSON.stringify({
						type: "message",
						payload: {
							type: "new_session",
							runtime: "opencode",
							prompt: "managed start",
							projectStart: {
								operationId: "configured-managed-worktree",
								originProjectPath: projectPath,
								mode: "worktree",
								preparation: {
									type: "create_worktree",
									baseRef: "refs/heads/main",
									expectedCommit: head,
									newBranch: null,
								},
							},
						},
					}),
				);
				const result = await resultPromise;
				expect(result["success"]).toBe(true);
				const execution = result["execution"] as Record<string, unknown>;
				const worktree = execution["worktree"] as Record<string, unknown>;
				expect(await realpath(dirname(worktree["path"] as string))).toBe(
					await realpath(managedRoot),
				);
				expect(execution["directory"]).toBe(worktree["path"]);
			} finally {
				mobile?.close();
				if (server) {
					await server.stop();
					server = null;
				}
				await rm(fixtureDir, { recursive: true, force: true });
			}
		}, 30_000);

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

function waitForMobilePayloadType(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const handler = (data: WebSocket.RawData) => {
			const envelope = JSON.parse(data.toString()) as Record<string, unknown>;
			if (envelope["type"] !== "message") return;
			const payload = envelope["payload"] as Record<string, unknown> | undefined;
			if (payload?.["type"] !== type) return;
			ws.off("message", handler);
			resolve(payload);
		};
		ws.on("message", handler);
		setTimeout(() => {
			ws.off("message", handler);
			reject(new Error(`WebSocket message timeout waiting for mobile payload: ${type}`));
		}, 10_000);
	});
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024,
	});
	return result.stdout.trim();
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
