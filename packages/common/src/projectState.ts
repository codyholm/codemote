import type { RuntimeType, SessionStatus } from "./index.js";

/**
 * Why a session should be looked at, as opposed to what its process is doing.
 * Notifications must tell "stopped for a decision" apart from "finished a turn",
 * and SessionStatus alone cannot: two of four runtimes finish a turn by going
 * `idle`, never `ended`.
 */
export type SessionAttentionState = "blocked" | "failed" | "awaiting" | "working" | "done";

/**
 * The one ordering every consumer shares. Lower sorts first, and the value is
 * the ordering key itself so no consumer invents its own notion of urgency.
 */
export const ATTENTION_RANK: Record<SessionAttentionState, number> = {
	blocked: 0,
	failed: 1,
	awaiting: 2,
	working: 3,
	done: 4,
};

/** An outstanding decision that is stopping a session from progressing. */
export interface PendingAttention {
	/** Executor-supplied reason: "permission_required" | "approval_required". */
	reason: string;
	/** One line an assistant can speak verbatim, so it does not compose its own. */
	description: string;
	/** Recorded so a consumer can say how long the request has been waiting. */
	since: number;
}

export interface ProjectSessionState {
	/** The argument send_input and stop already take, so a consumer can act. */
	sessionId: string;
	/** Which agent is running, for display and for runtime-specific phrasing. */
	runtime: RuntimeType;
	/** Raw process state, kept alongside `attention` for consumers that need it. */
	status: SessionStatus;
	attention: SessionAttentionState;
	/** ATTENTION_RANK[attention], carried so a single session can be classified
	 * without an array to compare against. */
	attentionRank: number;
	/** Non-null if and only if `attention` is "blocked". Any other state means
	 * there is no outstanding decision to describe. */
	pending: PendingAttention | null;
	startedAt: number;
	endedAt: number | null;
	/** Secondary sort key within one attention tier. */
	lastActivityAt: number;
	/**
	 * When `status` last actually changed. The transition key for `awaiting`, which
	 * per the runtime matrix is the completion signal for Claude and OpenCode - they
	 * finish a turn by going idle, not ended. `blocked` has `pending.since` and the
	 * terminal states have `endedAt`; without this, a consumer handed a snapshot
	 * pushed by some unrelated project could not tell which of five `awaiting`
	 * sessions just finished, and would have to diff against the previous aggregate.
	 * Unchanged by a repeated same-status write.
	 */
	statusChangedAt: number;
}

export interface ProjectState {
	/** Normalized absolute working directory. The only session-grouping identity
	 * that survives a restart, since session and workspace ids are regenerated. */
	id: string;
	/** basename(id), for display. */
	name: string;
	path: string;
	/** The most urgent attention across this project's sessions, including any
	 * omitted from `sessions` — a project must not look calm because its blocked
	 * session was dropped. */
	attention: SessionAttentionState;
	attentionRank: number;
	/** True total, including sessions omitted from `sessions`. */
	sessionCount: number;
	/** How many of this project's sessions were dropped by the session cap alone.
	 * Non-zero means `sessions` is a partial view of `sessionCount`. Scoped to this
	 * project, so it does not sum to the aggregate's `sessionsOmitted`. */
	sessionsOmitted: number;
	/** Most recent lastActivityAt across this project's sessions. */
	lastActivityAt: number;
	/** Sorted attention-first; render in array order. */
	sessions: ProjectSessionState[];
}

export interface ProjectStateAggregate {
	generatedAt: number;
	/** Sorted attention-first; render in array order. */
	projects: ProjectState[];
	/** True total across all projects, before any cap. */
	sessionCount: number;
	/**
	 * Sessions absent from this aggregate for any reason: dropped by the session cap
	 * or belonging to a project dropped by the project cap. `sessionCount` minus the
	 * sessions actually present always equals this. Deliberately NOT the sum of the
	 * per-project `sessionsOmitted` values, which only count the session cap - a
	 * project removed entirely contributes its sessions here and nothing there.
	 * Truncation is never silent.
	 */
	sessionsOmitted: number;
	/** True total, before the project cap. */
	projectCount: number;
	/** Projects dropped by the project cap. */
	projectsOmitted: number;
	truncated: boolean;
	/**
	 * How many PROJECTS are blocked, counted over the projects actually present so an
	 * assistant can name every one of them. A project holding five blocked sessions
	 * counts once here - use `blockedSessionCount` to say how many decisions wait.
	 */
	blockedProjectCount: number;
	/**
	 * How many SESSIONS are blocked, counted over the sessions actually present. This
	 * is the number of outstanding decisions, which is what a consumer means by "how
	 * many need approval".
	 */
	blockedSessionCount: number;
}

/**
 * Bounds exist because ended sessions accumulate for the uplink's whole process
 * lifetime and the aggregate crosses the relay inside a base64 NaCl envelope,
 * whose 192 KiB ciphertext cap binds before the 256 KiB socket cap. Both sit far
 * above any realistic single-developer load; they are a ceiling, not a budget.
 */
export const PROJECT_STATE_MAX_SESSIONS = 100;

/**
 * Serialized-byte ceiling for the whole aggregate, applied on top of the count caps.
 *
 * The count caps alone do not bound size: every project serializes its full path
 * twice (`id` and `path`) plus a basename, and a path is bounded only by PATH_MAX.
 * Fifty long-but-valid paths can therefore exceed the transport while the count caps
 * are untouched, which would make `truncated: false` a false statement.
 *
 * Derivation: the binding limit is the 192 KiB base64 ciphertext cap, and base64
 * expands by 4/3, so the raw budget is ~144 KiB. 128 KiB leaves envelope headroom.
 * The measured realistic worst case is ~61 KiB, so this is a ceiling that should
 * never fire in practice - not a working limit.
 */
export const PROJECT_STATE_MAX_BYTES = 128 * 1024;
export const PROJECT_STATE_MAX_PROJECTS = 50;

/**
 * The count caps above bound how many sessions appear; this bounds the one field
 * inside them whose length the runtimes control. A Claude permission request for a
 * Bash command carries the command itself, and a multi-kilobyte heredoc is ordinary
 * - 100 of those would exceed the payload cap and the push, being fire-and-forget,
 * would silently stop arriving. Long enough to speak; short enough to prove a bound.
 */
export const ATTENTION_DESCRIPTION_MAX = 200;

/**
 * The single place (status, pending) becomes an attention state, so the hub, the
 * assistant, and the notification path cannot disagree about what a session needs.
 */
export function attentionForSession(
	status: SessionStatus,
	hasPending: boolean,
): SessionAttentionState {
	// A terminal session has no outstanding decision, whatever is still recorded.
	if (hasPending && status !== "ended" && status !== "error") return "blocked";

	// Exhaustive with no default: a new SessionStatus becomes a type error rather
	// than a silent misclassification.
	switch (status) {
		case "error":
			return "failed";
		case "idle":
			return "awaiting";
		case "ended":
			return "done";
		case "starting":
		case "running":
			return "working";
	}
}
