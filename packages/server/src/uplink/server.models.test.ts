import type { ModelInfo } from "@codemote/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { reserveFreePort, waitForMessage, waitForOpen } from "../test-support/network.js";
import { UplinkServer } from "./server.js";

describe("UplinkServer list_models", () => {
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

	it("returns a curated model list per runtime", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "list_models", payload: { profile: "claude" } }));
			const msg = await msgPromise;

			expect(msg["type"]).toBe("model_list");
			const payload = msg["payload"] as {
				runtime: string;
				models: Array<{
					id: string;
					label: string;
					costTier?: ModelInfo["costTier"];
					capabilityTier?: ModelInfo["capabilityTier"];
				}>;
			};

			expect(payload.runtime).toBe("claude");
			expect(payload.models).toEqual([
				{ id: "sonnet", label: "Sonnet", costTier: "medium", capabilityTier: "standard" },
				{ id: "opus", label: "Opus", costTier: "high", capabilityTier: "advanced" },
				{ id: "haiku", label: "Haiku", costTier: "low", capabilityTier: "basic" },
			]);
		} finally {
			ws.close();
		}
	});

	it("returns available runtimes via list_runtimes", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "list_runtimes" }));
			const msg = await msgPromise;

			expect(msg["type"]).toBe("runtime_list");
			const payload = msg["payload"] as { runtimes: string[] };
			// Server started with runtimes: [] so probe finds none
			expect(payload.runtimes).toEqual([]);
		} finally {
			ws.close();
		}
	});
});
