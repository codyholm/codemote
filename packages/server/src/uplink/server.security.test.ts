import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UplinkServer } from "./server.js";

describe("UplinkServer security", () => {
	it("does not leak raw JSON parse errors", async () => {
		const port = 9960 + Math.floor(Math.random() * 50);
		const server = new UplinkServer({ port, host: "127.0.0.1", runtimes: [] });
		await server.start();
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			await waitForOpen(ws);

			const msgPromise = waitForMessage(ws);
			ws.send("not json");
			const msg = await msgPromise;
			expect(msg["type"]).toBe("error");
			const payload = msg["payload"] as Record<string, unknown>;
			expect(payload["message"]).toBe("Invalid request");
			ws.close();
		} finally {
			await server.stop();
		}
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

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		ws.once("message", (data) => resolve(JSON.parse(data.toString())));
		setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);
	});
}
