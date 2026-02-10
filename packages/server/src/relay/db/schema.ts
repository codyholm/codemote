import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Create and initialize the relay database.
 * Stores only metadata - never message content (zero-knowledge).
 */
export function createDatabase(dbPath?: string): Database.Database {
	const path = dbPath || join(process.cwd(), "relay.db");
	const db = new Database(path);

	// Enable WAL mode for better concurrency
	db.pragma("journal_mode = WAL");

	// Create tables
	db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      uplink_device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      mobile_device_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      uplink_device_id TEXT NOT NULL,
      mobile_device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      session_id TEXT NOT NULL,
      device_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      keys TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, device_type)
    );

    CREATE INDEX IF NOT EXISTS idx_codes_expires ON pairing_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at);
  `);

	return db;
}
