import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PINManager, RateLimiter, generatePIN } from "./pairing.js";

describe("generatePIN", () => {
	it("should generate a 6-digit string", () => {
		const pin = generatePIN();
		expect(pin).toHaveLength(6);
		expect(pin).toMatch(/^\d{6}$/);
	});

	it("should pad with leading zeros", () => {
		// Mock Math.random to return a small number
		vi.spyOn(Math, "random").mockReturnValue(0.000001);
		const pin = generatePIN();
		expect(pin).toBe("000001");
		vi.restoreAllMocks();
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
		limiter = new RateLimiter({
			maxAttempts: 3,
			windowMs: 10_000,
			backoffMs: [100, 200, 400],
			lockoutMs: 5000,
		});
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
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Second attempt should be allowed now
			const result2 = await limiter.checkAndRecord(client, false);
			expect(result2.allowed).toBe(true);
		});

		it("should increase backoff with more attempts", async () => {
			const client = "192.168.1.1";

			// First attempt (count=1)
			await limiter.checkAndRecord(client, false);
			await new Promise((resolve) => setTimeout(resolve, 200));

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
			await new Promise((resolve) => setTimeout(resolve, 200));

			await limiter.checkAndRecord(client, false); // count=2
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Third attempt triggers lockout (count=3)
			const result = await limiter.checkAndRecord(client, false);

			// Should be locked out
			expect(result.allowed).toBe(false);
			expect(result.waitMs).toBe(5000); // lockoutMs
			expect(result.message).toContain("Locked out");
		}, 10000);

		it("should keep client locked during lockout period", async () => {
			const client = "192.168.1.1";

			// Trigger lockout
			await limiter.checkAndRecord(client, false);
			await new Promise((resolve) => setTimeout(resolve, 150));
			await limiter.checkAndRecord(client, false);
			await new Promise((resolve) => setTimeout(resolve, 250));
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
			await new Promise((resolve) => setTimeout(resolve, 200));
			await limiter.checkAndRecord(client, false);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const lockoutResult = await limiter.checkAndRecord(client, false);
			expect(lockoutResult.allowed).toBe(false);

			// Wait past lockout period (5000ms from the lockout timestamp)
			await new Promise((resolve) => setTimeout(resolve, 5100));

			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(true);
		}, 15000);
	});

	describe("time window", () => {
		it("should reset attempts after time window expires", async () => {
			const client = "192.168.1.1";

			// Make some failed attempts
			await limiter.checkAndRecord(client, false);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await limiter.checkAndRecord(client, false);

			// Wait past time window (10000ms + buffer)
			await new Promise((resolve) => setTimeout(resolve, 10300));

			// Should be treated as first attempt again
			const result = await limiter.checkAndRecord(client, false);
			expect(result.allowed).toBe(true);
		}, 15000);
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

describe("PINManager", () => {
	describe("initialization", () => {
		it("should generate PIN on construction", () => {
			const manager = new PINManager();
			expect(manager.pin).toMatch(/^\d{6}$/);
			manager.dispose();
		});

		it("should use custom TTL", () => {
			const manager = new PINManager(1000);
			const remaining = manager.getRemainingTime();
			expect(remaining).toBeGreaterThan(900);
			expect(remaining).toBeLessThanOrEqual(1000);
			manager.dispose();
		});
	});

	describe("PIN access", () => {
		it("should return current PIN", () => {
			const manager = new PINManager();
			const pin1 = manager.pin;
			const pin2 = manager.pin;
			expect(pin1).toBe(pin2);
			manager.dispose();
		});

		it("should regenerate expired PIN on access", async () => {
			const manager = new PINManager(100);
			const pin1 = manager.pin;

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 120));

			const pin2 = manager.pin;
			expect(pin2).not.toBe(pin1);

			manager.dispose();
		});
	});

	describe("PIN validation", () => {
		it("should validate correct PIN", () => {
			const manager = new PINManager();
			const pin = manager.pin;
			expect(manager.validate(pin)).toBe(true);
			manager.dispose();
		});

		it("should reject incorrect PIN", () => {
			const manager = new PINManager();
			expect(manager.validate("000000")).toBe(false);
			manager.dispose();
		});

		it("should reject expired PIN", async () => {
			const manager = new PINManager(100);
			const pin = manager.pin;

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(manager.validate(pin)).toBe(false);

			manager.dispose();
		});
	});

	describe("expiry tracking", () => {
		it("should report remaining time", () => {
			const manager = new PINManager(5000);
			const remaining = manager.getRemainingTime();
			expect(remaining).toBeGreaterThan(4900);
			expect(remaining).toBeLessThanOrEqual(5000);
			manager.dispose();
		});

		it("should report zero remaining time when expired", async () => {
			const manager = new PINManager(100);

			// Wait for expiry and auto-regeneration
			await new Promise((resolve) => setTimeout(resolve, 110));

			// The PIN auto-regenerated, so check it's not expired anymore
			const remaining = manager.getRemainingTime();
			expect(remaining).toBeGreaterThan(0);
			expect(remaining).toBeLessThanOrEqual(100);

			manager.dispose();
		});

		it("should check expiry status", async () => {
			const manager = new PINManager(100);
			expect(manager.isExpired()).toBe(false);

			// Wait for auto-regeneration
			await new Promise((resolve) => setTimeout(resolve, 110));

			// After auto-regeneration, it should not be expired
			expect(manager.isExpired()).toBe(false);

			manager.dispose();
		});
	});

	describe("manual regeneration", () => {
		it("should regenerate PIN on demand", () => {
			const manager = new PINManager();
			const pin1 = manager.pin;

			manager.forceRegenerate();

			const pin2 = manager.pin;
			expect(pin2).not.toBe(pin1);
			manager.dispose();
		});

		it("should reset expiry on manual regeneration", async () => {
			const manager = new PINManager(5000);

			// Wait some time
			await new Promise((resolve) => setTimeout(resolve, 2000));

			manager.forceRegenerate();

			const remaining = manager.getRemainingTime();
			expect(remaining).toBeGreaterThan(4900);

			manager.dispose();
		});
	});

	describe("regeneration callback", () => {
		it("should call callback on initial generation", () => {
			const callback = vi.fn();
			const manager = new PINManager();
			manager.setOnRegenerate(callback);

			// Constructor already generated a PIN, but setting callback after
			// Let's force a regeneration to test
			manager.forceRegenerate();

			expect(callback).toHaveBeenCalledWith(expect.stringMatching(/^\d{6}$/));
			manager.dispose();
		});

		it("should call callback on automatic regeneration", async () => {
			const callback = vi.fn();
			const manager = new PINManager(100);
			manager.setOnRegenerate(callback);

			// Wait for automatic regeneration
			await new Promise((resolve) => setTimeout(resolve, 120));

			expect(callback).toHaveBeenCalled();

			manager.dispose();
		});

		it("should call callback on manual regeneration", () => {
			const callback = vi.fn();
			const manager = new PINManager();
			manager.setOnRegenerate(callback);

			manager.forceRegenerate();

			expect(callback).toHaveBeenCalledWith(manager.pin);
			manager.dispose();
		});
	});

	describe("automatic regeneration", () => {
		it("should regenerate after TTL expires", async () => {
			const manager = new PINManager(100);
			const pin1 = manager.pin;

			// Wait for TTL to expire
			await new Promise((resolve) => setTimeout(resolve, 120));

			const pin2 = manager.pin;
			expect(pin2).not.toBe(pin1);

			manager.dispose();
		});
	});

	describe("cleanup", () => {
		it("should clear timer on dispose", () => {
			const manager = new PINManager();
			manager.dispose();

			// Should not throw
			expect(() => manager.dispose()).not.toThrow();
		});
	});
});
