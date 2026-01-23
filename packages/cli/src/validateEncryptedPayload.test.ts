import { describe, expect, it } from "vitest";

import { ENCRYPTED_PAYLOAD_LIMITS } from "./messageLimits.js";
import { validateEncryptedPayload } from "./validateEncryptedPayload.js";

describe("validateEncryptedPayload", () => {
	it("accepts a plausible payload", () => {
		const payload = {
			senderPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			ciphertext: "AAAAAAAA",
			timestamp: Date.now(),
		};
		const res = validateEncryptedPayload(payload);
		expect(res.ok).toBe(true);
	});

	it("rejects missing fields", () => {
		const res = validateEncryptedPayload({});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("payload_missing_fields");
	});

	it("rejects oversized ciphertext before decode", () => {
		const payload = {
			senderPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			ciphertext: "A".repeat(ENCRYPTED_PAYLOAD_LIMITS.ciphertextBase64Max + 1),
			timestamp: Date.now(),
		};
		const res = validateEncryptedPayload(payload);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("ciphertext_too_large");
	});

	it("rejects non-base64 fields", () => {
		const payload = {
			senderPublicKey: "not base64!",
			nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			ciphertext: "AAAAAAAA",
			timestamp: Date.now(),
		};
		const res = validateEncryptedPayload(payload);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("sender_public_key_not_base64");
	});
});
