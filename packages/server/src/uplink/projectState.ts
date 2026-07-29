import { basename, resolve } from "node:path";
import type {
	ProjectSessionState,
	ProjectState,
	ProjectStateAggregate,
	RegisteredProject,
	SessionAttentionState,
} from "@codemote/common";
import {
	ATTENTION_RANK,
	PROJECT_STATE_MAX_BYTES,
	PROJECT_STATE_MAX_PROJECTS,
	PROJECT_STATE_MAX_SESSIONS,
	attentionForSession,
} from "@codemote/common";
import type { Session } from "./types.js";

interface GroupedSession {
	projectId: string;
	state: ProjectSessionState;
}

interface ProjectGroup {
	name: string;
	registered: boolean;
	sessions: GroupedSession[];
}

function compareSessions(a: GroupedSession, b: GroupedSession): number {
	if (a.state.attentionRank !== b.state.attentionRank) {
		return a.state.attentionRank - b.state.attentionRank;
	}
	if (a.state.lastActivityAt !== b.state.lastActivityAt) {
		return b.state.lastActivityAt - a.state.lastActivityAt;
	}
	// Without this the order of two otherwise-identical sessions is unspecified,
	// and a rendered list would jitter between pushes for no reason.
	return compareStrings(a.state.sessionId, b.state.sessionId);
}

function compareProjects(a: ProjectState, b: ProjectState): number {
	if (a.attentionRank !== b.attentionRank) return a.attentionRank - b.attentionRank;
	if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
	return compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Combine registered projects with path-grouped sessions, classify each session,
 * order both levels attention-first, and bound the result for transport.
 *
 * Pure: `now` is injected rather than read, so callers and tests get the same answer.
 */
export function buildProjectState(
	sessions: Session[],
	registeredProjects: RegisteredProject[],
	now: number,
): ProjectStateAggregate {
	const all: GroupedSession[] = sessions.map((session) => {
		const attention = attentionForSession(session.status, session.attention !== undefined);
		return {
			projectId: resolve(session.originProjectPath ?? session.workspace.workingDir),
			state: {
				sessionId: session.id,
				runtime: session.runtime,
				status: session.status,
				attention,
				attentionRank: ATTENTION_RANK[attention],
				// Enforcing the "non-null iff blocked" invariant at the single point of
				// construction is what lets every consumer trust it.
				pending: attention === "blocked" ? (session.attention ?? null) : null,
				startedAt: session.startedAt,
				endedAt: session.endedAt,
				lastActivityAt: session.lastActivityAt,
				statusChangedAt: session.statusChangedAt,
				...(session.originProjectPath
					? { originProjectPath: resolve(session.originProjectPath) }
					: {}),
				...(session.execution ? { execution: session.execution } : {}),
			},
		};
	});

	// Sorting the flat list before capping makes the retained sessions provably the
	// most attention-worthy ones, rather than whichever project happened to be first.
	all.sort(compareSessions);

	const sessionCount = all.length;
	const keptIds = new Set(
		all.slice(0, PROJECT_STATE_MAX_SESSIONS).map((entry) => entry.state.sessionId),
	);

	const groups = new Map<string, ProjectGroup>();
	for (const project of registeredProjects) {
		const id = resolve(project.path);
		groups.set(id, {
			name: project.name,
			registered: true,
			sessions: [],
		});
	}

	for (const entry of all) {
		const group = groups.get(entry.projectId);
		if (group) {
			group.sessions.push(entry);
			continue;
		}
		groups.set(entry.projectId, {
			name: basename(entry.projectId) || entry.projectId,
			registered: false,
			sessions: [entry],
		});
	}

	const projects: ProjectState[] = [];
	for (const [id, group] of groups) {
		// A stable filter of the already-sorted list preserves the global order.
		const kept = group.sessions
			.filter((entry) => keptIds.has(entry.state.sessionId))
			.map((entry) => entry.state);

		// Ranked over every session including the omitted ones: a project must not
		// look calm because its blocked session fell outside the cap.
		let worst: SessionAttentionState = "done";
		let worstRank = ATTENTION_RANK.done;
		let lastActivityAt = 0;
		for (const entry of group.sessions) {
			if (entry.state.attentionRank < worstRank) {
				worstRank = entry.state.attentionRank;
				worst = entry.state.attention;
			}
			if (entry.state.lastActivityAt > lastActivityAt) {
				lastActivityAt = entry.state.lastActivityAt;
			}
		}

		projects.push({
			id,
			name: group.name,
			path: id,
			registered: group.registered,
			attention: worst,
			attentionRank: worstRank,
			sessionCount: group.sessions.length,
			sessionsOmitted: group.sessions.length - kept.length,
			lastActivityAt,
			sessions: kept,
		});
	}

	projects.sort(compareProjects);

	const projectCount = projects.length;

	// The count cap alone does not bound size: each project carries its full path
	// twice plus a display name, and a path is bounded only by PATH_MAX. Admitting
	// projects against a running byte total keeps `truncated` honest for long paths
	// too. Accumulated incrementally rather than by re-serializing the aggregate,
	// because this runs on every status event.
	const keptProjects: ProjectState[] = [];
	let budgetUsed = 0;
	for (const project of projects) {
		if (keptProjects.length >= PROJECT_STATE_MAX_PROJECTS) break;
		const size = Buffer.byteLength(JSON.stringify(project), "utf8");
		if (budgetUsed + size > PROJECT_STATE_MAX_BYTES) break;
		budgetUsed += size;
		keptProjects.push(project);
	}
	// Counts drops from either cause - the count cap or the byte budget.
	const projectsOmitted = projectCount - keptProjects.length;

	// Counted after the project cap, not before it. Sessions belonging to a dropped
	// project leave the output too, so counting only the session cap would report
	// "0 omitted" while concealing them - an affirmatively false statement to a
	// consumer that reads this number to say "and N more not shown".
	const visibleSessions = keptProjects.reduce(
		(total, project) => total + project.sessions.length,
		0,
	);
	const sessionsOmitted = sessionCount - visibleSessions;

	return {
		generatedAt: now,
		projects: keptProjects,
		sessionCount,
		sessionsOmitted,
		projectCount,
		projectsOmitted,
		truncated: sessionsOmitted > 0 || projectsOmitted > 0,
		// Both counted over the retained projects only, so each matches what a consumer
		// can actually see and name. They differ whenever one project holds more than
		// one blocked session, which is why reporting only the project count would
		// understate the number of waiting decisions.
		blockedProjectCount: keptProjects.filter((project) => project.attention === "blocked").length,
		blockedSessionCount: keptProjects
			.flatMap((project) => project.sessions)
			.filter((session) => session.attention === "blocked").length,
	};
}

/**
 * Canonical serialization of the fields whose change warrants waking a consumer.
 *
 * Timestamps and array order are deliberately absent. `SessionManager.updateStatus`
 * writes `lastActivityAt` unconditionally, and the codex executor re-emits
 * `running` on every turn, so any signature carrying a timestamp would fire on a
 * write that changed nothing. Array order is derived from `lastActivityAt`, so
 * sorting by id here keeps an activity-only reordering invisible while a genuine
 * rank change still shows, because `attention` is included. `attentionRank`,
 * `path`, `runtime`, `startedAt` and `endedAt` are omitted as redundant or
 * immutable. `name` and `registered` are included because a registry rename or
 * membership change must wake consumers. `pending` is compared in full: a second
 * request for the same session is a genuinely new one.
 *
 * `statusChangedAt` is excluded on purpose rather than by oversight: it moves only
 * when `status` moves, and `status` is already here, so including it could neither
 * catch a change this misses nor suppress one it reports.
 */
export function projectStateSignature(state: ProjectStateAggregate): string {
	return JSON.stringify({
		sessionCount: state.sessionCount,
		sessionsOmitted: state.sessionsOmitted,
		projectCount: state.projectCount,
		projectsOmitted: state.projectsOmitted,
		truncated: state.truncated,
		blockedProjectCount: state.blockedProjectCount,
		blockedSessionCount: state.blockedSessionCount,
		projects: [...state.projects]
			.sort((a, b) => compareStrings(a.id, b.id))
			.map((project) => ({
				id: project.id,
				name: project.name,
				registered: project.registered,
				attention: project.attention,
				sessionCount: project.sessionCount,
				sessionsOmitted: project.sessionsOmitted,
				sessions: [...project.sessions]
					.sort((a, b) => compareStrings(a.sessionId, b.sessionId))
					.map((session) => ({
						sessionId: session.sessionId,
						status: session.status,
						attention: session.attention,
						pending: session.pending,
						originProjectPath: session.originProjectPath,
						execution: session.execution,
					})),
			})),
	});
}
