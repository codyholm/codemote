import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startRelayUplinkBridge } from "./bridge.js";

interface JsonRecord {
	[key: string]: unknown;
}

describe("RelayUplinkBridge", () => {
	let relayWss: WebSocketServer;
	let uplinkWss: WebSocketServer;
	let relayPort = 0;
	let uplinkPort = 0;
	let tempHomeDir = "";
	let tempRepoDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env["HOME"];
		tempHomeDir = await mkdtemp(join(tmpdir(), "bridge-home-"));
		tempRepoDir = await mkdtemp(join(tmpdir(), "bridge-repo-"));
		process.env["HOME"] = tempHomeDir;

		relayWss = await createWsServer();
		uplinkWss = await createWsServer();

		const relayAddr = relayWss.address();
		const uplinkAddr = uplinkWss.address();
		if (!relayAddr || typeof relayAddr === "string") {
			throw new Error("Failed to bind relay test server");
		}
		if (!uplinkAddr || typeof uplinkAddr === "string") {
			throw new Error("Failed to bind uplink test server");
		}

		relayPort = relayAddr.port;
		uplinkPort = uplinkAddr.port;
	});

	afterEach(async () => {
		await Promise.allSettled([closeWsServer(relayWss), closeWsServer(uplinkWss)]);
		await Promise.allSettled([
			rm(tempHomeDir, { recursive: true, force: true }),
			rm(tempRepoDir, { recursive: true, force: true }),
		]);
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env["HOME"] = originalHome;
		}
	});

	it("preserves a newer runtime status when run_started arrives later", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let startRunSeen = false;
		let startRunCompleted = false;
		let pendingListSessionsResponder: (() => void) | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "start_run") {
					startRunSeen = true;
					socket.send(
						JSON.stringify({
							type: "event",
							payload: {
								type: "session.status",
								timestamp: Date.now(),
								sessionId: "sess-race-1",
								payload: { status: "running" },
							},
						}),
					);

					setTimeout(() => {
						startRunCompleted = true;
						socket.send(
							JSON.stringify({
								type: "run_started",
								payload: {
									sessionId: "sess-race-1",
									runId: "run-race-1",
								},
							}),
						);
						pendingListSessionsResponder?.();
						pendingListSessionsResponder = null;
					}, 300);
					return;
				}

				if (type === "list_sessions") {
					const respond = () => {
						socket.send(
							JSON.stringify({
								type: "sessions",
								payload: [
									{
										id: "sess-race-1",
										runId: "run-race-1",
										runtime: "gemini",
										status: "running",
										workspace: {
											id: "ws-race-1",
											workingDir: tempRepoDir,
											createdAt: Date.now(),
										},
										startedAt: Date.now(),
										endedAt: null,
										lastActivityAt: Date.now(),
									},
								],
							}),
						);
					};

					if (startRunSeen && !startRunCompleted) {
						pendingListSessionsResponder = respond;
					} else {
						respond();
					}
					return;
				}

				if (type === "send_input") {
					socket.send(
						JSON.stringify({
							type: "input_sent",
							payload: { sessionId: "sess-race-1" },
						}),
					);
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "111111" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-1" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-1",
						}),
					);
					return;
				}

				if (type !== "message") return;
				if (socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				} else if (socket === relayUplinkSocket) {
					relayMobileSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const sessionLists: Array<Array<JsonRecord>> = [];
			mobileSocket.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload || payload["type"] !== "session_list") return;
				const sessions = payload["sessions"];
				if (Array.isArray(sessions)) {
					sessionLists.push(sessions as Array<JsonRecord>);
				}
			});

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-test-1",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);
			await waitForCondition(() => sessionLists.length > 0, 8000);
			await bridge.startSession("gemini", "What is 2 + 2?");

			await waitForCondition(
				() =>
					sessionLists.some((sessions) =>
						sessions.some((session) => session["id"] === "sess-race-1"),
					),
				8000,
			);

			const latestWithSession = [...sessionLists]
				.reverse()
				.find((sessions) => sessions.some((session) => session["id"] === "sess-race-1"));
			expect(latestWithSession).toBeDefined();

			const targetSession = latestWithSession?.find((session) => session["id"] === "sess-race-1");
			// Keep a compact trail of statuses for debugging race order in CI.
			const statusTrail = sessionLists
				.map((sessions) => sessions.find((session) => session["id"] === "sess-race-1")?.["status"])
				.filter((status) => typeof status === "string");
			expect(statusTrail.length).toBeGreaterThan(0);
			expect(targetSession?.["status"]).toBe("running");

			mobileSocket.close();
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("serializes uplink commands when status events trigger list_sessions", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "start_run") {
					socket.send(
						JSON.stringify({
							type: "event",
							payload: {
								type: "session.status",
								timestamp: Date.now(),
								sessionId: "sess-queue-1",
								payload: { status: "running" },
							},
						}),
					);

					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "run_started",
								payload: {
									sessionId: "sess-queue-1",
									runId: "run-queue-1",
								},
							}),
						);
					}, 100);
					return;
				}

				if (type === "list_sessions") {
					socket.send(
						JSON.stringify({
							type: "sessions",
							payload: [],
						}),
					);
					return;
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "222222" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-2" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-2",
						}),
					);
					return;
				}

				if (type !== "message") return;
				if (socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				} else if (socket === relayUplinkSocket) {
					relayMobileSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const sessionLists: Array<Array<JsonRecord>> = [];
			mobileSocket.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload || payload["type"] !== "session_list") return;
				const sessions = payload["sessions"];
				if (Array.isArray(sessions)) {
					sessionLists.push(sessions as Array<JsonRecord>);
				}
			});

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-test-2",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);
			await waitForCondition(() => sessionLists.length > 0, 8000);

			await expect(bridge.startSession("gemini", "Queue ordering check")).resolves.toEqual({
				sessionId: "sess-queue-1",
			});
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("drops timed-out start_run waiters so late responses do not satisfy the next start_run", async () => {
		const previousTimeout = process.env["CODEMOTE_UPLINK_COMMAND_TIMEOUT_MS"];
		const previousLongTimeout = process.env["CODEMOTE_UPLINK_LONG_COMMAND_TIMEOUT_MS"];
		process.env["CODEMOTE_UPLINK_COMMAND_TIMEOUT_MS"] = "80";
		process.env["CODEMOTE_UPLINK_LONG_COMMAND_TIMEOUT_MS"] = "80";

		let startRunCount = 0;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(
						JSON.stringify({
							type: "sessions",
							payload: [],
						}),
					);
					return;
				}

				if (type !== "start_run") {
					return;
				}

				startRunCount += 1;
				if (startRunCount === 1) {
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "run_started",
								payload: {
									sessionId: "sess-late-1",
									runId: "run-late-1",
								},
							}),
						);
					}, 200);
					return;
				}

				setTimeout(() => {
					socket.send(
						JSON.stringify({
							type: "run_started",
							payload: {
								sessionId: "sess-fast-2",
								runId: "run-fast-2",
							},
						}),
					);
				}, 20);
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				if (message["type"] === "register") {
					socket.send(JSON.stringify({ type: "registered", pairingCode: "555555" }));
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		try {
			await expect(bridge.startSession("gemini", "first run")).rejects.toThrow(
				"Timed out waiting for uplink response: run_started",
			);

			await expect(bridge.startSession("gemini", "second run")).resolves.toEqual({
				sessionId: "sess-fast-2",
			});
		} finally {
			if (previousTimeout === undefined) {
				Reflect.deleteProperty(process.env, "CODEMOTE_UPLINK_COMMAND_TIMEOUT_MS");
			} else {
				process.env["CODEMOTE_UPLINK_COMMAND_TIMEOUT_MS"] = previousTimeout;
			}
			if (previousLongTimeout === undefined) {
				Reflect.deleteProperty(process.env, "CODEMOTE_UPLINK_LONG_COMMAND_TIMEOUT_MS");
			} else {
				process.env["CODEMOTE_UPLINK_LONG_COMMAND_TIMEOUT_MS"] = previousLongTimeout;
			}
			await bridge.stop();
		}
	}, 20_000);

	it("reports a session error instead of crashing when send_prompt targets a missing session", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(
						JSON.stringify({
							type: "sessions",
							payload: [],
						}),
					);
					return;
				}

				if (type === "send_input") {
					socket.send(
						JSON.stringify({
							type: "error",
							payload: { message: "Session not found" },
						}),
					);
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "333333" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-3" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-3",
						}),
					);
					return;
				}

				if (type !== "message") return;
				if (socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				} else if (socket === relayUplinkSocket) {
					relayMobileSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const payloads: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload) return;
				payloads.push(payload);
			});

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-test-3",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() => payloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "send_prompt",
						sessionId: "missing-session-1",
						prompt: "Hello?",
					},
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "session_status" &&
							payload["sessionId"] === "missing-session-1" &&
							payload["status"] === "error",
					),
				8000,
			);

			const errorOutput = payloads.find(
				(payload) =>
					payload["type"] === "session_output" &&
					payload["sessionId"] === "missing-session-1" &&
					typeof payload["text"] === "string" &&
					(payload["text"] as string).includes("Session not found"),
			);
			expect(errorOutput).toBeDefined();

			const latestSessionList = [...payloads]
				.reverse()
				.find((payload) => payload["type"] === "session_list");
			const sessions = latestSessionList?.["sessions"];
			expect(Array.isArray(sessions)).toBe(true);
			expect(
				(sessions as Array<JsonRecord>).some(
					(session) => session["id"] === "missing-session-1" && session["status"] === "error",
				),
			).toBe(true);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("does not auto-resume opencode sessions when creating a new session", async () => {
		let startRunPayload: JsonRecord | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(
						JSON.stringify({
							type: "sessions",
							payload: [
								{
									id: "sess-old-1",
									runId: "run-old-1",
									runtime: "opencode",
									status: "idle",
									runtimeSessionId: "ses_existing_123",
									workspace: {
										id: "ws-old-1",
										workingDir: tempRepoDir,
										createdAt: Date.now(),
									},
									startedAt: Date.now() - 10_000,
									endedAt: null,
									lastActivityAt: Date.now() - 5_000,
								},
							],
						}),
					);
					return;
				}

				if (type === "start_run") {
					startRunPayload = (command["payload"] as JsonRecord | undefined) ?? null;
					socket.send(
						JSON.stringify({
							type: "run_started",
							payload: {
								sessionId: "sess-new-1",
								runId: "run-new-1",
							},
						}),
					);
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					socket.send(JSON.stringify({ type: "registered", pairingCode: "444444" }));
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		try {
			await expect(bridge.startSession("opencode", "auto-resume validation")).resolves.toEqual({
				sessionId: "sess-new-1",
			});
			expect(startRunPayload).toBeTruthy();
			expect(startRunPayload?.["resumeSessionId"]).toBeUndefined();
		} finally {
			await bridge.stop();
		}
	}, 20_000);
});

async function createWsServer(): Promise<WebSocketServer> {
	const wss = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
	});
	await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
	return wss;
}

async function closeWsServer(wss: WebSocketServer): Promise<void> {
	for (const client of wss.clients) {
		client.terminate();
	}
	await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitForOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) return;

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("WebSocket open timeout"));
		}, 4000);
		ws.once("open", () => {
			clearTimeout(timeout);
			resolve();
		});
		ws.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

async function waitForCondition(
	predicate: () => boolean,
	timeoutMs: number,
	intervalMs = 20,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("Timed out waiting for condition");
}
