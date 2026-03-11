export interface EncryptedPayload {
	senderPublicKey: string;
	ciphertext: string;
	nonce: string;
	timestamp: number;
}

/** Sent by bridge after pairing to offer E2E encryption. */
export interface EncryptionOffer {
	type: "encryption_offer";
	publicKey: string;
}

/** Sent by mobile to accept E2E encryption. */
export interface EncryptionAccept {
	type: "encryption_accept";
	publicKey: string;
}

/** Sent by bridge to initiate mid-session key rotation (encrypted). */
export interface EncryptionRotate {
	type: "encryption_rotate";
	publicKey: string;
}

/** Sent by mobile to acknowledge key rotation (encrypted with OLD keys). */
export interface EncryptionRotateAck {
	type: "encryption_rotate_ack";
	publicKey: string;
}
