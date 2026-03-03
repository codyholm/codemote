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

	it("forwards model from new_session into uplink start_run payload", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let startRunPayload: JsonRecord | null = null;

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

				if (type === "start_run") {
					startRunPayload = (command["payload"] as JsonRecord | undefined) ?? null;
					socket.send(
						JSON.stringify({
							type: "run_started",
							payload: { sessionId: "sess-model-1", runId: "run-model-1" },
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
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-model" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-model",
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
			const mobilePayloads: JsonRecord[] = [];

			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);
			mobileSocket.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload) return;
				mobilePayloads.push(payload);
			});

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-test-model",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);
			await waitForCondition(
				() => mobilePayloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "new_session",
						runtime: "claude",
						prompt: "test",
						model: "claude-sonnet-4-20250514",
					},
				}),
			);

			await waitForCondition(() => startRunPayload !== null, 8000);
			expect(startRunPayload?.["model"]).toBe("claude-sonnet-4-20250514");
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("forwards list_models to uplink and relays model_list back to mobile", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let listModelsPayload: JsonRecord | null = null;

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

				if (type === "list_models") {
					listModelsPayload = (command["payload"] as JsonRecord | undefined) ?? null;
					socket.send(
						JSON.stringify({
							type: "model_list",
							payload: {
								runtime: "claude",
								models: [
									{ id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
									{ id: "claude-opus-4-20250514", label: "Opus 4" },
									{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
								],
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
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "333334" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-model-list" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-model-list",
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
			const mobilePayloads: JsonRecord[] = [];

			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);
			mobileSocket.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload) return;
				mobilePayloads.push(payload);
			});

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-test-model-list",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() => mobilePayloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "list_models",
						runtime: "claude",
					},
				}),
			);

			await waitForCondition(() => listModelsPayload !== null, 8000);
			expect(listModelsPayload?.["profile"]).toBe("claude");

			await waitForCondition(
				() => mobilePayloads.some((payload) => payload["type"] === "model_list"),
				8000,
			);

			const modelList = mobilePayloads.find((payload) => payload["type"] === "model_list");
			expect(modelList?.["runtime"]).toBe("claude");
			expect(modelList?.["models"]).toEqual([
				{ id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
				{ id: "claude-opus-4-20250514", label: "Opus 4" },
				{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
			]);
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
				(sessions as Array<JsonRecord>).some((session) => session["id"] === "missing-session-1"),
			).toBe(false);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("does not synthesize an opencode session when status arrives for an unknown session id", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let uplinkSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			uplinkSocket = socket;
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(
						JSON.stringify({
							type: "sessions",
							payload: [],
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
					socket.send(JSON.stringify({ type: "registered", pairingCode: "323232" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(
						JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-unknown-status" }),
					);
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-unknown-status",
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
					deviceId: "mobile-test-unknown-status",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() => payloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);

			const connectedUplinkSocket = uplinkSocket as WebSocket | null;
			if (connectedUplinkSocket === null) {
				throw new Error("Expected uplink socket for unknown status test");
			}

			connectedUplinkSocket.send(
				JSON.stringify({
					type: "event",
					payload: {
						type: "session.status",
						timestamp: Date.now(),
						sessionId: "sess-unknown-status-1",
						payload: {
							status: "error",
						},
					},
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "session_status" &&
							payload["sessionId"] === "sess-unknown-status-1" &&
							payload["status"] === "error",
					),
				8000,
			);

			const latestSessionList = [...payloads]
				.reverse()
				.find((payload) => payload["type"] === "session_list");
			const sessions = latestSessionList?.["sessions"];
			expect(Array.isArray(sessions)).toBe(true);
			expect(
				(sessions as Array<JsonRecord>).some(
					(session) => session["id"] === "sess-unknown-status-1",
				),
			).toBe(false);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("forwards stop immediately while a send_input command is still awaiting response", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let sendInputCommandAt = 0;
		let sendInputAckAt = 0;
		let stopCommandAt = 0;

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
									id: "sess-stop-1",
									runId: "run-stop-1",
									runtime: "gemini",
									status: "idle",
									workspace: {
										id: "ws-stop-1",
										workingDir: tempRepoDir,
										createdAt: Date.now(),
									},
									startedAt: Date.now() - 5_000,
									endedAt: null,
									lastActivityAt: Date.now() - 2_000,
								},
							],
						}),
					);
					return;
				}

				if (type === "send_input") {
					sendInputCommandAt = Date.now();
					setTimeout(() => {
						sendInputAckAt = Date.now();
						socket.send(
							JSON.stringify({
								type: "input_sent",
								payload: { sessionId: "sess-stop-1" },
							}),
						);
					}, 300);
					return;
				}

				if (type === "stop") {
					stopCommandAt = Date.now();
					socket.send(
						JSON.stringify({
							type: "stopped",
							payload: { sessionId: "sess-stop-1" },
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
					socket.send(JSON.stringify({ type: "registered", pairingCode: "666666" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-6" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-6",
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
					deviceId: "mobile-test-6",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() =>
					payloads.some((payload) => {
						if (payload["type"] !== "session_list") return false;
						const sessions = payload["sessions"];
						return (
							Array.isArray(sessions) &&
							sessions.some((session) => (session as JsonRecord)["id"] === "sess-stop-1")
						);
					}),
				8000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "send_prompt",
						sessionId: "sess-stop-1",
						prompt: "long-running input",
					},
				}),
			);
			await waitForCondition(() => sendInputCommandAt > 0, 8000);

			await new Promise((resolve) => setTimeout(resolve, 30));
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "stop",
						sessionId: "sess-stop-1",
					},
				}),
			);

			await waitForCondition(() => stopCommandAt > 0, 8000);
			await waitForCondition(() => sendInputAckAt > 0, 8000);

			expect(stopCommandAt).toBeGreaterThan(sendInputCommandAt);
			expect(stopCommandAt).toBeLessThan(sendInputAckAt);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("returns explicit directory_listing error payload when list_directory fails", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (type === "list_directory") {
					socket.send(
						JSON.stringify({
							type: "error",
							payload: { message: "EACCES: permission denied, scandir '/root'" },
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
					socket.send(JSON.stringify({ type: "registered", pairingCode: "112233" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-listdir" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-test-listdir",
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
					deviceId: "mobile-test-listdir",
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
					payload: { type: "list_directory", path: "/root" },
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "directory_listing" &&
							payload["path"] === "/root" &&
							payload["error"] === "EACCES: permission denied, scandir '/root'",
					),
				8000,
			);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("suppresses sub-agent events that include parentToolUseId", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		let uplinkSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			uplinkSocket = socket;
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "778899" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-filter-1" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-filter-1",
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
					deviceId: "mobile-filter-1",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() => payloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);
			expect(uplinkSocket).toBeTruthy();
			const connectedUplinkSocket = uplinkSocket as WebSocket | null;
			if (connectedUplinkSocket === null) {
				throw new Error("Expected uplink connection for parent tool suppression test");
			}

			connectedUplinkSocket.send(
				JSON.stringify({
					type: "event",
					payload: {
						type: "session.message",
						timestamp: Date.now(),
						sessionId: "sess-parent-filter",
						payload: {
							role: "assistant",
							content: "internal sub-agent detail",
							parentToolUseId: "parent_42",
						},
					},
				}),
			);
			connectedUplinkSocket.send(
				JSON.stringify({
					type: "event",
					payload: {
						type: "session.message",
						timestamp: Date.now(),
						sessionId: "sess-parent-filter",
						payload: {
							role: "assistant",
							content: "top-level assistant reply",
						},
					},
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "session_message" &&
							payload["sessionId"] === "sess-parent-filter" &&
							payload["content"] === "top-level assistant reply",
					),
				8000,
			);

			expect(
				payloads.some(
					(payload) =>
						payload["type"] === "session_message" &&
						payload["sessionId"] === "sess-parent-filter" &&
						payload["content"] === "internal sub-agent detail",
				),
			).toBe(false);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("advertises local and hosted endpoint candidates through device_info", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "445566" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-endpoint-1" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-endpoint-1",
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
			localEndpointUrl: "wss://192.168.1.55:8080/ws",
			hostedEndpointUrl: "wss://relay.codemote.app/ws",
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
					deviceId: "mobile-endpoint-1",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "device_info" &&
							Array.isArray(payload["endpoints"]) &&
							(payload["endpoints"] as Array<JsonRecord>).some(
								(endpoint) =>
									endpoint["kind"] === "local" && endpoint["url"] === "wss://192.168.1.55:8080/ws",
							) &&
							(payload["endpoints"] as Array<JsonRecord>).some(
								(endpoint) =>
									endpoint["kind"] === "hosted" &&
									endpoint["url"] === "wss://relay.codemote.app/ws",
							),
					),
				8000,
			);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("refreshes device_info when mobile requests it", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "556677" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(
						JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-endpoint-refresh-1" }),
					);
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-endpoint-refresh-1",
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
			localEndpointUrl: "wss://192.168.1.55:8080/ws",
			hostedEndpointUrl: "wss://relay.codemote.app/ws",
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
					deviceId: "mobile-endpoint-refresh-1",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() =>
					payloads.some(
						(payload) =>
							payload["type"] === "device_info" &&
							Array.isArray(payload["endpoints"]) &&
							(payload["endpoints"] as Array<JsonRecord>).some(
								(endpoint) =>
									endpoint["kind"] === "local" && endpoint["url"] === "wss://192.168.1.55:8080/ws",
							) &&
							(payload["endpoints"] as Array<JsonRecord>).some(
								(endpoint) =>
									endpoint["kind"] === "hosted" &&
									endpoint["url"] === "wss://relay.codemote.app/ws",
							),
					),
				8000,
			);

			const deviceInfoCount = payloads.filter(
				(payload) => payload["type"] === "device_info",
			).length;

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "request_device_info" },
				}),
			);

			await waitForCondition(
				() =>
					payloads.filter((payload) => payload["type"] === "device_info").length > deviceInfoCount,
				8000,
			);

			const latest = [...payloads].reverse().find((payload) => payload["type"] === "device_info");
			const endpoints = latest?.["endpoints"];
			expect(Array.isArray(endpoints)).toBe(true);
			expect(
				(endpoints as Array<JsonRecord>).some(
					(endpoint) =>
						endpoint["kind"] === "local" && endpoint["url"] === "wss://192.168.1.55:8080/ws",
				),
			).toBe(true);
			expect(
				(endpoints as Array<JsonRecord>).some(
					(endpoint) =>
						endpoint["kind"] === "hosted" && endpoint["url"] === "wss://relay.codemote.app/ws",
				),
			).toBe(true);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("does not advertise tailscale candidate when local endpoint is unavailable", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "778899" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-endpoint-2" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: "mobile-endpoint-2",
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
			hostedEndpointUrl: "wss://relay.codemote.app/ws",
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
					deviceId: "mobile-endpoint-2",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(
				() =>
					payloads.some((payload) => {
						if (payload["type"] !== "device_info" || !Array.isArray(payload["endpoints"])) {
							return false;
						}
						const endpoints = payload["endpoints"] as Array<JsonRecord>;
						return (
							endpoints.some(
								(endpoint) =>
									endpoint["kind"] === "hosted" &&
									endpoint["url"] === "wss://relay.codemote.app/ws",
							) && !endpoints.some((endpoint) => endpoint["kind"] === "tailscale")
						);
					}),
				8000,
			);
		} finally {
			if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
				mobileSocket.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("continues forwarding to remaining mobile when one paired mobile disconnects", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		const relayMobileSockets = new Map<string, WebSocket>();
		const socketToDeviceId = new Map<WebSocket, string>();

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (command["type"] === "send_input") {
					const payload = (command["payload"] as JsonRecord | undefined) ?? {};
					const sessionId = String(payload["sessionId"] ?? "sess-multi-1");
					socket.send(
						JSON.stringify({
							type: "input_sent",
							payload: { sessionId },
						}),
					);
					socket.send(
						JSON.stringify({
							type: "event",
							payload: {
								type: "session.message",
								sessionId,
								timestamp: Date.now(),
								payload: {
									role: "assistant",
									content: "still-forwarding",
								},
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
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "112233" }));
					return;
				}

				if (type === "pair") {
					const mobileId = String(message["deviceId"] ?? "");
					if (!mobileId) return;
					relayMobileSockets.set(mobileId, socket);
					socketToDeviceId.set(socket, mobileId);
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-multi-1" }));
					relayUplinkSocket?.send(
						JSON.stringify({
							type: "paired",
							mobileDeviceId: mobileId,
						}),
					);
					return;
				}

				if (type !== "message") return;
				if (socket === relayUplinkSocket) {
					for (const mobileSocket of relayMobileSockets.values()) {
						if (mobileSocket.readyState === WebSocket.OPEN) {
							mobileSocket.send(raw.toString());
						}
					}
					return;
				}

				relayUplinkSocket?.send(raw.toString());
			});

			socket.on("close", () => {
				const mobileId = socketToDeviceId.get(socket);
				if (!mobileId) return;
				socketToDeviceId.delete(socket);
				relayMobileSockets.delete(mobileId);
				relayUplinkSocket?.send(
					JSON.stringify({
						type: "mobile_disconnected",
						uplinkDeviceId: "uplink-multi-1",
						mobileDeviceId: mobileId,
					}),
				);
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileFirst: WebSocket | null = null;
		let mobileSecond: WebSocket | null = null;
		try {
			const firstPayloads: JsonRecord[] = [];
			mobileFirst = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileFirst);
			mobileFirst.on("message", (raw) => {
				const envelope = JSON.parse(raw.toString()) as JsonRecord;
				if (envelope["type"] !== "message") return;
				const payload = envelope["payload"] as JsonRecord | undefined;
				if (!payload) return;
				firstPayloads.push(payload);
			});

			mobileSecond = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSecond);

			mobileFirst.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-first",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);
			mobileSecond.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-second",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			await waitForCondition(() => relayMobileSockets.size === 2, 8000);
			await waitForCondition(
				() => firstPayloads.some((payload) => payload["type"] === "session_list"),
				8000,
			);

			mobileSecond.close();
			await waitForCondition(() => relayMobileSockets.size === 1, 8000);

			mobileFirst.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "send_prompt",
						sessionId: "sess-multi-1",
						prompt: "ping",
					},
				}),
			);

			await waitForCondition(
				() =>
					firstPayloads.some(
						(payload) =>
							payload["type"] === "session_message" &&
							payload["sessionId"] === "sess-multi-1" &&
							payload["content"] === "still-forwarding",
					),
				8000,
			);
		} finally {
			if (mobileFirst && mobileFirst.readyState === WebSocket.OPEN) {
				mobileFirst.close();
			}
			if (mobileSecond && mobileSecond.readyState === WebSocket.OPEN) {
				mobileSecond.close();
			}
			await bridge.stop();
		}
	}, 20_000);

	it("updates session status metadata even when no mobile is paired", async () => {
		let statusEventSent = false;
		const statusUpdates: Array<{
			sessionId: string;
			runtime: string;
			status: string;
		}> = [];

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] !== "list_sessions") {
					return;
				}

				socket.send(
					JSON.stringify({
						type: "sessions",
						payload: [
							{
								id: "sess-status-no-mobile",
								runId: "run-status-no-mobile",
								runtime: "codex",
								status: "running",
								workspace: {
									id: "ws-status-no-mobile",
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
				if (!statusEventSent) {
					statusEventSent = true;
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "event",
								payload: {
									type: "session.status",
									sessionId: "sess-status-no-mobile",
									timestamp: Date.now(),
									payload: {
										status: "idle",
									},
								},
							}),
						);
					}, 20);
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				if (message["type"] === "register") {
					socket.send(JSON.stringify({ type: "registered", pairingCode: "223344" }));
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onSessionStatus: (info) => {
				statusUpdates.push({
					sessionId: info.sessionId,
					runtime: info.runtime,
					status: info.status,
				});
			},
		});

		try {
			await waitForCondition(
				() =>
					statusUpdates.some(
						(update) =>
							update.sessionId === "sess-status-no-mobile" &&
							update.runtime === "codex" &&
							update.status === "idle",
					),
				8000,
			);
		} finally {
			await bridge.stop();
		}
	}, 20_000);

	it("auto-resumes opencode sessions when creating a new session", async () => {
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
			expect(startRunPayload?.["resumeSessionId"]).toBe("ses_existing_123");
		} finally {
			await bridge.stop();
		}
	}, 20_000);

	it("falls back to a fresh local start when opencode auto-resume fails", async () => {
		const startRunPayloads: JsonRecord[] = [];

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
									id: "sess-old-2",
									runId: "run-old-2",
									runtime: "opencode",
									status: "idle",
									runtimeSessionId: "ses_stale_456",
									workspace: {
										id: "ws-old-2",
										workingDir: tempRepoDir,
										createdAt: Date.now(),
									},
									startedAt: Date.now() - 12_000,
									endedAt: null,
									lastActivityAt: Date.now() - 6_000,
								},
							],
						}),
					);
					return;
				}

				if (type === "start_run") {
					const payload = (command["payload"] as JsonRecord | undefined) ?? {};
					startRunPayloads.push(payload);
					if (startRunPayloads.length === 1) {
						socket.send(
							JSON.stringify({
								type: "error",
								payload: { message: "resume id no longer valid" },
							}),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: "run_started",
							payload: {
								sessionId: "sess-new-2",
								runId: "run-new-2",
							},
						}),
					);
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				if (message["type"] === "register") {
					socket.send(JSON.stringify({ type: "registered", pairingCode: "666666" }));
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		try {
			await expect(bridge.startSession("opencode", "fallback validation")).resolves.toEqual({
				sessionId: "sess-new-2",
			});
			expect(startRunPayloads.length).toBe(2);
			expect(startRunPayloads[0]?.["resumeSessionId"]).toBe("ses_stale_456");
			expect(startRunPayloads[1]?.["resumeSessionId"]).toBeUndefined();
		} finally {
			await bridge.stop();
		}
	}, 20_000);

	const runtimeContinuityMatrix = ["claude", "opencode", "codex", "gemini"] as const;

	for (const runtime of runtimeContinuityMatrix) {
		it(`maintains three-turn continuity across reconnect for ${runtime}`, async () => {
			interface MockSessionState {
				id: string;
				runtime: (typeof runtimeContinuityMatrix)[number];
				status: string;
				runtimeSessionId: string;
				originalPrompt: string;
			}

			let relayUplinkSocket: WebSocket | null = null;
			let relayMobileSocket: WebSocket | null = null;
			const sessionsById = new Map<string, MockSessionState>();
			let sessionCounter = 0;

			const emitEvent = (socket: WebSocket, payload: JsonRecord): void => {
				socket.send(
					JSON.stringify({
						type: "event",
						payload: {
							...payload,
							timestamp: Date.now(),
						},
					}),
				);
			};

			const emitStatus = (socket: WebSocket, sessionId: string, status: string): void => {
				const session = sessionsById.get(sessionId);
				if (session) {
					session.status = status;
				}
				emitEvent(socket, {
					type: "session.status",
					sessionId,
					payload: { status },
				});
			};

			const emitAssistantMessage = (
				socket: WebSocket,
				sessionId: string,
				content: string,
			): void => {
				emitEvent(socket, {
					type: "session.message",
					sessionId,
					payload: {
						role: "assistant",
						content,
					},
				});
			};

			uplinkWss.on("connection", (socket) => {
				socket.on("message", (raw) => {
					const command = JSON.parse(raw.toString()) as JsonRecord;
					const type = command["type"];

					if (type === "list_sessions") {
						socket.send(
							JSON.stringify({
								type: "sessions",
								payload: Array.from(sessionsById.values()).map((session) => ({
									id: session.id,
									runId: `run-${session.id}`,
									runtime: session.runtime,
									status: session.status,
									runtimeSessionId: session.runtimeSessionId,
									workspace: {
										id: `ws-${session.id}`,
										workingDir: tempRepoDir,
										createdAt: Date.now(),
									},
									startedAt: Date.now() - 3_000,
									endedAt: null,
									lastActivityAt: Date.now(),
								})),
							}),
						);
						return;
					}

					if (type === "start_run") {
						const payload = (command["payload"] as JsonRecord | undefined) ?? {};
						const initialPrompt = String(payload["initialPrompt"] ?? "");
						sessionCounter += 1;
						const sessionId = `sess-${runtime}-matrix-${sessionCounter}`;
						const runtimeSessionId = `runtime-${runtime}-matrix-${sessionCounter}`;
						sessionsById.set(sessionId, {
							id: sessionId,
							runtime,
							status: "starting",
							runtimeSessionId,
							originalPrompt: initialPrompt,
						});

						socket.send(
							JSON.stringify({
								type: "run_started",
								payload: {
									sessionId,
									runId: `run-${runtime}-${sessionCounter}`,
								},
							}),
						);
						emitStatus(socket, sessionId, "running");
						emitAssistantMessage(socket, sessionId, "4");
						emitStatus(socket, sessionId, "idle");
						return;
					}

					if (type === "send_input") {
						const payload = (command["payload"] as JsonRecord | undefined) ?? {};
						const sessionId = String(payload["sessionId"] ?? "");
						const input = String(payload["input"] ?? "");
						const session = sessionsById.get(sessionId);
						if (!session) {
							socket.send(
								JSON.stringify({
									type: "error",
									payload: { message: `Unknown session: ${sessionId}` },
								}),
							);
							return;
						}

						socket.send(
							JSON.stringify({
								type: "input_sent",
								payload: { sessionId },
							}),
						);
						emitStatus(socket, sessionId, "running");
						if (input.includes("Multiply that by 4")) {
							emitAssistantMessage(socket, sessionId, "16");
						} else if (input.includes("What was my original question")) {
							emitAssistantMessage(
								socket,
								sessionId,
								`Your original question was: ${session.originalPrompt}`,
							);
						} else {
							emitAssistantMessage(socket, sessionId, `echo:${input}`);
						}
						emitStatus(socket, sessionId, "idle");
					}
				});
			});

			relayWss.on("connection", (socket) => {
				socket.on("message", (raw) => {
					const message = JSON.parse(raw.toString()) as JsonRecord;
					const type = message["type"];

					if (type === "register") {
						relayUplinkSocket = socket;
						socket.send(JSON.stringify({ type: "registered", pairingCode: "121212" }));
						return;
					}

					if (type === "pair" || type === "resume") {
						relayMobileSocket = socket;
						socket.send(
							JSON.stringify({
								type: "paired",
								uplinkDeviceId: "uplink-runtime-matrix-1",
							}),
						);
						relayUplinkSocket?.send(
							JSON.stringify({
								type: "paired",
								mobileDeviceId: String(message["deviceId"] ?? "mobile-runtime-matrix-1"),
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
				const mobilePayloads: JsonRecord[] = [];
				const attachPayloadListener = (socket: WebSocket): void => {
					socket.on("message", (raw) => {
						const envelope = JSON.parse(raw.toString()) as JsonRecord;
						if (envelope["type"] !== "message") return;
						const payload = envelope["payload"] as JsonRecord | undefined;
						if (!payload) return;
						mobilePayloads.push(payload);
					});
				};

				mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
				await waitForOpen(mobileSocket);
				attachPayloadListener(mobileSocket);

				mobileSocket.send(
					JSON.stringify({
						type: "pair",
						deviceId: `mobile-runtime-matrix-${runtime}`,
						pin: bridge.pairingCode,
						deviceType: "mobile",
					}),
				);

				await waitForCondition(
					() => mobilePayloads.some((payload) => payload["type"] === "session_list"),
					8000,
				);

				mobileSocket.send(
					JSON.stringify({
						type: "message",
						payload: {
							type: "new_session",
							runtime,
							prompt: "What is 2+2?",
						},
					}),
				);

				await waitForCondition(
					() =>
						mobilePayloads.some(
							(payload) => payload["type"] === "session_message" && payload["content"] === "4",
						),
					8000,
				);

				let sessionId = "";
				await waitForCondition(() => {
					const listPayload = [...mobilePayloads]
						.reverse()
						.find((payload) => payload["type"] === "session_list");
					const sessions = listPayload?.["sessions"];
					if (!Array.isArray(sessions)) {
						return false;
					}

					const matching = sessions.find((session) => {
						const record = session as JsonRecord;
						return record["runtime"] === runtime && typeof record["id"] === "string";
					});
					if (!matching) {
						return false;
					}
					sessionId = String((matching as JsonRecord)["id"] ?? "");
					return sessionId.length > 0;
				}, 8000);

				mobileSocket.send(
					JSON.stringify({
						type: "message",
						payload: {
							type: "send_prompt",
							sessionId,
							prompt: "Multiply that by 4",
						},
					}),
				);

				await waitForCondition(
					() =>
						mobilePayloads.some(
							(payload) =>
								payload["type"] === "session_message" &&
								payload["sessionId"] === sessionId &&
								payload["content"] === "16",
						),
					8000,
				);

				mobileSocket.close();
				await new Promise((resolve) => setTimeout(resolve, 50));

				mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
				await waitForOpen(mobileSocket);
				attachPayloadListener(mobileSocket);
				mobileSocket.send(
					JSON.stringify({
						type: "resume",
						deviceId: `mobile-runtime-matrix-${runtime}`,
						uplinkDeviceId: "uplink-runtime-matrix-1",
						deviceType: "mobile",
					}),
				);

				await waitForCondition(
					() =>
						mobilePayloads.some(
							(payload) =>
								payload["type"] === "session_list" &&
								Array.isArray(payload["sessions"]) &&
								(payload["sessions"] as JsonRecord[]).some(
									(session) => session["id"] === sessionId,
								),
						),
					8000,
				);

				mobileSocket.send(
					JSON.stringify({
						type: "message",
						payload: {
							type: "send_prompt",
							sessionId,
							prompt: "What was my original question?",
						},
					}),
				);

				await waitForCondition(
					() =>
						mobilePayloads.some(
							(payload) =>
								payload["type"] === "session_message" &&
								payload["sessionId"] === sessionId &&
								String(payload["content"]).includes("What is 2+2?"),
						),
					8000,
				);

				const statusEvents = mobilePayloads.filter(
					(payload) => payload["type"] === "session_status" && payload["sessionId"] === sessionId,
				);
				const statusValues = statusEvents
					.map((payload) => payload["status"])
					.filter((status): status is string => typeof status === "string");

				expect(statusValues).toContain("running");
				expect(statusValues).toContain("idle");
				expect(
					mobilePayloads.some(
						(payload) =>
							payload["type"] === "session_status" &&
							payload["sessionId"] === sessionId &&
							payload["status"] === "error",
					),
				).toBe(false);
			} finally {
				if (mobileSocket && mobileSocket.readyState === WebSocket.OPEN) {
					mobileSocket.close();
				}
				await bridge.stop();
			}
		}, 30_000);
	}
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
