import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { reserveFreePort, waitForMessage, waitForOpen } from "../test-support/network.js";
import { UplinkServer } from "./server.js";

describe("UplinkServer security", () => {
	it("does not leak raw JSON parse errors", async () => {
		const port = await reserveFreePort();
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
