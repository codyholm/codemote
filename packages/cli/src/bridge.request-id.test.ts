import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("request-ID correlation", () => {
	it("tags command with requestId for correlation", () => {
		const requestId = randomUUID();
		const command = { type: "ping" as const };
		const tagged = { ...command, requestId };

		expect(tagged).toHaveProperty("type", "ping");
		expect(tagged).toHaveProperty("requestId");
		expect(typeof tagged.requestId).toBe("string");
		expect(tagged.requestId).toHaveLength(36); // UUID v4 format
	});

	it("matches response to request by requestId", () => {
		// Simulate the bridge's waiter matching logic
		interface Waiter {
			requestId: string;
			expectedType: string;
			resolve: (value: unknown) => void;
		}

		const pending: Waiter[] = [];
		const results: string[] = [];

		// Simulate two concurrent requests
		const id1 = randomUUID();
		const id2 = randomUUID();
		pending.push({
			requestId: id1,
			expectedType: "pong",
			resolve: (v) => results.push(`req1:${v}`),
		});
		pending.push({
			requestId: id2,
			expectedType: "pong",
			resolve: (v) => results.push(`req2:${v}`),
		});

		// Response for request 2 arrives first
		const response2 = { type: "pong", requestId: id2 };
		let idx = pending.findIndex((w) => w.requestId === response2.requestId);
		expect(idx).toBe(1);
		const [waiter2] = pending.splice(idx, 1);
		expect(waiter2).toBeDefined();
		waiter2?.resolve("second");

		// Response for request 1 arrives second
		const response1 = { type: "pong", requestId: id1 };
		idx = pending.findIndex((w) => w.requestId === response1.requestId);
		expect(idx).toBe(0);
		const [waiter1] = pending.splice(idx, 1);
		expect(waiter1).toBeDefined();
		waiter1?.resolve("first");

		expect(results).toEqual(["req2:second", "req1:first"]);
	});

	it("falls back to type-based matching when requestId is absent", () => {
		interface Waiter {
			requestId: string;
			expectedType: string;
		}

		const pending: Waiter[] = [
			{ requestId: randomUUID(), expectedType: "pong" },
			{ requestId: randomUUID(), expectedType: "sessions" },
		];

		// Response without requestId -- falls back to type matching
		const response = { type: "sessions" };
		const responseId = (response as { requestId?: string }).requestId;
		let idx = -1;
		if (responseId) {
			idx = pending.findIndex((w) => w.requestId === responseId);
		}
		if (idx < 0) {
			idx = pending.findIndex((w) => w.expectedType === response.type);
		}

		expect(idx).toBe(1);
	});
});
