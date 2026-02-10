import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairingCodeService } from "./codes";

describe("PairingCodeService", () => {
	let db: Database.Database;
	let service: PairingCodeService;

	beforeEach(() => {
		// Use in-memory SQLite database for tests
		db = new Database(":memory:");

		// Create the pairing_codes table
		db.exec(`
			CREATE TABLE pairing_codes (
				code TEXT PRIMARY KEY,
				uplink_device_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				used_at INTEGER,
				mobile_device_id TEXT
			)
		`);

		service = new PairingCodeService(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("create", () => {
		it("generates a 6-character code", () => {
			const code = service.create("pk_uplink_123");

			expect(code).toHaveLength(6);
		});

		it("generates a 6-digit numeric PIN", () => {
			const code = service.create("pk_uplink_123");

			expect(code).toMatch(/^\d{6}$/);
		});

		it("stores code in database with correct fields", () => {
			const uplinkKey = "pk_uplink_test";
			const code = service.create(uplinkKey);

			const row = db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code) as {
				code: string;
				uplink_device_id: string;
				created_at: number;
				expires_at: number;
				used_at: number | null;
			};

			expect(row).toBeDefined();
			expect(row.uplink_device_id).toBe(uplinkKey);
			expect(row.created_at).toBeLessThanOrEqual(Date.now());
			expect(row.expires_at).toBeGreaterThan(row.created_at);
			expect(row.used_at).toBeNull();
		});

		it("generates unique codes", () => {
			const codes = new Set<string>();

			for (let i = 0; i < 10; i++) {
				codes.add(service.create(`pk_uplink_${i}`));
			}

			// All codes should be unique
			expect(codes.size).toBe(10);
		});

		it("invalidates previous unused PINs for the same uplink on refresh", () => {
			const uplinkDeviceId = "pk_uplink_refresh";
			const firstCode = service.create(uplinkDeviceId);
			const secondCode = service.create(uplinkDeviceId);

			expect(firstCode).not.toBe(secondCode);
			expect(service.consume(firstCode, "pk_mobile_old_pin")).toBeNull();
			expect(service.consume(secondCode, "pk_mobile_new_pin")).toBe(uplinkDeviceId);

			const rows = db
				.prepare("SELECT code FROM pairing_codes WHERE uplink_device_id = ?")
				.all(uplinkDeviceId) as Array<{ code: string }>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.code).toBe(secondCode);
		});
	});

	describe("consume", () => {
		it("returns uplinkDeviceId for valid code", () => {
			const uplinkKey = "pk_uplink_valid";
			const code = service.create(uplinkKey);

			const result = service.consume(code, "pk_mobile_123");

			expect(result).toBe(uplinkKey);
		});

		it("marks code as used after consumption", () => {
			const code = service.create("pk_uplink_test");

			service.consume(code, "pk_mobile_123");

			const row = db
				.prepare("SELECT used_at, mobile_device_id FROM pairing_codes WHERE code = ?")
				.get(code) as { used_at: number | null; mobile_device_id: string | null };

			expect(row.used_at).not.toBeNull();
			expect(row.mobile_device_id).toBe("pk_mobile_123");
		});

		it("returns null for already consumed code", () => {
			const code = service.create("pk_uplink_test");

			// First consume should succeed
			const first = service.consume(code, "pk_mobile_1");
			expect(first).not.toBeNull();

			// Second consume should fail
			const second = service.consume(code, "pk_mobile_2");
			expect(second).toBeNull();
		});

		it("returns null for expired code", () => {
			// Insert an already-expired code directly
			const expiredCode = "123456";
			const now = Date.now();

			db.prepare(`
				INSERT INTO pairing_codes (code, uplink_device_id, created_at, expires_at)
				VALUES (?, ?, ?, ?)
			`).run(expiredCode, "pk_uplink_expired", now - 10000, now - 5000);

			const result = service.consume(expiredCode, "pk_mobile_123");

			expect(result).toBeNull();
		});

		it("returns null for non-existent code", () => {
			const result = service.consume("999999", "pk_mobile_123");

			expect(result).toBeNull();
		});
	});

	describe("cleanup", () => {
		it("removes expired codes", () => {
			const now = Date.now();

			// Insert expired codes directly
			db.prepare(`
				INSERT INTO pairing_codes (code, uplink_device_id, created_at, expires_at)
				VALUES (?, ?, ?, ?)
			`).run("EXPIR1", "pk_1", now - 20000, now - 10000);

			db.prepare(`
				INSERT INTO pairing_codes (code, uplink_device_id, created_at, expires_at)
				VALUES (?, ?, ?, ?)
			`).run("EXPIR2", "pk_2", now - 20000, now - 5000);

			// Create a valid code (not expired)
			const validCode = service.create("pk_valid");

			const removed = service.cleanup();

			expect(removed).toBe(2);

			// Valid code should still exist
			const validRow = db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(validCode);
			expect(validRow).toBeDefined();
		});

		it("returns 0 when no expired codes", () => {
			// Create only valid codes
			service.create("pk_1");
			service.create("pk_2");

			const removed = service.cleanup();

			expect(removed).toBe(0);
		});

		it("removes used but expired codes", () => {
			const now = Date.now();

			// Insert expired and used code
			db.prepare(`
				INSERT INTO pairing_codes (code, uplink_device_id, created_at, expires_at, used_at, mobile_device_id)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run("USEDEX", "pk_uplink", now - 20000, now - 10000, now - 15000, "pk_mobile");

			const removed = service.cleanup();

			expect(removed).toBe(1);
		});
	});
});
