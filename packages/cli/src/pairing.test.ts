import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, generatePIN } from "./pairing.js";

describe("generatePIN", () => {
	it("should generate a 6-digit string", () => {
		const pin = generatePIN();
		expect(pin).toHaveLength(6);
		expect(pin).toMatch(/^\d{6}$/);
	});

	it("can produce leading zeros", () => {
		let found = false;
		for (let i = 0; i < 5000; i++) {
			if (generatePIN().startsWith("0")) {
				found = true;
				break;
			}
		}
		expect(found).toBe(true);
	});

	it("should generate different PINs", () => {
		const pins = new Set();
		for (let i = 0; i < 100; i++) {
			pins.add(generatePIN());
		}
		// With 100 attempts, we should get at least some different values
		expect(pins.size).toBeGreaterThan(50);
	});

	it("should generate PINs in valid range", () => {
		for (let i = 0; i < 100; i++) {
			const pin = generatePIN();
			const num = Number.parseInt(pin, 10);
			expect(num).toBeGreaterThanOrEqual(0);
			expect(num).toBeLessThan(1_000_000);
		}
	});
});

describe("RateLimiter", () => {
	let limiter: RateLimiter;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		limiter = new RateLimiter({
			maxAttempts: 3,
			windowMs: 10_000,
			backoffMs: [100, 200, 400],
			lockoutMs: 5000,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("basic rate limiting", () => {
		it("should allow first attempt", async () => {
			const result = await limiter.checkAndRecord("192.168.1.1", false);
			expect(result.allowed).toBe(true);
			expect(result.message).toBeUndefined();
		});

		it("should clear record on successful attempt", async () => {
			await limiter.checkAndRecord("192.168.1.1", false);
			await limiter.checkAndRecord("192.168.1.1", false);

			const result = await limiter.checkAndRecord("192.168.1.1", true);
			expect(result.allowed).toBe(true);

			// Next attempt should be treated as first attempt
			const nextResult = await limiter.checkAndRecord("192.168.1.1", false);
			expect(nextResult.allowed).toBe(true);
		});

		it("should track separate clients independently", async () => {
			await limiter.checkAndRecord("192.168.1.1", false);
			await limiter.checkAndRecord("192.168.1.1", false);

			const result1 = await limiter.checkAndRecord("192.168.1.1", false);
			expect(result1.allowed).toBe(false); // Should hit backoff

			const result2 = await limiter.checkAndRecord("192.168.1.2", false);
			expect(result2.allowed).toBe(true); // Different client
		});
	});

	describe("exponential backoff", () => {
		it("should apply backoff after failed attempts", async () => {
			const client = "192.168.1.1";

			// First attempt - allowed and recorded (count becomes 1)
			await limiter.checkAndRecord(client, false);

			// Second attempt immediately - should be blocked by backoff
			// backoff for count=1 is backoffMs[0] = 100ms
			const result2 = await limiter.checkAndRecord(client, false);
			expect(result2.allowed).toBe(false);
			expect(result2.waitMs).toBeGreaterThan(0);
			expect(result2.message).toContain("Wait");
		});

		it("should allow attempt after sufficient wait", async () => {
			const client = "192.168.1.1";

			// First attempt - allowed (count=1)
			const result1 = await limiter.checkAndRecord(client, false);
			expect(result1.allowed).toBe(true);

			// Wait well past backoff period
			vi.advanceTimersByTime(200);

			// Second attempt should be allowed now
			const result2 = await limiter.checkAndRecord(client, false);
			expect(result2.allowed).toBe(true);
		});

		it("should increase backoff with more attempts", async () => {
			const client = "192.168.1.1";

			// First attempt (count=1)
			await limiter.checkAndRecord(client, false);
			vi.advanceTimersByTime(200);

			// Second attempt (count=2)
			await limiter.checkAndRecord(client, false);

			// Try third attempt immediately - should be blocked with backoff
			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(false);
			expect(result.waitMs).toBeGreaterThan(50); // Has some backoff remaining
		});
	});

	describe("lockout mechanism", () => {
		it("should lock out client after max attempts", async () => {
			const client = "192.168.1.1";

			// Make 3 attempts (max is 3) waiting between each to pass backoff
			await limiter.checkAndRecord(client, false); // count=1
			vi.advanceTimersByTime(200);

			await limiter.checkAndRecord(client, false); // count=2
			vi.advanceTimersByTime(300);

			// Third attempt triggers lockout (count=3)
			const result = await limiter.checkAndRecord(client, false);

			// Should be locked out
			expect(result.allowed).toBe(false);
			expect(result.waitMs).toBe(5000); // lockoutMs
			expect(result.message).toContain("Locked out");
		});

		it("should keep client locked during lockout period", async () => {
			const client = "192.168.1.1";

			// Trigger lockout
			await limiter.checkAndRecord(client, false);
			vi.advanceTimersByTime(150);
			await limiter.checkAndRecord(client, false);
			vi.advanceTimersByTime(250);
			await limiter.checkAndRecord(client, false);

			// Try again immediately
			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(false);
			expect(result.message).toContain("Locked out");
		});

		it("should allow attempts after lockout expires", async () => {
			const client = "192.168.1.1";

			// Trigger lockout
			await limiter.checkAndRecord(client, false);
			// Wait comfortably past backoff (100ms) for attempt #2.
			vi.advanceTimersByTime(300);
			const secondAttempt = await limiter.checkAndRecord(client, false);
			if (!secondAttempt.allowed) {
				vi.advanceTimersByTime((secondAttempt.waitMs ?? 0) + 50);
				await limiter.checkAndRecord(client, false);
			}
			vi.advanceTimersByTime(300);
			const lockoutResult = await limiter.checkAndRecord(client, false);
			expect(lockoutResult.allowed).toBe(false);

			// Wait past lockout period (5000ms from the lockout timestamp)
			vi.advanceTimersByTime(5100);

			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(true);
		});
	});

	describe("time window", () => {
		it("should reset attempts after time window expires", async () => {
			const client = "192.168.1.1";

			// Make some failed attempts
			await limiter.checkAndRecord(client, false);
			vi.advanceTimersByTime(200);
			await limiter.checkAndRecord(client, false);

			// Wait past time window (10000ms + buffer)
			vi.advanceTimersByTime(10300);

			// Should be treated as first attempt again
			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(true);
		});
	});

	describe("reset method", () => {
		it("should clear client record", async () => {
			const client = "192.168.1.1";

			await limiter.checkAndRecord(client, false);
			await limiter.checkAndRecord(client, false);

			limiter.reset(client);

			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(true);
		});
	});

	describe("utility methods", () => {
		it("should get attempt record", async () => {
			const client = "192.168.1.1";

			expect(limiter.getAttemptRecord(client)).toBeUndefined();

			await limiter.checkAndRecord(client, false);

			const record = limiter.getAttemptRecord(client);
			expect(record).toBeDefined();
			expect(record?.count).toBe(1);
		});

		it("should clear all records", async () => {
			await limiter.checkAndRecord("192.168.1.1", false);
			await limiter.checkAndRecord("192.168.1.2", false);

			limiter.clear();

			expect(limiter.getAttemptRecord("192.168.1.1")).toBeUndefined();
			expect(limiter.getAttemptRecord("192.168.1.2")).toBeUndefined();
		});
	});
});
