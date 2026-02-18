import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TRUSTED_PAIRINGS_FILE_VERSION = 1;

interface TrustedPairingsFile {
	version: number;
	updatedAt: number;
	records: TrustedPairingRecord[];
}

export interface TrustedPairingRecord {
	uplinkDeviceId: string;
	mobileDeviceId: string;
	pairedAt: number;
	lastSeenAt: number;
}

interface TrustedPairingsStoreOptions {
	filePath: string;
	enabled?: boolean;
	log?: (message: string) => void;
}

function isTrustedPairingRecord(value: unknown): value is TrustedPairingRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TrustedPairingRecord>;
	return (
		typeof record.uplinkDeviceId === "string" &&
		record.uplinkDeviceId.length > 0 &&
		typeof record.mobileDeviceId === "string" &&
		record.mobileDeviceId.length > 0 &&
		typeof record.pairedAt === "number" &&
		Number.isFinite(record.pairedAt) &&
		typeof record.lastSeenAt === "number" &&
		Number.isFinite(record.lastSeenAt)
	);
}

/**
 * File-backed trusted mobile<->uplink pairings.
 *
 * Persistence is JSON + atomic rename, with in-memory lookup for fast resume checks.
 */
export class TrustedPairingsStore {
	private readonly filePath: string;
	private readonly enabled: boolean;
	private readonly log: (message: string) => void;
	private readonly trustedByUplink = new Map<string, Map<string, TrustedPairingRecord>>();
	private persistHealthy = true;

	constructor(options: TrustedPairingsStoreOptions) {
		this.filePath = options.filePath;
		this.enabled = options.enabled ?? true;
		this.log = options.log ?? (() => {});

		if (this.enabled) {
			this.loadFromDisk();
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	hasPersistenceFailure(): boolean {
		return !this.persistHealthy;
	}

	recordCount(): number {
		let count = 0;
		for (const byMobile of this.trustedByUplink.values()) {
			count += byMobile.size;
		}
		return count;
	}

	isTrusted(uplinkDeviceId: string, mobileDeviceId: string): boolean {
		return this.trustedByUplink.get(uplinkDeviceId)?.has(mobileDeviceId) ?? false;
	}

	markPaired(uplinkDeviceId: string, mobileDeviceId: string, now = Date.now()): void {
		let byMobile = this.trustedByUplink.get(uplinkDeviceId);
		if (!byMobile) {
			byMobile = new Map<string, TrustedPairingRecord>();
			this.trustedByUplink.set(uplinkDeviceId, byMobile);
		}

		const existing = byMobile.get(mobileDeviceId);
		if (existing) {
			existing.lastSeenAt = now;
		} else {
			byMobile.set(mobileDeviceId, {
				uplinkDeviceId,
				mobileDeviceId,
				pairedAt: now,
				lastSeenAt: now,
			});
		}

		this.persist();
	}

	markSeen(uplinkDeviceId: string, mobileDeviceId: string, now = Date.now()): boolean {
		const record = this.trustedByUplink.get(uplinkDeviceId)?.get(mobileDeviceId);
		if (!record) return false;
		record.lastSeenAt = now;
		this.persist();
		return true;
	}

	listForUplink(uplinkDeviceId: string): TrustedPairingRecord[] {
		const records = Array.from(this.trustedByUplink.get(uplinkDeviceId)?.values() ?? []);
		records.sort(
			(a, b) => b.lastSeenAt - a.lastSeenAt || a.mobileDeviceId.localeCompare(b.mobileDeviceId),
		);
		return records.map((record) => ({ ...record }));
	}

	revoke(uplinkDeviceId: string, mobileDeviceId: string): boolean {
		const byMobile = this.trustedByUplink.get(uplinkDeviceId);
		if (!byMobile) return false;

		const removed = byMobile.delete(mobileDeviceId);
		if (!removed) return false;

		if (byMobile.size === 0) {
			this.trustedByUplink.delete(uplinkDeviceId);
		}

		this.persist();
		return true;
	}

	revokeAllForUplink(uplinkDeviceId: string): number {
		const byMobile = this.trustedByUplink.get(uplinkDeviceId);
		if (!byMobile) return 0;

		const removed = byMobile.size;
		this.trustedByUplink.delete(uplinkDeviceId);
		this.persist();
		return removed;
	}

	private loadFromDisk(): void {
		this.ensureParentDirectory();

		if (!existsSync(this.filePath)) {
			this.persist();
			return;
		}

		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<TrustedPairingsFile>;
			if (
				parsed.version !== TRUSTED_PAIRINGS_FILE_VERSION ||
				typeof parsed.updatedAt !== "number" ||
				!Array.isArray(parsed.records)
			) {
				throw new Error("Invalid trusted pairings format");
			}

			this.trustedByUplink.clear();
			for (const record of parsed.records) {
				if (!isTrustedPairingRecord(record)) continue;
				let byMobile = this.trustedByUplink.get(record.uplinkDeviceId);
				if (!byMobile) {
					byMobile = new Map<string, TrustedPairingRecord>();
					this.trustedByUplink.set(record.uplinkDeviceId, byMobile);
				}
				byMobile.set(record.mobileDeviceId, { ...record });
			}
			this.persistHealthy = true;
		} catch (error) {
			const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
			try {
				renameSync(this.filePath, corruptPath);
				this.log(
					`[relay] trusted pairings file was corrupt, moved to ${corruptPath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} catch (renameError) {
				this.log(
					`[relay] failed to move corrupt trusted pairings file: ${
						renameError instanceof Error ? renameError.message : String(renameError)
					}`,
				);
			}

			this.trustedByUplink.clear();
			this.persist();
		}
	}

	private persist(): void {
		if (!this.enabled) return;

		try {
			this.ensureParentDirectory();
			const fileData: TrustedPairingsFile = {
				version: TRUSTED_PAIRINGS_FILE_VERSION,
				updatedAt: Date.now(),
				records: this.flattenRecords(),
			};
			const tmpPath = `${this.filePath}.tmp`;
			writeFileSync(tmpPath, `${JSON.stringify(fileData, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(tmpPath, this.filePath);
			chmodSync(this.filePath, 0o600);
			this.persistHealthy = true;
		} catch (error) {
			this.persistHealthy = false;
			this.log(
				`[relay] failed to persist trusted pairings: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private flattenRecords(): TrustedPairingRecord[] {
		const records: TrustedPairingRecord[] = [];
		for (const byMobile of this.trustedByUplink.values()) {
			for (const record of byMobile.values()) {
				records.push({ ...record });
			}
		}
		records.sort(
			(a, b) =>
				a.uplinkDeviceId.localeCompare(b.uplinkDeviceId) ||
				a.mobileDeviceId.localeCompare(b.mobileDeviceId),
		);
		return records;
	}

	private ensureParentDirectory(): void {
		mkdirSync(dirname(this.filePath), {
			recursive: true,
			mode: 0o700,
		});
	}
}
