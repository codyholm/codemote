import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelayServer } from "../../relay/server.js";
import { UplinkServer } from "../server.js";

describe("E2E: Mobile -> Relay -> Uplink Flow", () => {
	let testDir: string;
	let relayServer: Awaited<ReturnType<typeof createRelayServer>>;
	let uplinkServer: UplinkServer;
	let relayPort: number;
	let uplinkPort: number;

	beforeAll(async () => {
		// Setup test repo
		testDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# E2E Test");
		await git.add(".");
		await git.commit("Initial commit");

		// Start relay on random port
		relayPort = 9900 + Math.floor(Math.random() * 100);
		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			dbPath: ":memory:",
		});
		await relayServer.start();

		// Start uplink on random port
		// Use empty runtimes array so only MockExecutor is registered (avoids fetch to real OpenCode server)
		uplinkPort = 9800 + Math.floor(Math.random() * 100);
		uplinkServer = new UplinkServer({
			port: uplinkPort,
			host: "127.0.0.1",
			repoPath: testDir,
			runtimes: [], // Only use MockExecutor
		});
		await uplinkServer.start();
	}, 30000);

	afterAll(async () => {
		await uplinkServer?.stop();
		await relayServer?.stop();
		await rm(testDir, { recursive: true, force: true });
	});

	it("completes full pairing and message flow", async () => {
		// 1. Uplink connects to relay and gets pairing code
		const uplinkWs = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		await waitForOpen(uplinkWs);

		const pairingCodePromise = waitForMessage(uplinkWs);
		uplinkWs.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-device-123",
				deviceType: "uplink",
			}),
		);

		const registerResponse = await pairingCodePromise;
		expect(registerResponse["type"]).toBe("registered");
		const pairingCode = registerResponse["pairingCode"];
		expect(pairingCode).toBeDefined();
		if (typeof pairingCode !== "string") {
			throw new Error("Expected pairingCode to be a string");
		}

		// 2. Mobile connects and pairs with code
		const mobileWs = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		await waitForOpen(mobileWs);

		// Set up listener for uplink to receive "paired" notification
		const uplinkPairedPromise = waitForMessage(uplinkWs);

		const pairPromise = waitForMessage(mobileWs);
		mobileWs.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-device-456",
				pairingCode,
				deviceType: "mobile",
			}),
		);

		const pairResponse = await pairPromise;
		expect(pairResponse["type"]).toBe("paired");
		expect(pairResponse["uplinkDeviceId"]).toBe("uplink-test-device-123");

		// Wait for uplink to receive paired notification
		const uplinkPaired = await uplinkPairedPromise;
		expect(uplinkPaired["type"]).toBe("paired");
		expect(uplinkPaired["mobileDeviceId"]).toBe("mobile-test-device-456");

		// 3. Test message routing (simulated encrypted blob)
		const messagePromise = waitForMessage(uplinkWs);
		mobileWs.send(
			JSON.stringify({
				type: "message",
				payload: { encrypted: "test-message-blob" },
			}),
		);

		const routedMessage = await messagePromise;
		expect(routedMessage["type"]).toBe("message");
		const routedPayload = routedMessage["payload"] as Record<string, unknown>;
		expect(routedPayload["encrypted"]).toBe("test-message-blob");

		// 4. Resume after disconnect (no PIN)
		mobileWs.close();
		const mobileWs2 = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		await waitForOpen(mobileWs2);

		const uplinkPairedAgainPromise = waitForMessage(uplinkWs);
		const resumePromise = waitForMessage(mobileWs2);
		mobileWs2.send(
			JSON.stringify({
				type: "resume",
				deviceId: "mobile-test-device-456",
				uplinkDeviceId: "uplink-test-device-123",
				deviceType: "mobile",
			}),
		);

		const resumeResponse = await resumePromise;
		expect(resumeResponse["type"]).toBe("paired");
		expect(resumeResponse["uplinkDeviceId"]).toBe("uplink-test-device-123");

		const uplinkPairedAgain = await uplinkPairedAgainPromise;
		expect(uplinkPairedAgain["type"]).toBe("paired");
		expect(uplinkPairedAgain["mobileDeviceId"]).toBe("mobile-test-device-456");

		const messageAfterResumePromise = waitForMessage(uplinkWs);
		mobileWs2.send(
			JSON.stringify({
				type: "message",
				payload: { encrypted: "test-message-blob-2" },
			}),
		);
		const routedAfterResume = await messageAfterResumePromise;
		expect(routedAfterResume["type"]).toBe("message");
		const routedAfterResumePayload = routedAfterResume["payload"] as Record<string, unknown>;
		expect(routedAfterResumePayload["encrypted"]).toBe("test-message-blob-2");

		// Cleanup
		uplinkWs.close();
		mobileWs2.close();
	}, 15000);

	it("uplink executes mock session", async () => {
		const clientWs = new WebSocket(`ws://127.0.0.1:${uplinkPort}`);
		await waitForOpen(clientWs);

		// Ping test
		const pongPromise = waitForMessage(clientWs);
		clientWs.send(JSON.stringify({ type: "ping" }));
		const pong = await pongPromise;
		expect(pong["type"]).toBe("pong");

		// Start a mock run (MockExecutor is registered for "opencode" profile)
		// Set up the listener BEFORE sending to avoid race condition
		const runPromise = waitForMessageOfType(clientWs, "run_started");
		clientWs.send(
			JSON.stringify({
				type: "start_run",
				payload: {
					profile: "opencode",
					workspace: testDir,
					initialPrompt: "Test prompt",
				},
			}),
		);

		const runResponse = await runPromise;
		expect(runResponse["type"]).toBe("run_started");
		const runPayload = runResponse["payload"] as Record<string, unknown>;
		expect(runPayload["sessionId"]).toBeDefined();

		// Collect some streamed events
		const events: Record<string, unknown>[] = [];
		const collectEvents = new Promise<void>((resolve) => {
			const handler = (data: WebSocket.RawData) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === "event") {
					events.push(msg);
				}
			};
			clientWs.on("message", handler);
			setTimeout(() => {
				clientWs.off("message", handler);
				resolve();
			}, 1000);
		});

		await collectEvents;
		expect(events.length).toBeGreaterThan(0);

		clientWs.close();
	}, 15000);

	it("uplink handles get_diff command", async () => {
		const clientWs = new WebSocket(`ws://127.0.0.1:${uplinkPort}`);
		await waitForOpen(clientWs);

		// Start a session first
		const runPromise = waitForMessageOfType(clientWs, "run_started");
		clientWs.send(
			JSON.stringify({
				type: "start_run",
				payload: {
					profile: "opencode",
					workspace: testDir,
					initialPrompt: "Test for diff",
				},
			}),
		);

		const runResponse = await runPromise;
		const runPayload = runResponse["payload"] as Record<string, unknown>;
		const sessionId = runPayload["sessionId"] as string;
		expect(sessionId).toBeDefined();

		// Request diff for the session
		const diffPromise = waitForMessageOfType(clientWs, "diff");
		clientWs.send(
			JSON.stringify({
				type: "get_diff",
				payload: {
					sessionId,
					scope: "all",
				},
			}),
		);

		const diffResponse = await diffPromise;
		expect(diffResponse["type"]).toBe("diff");
		const diffPayload = diffResponse["payload"] as Record<string, unknown>;
		expect(diffPayload["sessionId"]).toBe(sessionId);
		expect(typeof diffPayload["diff"]).toBe("string");

		// Test staged scope
		const stagedDiffPromise = waitForMessageOfType(clientWs, "diff");
		clientWs.send(
			JSON.stringify({
				type: "get_diff",
				payload: {
					sessionId,
					scope: "staged",
				},
			}),
		);

		const stagedDiffResponse = await stagedDiffPromise;
		expect(stagedDiffResponse["type"]).toBe("diff");
		const stagedDiffPayload = stagedDiffResponse["payload"] as Record<string, unknown>;
		expect(stagedDiffPayload["sessionId"]).toBe(sessionId);
		expect(typeof stagedDiffPayload["diff"]).toBe("string");

		clientWs.close();
	}, 15000);
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

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		ws.once("message", (data) => {
			resolve(JSON.parse(data.toString()));
		});
		setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);
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
