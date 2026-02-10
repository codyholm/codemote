import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairingCodeService } from "./codes";

describe("PairingCodeService", () => {
	let service: PairingCodeService;

	beforeEach(() => {
		service = new PairingCodeService();
	});

	describe("create", () => {
		it("generates a 6-character code", () => {
			const code = service.create("pk_uplink_123");

			expect(code).toHaveLength(6);
		});

		it("generates a 6-digit numeric PIN", () => {
			const code = service.create("pk_uplink_123");

			expect(code).toMatch(/^\d{6}$/);
		});

		it("generates unique codes", () => {
			const codes = new Set<string>();

			for (let i = 0; i < 10; i++) {
				codes.add(service.create(`pk_uplink_${i}`));
			}

			// All codes should be unique
			expect(codes.size).toBe(10);
		});

		it("invalidates previous unused PINs for the same uplink on refresh", () => {
			const uplinkDeviceId = "pk_uplink_refresh";
			const firstCode = service.create(uplinkDeviceId);
			const secondCode = service.create(uplinkDeviceId);

			expect(firstCode).not.toBe(secondCode);
			expect(service.consume(firstCode, "pk_mobile_old_pin")).toBeNull();
			expect(service.consume(secondCode, "pk_mobile_new_pin")).toBe(uplinkDeviceId);
		});
	});

	describe("consume", () => {
		it("returns uplinkDeviceId for valid code", () => {
			const uplinkKey = "pk_uplink_valid";
			const code = service.create(uplinkKey);

			const result = service.consume(code, "pk_mobile_123");

			expect(result).toBe(uplinkKey);
		});

		it("returns null for already consumed code", () => {
			const code = service.create("pk_uplink_test");

			// First consume should succeed
			const first = service.consume(code, "pk_mobile_1");
			expect(first).not.toBeNull();

			// Second consume should fail
			const second = service.consume(code, "pk_mobile_2");
			expect(second).toBeNull();
		});

		it("returns null for expired code", () => {
			const code = service.create("pk_uplink_expired");

			// Advance time past the 15-minute TTL
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + 16 * 60 * 1000);

			const result = service.consume(code, "pk_mobile_123");
			expect(result).toBeNull();

			vi.useRealTimers();
		});

		it("returns null for non-existent code", () => {
			const result = service.consume("999999", "pk_mobile_123");

			expect(result).toBeNull();
		});
	});

	describe("cleanup", () => {
		it("removes expired codes", () => {
			service.create("pk_1");
			service.create("pk_2");
			const validCode = service.create("pk_valid");

			// Advance time past TTL
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + 16 * 60 * 1000);

			// Create a fresh code (not expired)
			const freshCode = service.create("pk_fresh");

			const removed = service.cleanup();

			// The 3 old codes should be expired (pk_1 and pk_2 were deleted by create("pk_valid")... no wait)
			// pk_1, pk_2, pk_valid are all expired; freshCode is not
			expect(removed).toBe(3);

			// Fresh code should still be consumable
			expect(service.consume(freshCode, "pk_mobile")).not.toBeNull();

			vi.useRealTimers();
		});

		it("returns 0 when no expired codes", () => {
			service.create("pk_1");
			service.create("pk_2");

			const removed = service.cleanup();

			expect(removed).toBe(0);
		});
	});
});
