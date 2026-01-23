export const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

export const ENCRYPTED_PAYLOAD_LIMITS = {
	// NaCl box key is 32 bytes. Base64 is typically 44 chars (with padding).
	senderPublicKeyBase64Max: 64,
	// NaCl box nonce is 24 bytes. Base64 is typically 32 chars.
	nonceBase64Max: 64,
	// Cap ciphertext size to prevent allocation DoS in Buffer.from(..., "base64").
	// Note: base64 expands by ~4/3, so 128 KiB bytes corresponds to ~171 KiB base64 chars.
	ciphertextBase64Max: 192 * 1024,
} as const;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function isPlausibleBase64(value: string): boolean {
	if (value.length === 0) return false;
	if (value.length % 4 !== 0) return false;
	return BASE64_RE.test(value);
}
