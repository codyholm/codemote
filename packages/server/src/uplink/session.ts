import { randomUUID } from "node:crypto";
import type { RuntimeType, SessionStatus } from "@codemote/common";
import type { Session, Workspace } from "./types.js";

/**
 * Manages session lifecycle
 */
export class SessionManager {
	private sessions = new Map<string, Session>();

	/**
	 * Create a new session
	 */
	create(runtime: RuntimeType, workspace: Workspace): Session {
		const id = randomUUID();
		const runId = randomUUID();

		const session: Session = {
			id,
			runId,
			runtime,
			status: "starting",
			workspace,
			startedAt: Date.now(),
			endedAt: null,
			lastActivityAt: Date.now(),
			statusChangedAt: Date.now(),
		};

		this.sessions.set(id, session);
		return session;
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

		// Guarded: codex re-emits "running" on every turn, so an unguarded write would
		// make this move without a transition and destroy its value as a transition key.
		if (status !== session.status) {
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
				this.sessions.delete(id);
				removed++;
			}
		}

		return removed;
	}
}
