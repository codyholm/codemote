export interface ReplayProtectedPayload {
	senderPublicKey: string;
	nonce: string;
	timestamp: number;
}

export type ReplayCheckFailureReason = "duplicate_nonce" | "stale_timestamp" | "invalid_timestamp";

export type ReplayCheckResult =
	| { ok: true }
	| {
			ok: false;
			reason: ReplayCheckFailureReason;
	  };

export interface ReplayGuardConfig {
	windowMs?: number;
	maxEntries?: number;
	now?: () => number;
}

export class ReplayGuard {
	private readonly windowMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly seen = new Map<string, { expiresAt: number }>();
	private lastPruneAt = 0;

	constructor(config: ReplayGuardConfig = {}) {
		this.windowMs = config.windowMs ?? 5 * 60 * 1000;
		this.maxEntries = config.maxEntries ?? 2048;
		this.now = config.now ?? (() => Date.now());
	}

	check(payload: ReplayProtectedPayload): ReplayCheckResult {
		const now = this.now();

		if (!Number.isFinite(payload.timestamp)) {
			return { ok: false, reason: "invalid_timestamp" };
		}

		if (Math.abs(payload.timestamp - now) > this.windowMs) {
			return { ok: false, reason: "stale_timestamp" };
		}

		this.maybePrune(now);

		const key = `${payload.senderPublicKey}|${payload.nonce}`;
		if (this.seen.has(key)) {
			return { ok: false, reason: "duplicate_nonce" };
		}

		this.seen.set(key, { expiresAt: payload.timestamp + this.windowMs });
		this.enforceBound(now);
		return { ok: true };
	}

	private maybePrune(now: number) {
		if (this.seen.size > this.maxEntries || now - this.lastPruneAt > this.windowMs) {
			this.pruneExpired(now);
			this.lastPruneAt = now;
		}
	}

	private pruneExpired(now: number) {
		for (const [key, value] of this.seen) {
			if (value.expiresAt > now) {
				continue;
			}
			this.seen.delete(key);
		}
	}

	private enforceBound(now: number) {
		if (this.seen.size <= this.maxEntries) {
			return;
		}

		this.pruneExpired(now);
		while (this.seen.size > this.maxEntries) {
			const firstKey = this.seen.keys().next().value as string | undefined;
			if (!firstKey) {
				return;
			}
			this.seen.delete(firstKey);
		}
	}
}
