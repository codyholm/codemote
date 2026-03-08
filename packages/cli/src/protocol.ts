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
