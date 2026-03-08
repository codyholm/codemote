import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UplinkServer } from "./server.js";

function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", (err) => {
			server.close(() => reject(err));
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Failed to reserve port")));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

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
		ws.once("message", (data) => resolve(JSON.parse(data.toString())));
		setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);
	});
}

describe("UplinkServer cache", () => {
	let port: number;
	let server: UplinkServer;

	beforeAll(async () => {
		port = await reserveFreePort();
		server = new UplinkServer({ port, host: "127.0.0.1", runtimes: [] });
		await server.start();
	});

	afterAll(async () => {
		await server.stop();
	});

	it("refreshCaches populates availableRuntimes and getCacheSnapshot returns them", async () => {
		await server.refreshCaches();
		const snap = server.getCacheSnapshot();
		expect(snap.availableRuntimes).toBeInstanceOf(Array);
		expect(snap.refreshedAt).toBeTruthy();
		expect(typeof snap.modelCounts).toBe("object");
	});

	it("getCacheSnapshot returns current timestamp", () => {
		const before = new Date().toISOString();
		const snap = server.getCacheSnapshot();
		const after = new Date().toISOString();
		expect(snap.refreshedAt >= before).toBe(true);
		expect(snap.refreshedAt <= after).toBe(true);
	});

	it("refresh_cache command returns cache_refreshed response via WebSocket", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "refresh_cache" }));
			const msg = await msgPromise;

			expect(msg["type"]).toBe("cache_refreshed");
			const payload = msg["payload"] as {
				availableRuntimes: string[];
				modelCounts: Record<string, number>;
			};
			expect(payload.availableRuntimes).toBeInstanceOf(Array);
			expect(typeof payload.modelCounts).toBe("object");
		} finally {
			ws.close();
		}
	});
});
