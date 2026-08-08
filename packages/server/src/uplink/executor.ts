import type {
	MessagePayload,
	RunOptions,
	RunResult,
	RuntimeType,
	SessionStatus,
	StreamEvent,
	ToolCallPayload,
	ToolResultPayload,
} from "@codemote/common";
import {
	ATTENTION_DESCRIPTION_MAX,
	SessionNotActiveError,
	SessionNotFoundError,
} from "@codemote/common";
import { type EventBus, createEvent } from "./events.js";
import type { SessionManager } from "./session.js";
import type {
	DurableProjectSession,
	Session,
	SessionStartContext,
	Workspace,
	WorkspaceConfig,
} from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

/**
 * One line an assistant can speak verbatim, taken from what the executors already
 * pass. Reads the existing `details` shapes rather than asking executors to supply
 * anything new, and falls back to the reason so the line is never empty.
 */
function describeAttention(reason: string, details?: unknown): string {
	if (typeof details === "object" && details !== null) {
		const record = details as Record<string, unknown>;
		if (typeof record["description"] === "string") return truncate(record["description"]);
		if (typeof record["action"] === "string") return truncate(record["action"]);
		// Claude's permission_request sends { tool, description, args } and omits
		// description for some tools; without this the line degrades to the bare
		// reason while the tool name sits unused.
		if (typeof record["tool"] === "string") return truncate(record["tool"]);
	}
	return truncate(reason);
}

/**
 * The runtimes control this string's length - a Bash permission request carries the
 * command - and it is the only unbounded field inside the aggregate's count caps.
 */
function truncate(text: string): string {
	if (text.length <= ATTENTION_DESCRIPTION_MAX) return text;
	return `${text.slice(0, ATTENTION_DESCRIPTION_MAX - 1)}…`;
}

/**
 * Abstract base class for runtime executors
 *
 * This class provides common functionality that all runtime executors share:
 * - Workspace setup and management
 * - Session registration and lifecycle
 * - Event emission helpers
 *
 * Concrete executors extend this class and implement runtime-specific logic
 * through the abstract do* methods.
 */
export abstract class BaseExecutor {
	abstract readonly type: RuntimeType;

	protected workspaceManager: WorkspaceManager;
	protected sessionManager: SessionManager;
	protected eventBus: EventBus;

	constructor(
		workspaceManager: WorkspaceManager,
		sessionManager: SessionManager,
		eventBus: EventBus,
	) {
		this.workspaceManager = workspaceManager;
		this.sessionManager = sessionManager;
		this.eventBus = eventBus;
	}

	/**
	 * Start a new run
	 */
	async startRun(options: RunOptions, context?: SessionStartContext): Promise<RunResult> {
		const control = context?.launch;
		const recorded = control?.session;
		// Create or get workspace
		const workspaceConfig: WorkspaceConfig = {
			repoPath: options.workspace,
			workspaceId: recorded?.workspaceId ?? this.generateWorkspaceId(),
		};

		const workspace = await this.workspaceManager.create(workspaceConfig);
		const session = recorded
			? this.sessionManager.restore(this.recoveredSession(recorded, workspace, context))
			: this.sessionManager.create(this.type, workspace, context);

		// Each boundary is durable before the action it admits to. A session this
		// process cannot record must not exist for the runtime to write into, so
		// failing to persist discards it instead of leaving a phantom behind.
		try {
			control?.recordSession(session);
		} catch (error) {
			await this.discardSession(session.id, workspace.id);
			throw error;
		}

		this.emitStatus(session.id, "starting");

		try {
			control?.recordRuntimeLaunchRequested(session);
		} catch (error) {
			await this.discardSession(session.id, workspace.id);
			throw error;
		}

		try {
			await this.doStartRun(session, options);
			const currentStatus = this.sessionManager.get(session.id)?.status;
			// Preserve executor-selected post-start status (e.g. idle after an initial turn).
			if (currentStatus === "starting") {
				this.emitStatus(session.id, "running");
			}
		} catch (error) {
			this.emitStatus(session.id, "error");
			throw new ExecutorStartError(
				error instanceof Error ? error.message : String(error),
				session.runId,
				session.id,
				error,
			);
		}

		return {
			runId: session.runId,
			sessionId: session.id,
			...(context
				? {
						originProjectPath: context.originProjectPath,
						execution: context.execution,
					}
				: {}),
		};
	}

	/**
	 * Rehydrate a durable runtime conversation without manufacturing a new turn.
	 *
	 * Runtime-specific recovery may register enough state to resume lazily when
	 * the next real user input arrives. Unsupported runtimes return false and the
	 * caller keeps the existing conservative ended-session restoration.
	 */
	async recoverRun(
		recorded: DurableProjectSession,
		context: SessionStartContext,
	): Promise<boolean> {
		const runtimeSessionId = recorded.runtimeSessionId?.trim();
		if (!runtimeSessionId) return false;

		const workspace = this.workspaceManager.restore({
			id: recorded.workspaceId,
			workingDir: recorded.execution.directory,
			createdAt: recorded.createdAt,
		});
		const session = this.sessionManager.restore(
			this.recoveredSession(recorded, workspace, context, "idle"),
		);

		try {
			const recovered = await this.doRecoverRun(session, runtimeSessionId);
			if (recovered) return true;
		} catch (error) {
			await this.discardSession(session.id, workspace.id);
			throw error;
		}

		await this.discardSession(session.id, workspace.id);
		return false;
	}

	/**
	 * Send input to a session
	 */
	async sendInput(sessionId: string, input: string): Promise<void> {
		const session = this.sessionManager.get(sessionId);
		if (!session) throw new SessionNotFoundError(sessionId);
		if (session.status === "ended" || session.status === "error") {
			throw new SessionNotActiveError(sessionId);
		}

		this.sessionManager.touch(sessionId);
		await this.doSendInput(session, input);
		// Sending input is the answer to a pending request: the bridge's approval
		// response arrives here as "y" or "n". No runtime emits a resolution event,
		// so this is the only signal that the decision was made.
		//
		// Cleared only after the input actually landed. If doSendInput throws - a dead
		// child's stdin, say - the caller propagates and never republishes, so clearing
		// first would erase the approval from the state with nothing to restore it. A
		// duplicate blocked push on retry is the better failure.
		this.sessionManager.clearAttention(sessionId);
	}

	/**
	 * Stream events for a session
	 */
	stream(sessionId: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
		return this.eventBus.streamSession(sessionId, signal);
	}

	/**
	 * Stop a session
	 */
	async stop(sessionId: string): Promise<void> {
		const session = this.sessionManager.get(sessionId);
		if (!session) return;

		// Runtime exit handlers may report an error while an intentional stop is in
		// flight. The protocol caller records user intent separately; service shutdown
		// deliberately records nothing so the durable conversation remains recoverable.
		await this.sessionManager.withoutRecoveryPersistence(sessionId, () => this.doStop(session));
		this.sessionManager.end(sessionId);
		this.emitStatus(sessionId, "ended");
	}

	/**
	 * Get diff for a session's workspace
	 */
	async getDiff(sessionId: string, scope: "staged" | "unstaged" | "all"): Promise<string> {
		const session = this.sessionManager.get(sessionId);
		if (!session) throw new Error(`Session not found: ${sessionId}`);

		return this.workspaceManager.getDiff(session.workspace.id, scope);
	}

	// ========================================
	// Helper methods for subclasses
	// ========================================

	/**
	 * Emit an output event for a session
	 */
	protected emitOutput(sessionId: string, text: string): void {
		this.eventBus.emit(createEvent("session.output", sessionId, { text }));
	}

	/**
	 * Emit a status change event and update session state
	 */
	protected emitStatus(sessionId: string, status: SessionStatus): void {
		this.sessionManager.updateStatus(sessionId, status);
		this.eventBus.emit(createEvent("session.status", sessionId, { status }));
	}

	/**
	 * Emit an attention required event
	 */
	protected emitAttention(sessionId: string, reason: string, details?: unknown): void {
		this.sessionManager.setAttention(sessionId, reason, describeAttention(reason, details));
		// The payload stays exactly as it was: bridge.ts reads payload.details?.action
		// and payload.details?.description to build its approval request.
		this.eventBus.emit(createEvent("attention.required", sessionId, { reason, details }));
	}

	/**
	 * Emit a diff updated event
	 */
	protected emitDiffUpdated(sessionId: string): void {
		this.eventBus.emit(createEvent("git.diff_updated", sessionId, {}));
	}

	/**
	 * Emit a structured message event for a session
	 */
	protected emitMessage(
		sessionId: string,
		role: MessagePayload["role"],
		content: string,
		parentToolUseId?: string,
	): void {
		const payload: MessagePayload = {
			role,
			content,
			...(parentToolUseId ? { parentToolUseId } : {}),
		};
		this.eventBus.emit(createEvent("session.message", sessionId, payload));
	}

	/**
	 * Emit a tool call event for a session
	 */
	protected emitToolCall(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		args?: string,
		parentToolUseId?: string,
	): void {
		const payload: ToolCallPayload = {
			toolCallId,
			toolName,
			...(args !== undefined ? { arguments: args } : {}),
			...(parentToolUseId ? { parentToolUseId } : {}),
		};
		this.eventBus.emit(createEvent("session.tool_call", sessionId, payload));
	}

	/**
	 * Emit a tool result event for a session
	 */
	protected emitToolResult(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		output?: string,
		error?: string,
		parentToolUseId?: string,
	): void {
		const payload: ToolResultPayload = {
			toolCallId,
			toolName,
			...(output !== undefined ? { output } : {}),
			...(error !== undefined ? { error } : {}),
			...(parentToolUseId ? { parentToolUseId } : {}),
		};
		this.eventBus.emit(createEvent("session.tool_result", sessionId, payload));
	}

	// ========================================
	// Private helpers
	// ========================================

	private generateWorkspaceId(): string {
		return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Rebuild the exact session identity a previous process recorded, so a
	 * retransmission after a restart launches into the same session rather than
	 * allocating a second one.
	 */
	private recoveredSession(
		recorded: DurableProjectSession,
		workspace: Workspace,
		context?: SessionStartContext,
		status: SessionStatus = "starting",
	): Session {
		const now = Date.now();
		return {
			id: recorded.sessionId,
			runId: recorded.runId,
			runtime: this.type,
			status,
			resumeEligible: (recorded.recoveryState ?? "resumable") === "resumable",
			workspace,
			startedAt: recorded.createdAt,
			endedAt: null,
			lastActivityAt: now,
			statusChangedAt: now,
			...(recorded.runtimeSessionId ? { runtimeSessionId: recorded.runtimeSessionId } : {}),
			...(context
				? {
						originProjectPath: context.originProjectPath,
						execution: context.execution,
					}
				: {}),
		};
	}

	private async discardSession(sessionId: string, workspaceId: string): Promise<void> {
		this.sessionManager.remove(sessionId);
		await this.workspaceManager.remove(workspaceId);
	}

	// ========================================
	// Abstract methods for subclasses to implement
	// ========================================

	/**
	 * Implement runtime-specific run start logic
	 */
	protected abstract doStartRun(session: Session, options: RunOptions): Promise<void>;

	/**
	 * Register a durable runtime-native identity for lazy follow-up recovery.
	 * Runtimes that do not explicitly support this keep the prior ended state.
	 */
	protected async doRecoverRun(_session: Session, _runtimeSessionId: string): Promise<boolean> {
		return false;
	}

	/**
	 * Implement runtime-specific input handling
	 */
	protected abstract doSendInput(session: Session, input: string): Promise<void>;

	/**
	 * Implement runtime-specific stop logic
	 */
	protected abstract doStop(session: Session): Promise<void>;
}

export class ExecutorStartError extends Error {
	constructor(
		message: string,
		readonly runId: string,
		readonly sessionId: string,
		options?: unknown,
	) {
		super(message, options !== undefined ? { cause: options } : undefined);
		this.name = "ExecutorStartError";
	}
}
