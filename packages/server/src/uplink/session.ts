import { randomUUID } from "node:crypto";
import type { RuntimeType, SessionStatus } from "@codemote/common";
import type {
	DurableSessionRecoveryState,
	Session,
	SessionStartContext,
	Workspace,
} from "./types.js";

/**
 * Persists a runtime-native session ID for a session bound to a Git-aware start
 * operation. Throwing means the ID was not made durable.
 */
export type RuntimeSessionPersist = (sessionId: string, runtimeSessionId: string) => void;
export type RecoveryStatePersist = (
	sessionId: string,
	recoveryState: DurableSessionRecoveryState,
) => void;

export class SessionRestoreConflictError extends Error {
	readonly code = "SESSION_RESTORE_CONFLICT";

	constructor(sessionId: string) {
		super(`Session ID is already in use by a different session: ${sessionId}`);
		this.name = "SessionRestoreConflictError";
	}
}

function sameSessionIdentity(a: Session, b: Session): boolean {
	return (
		a.id === b.id &&
		a.runId === b.runId &&
		a.runtime === b.runtime &&
		a.workspace.id === b.workspace.id &&
		a.workspace.workingDir === b.workspace.workingDir &&
		a.originProjectPath === b.originProjectPath &&
		a.execution?.directory === b.execution?.directory
	);
}

/**
 * Manages session lifecycle
 */
export class SessionManager {
	private sessions = new Map<string, Session>();
	private runtimeSessionPersistence = new Map<string, RuntimeSessionPersist>();
	private recoveryStatePersistence = new Map<string, RecoveryStatePersist>();
	private recoveryPersistenceSuppression = new Map<string, number>();

	/**
	 * Create a new session
	 */
	create(runtime: RuntimeType, workspace: Workspace, context?: SessionStartContext): Session {
		const id = randomUUID();
		const runId = randomUUID();

		const session: Session = {
			id,
			runId,
			runtime,
			status: "starting",
			resumeEligible: true,
			workspace,
			startedAt: Date.now(),
			endedAt: null,
			lastActivityAt: Date.now(),
			statusChangedAt: Date.now(),
			...(context
				? {
						originProjectPath: context.originProjectPath,
						execution: context.execution,
					}
				: {}),
		};

		this.sessions.set(id, session);
		return session;
	}

	/**
	 * Re-register an exact session recorded by a previous process.
	 *
	 * Idempotent for the same identity, and refuses to replace a different
	 * session that already holds the ID rather than silently taking it over.
	 */
	restore(session: Session): Session {
		const existing = this.sessions.get(session.id);
		if (existing) {
			if (!sameSessionIdentity(existing, session)) {
				throw new SessionRestoreConflictError(session.id);
			}
			return existing;
		}
		this.sessions.set(session.id, session);
		return session;
	}

	/**
	 * Forget a session and any persistence bound to it.
	 */
	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.runtimeSessionPersistence.delete(sessionId);
		this.recoveryStatePersistence.delete(sessionId);
		this.recoveryPersistenceSuppression.delete(sessionId);
	}

	/**
	 * Bind a session's runtime-native ID to durable operation state. Only
	 * sessions created by a Git-aware start have one; every other session stays
	 * in memory exactly as before.
	 */
	bindRuntimeSessionPersistence(sessionId: string, persist: RuntimeSessionPersist): void {
		this.runtimeSessionPersistence.set(sessionId, persist);
	}

	bindRecoveryStatePersistence(sessionId: string, persist: RecoveryStatePersist): void {
		this.recoveryStatePersistence.set(sessionId, persist);
	}

	/**
	 * Persist an explicit recovery-policy change before accepting it in memory.
	 * Callers use this for user intent; runtime errors use the guarded best-effort
	 * path in updateStatus so a journal write failure cannot mask the runtime error.
	 */
	setRecoveryState(sessionId: string, recoveryState: DurableSessionRecoveryState): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const persist = this.recoveryStatePersistence.get(sessionId);
		if (persist) persist(sessionId, recoveryState);
		session.resumeEligible = recoveryState === "resumable";
	}

	async withoutRecoveryPersistence<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
		this.recoveryPersistenceSuppression.set(
			sessionId,
			(this.recoveryPersistenceSuppression.get(sessionId) ?? 0) + 1,
		);
		try {
			return await action();
		} finally {
			const remaining = (this.recoveryPersistenceSuppression.get(sessionId) ?? 1) - 1;
			if (remaining === 0) this.recoveryPersistenceSuppression.delete(sessionId);
			else this.recoveryPersistenceSuppression.set(sessionId, remaining);
		}
	}

	/**
	 * Get a session by ID
	 */
	get(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Update session status
	 */
	updateStatus(sessionId: string, status: SessionStatus): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const changed = status !== session.status;
		if (
			changed &&
			status === "error" &&
			session.resumeEligible !== false &&
			!this.recoveryPersistenceSuppression.has(sessionId)
		) {
			try {
				this.setRecoveryState(sessionId, "error");
			} catch (error) {
				console.error(
					`Failed to persist recovery state for ${sessionId}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		// Guarded: codex re-emits "running" on every turn, so an unguarded write would
		// make this move without a transition and destroy its value as a transition key.
		if (changed) {
			session.statusChangedAt = Date.now();
		}

		session.status = status;
		session.lastActivityAt = Date.now();

		// A runtime cannot finish a turn while blocked on a decision, so reaching
		// idle proves the request was resolved; a terminal session has none left
		// outstanding. Clearing here rather than at the emit site makes it
		// unbypassable, and it must precede the terminal early return below.
		if (status === "idle" || status === "ended" || status === "error") {
			session.attention = undefined;
		}

		if (status === "ended" || status === "error") {
			session.endedAt = Date.now();
			return;
		}

		// Session resumed after a terminal state.
		if (session.endedAt !== null) {
			session.endedAt = null;
		}
	}

	/**
	 * Store runtime-native resume ID for a session.
	 */
	setRuntimeSessionId(sessionId: string, runtimeSessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const persist = this.runtimeSessionPersistence.get(sessionId);
		if (persist && session.runtimeSessionId !== runtimeSessionId) {
			try {
				// Durable first: an ID accepted in memory but lost from the journal
				// would make a restarted process disagree with this one about how the
				// runtime session is named.
				persist(sessionId, runtimeSessionId);
			} catch (error) {
				console.error(
					`Failed to persist runtime session ID for ${sessionId}:`,
					error instanceof Error ? error.message : error,
				);
				return;
			}
		}
		session.runtimeSessionId = runtimeSessionId;
		session.lastActivityAt = Date.now();
	}

	/**
	 * Record an outstanding decision that is stopping this session.
	 */
	setAttention(sessionId: string, reason: string, description: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		// A terminal session has no decision to make. The classifier masks a pending
		// request while ended/error, but updateStatus does not clear on "running", so
		// storing one here would resurface as a false approval when the session resumes.
		if (session.status === "ended" || session.status === "error") return;

		const now = Date.now();
		session.attention = { reason, description, since: now };
		session.lastActivityAt = now;
	}

	/**
	 * Drop the outstanding decision, whether or not one was recorded.
	 */
	clearAttention(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.attention = undefined;
	}

	/**
	 * Record activity on a session
	 */
	touch(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.lastActivityAt = Date.now();
		}
	}

	/**
	 * End a session
	 */
	end(sessionId: string): void {
		this.updateStatus(sessionId, "ended");
	}

	/**
	 * List all sessions
	 */
	list(): Session[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * List active sessions (not ended/error)
	 */
	listActive(): Session[] {
		return this.list().filter((s) => s.status !== "ended" && s.status !== "error");
	}

	/**
	 * Remove ended sessions older than maxAge (ms)
	 */
	cleanup(maxAge: number): number {
		const cutoff = Date.now() - maxAge;
		let removed = 0;

		for (const [id, session] of this.sessions) {
			if (session.endedAt && session.endedAt < cutoff) {
				this.remove(id);
				removed++;
			}
		}

		return removed;
	}
}
