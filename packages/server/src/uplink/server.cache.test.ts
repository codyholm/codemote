import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { reserveFreePort, waitForMessage, waitForOpen } from "../test-support/network.js";
import { UplinkServer } from "./server.js";

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

	it("does not register a fake executor when no runtime is available", () => {
		expect(server.getExecutor("opencode")).toBeUndefined();
		expect(server.getExecutor("claude")).toBeUndefined();
		expect(server.getExecutor("codex")).toBeUndefined();
		expect(server.getExecutor("gemini")).toBeUndefined();
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
