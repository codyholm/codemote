import { ENCRYPTED_PAYLOAD_LIMITS, isPlausibleBase64 } from "./messageLimits.js";
import type { EncryptedPayload } from "./protocol.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function validateEncryptedPayload(payload: unknown): ValidationResult<EncryptedPayload> {
	if (!isRecord(payload)) {
		return { ok: false, reason: "payload_not_object" };
	}

	const senderPublicKey = payload["senderPublicKey"];
	const nonce = payload["nonce"];
	const ciphertext = payload["ciphertext"];
	const timestamp = payload["timestamp"];

	if (
		typeof senderPublicKey !== "string" ||
		typeof nonce !== "string" ||
		typeof ciphertext !== "string" ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp)
	) {
		return { ok: false, reason: "payload_missing_fields" };
	}

	if (senderPublicKey.length > ENCRYPTED_PAYLOAD_LIMITS.senderPublicKeyBase64Max) {
		return { ok: false, reason: "sender_public_key_too_large" };
	}
	if (nonce.length > ENCRYPTED_PAYLOAD_LIMITS.nonceBase64Max) {
		return { ok: false, reason: "nonce_too_large" };
	}
	if (ciphertext.length > ENCRYPTED_PAYLOAD_LIMITS.ciphertextBase64Max) {
		return { ok: false, reason: "ciphertext_too_large" };
	}

	if (!isPlausibleBase64(senderPublicKey)) {
		return { ok: false, reason: "sender_public_key_not_base64" };
	}
	if (!isPlausibleBase64(nonce)) {
		return { ok: false, reason: "nonce_not_base64" };
	}
	if (!isPlausibleBase64(ciphertext)) {
		return { ok: false, reason: "ciphertext_not_base64" };
	}

	return { ok: true, value: payload as unknown as EncryptedPayload };
}
