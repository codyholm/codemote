/**
 * PIN generation and rate limiting for pairing operations
 */

import { randomInt } from "node:crypto";

/**
 * Generates a 6-digit numeric PIN (000000-999999)
 */
export function generatePIN(): string {
	const pin = randomInt(0, 1_000_000);
	return pin.toString().padStart(6, "0");
}

/**
 * Configuration for rate limiting behavior
 */
export interface RateLimiterConfig {
	/** Maximum number of attempts allowed within the time window */
	maxAttempts: number;
	/** Time window in milliseconds for rate limiting */
	windowMs: number;
	/** Backoff delays in milliseconds for each failed attempt */
	backoffMs: number[];
	/** Duration in milliseconds for lockout after exceeding max attempts */
	lockoutMs: number;
}

/**
 * Attempt tracking information for a client
 */
interface AttemptRecord {
	/** Number of failed attempts */
	count: number;
	/** Timestamp of the last attempt */
	lastAttempt: number;
	/** Timestamp when the lockout expires (if locked out) */
	lockedUntil?: number;
}

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
	/** Whether the request is allowed */
	allowed: boolean;
	/** Milliseconds to wait before next attempt (if not allowed) */
	waitMs?: number;
	/** Human-readable message explaining the result */
	message?: string;
}

/**
 * Rate limiter with exponential backoff and lockout mechanism
 */
export class RateLimiter {
	private attempts: Map<string, AttemptRecord>;
	private config: RateLimiterConfig;

	constructor(config?: Partial<RateLimiterConfig>) {
		this.attempts = new Map();
		this.config = {
			maxAttempts: 5,
			windowMs: 60_000,
			backoffMs: [1000, 2000, 4000, 8000, 16_000],
			lockoutMs: 60_000,
			...config,
		};
	}

	/**
	 * Checks if a request is allowed and records the attempt
	 * @param clientIP - Client identifier (typically IP address)
	 * @param success - Whether the attempt was successful
	 */
	async checkAndRecord(clientIP: string, success: boolean): Promise<RateLimitResult> {
		const now = Date.now();
		let record = this.attempts.get(clientIP);

		// Check if client is locked out
		if (record?.lockedUntil) {
			if (now < record.lockedUntil) {
				const waitMs = record.lockedUntil - now;
				return {
					allowed: false,
					waitMs,
					message: `Too many failed attempts. Locked out for ${Math.ceil(waitMs / 1000)}s`,
				};
			}
			// Lockout expired, clear the record and continue
			this.attempts.delete(clientIP);
			record = undefined;
		}

		// No record or outside time window - allow request
		if (!record || now - record.lastAttempt > this.config.windowMs) {
			if (success) {
				this.attempts.delete(clientIP);
			} else {
				this.attempts.set(clientIP, {
					count: 1,
					lastAttempt: now,
				});
			}
			return { allowed: true };
		}

		// Successful attempt - clear record
		if (success) {
			this.attempts.delete(clientIP);
			return { allowed: true };
		}

		// Failed attempt - increment count
		const newCount = record.count + 1;

		// Check if max attempts exceeded
		if (newCount >= this.config.maxAttempts) {
			this.attempts.set(clientIP, {
				count: newCount,
				lastAttempt: now,
				lockedUntil: now + this.config.lockoutMs,
			});
			return {
				allowed: false,
				waitMs: this.config.lockoutMs,
				message: `Maximum attempts exceeded. Locked out for ${this.config.lockoutMs / 1000}s`,
			};
		}

		// Apply exponential backoff
		// Backoff applies based on the number of *prior* failed attempts.
		// e.g. after 1 failed attempt, require backoffMs[0] before allowing attempt #2.
		const backoffIndex = Math.min(record.count - 1, this.config.backoffMs.length - 1);
		const backoffDelay = this.config.backoffMs[backoffIndex];
		const timeSinceLastAttempt = now - record.lastAttempt;

		if (backoffDelay !== undefined && timeSinceLastAttempt < backoffDelay) {
			const waitMs = backoffDelay - timeSinceLastAttempt;
			return {
				allowed: false,
				waitMs,
				message: `Too many attempts. Wait ${Math.ceil(waitMs / 1000)}s before retrying`,
			};
		}

		// Update record and allow attempt
		this.attempts.set(clientIP, {
			count: newCount,
			lastAttempt: now,
		});

		return { allowed: true };
	}

	/**
	 * Resets rate limit tracking for a client (e.g., after successful pairing)
	 */
	reset(clientIP: string): void {
		this.attempts.delete(clientIP);
	}

	/**
	 * Gets current attempt record for a client (for testing/monitoring)
	 */
	getAttemptRecord(clientIP: string): AttemptRecord | undefined {
		return this.attempts.get(clientIP);
	}

	/**
	 * Clears all attempt records
	 */
	clear(): void {
		this.attempts.clear();
	}
}

/**
 * Callback function for PIN regeneration events
 */
export type OnRegenerateCallback = (pin: string) => void;

/**
 * Manages PIN lifecycle including generation, expiry, and validation
 */
export class PINManager {
	private currentPIN: string;
	private expiresAt: number;
	private ttlMs: number;
	private onRegenerateCallback?: OnRegenerateCallback;
	private regenerateTimer: NodeJS.Timeout | undefined;

	constructor(ttlMs = 5 * 60 * 1000) {
		this.ttlMs = ttlMs;
		this.currentPIN = "";
		this.expiresAt = 0;
		this.regenerate();
	}

	/**
	 * Gets the current PIN, regenerating if expired
	 */
	get pin(): string {
		if (Date.now() >= this.expiresAt) {
			this.regenerate();
		}
		return this.currentPIN;
	}

	/**
	 * Validates if the provided PIN matches the current PIN
	 */
	validate(pin: string): boolean {
		if (Date.now() >= this.expiresAt) {
			return false;
		}
		return pin === this.currentPIN;
	}

	/**
	 * Gets remaining time in milliseconds until PIN expires
	 */
	getRemainingTime(): number {
		return Math.max(0, this.expiresAt - Date.now());
	}

	/**
	 * Checks if the current PIN is expired
	 */
	isExpired(): boolean {
		return Date.now() >= this.expiresAt;
	}

	/**
	 * Manually triggers PIN regeneration
	 */
	forceRegenerate(): void {
		this.regenerate();
	}

	/**
	 * Sets a callback to be invoked when PIN is regenerated
	 */
	setOnRegenerate(callback: OnRegenerateCallback): void {
		this.onRegenerateCallback = callback;
	}

	/**
	 * Cleans up timers (call before disposing)
	 */
	dispose(): void {
		if (this.regenerateTimer) {
			clearTimeout(this.regenerateTimer);
			this.regenerateTimer = undefined;
		}
	}

	/**
	 * Generates a new PIN and sets expiry time
	 */
	private regenerate(): void {
		// Clear existing timer
		if (this.regenerateTimer) {
			clearTimeout(this.regenerateTimer);
		}

		this.currentPIN = generatePIN();
		this.expiresAt = Date.now() + this.ttlMs;

		// Schedule next regeneration
		this.regenerateTimer = setTimeout(() => {
			this.regenerate();
		}, this.ttlMs);

		// Notify callback
		if (this.onRegenerateCallback) {
			this.onRegenerateCallback(this.currentPIN);
		}
	}
}
