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
import { SessionNotActiveError, SessionNotFoundError } from "@codemote/common";
import { type EventBus, createEvent } from "./events.js";
import type { SessionManager } from "./session.js";
import type { Session, WorkspaceConfig } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

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
	async startRun(options: RunOptions): Promise<RunResult> {
		// Create or get workspace
		const workspaceConfig: WorkspaceConfig = {
			repoPath: options.workspace,
			workspaceId: this.generateWorkspaceId(),
		};

		const workspace = await this.workspaceManager.create(workspaceConfig);
		const session = this.sessionManager.create(this.type, workspace);

		this.emitStatus(session.id, "starting");

		try {
			await this.doStartRun(session, options);
			const currentStatus = this.sessionManager.get(session.id)?.status;
			// Preserve executor-selected post-start status (e.g. idle after an initial turn).
			if (currentStatus === "starting") {
				this.emitStatus(session.id, "running");
			}
		} catch (error) {
			this.emitStatus(session.id, "error");
			throw error;
		}

		return {
			runId: session.runId,
			sessionId: session.id,
		};
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

		await this.doStop(session);
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
	protected emitMessage(sessionId: string, role: MessagePayload["role"], content: string): void {
		const payload: MessagePayload = { role, content };
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
	): void {
		const payload: ToolCallPayload = {
			toolCallId,
			toolName,
			...(args !== undefined ? { arguments: args } : {}),
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
	): void {
		const payload: ToolResultPayload = {
			toolCallId,
			toolName,
			...(output !== undefined ? { output } : {}),
			...(error !== undefined ? { error } : {}),
		};
		this.eventBus.emit(createEvent("session.tool_result", sessionId, payload));
	}

	// ========================================
	// Private helpers
	// ========================================

	private generateWorkspaceId(): string {
		return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	// ========================================
	// Abstract methods for subclasses to implement
	// ========================================

	/**
	 * Implement runtime-specific run start logic
	 */
	protected abstract doStartRun(session: Session, options: RunOptions): Promise<void>;

	/**
	 * Implement runtime-specific input handling
	 */
	protected abstract doSendInput(session: Session, input: string): Promise<void>;

	/**
	 * Implement runtime-specific stop logic
	 */
	protected abstract doStop(session: Session): Promise<void>;
}
