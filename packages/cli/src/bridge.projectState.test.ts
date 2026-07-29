import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectStateAggregate } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { decodeMobileInbound, startRelayUplinkBridge } from "./bridge.js";

interface JsonRecord {
	[key: string]: unknown;
}

/** Distinguishable by sessionCount, so a test can tell which aggregate arrived. */
function aggregate(sessionCount: number): ProjectStateAggregate {
	return {
		generatedAt: 1,
		projects: [],
		sessionCount,
		sessionsOmitted: 0,
		projectCount: 0,
		projectsOmitted: 0,
		truncated: false,
		blockedProjectCount: 0,
		blockedSessionCount: 0,
	};
}

const PUSHED = 99;
const SOLICITED = 7;
const LISTED = 8;

// These tests each start a real bridge against fake relay and uplink sockets, and
// the bridge now issues its own get_project_state on pair, so a run has two
// serialized uplink round trips before the assertion can hold. Under parallel file
// load that legitimately exceeds the vitest default, so the suite carries an
// explicit timeout - matching server.test.ts. A retry wrapper was rejected for the
// same reason it was there: it would mask a genuine hang.
describe("bridge project state", { timeout: 30000 }, () => {
	let relayWss: WebSocketServer;
	let uplinkWss: WebSocketServer;
	let relayPort = 0;
	let uplinkPort = 0;
	let tempHomeDir = "";
	let tempRepoDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env["HOME"];
		tempHomeDir = await mkdtemp(join(tmpdir(), "bridge-ps-home-"));
		tempRepoDir = await mkdtemp(join(tmpdir(), "bridge-ps-repo-"));
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

	it("keeps an in-flight get_project_state correlated when a push interleaves", async () => {
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (type === "get_project_state") {
					// The unsolicited push races ahead of the real reply. This is the exact
					// interleaving that would resolve the wrong waiter if the push reached
					// the correlation logic.
					socket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "project_state",
								requestId: command["requestId"],
								payload: aggregate(SOLICITED),
							}),
						);
					}, 50);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const observedPushes: number[] = [];

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onProjectState: (state) => observedPushes.push(state.sessionCount),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: number[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload?.["type"] !== "project_state") return;
				const state = payload["state"] as ProjectStateAggregate;
				toMobile.push(state.sessionCount);
			});

			await pairMobile(mobileSocket, bridge.pairingCode);

			mobileSocket.send(
				JSON.stringify({ type: "message", payload: { type: "get_project_state" } }),
			);

			// Both must arrive: the push via the short-circuit, the reply via correlation.
			await waitForCondition(() => toMobile.includes(SOLICITED), 15000);
			await waitForCondition(() => observedPushes.includes(PUSHED), 15000);

			// Correlation intact: the solicited reply carried its own payload, not the push's.
			expect(toMobile).toContain(SOLICITED);
			// The push still reached the push path. Fails if the short-circuit is removed,
			// because the push then falls into correlation and is dropped as unmatched.
			expect(observedPushes).toContain(PUSHED);
			// And the solicited reply was never mistaken for a push.
			expect(observedPushes).not.toContain(SOLICITED);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("routes registry CRUD, list state, failures, and an interleaved push", async () => {
		const projectPath = "/tmp/bridge-alpha ";
		const missingPath = "/tmp/bridge-missing ";
		const commands: JsonRecord[] = [];
		let removeCount = 0;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				commands.push(command);
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (type === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
					return;
				}

				if (type === "add_project") {
					socket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "project_registry_result",
								requestId: command["requestId"],
								payload: { operation: "add", path: projectPath, success: true },
							}),
						);
					}, 50);
					return;
				}

				if (type === "list_projects") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(LISTED),
						}),
					);
					return;
				}

				if (type === "rename_project") {
					socket.send(
						JSON.stringify({
							type: "project_registry_result",
							requestId: command["requestId"],
							payload: { operation: "rename", path: projectPath, success: true },
						}),
					);
					return;
				}

				if (type === "remove_project") {
					removeCount += 1;
					if (removeCount === 2) {
						socket.send(
							JSON.stringify({
								type: "error",
								requestId: command["requestId"],
								payload: {
									message: `Project not found: ${missingPath}`,
									code: "PROJECT_NOT_FOUND",
								},
							}),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: "project_registry_result",
							requestId: command["requestId"],
							payload: { operation: "remove", path: projectPath, success: true },
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const observedPushes: number[] = [];
		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onProjectState: (state) => observedPushes.push(state.sessionCount),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload) toMobile.push(payload);
			});

			await pairMobile(mobileSocket, bridge.pairingCode);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "add_project",
						name: "  Alpha  ",
						path: projectPath,
					},
				}),
			);

			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_registry_result" && message["operation"] === "add",
					),
				15000,
			);
			await waitForCondition(() => observedPushes.includes(PUSHED), 15000);

			const pushIndex = toMobile.findIndex(
				(message) =>
					message["type"] === "project_state" &&
					(message["state"] as ProjectStateAggregate).sessionCount === PUSHED,
			);
			const addIndex = toMobile.findIndex(
				(message) =>
					message["type"] === "project_registry_result" && message["operation"] === "add",
			);
			expect(pushIndex).toBeGreaterThanOrEqual(0);
			expect(pushIndex).toBeLessThan(addIndex);
			expect(toMobile[addIndex]).toEqual({
				type: "project_registry_result",
				operation: "add",
				path: projectPath,
				success: true,
			});

			mobileSocket.send(JSON.stringify({ type: "message", payload: { type: "list_projects" } }));
			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_state" &&
							(message["state"] as ProjectStateAggregate).sessionCount === LISTED,
					),
				15000,
			);
			expect(
				toMobile.find(
					(message) =>
						message["type"] === "project_state" &&
						(message["state"] as ProjectStateAggregate).sessionCount === LISTED,
				),
			).toEqual({ type: "project_state", state: aggregate(LISTED) });

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "rename_project",
						path: projectPath,
						name: " Beta ",
					},
				}),
			);
			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_registry_result" && message["operation"] === "rename",
					),
				15000,
			);
			expect(
				toMobile.find(
					(message) =>
						message["type"] === "project_registry_result" && message["operation"] === "rename",
				),
			).toEqual({
				type: "project_registry_result",
				operation: "rename",
				path: projectPath,
				success: true,
			});

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "remove_project", path: projectPath },
				}),
			);
			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_registry_result" &&
							message["operation"] === "remove" &&
							message["success"] === true,
					),
				15000,
			);
			expect(
				toMobile.find(
					(message) =>
						message["type"] === "project_registry_result" &&
						message["operation"] === "remove" &&
						message["success"] === true,
				),
			).toEqual({
				type: "project_registry_result",
				operation: "remove",
				path: projectPath,
				success: true,
			});

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "remove_project", path: missingPath },
				}),
			);
			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_registry_result" &&
							message["operation"] === "remove" &&
							message["success"] === false,
					),
				15000,
			);
			expect(
				toMobile.find(
					(message) =>
						message["type"] === "project_registry_result" &&
						message["operation"] === "remove" &&
						message["success"] === false,
				),
			).toEqual({
				type: "project_registry_result",
				operation: "remove",
				path: missingPath,
				success: false,
				error: `Project not found: ${missingPath}`,
			});

			const registryCommands = commands.filter((command) =>
				["add_project", "list_projects", "rename_project", "remove_project"].includes(
					String(command["type"]),
				),
			);
			expect(registryCommands).toEqual([
				expect.objectContaining({
					type: "add_project",
					requestId: expect.any(String),
					payload: { name: "Alpha", path: projectPath },
				}),
				expect.objectContaining({
					type: "list_projects",
					requestId: expect.any(String),
				}),
				expect.objectContaining({
					type: "rename_project",
					requestId: expect.any(String),
					payload: { path: projectPath, name: "Beta" },
				}),
				expect.objectContaining({
					type: "remove_project",
					requestId: expect.any(String),
					payload: { path: projectPath },
				}),
				expect.objectContaining({
					type: "remove_project",
					requestId: expect.any(String),
					payload: { path: missingPath },
				}),
			]);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("validates registry mobile messages while trimming only names", () => {
		expect(
			decodeMobileInbound({ type: "add_project", name: " Name ", path: "/tmp/project " }),
		).toEqual({ type: "add_project", name: "Name", path: "/tmp/project " });
		expect(
			decodeMobileInbound({
				type: "rename_project",
				path: "/tmp/project ",
				name: " Renamed ",
			}),
		).toEqual({ type: "rename_project", path: "/tmp/project ", name: "Renamed" });
		expect(decodeMobileInbound({ type: "remove_project", path: "/tmp/project " })).toEqual({
			type: "remove_project",
			path: "/tmp/project ",
		});
		expect(decodeMobileInbound({ type: "list_projects" })).toEqual({ type: "list_projects" });

		expect(decodeMobileInbound({ type: "add_project", name: 1, path: "/tmp/project" })).toBeNull();
		expect(
			decodeMobileInbound({ type: "rename_project", path: "/tmp/project", name: false }),
		).toBeNull();
		expect(decodeMobileInbound({ type: "remove_project", path: null })).toBeNull();
	});

	it("starts a registry mutation while a long agent command remains unresolved", async () => {
		const projectPath = "/tmp/independent-registry ";
		const commands: JsonRecord[] = [];
		let releaseStart: (() => void) | undefined;
		let startReleased = false;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				commands.push(command);

				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (command["type"] === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
					return;
				}

				if (command["type"] === "start_run") {
					releaseStart = () => {
						startReleased = true;
						socket.send(
							JSON.stringify({
								type: "run_started",
								requestId: command["requestId"],
								payload: { runId: "run-held", sessionId: "session-held" },
							}),
						);
					};
					return;
				}

				if (command["type"] === "add_project") {
					socket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));
					socket.send(
						JSON.stringify({
							type: "project_registry_result",
							requestId: command["requestId"],
							payload: { operation: "add", path: projectPath, success: true },
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const observedPushes: number[] = [];
		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onProjectState: (state) => observedPushes.push(state.sessionCount),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload) toMobile.push(payload);
			});
			await pairMobile(mobileSocket, bridge.pairingCode);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "new_session",
						runtime: "opencode",
						prompt: "hold this run",
					},
				}),
			);
			await waitForCondition(
				() => commands.some((command) => command["type"] === "start_run"),
				15000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "add_project", name: "Independent", path: projectPath },
				}),
			);

			await waitForCondition(
				() => commands.some((command) => command["type"] === "add_project"),
				5000,
			);
			await waitForCondition(
				() =>
					toMobile.some(
						(message) =>
							message["type"] === "project_registry_result" && message["operation"] === "add",
					),
				5000,
			);

			expect(releaseStart).toBeDefined();
			expect(startReleased).toBe(false);
			expect(toMobile).toContainEqual({
				type: "project_registry_result",
				operation: "add",
				path: projectPath,
				success: true,
			});
			expect(observedPushes).toContain(PUSHED);
		} finally {
			releaseStart?.();
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("forwards an unsolicited push to a paired mobile", async () => {
		let announceUplink: ((socket: WebSocket) => void) | undefined;
		const uplinkConnected = new Promise<WebSocket>((resolve) => {
			announceUplink = resolve;
		});

		uplinkWss.on("connection", (socket) => {
			announceUplink?.(socket);
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		const relay = wireRelay(relayWss);
		const observedPushes: number[] = [];

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onProjectState: (state) => observedPushes.push(state.sessionCount),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: number[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload?.["type"] !== "project_state") return;
				toMobile.push((payload["state"] as ProjectStateAggregate).sessionCount);
			});

			await pairMobile(mobileSocket, bridge.pairingCode);
			const uplinkSocket = await uplinkConnected;

			// No request is in flight; this is purely server-initiated.
			uplinkSocket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));

			await waitForCondition(() => observedPushes.includes(PUSHED), 15000);
			await waitForCondition(() => toMobile.includes(PUSHED), 15000);

			expect(observedPushes).toContain(PUSHED);
			expect(toMobile).toContain(PUSHED);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("sends the current project state when a mobile pairs", async () => {
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (type === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: number[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload?.["type"] !== "project_state") return;
				toMobile.push((payload["state"] as ProjectStateAggregate).sessionCount);
			});

			// Pair only. The mobile asks for nothing; the state must arrive anyway.
			await pairMobile(mobileSocket, bridge.pairingCode);

			await waitForCondition(() => toMobile.includes(SOLICITED), 15000);
			expect(toMobile).toContain(SOLICITED);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("survives a consumer onProjectState callback that throws", async () => {
		let announceUplink: ((socket: WebSocket) => void) | undefined;
		const uplinkConnected = new Promise<WebSocket>((resolve) => {
			announceUplink = resolve;
		});

		uplinkWss.on("connection", (socket) => {
			announceUplink?.(socket);
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}
				if (command["type"] === "ping") {
					socket.send(JSON.stringify({ type: "pong", requestId: command["requestId"] }));
				}
			});
		});

		const relay = wireRelay(relayWss);
		const logs: string[] = [];

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			onProjectState: () => {
				throw new Error("consumer blew up");
			},
			log: (message) => logs.push(message),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: number[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload?.["type"] !== "project_state") return;
				toMobile.push((payload["state"] as ProjectStateAggregate).sessionCount);
			});

			await pairMobile(mobileSocket, bridge.pairingCode);
			const uplinkSocket = await uplinkConnected;

			uplinkSocket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));

			const threw = (): number =>
				logs.filter((line) => line.includes("onProjectState consumer threw")).length;

			await waitForCondition(() => threw() === 1, 15000);
			expect(logs.some((line) => line.includes("consumer blew up"))).toBe(true);

			// The consumer is an observer, not a gate: the phone must still receive the
			// state even though the consumer callback threw on the way past.
			await waitForCondition(() => toMobile.includes(PUSHED), 15000);
			expect(toMobile).toContain(PUSHED);

			// The throw was contained rather than tearing down the listener: a second
			// push is still received and handled.
			uplinkSocket.send(JSON.stringify({ type: "project_state_push", payload: aggregate(PUSHED) }));
			await waitForCondition(() => threw() === 2, 15000);
			expect(threw()).toBe(2);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("answers a mobile get_project_state with a project_state message", async () => {
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];

				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}

				if (type === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			const toMobile: number[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload?.["type"] !== "project_state") return;
				toMobile.push((payload["state"] as ProjectStateAggregate).sessionCount);
			});

			await pairMobile(mobileSocket, bridge.pairingCode);

			mobileSocket.send(
				JSON.stringify({ type: "message", payload: { type: "get_project_state" } }),
			);

			await waitForCondition(() => toMobile.includes(SOLICITED), 15000);
			expect(toMobile).toContain(SOLICITED);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("forwards project start inspection success and failure", async () => {
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				const type = command["type"];
				if (type === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}
				if (type === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
					return;
				}
				if (type === "get_project_start_state") {
					const path = (command["payload"] as JsonRecord)["projectPath"];
					if (path === "/missing") {
						socket.send(
							JSON.stringify({
								type: "error",
								requestId: command["requestId"],
								payload: {
									code: "PROJECT_NOT_REGISTERED",
									message: "Project is not registered",
								},
							}),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: "project_start_state",
							requestId: command["requestId"],
							payload: {
								originProjectPath: tempRepoDir,
								mode: "project_folder",
								directory: tempRepoDir,
								git: null,
							},
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});
		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);
			const received: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload) received.push(payload);
			});
			await pairMobile(mobileSocket, bridge.pairingCode);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "get_project_start_state", projectPath: tempRepoDir },
				}),
			);
			await waitForCondition(
				() =>
					received.some(
						(message) =>
							message["type"] === "project_start_state" &&
							(message["state"] as JsonRecord | undefined)?.["directory"] === tempRepoDir,
					),
				15_000,
			);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "get_project_start_state", projectPath: "/missing" },
				}),
			);
			await waitForCondition(
				() =>
					received.some(
						(message) =>
							message["type"] === "project_start_state" &&
							(message["error"] as JsonRecord | undefined)?.["code"] === "PROJECT_NOT_REGISTERED",
					),
				15_000,
			);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("forwards fresh project start success with origin and effective state", async () => {
		let startPayload: JsonRecord | null = null;
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
									id: "old-session",
									runId: "old-run",
									runtime: "opencode",
									status: "idle",
									runtimeSessionId: "ses_old",
									workspace: { id: "old-workspace", workingDir: "/old", createdAt: 1 },
									startedAt: 1,
									endedAt: null,
									lastActivityAt: 1,
									statusChangedAt: 1,
								},
							],
						}),
					);
					return;
				}
				if (type === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
					return;
				}
				if (type === "start_run") {
					startPayload = command["payload"] as JsonRecord;
					socket.send(
						JSON.stringify({
							type: "run_started",
							requestId: command["requestId"],
							payload: {
								runId: "project-run",
								sessionId: "project-session",
								operationId: "operation-success",
								originProjectPath: tempRepoDir,
								execution: {
									directory: tempRepoDir,
									mode: "project_folder",
									git: null,
								},
							},
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: "/legacy-default",
		});
		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);
			const received: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload) received.push(payload);
			});
			await pairMobile(mobileSocket, bridge.pairingCode);
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "new_session",
						runtime: "opencode",
						prompt: "fresh project start",
						resumeSessionId: "ses_explicit_should_be_ignored",
						projectStart: {
							operationId: "operation-success",
							originProjectPath: tempRepoDir,
							mode: "project_folder",
							preparation: { type: "none" },
						},
					},
				}),
			);

			await waitForCondition(
				() =>
					received.some(
						(message) => message["type"] === "session_start_result" && message["success"] === true,
					),
				15_000,
			);
			const capturedStart = startPayload as JsonRecord | null;
			expect(capturedStart).not.toBeNull();
			if (!capturedStart) throw new Error("Expected start_run payload");
			expect(capturedStart["workspace"]).toBe(tempRepoDir);
			expect(capturedStart["resumeSessionId"]).toBeUndefined();
			expect((capturedStart["projectStart"] as JsonRecord)["operationId"]).toBe(
				"operation-success",
			);
			expect(received.find((message) => message["type"] === "session_start_result")).toMatchObject({
				type: "session_start_result",
				operationId: "operation-success",
				success: true,
				sessionId: "project-session",
				originProjectPath: tempRepoDir,
				execution: { directory: tempRepoDir, mode: "project_folder", git: null },
			});
			const projected = received
				.filter((message) => message["type"] === "session_list")
				.flatMap((message) => message["sessions"] as JsonRecord[])
				.find((session) => session["id"] === "project-session");
			expect(projected).toMatchObject({
				originProjectPath: tempRepoDir,
				execution: { directory: tempRepoDir, mode: "project_folder", git: null },
			});
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});

	it("forwards structured project and journal failures without synthetic sessions", async () => {
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
					return;
				}
				if (command["type"] === "get_project_state") {
					socket.send(
						JSON.stringify({
							type: "project_state",
							requestId: command["requestId"],
							payload: aggregate(SOLICITED),
						}),
					);
					return;
				}
				if (command["type"] === "start_run") {
					const payload = command["payload"] as JsonRecord;
					const projectStart = payload["projectStart"] as JsonRecord;
					const operationId = projectStart["operationId"];
					const journalCode =
						operationId === "corrupt-journal"
							? "INVALID_PROJECT_START_JOURNAL"
							: operationId === "unwritable-journal"
								? "PROJECT_START_JOURNAL_IO"
								: null;
					socket.send(
						JSON.stringify({
							type: "error",
							requestId: command["requestId"],
							payload: {
								code: journalCode ?? "STALE_PROJECT_STATE",
								message:
									journalCode === "INVALID_PROJECT_START_JOURNAL"
										? "Invalid project start operation journal"
										: journalCode === "PROJECT_START_JOURNAL_IO"
											? "Failed to persist project start operation journal"
											: "Refresh the project state",
								...(operationId === "corrupt-journal"
									? {}
									: {
											details: {
												operationId,
												phase: operationId === "unwritable-journal" ? "recorded" : "failed",
												originProjectPath: tempRepoDir,
											},
										}),
							},
						}),
					);
				}
			});
		});

		const relay = wireRelay(relayWss);
		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
		});
		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);
			const received: JsonRecord[] = [];
			mobileSocket.on("message", (raw) => {
				const payload = mobilePayload(raw.toString());
				if (payload) received.push(payload);
			});
			await pairMobile(mobileSocket, bridge.pairingCode);
			const sendProjectStart = (operationId: string): void => {
				mobileSocket?.send(
					JSON.stringify({
						type: "message",
						payload: {
							type: "new_session",
							runtime: "codex",
							prompt: operationId,
							projectStart: {
								operationId,
								originProjectPath: tempRepoDir,
								mode: "project_folder",
								preparation: { type: "none" },
							},
						},
					}),
				);
			};
			sendProjectStart("operation-failure");

			await waitForCondition(
				() =>
					received.some(
						(message) =>
							message["type"] === "session_start_result" &&
							message["operationId"] === "operation-failure",
					),
				15_000,
			);
			expect(
				received.find(
					(message) =>
						message["type"] === "session_start_result" &&
						message["operationId"] === "operation-failure",
				),
			).toMatchObject({
				operationId: "operation-failure",
				success: false,
				code: "STALE_PROJECT_STATE",
				message: "Refresh the project state",
				details: { phase: "failed", originProjectPath: tempRepoDir },
			});

			sendProjectStart("corrupt-journal");
			await waitForCondition(
				() =>
					received.some(
						(message) =>
							message["type"] === "session_start_result" &&
							message["operationId"] === "corrupt-journal",
					),
				15_000,
			);
			expect(
				received.find(
					(message) =>
						message["type"] === "session_start_result" &&
						message["operationId"] === "corrupt-journal",
				),
			).toMatchObject({
				operationId: "corrupt-journal",
				success: false,
				code: "INVALID_PROJECT_START_JOURNAL",
				message: "Invalid project start operation journal",
			});

			sendProjectStart("unwritable-journal");
			await waitForCondition(
				() =>
					received.some(
						(message) =>
							message["type"] === "session_start_result" &&
							message["operationId"] === "unwritable-journal",
					),
				15_000,
			);
			expect(
				received.find(
					(message) =>
						message["type"] === "session_start_result" &&
						message["operationId"] === "unwritable-journal",
				),
			).toMatchObject({
				operationId: "unwritable-journal",
				success: false,
				code: "PROJECT_START_JOURNAL_IO",
				message: "Failed to persist project start operation journal",
				details: {
					operationId: "unwritable-journal",
					phase: "recorded",
					originProjectPath: tempRepoDir,
				},
			});
			expect(
				received
					.filter((message) => message["type"] === "session_list")
					.flatMap((message) => message["sessions"] as JsonRecord[]),
			).toEqual([]);
			expect(received.some((message) => message["type"] === "session_output")).toBe(false);
		} finally {
			mobileSocket?.close();
			await bridge.stop();
			relay.dispose();
		}
	});
});

function mobilePayload(raw: string): JsonRecord | null {
	const envelope = JSON.parse(raw) as JsonRecord;
	if (envelope["type"] !== "message") return null;
	return (envelope["payload"] as JsonRecord | undefined) ?? null;
}

function wireRelay(wss: WebSocketServer): { dispose: () => void } {
	let uplinkSide: WebSocket | null = null;
	let mobileSide: WebSocket | null = null;

	const onConnection = (socket: WebSocket) => {
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as JsonRecord;
			const type = message["type"];

			if (type === "register") {
				uplinkSide = socket;
				socket.send(JSON.stringify({ type: "registered", pairingCode: "111111" }));
				return;
			}

			if (type === "pair") {
				mobileSide = socket;
				socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-test-1" }));
				uplinkSide?.send(JSON.stringify({ type: "paired", mobileDeviceId: "mobile-test-1" }));
				return;
			}

			if (type !== "message") return;
			if (socket === mobileSide) {
				uplinkSide?.send(raw.toString());
			} else if (socket === uplinkSide) {
				mobileSide?.send(raw.toString());
			}
		});
	};

	wss.on("connection", onConnection);
	return { dispose: () => wss.off("connection", onConnection) };
}

async function pairMobile(mobileSocket: WebSocket, pin: string): Promise<void> {
	const paired = new Promise<void>((resolve) => {
		const onMessage = (raw: WebSocket.RawData) => {
			const message = JSON.parse(raw.toString()) as JsonRecord;
			if (message["type"] === "paired") {
				mobileSocket.off("message", onMessage);
				resolve();
			}
		};
		mobileSocket.on("message", onMessage);
	});

	mobileSocket.send(
		JSON.stringify({ type: "pair", deviceId: "mobile-test-1", pin, deviceType: "mobile" }),
	);
	await paired;
}

async function createWsServer(): Promise<WebSocketServer> {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
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
		const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 4000);
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
