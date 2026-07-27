import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectStateAggregate } from "@codemote/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startRelayUplinkBridge } from "./bridge.js";

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
