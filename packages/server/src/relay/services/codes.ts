import { customAlphabet } from "nanoid";

// Canonical onboarding token: 6-digit numeric PIN
const generateCode = customAlphabet("0123456789", 6);

const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface PairingCode {
	code: string;
	uplinkDeviceId: string;
	createdAt: number;
	expiresAt: number;
	usedAt?: number;
	mobileDeviceId?: string;
}

/**
 * Service for managing pairing codes (numeric PINs).
 * Codes are 6-digit numeric strings, single-use, with 15-minute TTL.
 */
export class PairingCodeService {
	private codes = new Map<string, PairingCode>();

	/**
	 * Generate a new pairing code for an Uplink.
	 * @param uplinkDeviceId - The Uplink device identifier
	 * @returns The generated 6-character code
	 */
	create(uplinkDeviceId: string): string {
		const code = generateCode();
		const now = Date.now();

		// PIN refresh should invalidate previous unused PINs for this uplink.
		for (const [key, entry] of this.codes) {
			if (entry.uplinkDeviceId === uplinkDeviceId && entry.usedAt === undefined) {
				this.codes.delete(key);
			}
		}

		this.codes.set(code, {
			code,
			uplinkDeviceId,
			createdAt: now,
			expiresAt: now + CODE_TTL_MS,
		});

		return code;
	}

	/**
	 * Validate and consume a pairing code.
	 * @param code - The pairing code to validate
	 * @param mobileDeviceId - The mobile device identifier
	 * @returns The Uplink device ID if valid, null otherwise
	 */
	consume(code: string, mobileDeviceId: string): string | null {
		const now = Date.now();
		const normalizedCode = code.toUpperCase();

		const entry = this.codes.get(normalizedCode);
		if (!entry) return null;
		if (entry.expiresAt <= now) return null;
		if (entry.usedAt !== undefined) return null;

		// Mark as used
		entry.usedAt = now;
		entry.mobileDeviceId = mobileDeviceId;

		return entry.uplinkDeviceId;
	}

	/**
	 * Clean up expired codes.
	 * @returns Number of codes removed
	 */
	cleanup(): number {
		const now = Date.now();
		let removed = 0;

		for (const [key, entry] of this.codes) {
			if (entry.expiresAt < now) {
				this.codes.delete(key);
				removed++;
			}
		}

		return removed;
	}
}
