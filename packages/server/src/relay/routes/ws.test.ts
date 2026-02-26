import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelayServer } from "../server.js";

type RelayServerHandle = Awaited<ReturnType<typeof createRelayServer>>;

describe("relay ws routes", () => {
	let relayServer: RelayServerHandle | null = null;
	let fixtureDir: string | null = null;
	const openSockets: WebSocket[] = [];

	afterEach(async () => {
		for (const socket of openSockets) {
			try {
				socket.close();
			} catch {
				// ignore cleanup errors
			}
		}
		openSockets.length = 0;

		if (relayServer) {
			await relayServer.stop();
			relayServer = null;
		}
		if (fixtureDir) {
			await rm(fixtureDir, { recursive: true, force: true });
			fixtureDir = null;
		}
	});

	it("resumes pairing after relay restart using persisted trusted devices", async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "relay-ws-test-"));
		const storePath = join(fixtureDir, "trusted-pairings.json");
		const relayPort = 20100 + Math.floor(Math.random() * 500);

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplink = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplink);
		await waitForOpen(uplink);
		const registered = waitForMessageOfType(uplink, "registered");
		uplink.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-1",
				deviceType: "uplink",
			}),
		);
		const registeredMsg = await registered;
		const pairingCode = registeredMsg["pin"] ?? registeredMsg["pairingCode"];
		if (typeof pairingCode !== "string") {
			throw new Error("expected pairing code");
		}

		const mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobile);
		await waitForOpen(mobile);
		const paired = waitForMessageOfType(mobile, "paired");
		mobile.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-1",
				deviceType: "mobile",
				pin: pairingCode,
			}),
		);
		const pairedMsg = await paired;
		expect(pairedMsg["uplinkDeviceId"]).toBe("uplink-test-1");

		uplink.close();
		mobile.close();
		await relayServer.stop();
		relayServer = null;

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplinkAfterRestart = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplinkAfterRestart);
		await waitForOpen(uplinkAfterRestart);
		const registeredAgain = waitForMessageOfType(uplinkAfterRestart, "registered");
		uplinkAfterRestart.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-1",
				deviceType: "uplink",
			}),
		);
		await registeredAgain;

		const mobileAfterRestart = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobileAfterRestart);
		await waitForOpen(mobileAfterRestart);
		const resumed = waitForMessageOfType(mobileAfterRestart, "paired");
		mobileAfterRestart.send(
			JSON.stringify({
				type: "resume",
				deviceId: "mobile-test-1",
				deviceType: "mobile",
				uplinkDeviceId: "uplink-test-1",
			}),
		);
		const resumedMsg = await resumed;
		expect(resumedMsg["uplinkDeviceId"]).toBe("uplink-test-1");
	});

	it("keeps resumed mobile connected after stale socket closes", async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "relay-ws-test-"));
		const storePath = join(fixtureDir, "trusted-pairings.json");
		const relayPort = 21500 + Math.floor(Math.random() * 500);

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplink = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplink);
		await waitForOpen(uplink);
		const registered = waitForMessageOfType(uplink, "registered");
		uplink.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-reconnect",
				deviceType: "uplink",
			}),
		);
		const registeredMsg = await registered;
		const pairingCode = registeredMsg["pin"] ?? registeredMsg["pairingCode"];
		if (typeof pairingCode !== "string") {
			throw new Error("expected pairing code");
		}

		const mobileOld = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobileOld);
		await waitForOpen(mobileOld);
		const paired = waitForMessageOfType(mobileOld, "paired");
		mobileOld.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-reconnect",
				deviceType: "mobile",
				pin: pairingCode,
			}),
		);
		await paired;

		const mobileNew = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobileNew);
		await waitForOpen(mobileNew);
		const resumed = waitForMessageOfType(mobileNew, "paired");
		mobileNew.send(
			JSON.stringify({
				type: "resume",
				deviceId: "mobile-test-reconnect",
				deviceType: "mobile",
				uplinkDeviceId: "uplink-test-reconnect",
			}),
		);
		await resumed;

		mobileOld.close();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const forwarded = waitForMessageOfType(uplink, "message");
		mobileNew.send(
			JSON.stringify({
				type: "message",
				payload: {
					type: "send_prompt",
					sessionId: "sess-reconnect",
					prompt: "still-connected",
				},
			}),
		);
		const forwardedMsg = await forwarded;
		expect((forwardedMsg["payload"] as { type?: string }).type).toBe("send_prompt");
		expect((forwardedMsg["payload"] as { prompt?: string }).prompt).toBe("still-connected");
	});

	it("notifies uplink when a mobile socket disconnects", async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "relay-ws-test-"));
		const storePath = join(fixtureDir, "trusted-pairings.json");
		const relayPort = 20900 + Math.floor(Math.random() * 500);

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplink = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplink);
		await waitForOpen(uplink);
		const registered = waitForMessageOfType(uplink, "registered");
		uplink.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-disconnect",
				deviceType: "uplink",
			}),
		);
		const registeredMsg = await registered;
		const pairingCode = registeredMsg["pin"] ?? registeredMsg["pairingCode"];
		if (typeof pairingCode !== "string") {
			throw new Error("expected pairing code");
		}

		const mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobile);
		await waitForOpen(mobile);
		const paired = waitForMessageOfType(mobile, "paired");
		mobile.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-disconnect",
				deviceType: "mobile",
				pin: pairingCode,
			}),
		);
		await paired;
		await waitForMessageOfType(uplink, "paired");

		const disconnected = waitForMessageOfType(uplink, "mobile_disconnected");
		mobile.close();
		const disconnectedMsg = await disconnected;
		expect(disconnectedMsg["uplinkDeviceId"]).toBe("uplink-test-disconnect");
		expect(disconnectedMsg["mobileDeviceId"]).toBe("mobile-test-disconnect");
	});

	it("unpair removes trust and future resume fails", async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "relay-ws-test-"));
		const storePath = join(fixtureDir, "trusted-pairings.json");
		const relayPort = 20700 + Math.floor(Math.random() * 500);

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplink = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplink);
		await waitForOpen(uplink);
		const registered = waitForMessageOfType(uplink, "registered");
		uplink.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-2",
				deviceType: "uplink",
			}),
		);
		const registeredMsg = await registered;
		const pairingCode = registeredMsg["pin"] ?? registeredMsg["pairingCode"];
		if (typeof pairingCode !== "string") {
			throw new Error("expected pairing code");
		}

		const mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobile);
		await waitForOpen(mobile);
		const paired = waitForMessageOfType(mobile, "paired");
		mobile.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-2",
				deviceType: "mobile",
				pin: pairingCode,
			}),
		);
		await paired;

		const unpaired = waitForMessageOfType(mobile, "unpaired");
		mobile.send(
			JSON.stringify({
				type: "unpair",
				deviceId: "mobile-test-2",
				deviceType: "mobile",
				uplinkDeviceId: "uplink-test-2",
			}),
		);
		const unpairedMsg = await unpaired;
		expect(unpairedMsg["uplinkDeviceId"]).toBe("uplink-test-2");
		expect(unpairedMsg["mobileDeviceId"]).toBe("mobile-test-2");

		const mobileReconnect = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobileReconnect);
		await waitForOpen(mobileReconnect);
		const resumeError = waitForMessageOfType(mobileReconnect, "error");
		mobileReconnect.send(
			JSON.stringify({
				type: "resume",
				deviceId: "mobile-test-2",
				deviceType: "mobile",
				uplinkDeviceId: "uplink-test-2",
			}),
		);
		const errorMsg = await resumeError;
		expect(errorMsg["message"]).toBe("Not paired");
	});

	it("relay revocation removes trusted resume without restart", async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "relay-ws-test-"));
		const storePath = join(fixtureDir, "trusted-pairings.json");
		const relayPort = 21300 + Math.floor(Math.random() * 500);

		relayServer = await createRelayServer({
			port: relayPort,
			host: "127.0.0.1",
			pairingStorePath: storePath,
		});
		await relayServer.start();

		const uplink = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(uplink);
		await waitForOpen(uplink);
		const registered = waitForMessageOfType(uplink, "registered");
		uplink.send(
			JSON.stringify({
				type: "register",
				deviceId: "uplink-test-3",
				deviceType: "uplink",
			}),
		);
		const registeredMsg = await registered;
		const pairingCode = registeredMsg["pin"] ?? registeredMsg["pairingCode"];
		if (typeof pairingCode !== "string") {
			throw new Error("expected pairing code");
		}

		const mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobile);
		await waitForOpen(mobile);
		const paired = waitForMessageOfType(mobile, "paired");
		mobile.send(
			JSON.stringify({
				type: "pair",
				deviceId: "mobile-test-3",
				deviceType: "mobile",
				pin: pairingCode,
			}),
		);
		await paired;

		const removed = relayServer.revokeTrustedDevice("uplink-test-3", "mobile-test-3");
		expect(removed).toBe(true);

		const mobileReconnect = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		openSockets.push(mobileReconnect);
		await waitForOpen(mobileReconnect);
		const resumeError = waitForMessageOfType(mobileReconnect, "error");
		mobileReconnect.send(
			JSON.stringify({
				type: "resume",
				deviceId: "mobile-test-3",
				deviceType: "mobile",
				uplinkDeviceId: "uplink-test-3",
			}),
		);
		const errorMsg = await resumeError;
		expect(errorMsg["message"]).toBe("Not paired");
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
		setTimeout(() => reject(new Error("WebSocket open timeout")), 5_000);
	});
}

function waitForMessageOfType(
	ws: WebSocket,
	type: string,
	timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.off("message", handler);
			reject(new Error(`WebSocket message timeout waiting for type ${type}`));
		}, timeoutMs);

		const handler = (data: WebSocket.RawData) => {
			const msg = JSON.parse(data.toString()) as Record<string, unknown>;
			if (msg["type"] === type) {
				clearTimeout(timeout);
				ws.off("message", handler);
				resolve(msg);
			}
		};

		ws.on("message", handler);
	});
}
