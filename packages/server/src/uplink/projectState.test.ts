import { resolve } from "node:path";
import {
	ATTENTION_DESCRIPTION_MAX,
	ATTENTION_RANK,
	PROJECT_STATE_MAX_BYTES,
	PROJECT_STATE_MAX_PROJECTS,
	PROJECT_STATE_MAX_SESSIONS,
	type PendingAttention,
} from "@codemote/common";
import { describe, expect, it } from "vitest";
import { buildProjectState, projectStateSignature } from "./projectState";
import type { Session } from "./types";

const NOW = 10_000;

const PENDING: PendingAttention = {
	reason: "permission_required",
	description: "Write to /etc/hosts?",
	since: 900,
};

function makeSession(overrides: Partial<Session> = {}): Session {
	const base: Session = {
		id: "sess-1",
		runId: "run-1",
		runtime: "claude",
		status: "running",
		workspace: { id: "ws-1", workingDir: "/tmp/project-a", createdAt: 0 },
		startedAt: 1000,
		endedAt: null,
		lastActivityAt: 1000,
		statusChangedAt: 1000,
	};
	return { ...base, ...overrides };
}

function sessionIn(id: string, workingDir: string, overrides: Partial<Session> = {}): Session {
	return makeSession({ id, workspace: { id: `ws-${id}`, workingDir, createdAt: 0 }, ...overrides });
}

describe("buildProjectState", () => {
	it("classifies a session with a pending request as blocked", () => {
		const agg = buildProjectState(
			[makeSession({ status: "running", attention: PENDING })],
			[],
			NOW,
		);

		const session = agg.projects[0]?.sessions[0];
		expect(session?.attention).toBe("blocked");
		expect(session?.pending).toEqual(PENDING);
	});

	it("classifies an idle session as awaiting, with no pending request", () => {
		const agg = buildProjectState([makeSession({ status: "idle" })], [], NOW);

		const session = agg.projects[0]?.sessions[0];
		expect(session?.attention).toBe("awaiting");
		expect(session?.pending).toBeNull();
	});

	it("classifies an ended session as done", () => {
		const agg = buildProjectState([makeSession({ status: "ended", endedAt: 2000 })], [], NOW);

		expect(agg.projects[0]?.sessions[0]?.attention).toBe("done");
	});

	it("classifies an errored session as failed", () => {
		const agg = buildProjectState([makeSession({ status: "error", endedAt: 2000 })], [], NOW);

		expect(agg.projects[0]?.sessions[0]?.attention).toBe("failed");
	});

	it("carries statusChangedAt through to the aggregate", () => {
		const agg = buildProjectState(
			[makeSession({ status: "idle", statusChangedAt: 4242 })],
			[],
			NOW,
		);

		expect(agg.projects[0]?.sessions[0]?.statusChangedAt).toBe(4242);
	});

	it("orders a blocked project ahead of a working one", () => {
		const agg = buildProjectState(
			[
				sessionIn("sess-working", "/tmp/calm", { lastActivityAt: 5000 }),
				sessionIn("sess-blocked", "/tmp/stuck", { attention: PENDING, lastActivityAt: 1000 }),
			],
			[],
			NOW,
		);

		expect(agg.projects[0]?.id).toBe("/tmp/stuck");
		expect(agg.projects[0]?.attentionRank).toBe(0);
		expect(agg.blockedProjectCount).toBe(1);
	});

	it("counts blocked projects and blocked sessions separately", () => {
		const agg = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/busy", { attention: PENDING }),
				sessionIn("sess-b", "/tmp/busy", { attention: PENDING }),
				sessionIn("sess-c", "/tmp/busy", { attention: PENDING }),
				sessionIn("sess-d", "/tmp/calm"),
			],
			[],
			NOW,
		);

		// One project is blocked, but three decisions are waiting. Reporting only the
		// project count would understate the work by 3x.
		expect(agg.blockedProjectCount).toBe(1);
		expect(agg.blockedSessionCount).toBe(3);
	});

	it("ranks a project by its most urgent session", () => {
		const agg = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/mixed", { status: "running" }),
				sessionIn("sess-b", "/tmp/mixed", { status: "running", attention: PENDING }),
			],
			[],
			NOW,
		);

		expect(agg.projects).toHaveLength(1);
		expect(agg.projects[0]?.attention).toBe("blocked");
	});

	it("still ranks a project blocked when its blocked session was omitted", () => {
		const crowd = Array.from({ length: PROJECT_STATE_MAX_SESSIONS }, (_, i) =>
			sessionIn(`sess-crowd-${String(i).padStart(3, "0")}`, "/tmp/crowd", {
				attention: PENDING,
				lastActivityAt: 5000,
			}),
		);
		const straggler = sessionIn("sess-straggler", "/tmp/quiet", {
			attention: PENDING,
			lastActivityAt: 1000,
		});

		const agg = buildProjectState([...crowd, straggler], [], NOW);
		const quiet = agg.projects.find((project) => project.id === "/tmp/quiet");

		expect(quiet?.sessions).toHaveLength(0);
		expect(quiet?.sessionsOmitted).toBe(1);
		expect(quiet?.attention).toBe("blocked");
	});

	it("breaks ties by sessionId and is stable across builds", () => {
		const sessions = [
			sessionIn("sess-b", "/tmp/tie", { lastActivityAt: 3000 }),
			sessionIn("sess-a", "/tmp/tie", { lastActivityAt: 3000 }),
		];

		const first = buildProjectState(sessions, [], NOW);
		const second = buildProjectState(sessions, [], NOW);

		expect(first.projects[0]?.sessions.map((s) => s.sessionId)).toEqual(["sess-a", "sess-b"]);
		expect(second).toEqual(first);
	});

	it("groups sessions by normalized working directory", () => {
		const agg = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/shared"),
				sessionIn("sess-b", "/tmp/shared/"),
				sessionIn("sess-c", "/tmp/shared/./"),
			],
			[],
			NOW,
		);

		expect(agg.projects).toHaveLength(1);
		expect(agg.projects[0]?.id).toBe("/tmp/shared");
		expect(agg.projects[0]?.name).toBe("shared");
		expect(agg.projects[0]?.registered).toBe(false);
		expect(agg.projects[0]?.sessionCount).toBe(3);
	});

	it("includes a named registered project with no sessions", () => {
		const projectPath = resolve("/tmp/sessionless-project");
		const agg = buildProjectState([], [{ name: "Named Project", path: `${projectPath}/./` }], NOW);

		expect(agg.projects).toEqual([
			{
				id: projectPath,
				name: "Named Project",
				path: projectPath,
				registered: true,
				attention: "done",
				attentionRank: ATTENTION_RANK.done,
				sessionCount: 0,
				sessionsOmitted: 0,
				lastActivityAt: 0,
				sessions: [],
			},
		]);
		expect(agg.sessionCount).toBe(0);
		expect(agg.projectCount).toBe(1);
		expect(agg.truncated).toBe(false);
	});

	it("matches normalized sessions to registered paths and keeps unmatched fallback groups", () => {
		const registeredPath = resolve("/tmp/registered-project");
		const fallbackPath = resolve("/tmp/unregistered-project");
		const agg = buildProjectState(
			[
				sessionIn("sess-registered", `${registeredPath}/./`),
				sessionIn("sess-fallback", `${fallbackPath}/`),
			],
			[{ name: "Persisted Name", path: `${registeredPath}/` }],
			NOW,
		);

		expect(agg.projects).toHaveLength(2);
		expect(agg.projects.filter((project) => project.id === registeredPath)).toHaveLength(1);
		const registered = agg.projects.find((project) => project.id === registeredPath);
		expect(registered?.name).toBe("Persisted Name");
		expect(registered?.registered).toBe(true);
		expect(registered?.sessionCount).toBe(1);
		expect(registered?.sessions[0]?.sessionId).toBe("sess-registered");

		const fallback = agg.projects.find((project) => project.id === fallbackPath);
		expect(fallback?.name).toBe("unregistered-project");
		expect(fallback?.registered).toBe(false);
		expect(fallback?.sessionCount).toBe(1);
		expect(fallback?.sessions[0]?.sessionId).toBe("sess-fallback");
	});

	it("falls back to an unregistered path group after registry removal", () => {
		const projectPath = resolve("/tmp/removed-project");
		const sessions = [sessionIn("sess-a", `${projectPath}/./`)];
		const registered = buildProjectState(
			sessions,
			[{ name: "Before Removal", path: projectPath }],
			NOW,
		);
		const fallback = buildProjectState(sessions, [], NOW);

		expect(registered.projects).toHaveLength(1);
		expect(registered.projects[0]?.name).toBe("Before Removal");
		expect(registered.projects[0]?.registered).toBe(true);
		expect(fallback.projects).toHaveLength(1);
		expect(fallback.projects[0]?.id).toBe(projectPath);
		expect(fallback.projects[0]?.name).toBe("removed-project");
		expect(fallback.projects[0]?.registered).toBe(false);
		expect(fallback.projects[0]?.sessions[0]?.sessionId).toBe("sess-a");
	});

	it("caps sessions, reports the omission, and keeps every blocked session", () => {
		const total = PROJECT_STATE_MAX_SESSIONS + 20;
		const sessions = Array.from({ length: total }, (_, i) =>
			sessionIn(`sess-${String(i).padStart(3, "0")}`, i % 2 === 0 ? "/tmp/a" : "/tmp/b", {
				// The blocked ones are the least recently active, so they survive only
				// because rank is sorted before the cap is applied.
				...(i < 3 ? { attention: PENDING, lastActivityAt: 1 } : { lastActivityAt: 5000 }),
			}),
		);

		const agg = buildProjectState(sessions, [], NOW);
		const kept = agg.projects.flatMap((project) => project.sessions);

		expect(kept).toHaveLength(PROJECT_STATE_MAX_SESSIONS);
		expect(agg.sessionCount).toBe(total);
		expect(agg.sessionsOmitted).toBe(20);
		expect(agg.truncated).toBe(true);
		expect(kept.filter((session) => session.attention === "blocked")).toHaveLength(3);
		// Every session is either visible or counted as omitted.
		expect(kept.length + agg.sessionsOmitted).toBe(agg.sessionCount);
	});

	it("bounds the aggregate by serialized bytes, not just record counts", () => {
		// Long but valid paths: each project serializes its path twice plus a basename,
		// so the byte budget is reached well before the project count cap.
		// ~1650 chars, well under PATH_MAX (4096 on Linux) so these are valid paths.
		const longSegment = "d".repeat(400);
		const sessions = Array.from({ length: PROJECT_STATE_MAX_PROJECTS }, (_, i) =>
			sessionIn(
				`sess-${String(i).padStart(3, "0")}`,
				`/tmp/${longSegment}/${longSegment}/${longSegment}/${longSegment}/p-${String(i).padStart(3, "0")}`,
			),
		);

		const agg = buildProjectState(sessions, [], NOW);

		// The byte budget fired before the count cap did.
		expect(agg.projects.length).toBeLessThan(PROJECT_STATE_MAX_PROJECTS);
		expect(agg.projectsOmitted).toBe(agg.projectCount - agg.projects.length);
		expect(agg.projectCount).toBe(PROJECT_STATE_MAX_PROJECTS);
		expect(agg.truncated).toBe(true);

		// Assert the bound itself, so the test survives a change to the constant.
		expect(Buffer.byteLength(JSON.stringify(agg), "utf8")).toBeLessThanOrEqual(
			PROJECT_STATE_MAX_BYTES,
		);

		// Dropping projects must not break session accounting.
		const visible = agg.projects.reduce((total, project) => total + project.sessions.length, 0);
		expect(visible + agg.sessionsOmitted).toBe(agg.sessionCount);
	});

	it("does not truncate realistic paths - the byte budget is a ceiling, not a limit", () => {
		const sessions = Array.from({ length: PROJECT_STATE_MAX_PROJECTS }, (_, i) =>
			sessionIn(
				`sess-${String(i).padStart(3, "0")}`,
				`/Users/dev/repos/some-project-${String(i).padStart(3, "0")}`,
			),
		);

		const agg = buildProjectState(sessions, [], NOW);

		expect(agg.projects).toHaveLength(PROJECT_STATE_MAX_PROJECTS);
		expect(agg.projectsOmitted).toBe(0);
		expect(agg.truncated).toBe(false);
	});

	it("caps projects and reports the omission", () => {
		const total = PROJECT_STATE_MAX_PROJECTS + 5;
		const sessions = Array.from({ length: total }, (_, i) =>
			sessionIn(`sess-${String(i).padStart(3, "0")}`, `/tmp/project-${String(i).padStart(3, "0")}`),
		);

		const agg = buildProjectState(sessions, [], NOW);
		const kept = agg.projects.flatMap((project) => project.sessions);

		expect(agg.projects).toHaveLength(PROJECT_STATE_MAX_PROJECTS);
		expect(agg.projectCount).toBe(total);
		expect(agg.projectsOmitted).toBe(5);
		expect(agg.truncated).toBe(true);
		// Sessions in a dropped project leave the output too, so they must be counted
		// as omitted. The identity is the invariant; the literal survives a cap change
		// only by coincidence.
		expect(kept.length + agg.sessionsOmitted).toBe(agg.sessionCount);
		expect(agg.sessionsOmitted).toBe(5);
	});

	it("fits the encrypted payload cap in the worst case", () => {
		// Source: ENCRYPTED_PAYLOAD_LIMITS.ciphertextBase64Max in
		// packages/cli/src/messageLimits.ts. Not imported: server must not depend on cli.
		const CIPHERTEXT_BASE64_MAX = 192 * 1024;
		const perProject = PROJECT_STATE_MAX_SESSIONS / PROJECT_STATE_MAX_PROJECTS;
		const sessions = Array.from({ length: PROJECT_STATE_MAX_SESSIONS }, (_, i) => {
			const project = Math.floor(i / perProject);
			const dir = `/Users/developer/dev/repos/very-long-organization-name/service-${String(project).padStart(3, "0")}/packages/worktree`;
			return sessionIn(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, dir, {
				attention: {
					reason: "approval_required",
					// Exactly the cap describeAttention enforces, so this is a real byte
					// bound rather than an estimate from one sample description.
					description: "d".repeat(ATTENTION_DESCRIPTION_MAX),
					since: 900,
				},
			});
		});

		const agg = buildProjectState(sessions, [], NOW);

		expect(agg.truncated).toBe(false);
		expect(Buffer.byteLength(JSON.stringify(agg)) * (4 / 3)).toBeLessThan(CIPHERTEXT_BASE64_MAX);
	});

	it("returns an empty, non-truncated aggregate for no sessions", () => {
		const agg = buildProjectState([], [], NOW);

		expect(agg).toEqual({
			generatedAt: NOW,
			projects: [],
			sessionCount: 0,
			sessionsOmitted: 0,
			projectCount: 0,
			projectsOmitted: 0,
			truncated: false,
			blockedProjectCount: 0,
			blockedSessionCount: 0,
		});
	});
});

describe("projectStateSignature", () => {
	it("reacts to a registry rename with no session changes", () => {
		const projectPath = resolve("/tmp/renamed-project");
		const before = buildProjectState([], [{ name: "Before", path: projectPath }], NOW);
		const after = buildProjectState([], [{ name: "After", path: projectPath }], NOW);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to registry membership changing when the display name is unchanged", () => {
		const projectPath = resolve("/tmp/membership-project");
		const sessions = [sessionIn("sess-a", projectPath)];
		const before = buildProjectState(sessions, [], NOW);
		const after = buildProjectState(
			sessions,
			[{ name: "membership-project", path: projectPath }],
			NOW,
		);

		expect(before.projects[0]?.name).toBe(after.projects[0]?.name);
		expect(before.projects[0]?.registered).toBe(false);
		expect(after.projects[0]?.registered).toBe(true);
		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("ignores a change to every lastActivityAt", () => {
		const before = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/a", { lastActivityAt: 1000 }),
				sessionIn("sess-b", "/tmp/b", { lastActivityAt: 2000 }),
			],
			[],
			NOW,
		);
		const after = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/a", { lastActivityAt: 7000 }),
				sessionIn("sess-b", "/tmp/b", { lastActivityAt: 8000 }),
			],
			[],
			NOW + 500,
		);

		expect(projectStateSignature(after)).toBe(projectStateSignature(before));
	});

	it("ignores a reordering caused only by lastActivityAt", () => {
		const before = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/pair", { lastActivityAt: 1000 }),
				sessionIn("sess-b", "/tmp/pair", { lastActivityAt: 2000 }),
			],
			[],
			NOW,
		);
		const after = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/pair", { lastActivityAt: 3000 }),
				sessionIn("sess-b", "/tmp/pair", { lastActivityAt: 2000 }),
			],
			[],
			NOW,
		);

		expect(before.projects[0]?.sessions.map((s) => s.sessionId)).toEqual(["sess-b", "sess-a"]);
		expect(after.projects[0]?.sessions.map((s) => s.sessionId)).toEqual(["sess-a", "sess-b"]);
		expect(projectStateSignature(after)).toBe(projectStateSignature(before));
	});

	it("reacts to a status change", () => {
		const before = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { status: "running" })],
			[],
			NOW,
		);
		const after = buildProjectState([sessionIn("sess-a", "/tmp/a", { status: "idle" })], [], NOW);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to a session becoming blocked", () => {
		const before = buildProjectState([sessionIn("sess-a", "/tmp/a")], [], NOW);
		const after = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { attention: PENDING })],
			[],
			NOW,
		);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to a pending request whose since alone changed", () => {
		const before = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { attention: PENDING })],
			[],
			NOW,
		);
		const after = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { attention: { ...PENDING, since: 4321 } })],
			[],
			NOW,
		);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to a session being added", () => {
		const before = buildProjectState([sessionIn("sess-a", "/tmp/a")], [], NOW);
		const after = buildProjectState(
			[sessionIn("sess-a", "/tmp/a"), sessionIn("sess-b", "/tmp/a")],
			[],
			NOW,
		);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to a session being removed", () => {
		const before = buildProjectState(
			[sessionIn("sess-a", "/tmp/a"), sessionIn("sess-b", "/tmp/a")],
			[],
			NOW,
		);
		const after = buildProjectState([sessionIn("sess-a", "/tmp/a")], [], NOW);

		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to sessionsOmitted changing", () => {
		const atCap = Array.from({ length: PROJECT_STATE_MAX_SESSIONS }, (_, i) =>
			sessionIn(`sess-${String(i).padStart(3, "0")}`, "/tmp/a"),
		);
		const overCap = [...atCap, sessionIn("sess-extra", "/tmp/a")];

		const before = buildProjectState(atCap, [], NOW);
		const after = buildProjectState(overCap, [], NOW);

		expect(before.sessionsOmitted).toBe(0);
		expect(after.sessionsOmitted).toBe(1);
		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to the blocked counts changing", () => {
		const before = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { attention: PENDING }), sessionIn("sess-b", "/tmp/b")],
			[],
			NOW,
		);
		const after = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/a", { attention: PENDING }),
				sessionIn("sess-b", "/tmp/b", { attention: PENDING }),
			],
			[],
			NOW,
		);

		expect(before.blockedProjectCount).toBe(1);
		expect(after.blockedProjectCount).toBe(2);
		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});

	it("reacts to blockedSessionCount changing within one project", () => {
		const before = buildProjectState(
			[sessionIn("sess-a", "/tmp/a", { attention: PENDING }), sessionIn("sess-b", "/tmp/a")],
			[],
			NOW,
		);
		const after = buildProjectState(
			[
				sessionIn("sess-a", "/tmp/a", { attention: PENDING }),
				sessionIn("sess-b", "/tmp/a", { attention: PENDING }),
			],
			[],
			NOW,
		);

		// blockedProjectCount is 1 in both; only the session count moves.
		expect(before.blockedProjectCount).toBe(after.blockedProjectCount);
		expect(before.blockedSessionCount).toBe(1);
		expect(after.blockedSessionCount).toBe(2);
		expect(projectStateSignature(after)).not.toBe(projectStateSignature(before));
	});
});
