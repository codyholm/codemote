import { describe, expect, it, vi } from "vitest";
import { SessionManager, SessionRestoreConflictError } from "./session";
import type { Session, Workspace } from "./types";

describe("SessionManager", () => {
	const mockWorkspace: Workspace = {
		id: "ws-test",
		workingDir: "/tmp/test",
		createdAt: Date.now(),
	};

	function recordedSession(): Session {
		return {
			id: "session-restored",
			runId: "run-restored",
			runtime: "claude",
			status: "ended",
			workspace: mockWorkspace,
			startedAt: 1000,
			endedAt: 2000,
			lastActivityAt: 2000,
			statusChangedAt: 2000,
			originProjectPath: "/tmp/project",
			execution: { directory: "/tmp/test", mode: "project_folder", git: null },
		};
	}

	it("creates session with unique ID", () => {
		const manager = new SessionManager();
		const session = manager.create("opencode", mockWorkspace);

		expect(session.id).toBeDefined();
		expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(session.runtime).toBe("opencode");
		expect(session.status).toBe("starting");
	});

	it("creates sessions with different IDs", () => {
		const manager = new SessionManager();
		const session1 = manager.create("opencode", mockWorkspace);
		const session2 = manager.create("claude", mockWorkspace);

		expect(session1.id).not.toBe(session2.id);
	});

	it("records project origin separately from effective execution state", () => {
		const manager = new SessionManager();
		const execution = {
			directory: "/tmp/project-worktree",
			mode: "worktree" as const,
			git: {
				repositoryRoot: "/tmp/project-worktree",
				head: "abc123",
				branch: "feature/session",
				detached: false,
			},
			worktree: {
				path: "/tmp/project-worktree",
				baseRef: "refs/heads/main",
				baseCommit: "abc123",
			},
		};

		const session = manager.create("codex", mockWorkspace, {
			originProjectPath: "/tmp/project",
			execution,
		});

		expect(session.originProjectPath).toBe("/tmp/project");
		expect(session.execution).toEqual(execution);
	});

	it("updates session status", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.updateStatus(session.id, "running");
		expect(manager.get(session.id)?.status).toBe("running");
	});

	it("sets endedAt when status is ended", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		expect(session.endedAt).toBeNull();
		manager.updateStatus(session.id, "ended");

		const updated = manager.get(session.id);
		expect(updated?.endedAt).not.toBeNull();
		expect(updated?.status).toBe("ended");
	});

	it("sets endedAt when status is error", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.updateStatus(session.id, "error");

		const updated = manager.get(session.id);
		expect(updated?.endedAt).not.toBeNull();
		expect(updated?.status).toBe("error");
	});

	it("clears endedAt when session resumes from terminal state", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.updateStatus(session.id, "ended");
		const endedAt = manager.get(session.id)?.endedAt;
		expect(endedAt).not.toBeNull();

		manager.updateStatus(session.id, "running");
		const resumed = manager.get(session.id);
		expect(resumed?.status).toBe("running");
		expect(resumed?.endedAt).toBeNull();
	});

	it("lists active sessions", () => {
		const manager = new SessionManager();
		const s1 = manager.create("opencode", mockWorkspace);
		const s2 = manager.create("claude", mockWorkspace);

		manager.updateStatus(s1.id, "running");
		manager.end(s2.id);

		const active = manager.listActive();
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(s1.id);
	});

	it("lists all sessions including ended", () => {
		const manager = new SessionManager();
		const s1 = manager.create("opencode", mockWorkspace);
		const s2 = manager.create("claude", mockWorkspace);

		manager.end(s2.id);

		const all = manager.list();
		expect(all).toHaveLength(2);
	});

	it("touches session to update lastActivityAt", () => {
		const manager = new SessionManager();
		const session = manager.create("opencode", mockWorkspace);
		const originalActivity = session.lastActivityAt;

		// Small delay to ensure time difference
		const later = originalActivity + 100;
		manager.touch(session.id);

		const updated = manager.get(session.id);
		expect(updated?.lastActivityAt).toBeGreaterThanOrEqual(originalActivity);
	});

	it("stores runtime session ID for resume", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.setRuntimeSessionId(session.id, "claude-session-123");

		expect(manager.get(session.id)?.runtimeSessionId).toBe("claude-session-123");
	});

	// Fake timers because the real clock can return the same millisecond twice, which
	// would let both assertions below pass against a broken implementation.
	it("advances statusChangedAt on a real status transition", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const manager = new SessionManager();
			const session = manager.create("claude", mockWorkspace);
			expect(session.statusChangedAt).toBe(1_000);

			vi.setSystemTime(5_000);
			manager.updateStatus(session.id, "idle");

			expect(manager.get(session.id)?.statusChangedAt).toBe(5_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves statusChangedAt alone when the same status is written again", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const manager = new SessionManager();
			const session = manager.create("claude", mockWorkspace);
			manager.updateStatus(session.id, "running");

			// Codex re-emits "running" on every turn; that is not a transition.
			vi.setSystemTime(9_000);
			manager.updateStatus(session.id, "running");

			const updated = manager.get(session.id);
			expect(updated?.statusChangedAt).toBe(1_000);
			// lastActivityAt still moves - only the transition key is guarded.
			expect(updated?.lastActivityAt).toBe(9_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records attention and exposes it on get", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.setAttention(session.id, "permission_required", "Write /etc/hosts?");

		const attention = manager.get(session.id)?.attention;
		expect(attention?.reason).toBe("permission_required");
		expect(attention?.description).toBe("Write /etc/hosts?");
		expect(attention?.since).toBeGreaterThan(0);
	});

	it("clears attention when status becomes idle", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.setAttention(session.id, "permission_required", "Write /etc/hosts?");
		manager.updateStatus(session.id, "idle");

		expect(manager.get(session.id)?.attention).toBeUndefined();
	});

	it("clears attention when status becomes ended, and still sets endedAt", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.setAttention(session.id, "approval_required", "Run the migration?");
		manager.updateStatus(session.id, "ended");

		const updated = manager.get(session.id);
		expect(updated?.attention).toBeUndefined();
		expect(updated?.endedAt).not.toBeNull();
	});

	it("keeps attention when status becomes running", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.setAttention(session.id, "permission_required", "Write /etc/hosts?");
		manager.updateStatus(session.id, "running");

		expect(manager.get(session.id)?.attention?.reason).toBe("permission_required");
	});

	it("ignores attention set on a terminal session, so a resume cannot resurface it", () => {
		const manager = new SessionManager();
		const session = manager.create("claude", mockWorkspace);

		manager.updateStatus(session.id, "ended");
		manager.setAttention(session.id, "approval_required", "Run the migration?");
		expect(manager.get(session.id)?.attention).toBeUndefined();

		// Resuming does not clear attention, so anything stored above would surface here.
		manager.updateStatus(session.id, "running");
		expect(manager.get(session.id)?.attention).toBeUndefined();
	});

	it("does not throw when clearing attention on an unknown session", () => {
		const manager = new SessionManager();

		expect(() => manager.clearAttention("no-such-session")).not.toThrow();
	});

	it("restores a recorded session idempotently and refuses to replace a different one", () => {
		const manager = new SessionManager();
		const restored = manager.restore(recordedSession());

		expect(restored.id).toBe("session-restored");
		expect(manager.get("session-restored")?.status).toBe("ended");
		expect(manager.restore(recordedSession())).toBe(restored);
		expect(manager.list()).toHaveLength(1);

		expect(() => manager.restore({ ...recordedSession(), runId: "run-different" })).toThrowError(
			SessionRestoreConflictError,
		);
		expect(manager.get("session-restored")?.runId).toBe("run-restored");
	});

	it("persists a runtime session ID before accepting it, and keeps memory honest if that fails", () => {
		const manager = new SessionManager();
		const persisted: string[] = [];
		const session = manager.create("claude", mockWorkspace);
		manager.bindRuntimeSessionPersistence(session.id, (_id, runtimeSessionId) => {
			persisted.push(runtimeSessionId);
		});

		manager.setRuntimeSessionId(session.id, "runtime-1");
		expect(persisted).toEqual(["runtime-1"]);
		expect(manager.get(session.id)?.runtimeSessionId).toBe("runtime-1");

		// Re-recording the same ID needs no write.
		manager.setRuntimeSessionId(session.id, "runtime-1");
		expect(persisted).toEqual(["runtime-1"]);

		const unbound = manager.create("codex", mockWorkspace);
		manager.setRuntimeSessionId(unbound.id, "runtime-unbound");
		expect(persisted).toEqual(["runtime-1"]);
		expect(manager.get(unbound.id)?.runtimeSessionId).toBe("runtime-unbound");

		const failing = manager.create("claude", mockWorkspace);
		manager.bindRuntimeSessionPersistence(failing.id, () => {
			throw new Error("journal unavailable");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => manager.setRuntimeSessionId(failing.id, "runtime-2")).not.toThrow();
		expect(manager.get(failing.id)?.runtimeSessionId).toBeUndefined();
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	it("persists explicit terminal recovery state before disabling resume", () => {
		const manager = new SessionManager();
		const persisted: string[] = [];
		const session = manager.create("codex", mockWorkspace);
		manager.bindRecoveryStatePersistence(session.id, (_id, recoveryState) => {
			persisted.push(recoveryState);
		});

		manager.setRecoveryState(session.id, "ended");
		expect(persisted).toEqual(["ended"]);
		expect(manager.get(session.id)?.resumeEligible).toBe(false);

		const failing = manager.create("claude", mockWorkspace);
		manager.bindRecoveryStatePersistence(failing.id, () => {
			throw new Error("journal unavailable");
		});
		expect(() => manager.setRecoveryState(failing.id, "ended")).toThrow("journal unavailable");
		expect(manager.get(failing.id)?.resumeEligible).toBe(true);
	});

	it("persists runtime errors but not errors emitted during an intentional stop", async () => {
		const manager = new SessionManager();
		const persisted: string[] = [];
		const failed = manager.create("gemini", mockWorkspace);
		manager.bindRecoveryStatePersistence(failed.id, (_id, recoveryState) => {
			persisted.push(recoveryState);
		});

		manager.updateStatus(failed.id, "error");
		expect(persisted).toEqual(["error"]);
		expect(failed.resumeEligible).toBe(false);

		const stopped = manager.create("opencode", mockWorkspace);
		manager.bindRecoveryStatePersistence(stopped.id, (_id, recoveryState) => {
			persisted.push(recoveryState);
		});
		await manager.withoutRecoveryPersistence(stopped.id, async () => {
			manager.updateStatus(stopped.id, "error");
		});
		expect(persisted).toEqual(["error"]);
		expect(stopped.resumeEligible).toBe(true);
	});

	it("drops persistence binding with the session it belongs to", () => {
		const manager = new SessionManager();
		const persisted: string[] = [];
		const session = manager.restore(recordedSession());
		manager.bindRuntimeSessionPersistence(session.id, (_id, runtimeSessionId) => {
			persisted.push(runtimeSessionId);
		});
		manager.bindRecoveryStatePersistence(session.id, (_id, recoveryState) => {
			persisted.push(recoveryState);
		});

		manager.remove(session.id);
		expect(manager.get(session.id)).toBeUndefined();

		manager.restore(recordedSession());
		manager.setRuntimeSessionId(session.id, "runtime-after-remove");
		manager.setRecoveryState(session.id, "ended");
		expect(persisted).toEqual([]);
	});
});
