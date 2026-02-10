import type Database from "better-sqlite3";
import { customAlphabet } from "nanoid";

// Canonical onboarding token: 6-digit numeric PIN
const generateCode = customAlphabet("0123456789", 6);

const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Service for managing pairing codes (numeric PINs).
 * Codes are 6-digit numeric strings, single-use, with 15-minute TTL.
 */
export class PairingCodeService {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/**
	 * Generate a new pairing code for an Uplink.
	 * @param uplinkDeviceId - The Uplink device identifier
	 * @returns The generated 6-character code
	 */
	create(uplinkDeviceId: string): string {
		const code = generateCode();
		const now = Date.now();

		const invalidateAndInsert = this.db.transaction(
			(nextCode: string, nextUplinkDeviceId: string, createdAt: number, expiresAt: number) => {
				// PIN refresh should invalidate previous unused PINs for this uplink.
				this.db
					.prepare(
						`
	      DELETE FROM pairing_codes
	      WHERE uplink_device_id = ? AND used_at IS NULL
	    `,
					)
					.run(nextUplinkDeviceId);

				this.db
					.prepare(
						`
	      INSERT INTO pairing_codes (code, uplink_device_id, created_at, expires_at)
	      VALUES (?, ?, ?, ?)
	    `,
					)
					.run(nextCode, nextUplinkDeviceId, createdAt, expiresAt);
			},
		);

		invalidateAndInsert(code, uplinkDeviceId, now, now + CODE_TTL_MS);

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

		// Find valid, unused code
		const row = this.db
			.prepare(
				`
      SELECT uplink_device_id FROM pairing_codes
      WHERE code = ? AND expires_at > ? AND used_at IS NULL
    `,
			)
			.get(normalizedCode, now) as { uplink_device_id: string } | undefined;

		if (!row) return null;

		// Mark as used
		this.db
			.prepare(
				`
      UPDATE pairing_codes
      SET used_at = ?, mobile_device_id = ?
      WHERE code = ?
    `,
			)
			.run(now, mobileDeviceId, normalizedCode);

		return row.uplink_device_id;
	}

	/**
	 * Clean up expired codes.
	 * @returns Number of codes removed
	 */
	cleanup(): number {
		const result = this.db
			.prepare(
				`
      DELETE FROM pairing_codes WHERE expires_at < ?
    `,
			)
			.run(Date.now());

		return result.changes;
	}
}
