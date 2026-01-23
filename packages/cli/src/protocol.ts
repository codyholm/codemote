export interface EncryptedPayload {
	senderPublicKey: string;
	ciphertext: string;
	nonce: string;
	timestamp: number;
}
