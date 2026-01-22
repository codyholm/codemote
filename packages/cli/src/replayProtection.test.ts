import { describe, expect, it } from "vitest";
import { ReplayGuard } from "./replayProtection.js";

describe("ReplayGuard", () => {
	it("rejects duplicate nonce", () => {
		const now = 1_000_000;
		const guard = new ReplayGuard({ now: () => now, windowMs: 5 * 60 * 1000 });

		const payload = {
			senderPublicKey: "sender-pub",
			nonce: "nonce",
			timestamp: now,
		};

		expect(guard.check(payload)).toEqual({ ok: true });
		expect(guard.check(payload)).toEqual({ ok: false, reason: "duplicate_nonce" });
	});

	it("rejects stale timestamp", () => {
		const now = 1_000_000;
		const windowMs = 5 * 60 * 1000;
		const guard = new ReplayGuard({ now: () => now, windowMs });

		const payload = {
			senderPublicKey: "sender-pub",
			nonce: "nonce",
			timestamp: now - windowMs - 1,
		};

		expect(guard.check(payload)).toEqual({ ok: false, reason: "stale_timestamp" });
	});
});
