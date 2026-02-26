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

		session.status = status;
		session.lastActivityAt = Date.now();

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
