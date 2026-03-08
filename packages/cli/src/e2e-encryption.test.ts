import { describe, expect, it } from "vitest";

import { decodeBase64, decrypt, encodeBase64, encrypt, generateKeyPair } from "./encryption.js";
import { validateEncryptedPayload } from "./validateEncryptedPayload.js";

describe("encryption", () => {
	describe("generateKeyPair", () => {
		it("produces 32-byte keys", () => {
			const kp = generateKeyPair();
			expect(kp.publicKey).toBeInstanceOf(Uint8Array);
			expect(kp.secretKey).toBeInstanceOf(Uint8Array);
			expect(kp.publicKey.length).toBe(32);
			expect(kp.secretKey.length).toBe(32);
		});

		it("generates distinct key pairs", () => {
			const a = generateKeyPair();
			const b = generateKeyPair();
			expect(encodeBase64(a.publicKey)).not.toBe(encodeBase64(b.publicKey));
		});
	});

	describe("encrypt / decrypt round-trip", () => {
		it("recovers original plaintext", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();
			const message = "hello from alice to bob";

			const envelope = encrypt(message, bob.publicKey, alice.secretKey, alice.publicKey);
			const recovered = decrypt(envelope, alice.publicKey, bob.secretKey);

			expect(recovered).toBe(message);
		});

		it("handles unicode and multi-byte text", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();
			const message = "emoji: \u{1F680} | kanji: \u6F22\u5B57 | accents: cafe\u0301";

			const envelope = encrypt(message, bob.publicKey, alice.secretKey, alice.publicKey);
			const recovered = decrypt(envelope, alice.publicKey, bob.secretKey);

			expect(recovered).toBe(message);
		});

		it("handles empty plaintext", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();

			const envelope = encrypt("", bob.publicKey, alice.secretKey, alice.publicKey);
			const recovered = decrypt(envelope, alice.publicKey, bob.secretKey);

			expect(recovered).toBe("");
		});
	});

	describe("decrypt failure modes", () => {
		it("throws when decrypting with wrong key", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();
			const eve = generateKeyPair();
			const message = "secret message";

			const envelope = encrypt(message, bob.publicKey, alice.secretKey, alice.publicKey);

			expect(() => decrypt(envelope, alice.publicKey, eve.secretKey)).toThrow("Decryption failed");
		});

		it("throws on tampered ciphertext", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();

			const envelope = encrypt("test", bob.publicKey, alice.secretKey, alice.publicKey);
			const corrupted = { ...envelope, ciphertext: encodeBase64(new Uint8Array(48)) };

			expect(() => decrypt(corrupted, alice.publicKey, bob.secretKey)).toThrow("Decryption failed");
		});
	});

	describe("EncryptedPayload shape", () => {
		it("has all required fields", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();

			const envelope = encrypt("test", bob.publicKey, alice.secretKey, alice.publicKey);

			expect(envelope).toHaveProperty("senderPublicKey");
			expect(envelope).toHaveProperty("ciphertext");
			expect(envelope).toHaveProperty("nonce");
			expect(envelope).toHaveProperty("timestamp");
			expect(typeof envelope.senderPublicKey).toBe("string");
			expect(typeof envelope.ciphertext).toBe("string");
			expect(typeof envelope.nonce).toBe("string");
			expect(typeof envelope.timestamp).toBe("number");
		});

		it("senderPublicKey matches the sender key", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();

			const envelope = encrypt("test", bob.publicKey, alice.secretKey, alice.publicKey);

			expect(envelope.senderPublicKey).toBe(encodeBase64(alice.publicKey));
		});

		it("passes validateEncryptedPayload", () => {
			const alice = generateKeyPair();
			const bob = generateKeyPair();

			const envelope = encrypt("test payload", bob.publicKey, alice.secretKey, alice.publicKey);
			const result = validateEncryptedPayload(envelope);

			expect(result.ok).toBe(true);
		});
	});

	describe("base64 helpers", () => {
		it("round-trips bytes through base64", () => {
			const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
			const encoded = encodeBase64(original);
			const decoded = decodeBase64(encoded);
			expect(decoded).toEqual(original);
		});
	});
});
