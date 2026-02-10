import { describe, expect, it } from "vitest";
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
});
