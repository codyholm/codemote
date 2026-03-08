import nacl from "tweetnacl";
import type { EncryptedPayload } from "./protocol.js";

export interface KeyPair {
	publicKey: Uint8Array;
	secretKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
	return nacl.box.keyPair();
}

export function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(str: string): Uint8Array {
	return new Uint8Array(Buffer.from(str, "base64"));
}

export function encrypt(
	plaintext: string,
	recipientPublicKey: Uint8Array,
	senderSecretKey: Uint8Array,
	senderPublicKey: Uint8Array,
): EncryptedPayload {
	const nonce = nacl.randomBytes(nacl.box.nonceLength);
	const messageBytes = new TextEncoder().encode(plaintext);
	const ciphertext = nacl.box(messageBytes, nonce, recipientPublicKey, senderSecretKey);
	if (!ciphertext) throw new Error("Encryption failed");
	return {
		senderPublicKey: encodeBase64(senderPublicKey),
		ciphertext: encodeBase64(ciphertext),
		nonce: encodeBase64(nonce),
		timestamp: Date.now(),
	};
}

export function decrypt(
	payload: EncryptedPayload,
	senderPublicKey: Uint8Array,
	recipientSecretKey: Uint8Array,
): string {
	const ciphertext = decodeBase64(payload.ciphertext);
	const nonce = decodeBase64(payload.nonce);
	const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
	if (!plaintext) throw new Error("Decryption failed -- invalid key or corrupted message");
	return new TextDecoder().decode(plaintext);
}
