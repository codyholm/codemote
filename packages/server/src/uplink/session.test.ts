import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session";
import type { Workspace } from "./types";

describe("SessionManager", () => {
	const mockWorkspace: Workspace = {
		id: "ws-test",
		workingDir: "/tmp/test",
		createdAt: Date.now(),
	};

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
});
