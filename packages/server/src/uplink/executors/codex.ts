import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunOptions, RuntimeType } from "@codemote/common";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

/**
 * Codex CLI configuration
 */
export interface CodexConfig {
	/** Path to codex CLI (default: finds in PATH) */
	codexPath: string;
	/** Sandbox mode for file access permissions */
	sandbox: "read-only" | "workspace-write" | "danger-full-access";
	/** Approval policy for uncertain operations */
	approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
	/** Output schema file path for validation (optional) */
	outputSchema: string | null;
}

const DEFAULT_CODEX_CONFIG: CodexConfig = {
	codexPath: "codex",
	sandbox: "workspace-write",
	approvalPolicy: "on-request",
	outputSchema: null,
};

/**
 * Codex session state
 */
interface CodexSession {
	/** Child process handle */
	process: ChildProcess | null;
	/** Codex session ID (for resume) */
	codexSessionId: string | null;
	/** Last thread ID */
	threadId: string | null;
	/** Whether process is running */
	running: boolean;
	/** Non-JSON stderr output for troubleshooting process failures */
	stderr: string;
	/** Pending tool call mappings keyed by Codex item id */
	pendingToolCalls: Map<string, { toolCallId: string; toolName: string }>;
}

/**
 * Codex event types from JSON Lines output
 *
 * Codex CLI emits these events to stdout when run with --json flag.
 * Each line is a complete JSON object.
 */
interface CodexEvent {
	type: string;
	thread_id?: string;
	session_id?: string;
	content?: string;
	command?: string;
	output?: string;
	path?: string;
	action?: string;
	description?: string;
	error?: string;
	item?: {
		id?: string;
		type?: string;
		text?: string;
		command?: string;
		aggregated_output?: string;
		exit_code?: number | null;
		status?: string;
		path?: string;
		action?: string;
		description?: string;
		[key: string]: unknown;
	};
}

/**
 * Codex CLI executor - controls Codex via subprocess
 *
 * This executor spawns Codex CLI with `codex exec --json` for machine-readable
 * output. It parses JSON Lines events from stdout and maps them to our unified
 * StreamEvent types. Stderr is used for diagnostics and surfaced when runs fail.
 *
 * Key CLI flags used:
 * - `exec`: Run in non-interactive mode
 * - `--json`: Output JSON Lines events to stdout
 * - `--sandbox <mode>`: Control file access permissions (top-level flag)
 * - `--ask-for-approval <policy>`: Control when to ask for confirmation (top-level flag)
 *
 * Environment variables:
 * - CODEX_API_KEY: Required for Codex authentication
 * - CODEX_PATH: Override path to codex binary
 */
export class CodexExecutor extends BaseExecutor {
	readonly type: RuntimeType = "codex";

	private config: CodexConfig;
	private codexSessions = new Map<string, CodexSession>();

	constructor(
		workspaceManager: ConstructorParameters<typeof BaseExecutor>[0],
		sessionManager: ConstructorParameters<typeof BaseExecutor>[1],
		eventBus: ConstructorParameters<typeof BaseExecutor>[2],
		config: Partial<CodexConfig> = {},
	) {
		super(workspaceManager, sessionManager, eventBus);
		this.config = { ...DEFAULT_CODEX_CONFIG, ...config };

		// Allow env override for codex path
		if (process.env["CODEX_PATH"]) {
			this.config.codexPath = process.env["CODEX_PATH"];
		}
	}

	/**
	 * Start a new Codex session
	 *
	 * Spawns `codex exec --json` as a subprocess. Parses JSON Lines events
	 * from stdout using readline and maps them to our unified event types.
	 */
	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const args = this.buildExecArgs(options.initialPrompt);
		const codexSession = this.createCodexSession();

		this.codexSessions.set(session.id, codexSession);

		const proc = spawn(this.config.codexPath, args, {
			cwd: session.workspace.workingDir,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.attachProcessHandlers(session.id, codexSession, proc);
	}

	/**
	 * Send input to the Codex session
	 *
	 * Writes to the process stdin. This is used for responding to
	 * approval requests or providing additional context.
	 */
	protected async doSendInput(session: Session, input: string): Promise<void> {
		const codexSession = this.codexSessions.get(session.id);
		if (!codexSession?.process || !codexSession.running) {
			throw new Error("Codex session not running");
		}

		if (!codexSession.process.stdin) {
			throw new Error("Codex process stdin not available");
		}

		// Write input with newline
		codexSession.process.stdin.write(`${input}\n`);
	}

	/**
	 * Stop the Codex session
	 *
	 * Sends SIGTERM for graceful shutdown. If the process doesn't
	 * exit within 1 second, sends SIGKILL to force termination.
	 */
	protected async doStop(session: Session): Promise<void> {
		const codexSession = this.codexSessions.get(session.id);
		if (!codexSession) return;

		if (codexSession.process && codexSession.running) {
			// Send SIGTERM for graceful shutdown
			codexSession.process.kill("SIGTERM");

			// Wait a bit for graceful exit
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Force kill if still running
			if (codexSession.running) {
				codexSession.process.kill("SIGKILL");
			}
		}

		codexSession.running = false;
		this.codexSessions.delete(session.id);
	}

	/**
	 * Resume a previous Codex session
	 *
	 * Uses `codex exec resume <session_id>` to continue a previous session.
	 * Optionally includes a follow-up message.
	 */
	async resumeSession(sessionId: string, codexSessionId: string, followUp?: string): Promise<void> {
		const session = this.sessionManager.get(sessionId);
		if (!session) throw new Error("Session not found");

		const args = this.buildResumeArgs(codexSessionId, followUp);
		const codexSession = this.createCodexSession(codexSessionId);

		this.codexSessions.set(session.id, codexSession);

		const proc = spawn(this.config.codexPath, args, {
			cwd: session.workspace.workingDir,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.attachProcessHandlers(session.id, codexSession, proc);
	}

	// ========================================
	// Private helper methods
	// ========================================

	private createCodexSession(initialSessionId: string | null = null): CodexSession {
		return {
			process: null,
			codexSessionId: initialSessionId,
			threadId: null,
			running: true,
			stderr: "",
			pendingToolCalls: new Map(),
		};
	}

	/**
	 * Build command line arguments for new `codex exec` runs.
	 *
	 * `--ask-for-approval` and `--sandbox` are top-level Codex flags, so they
	 * must appear before the `exec` subcommand.
	 */
	private buildExecArgs(task: string): string[] {
		const args: string[] = [
			"--ask-for-approval",
			this.config.approvalPolicy,
			"--sandbox",
			this.config.sandbox,
			"exec",
			"--json",
		];

		if (this.config.outputSchema) {
			args.push("--output-schema", this.config.outputSchema);
		}

		args.push(task);
		return args;
	}

	/**
	 * Build command line arguments for `codex exec resume`.
	 *
	 * Use top-level flags before `exec` so the command works with current Codex CLI.
	 */
	private buildResumeArgs(codexSessionId: string, followUp?: string): string[] {
		const args: string[] = [
			"--ask-for-approval",
			this.config.approvalPolicy,
			"--sandbox",
			this.config.sandbox,
			"exec",
			"resume",
			codexSessionId,
			"--json",
		];

		if (followUp) {
			args.push(followUp);
		}

		return args;
	}

	/**
	 * Attach stdout/stderr parsing and lifecycle handlers to a Codex process.
	 */
	private attachProcessHandlers(
		sessionId: string,
		codexSession: CodexSession,
		proc: ChildProcess,
	): void {
		codexSession.process = proc;

		// JSONL events are emitted on stdout in modern Codex builds.
		if (proc.stdout) {
			const stdoutReader = createInterface({ input: proc.stdout });
			stdoutReader.on("line", (line) => {
				this.handleJsonLine(sessionId, line, true);
			});
		}

		// Keep stderr mostly for diagnostics; don't stream noisy non-JSON logs live.
		if (proc.stderr) {
			const stderrReader = createInterface({ input: proc.stderr });
			stderrReader.on("line", (line) => {
				this.handleJsonLine(sessionId, line, false);
			});
		}

		proc.on("exit", (code) => {
			codexSession.running = false;

			if (code === 0) {
				this.emitStatus(sessionId, "ended");
				return;
			}

			const stderrSummary = this.getStderrSummary(codexSession.stderr);
			if (stderrSummary) {
				this.emitOutput(sessionId, `Error: ${stderrSummary}\n`);
			}
			this.emitStatus(sessionId, "error");
		});

		proc.on("error", (error) => {
			codexSession.running = false;
			this.emitOutput(sessionId, `Error: ${error.message}\n`);
			this.emitStatus(sessionId, "error");
		});
	}

	/**
	 * Handle a line from Codex output streams.
	 *
	 * JSON lines are treated as structured events. Non-JSON stdout lines are
	 * emitted as raw output. Non-JSON stderr lines are buffered for failures.
	 */
	private handleJsonLine(sessionId: string, line: string, emitRawOnParseFailure: boolean): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		try {
			const event = JSON.parse(trimmed) as CodexEvent;
			this.handleCodexEvent(sessionId, event);
		} catch {
			if (emitRawOnParseFailure) {
				this.emitOutput(sessionId, `${line}\n`);
				return;
			}
			this.appendStderr(sessionId, line);
		}
	}

	/**
	 * Handle a parsed Codex event
	 *
	 * Maps Codex event types to our unified StreamEvent types:
	 * - thread.started: Extract thread ID, emit running status
	 * - turn.started: Emit turn notification
	 * - turn.completed: Emit idle status
	 * - turn.failed: Emit error with details
	 * - item.message: Emit content as output
	 * - item.command_execution: Emit command and its output
	 * - item.file_change: Emit file change notification, trigger diff update
	 * - item.approval_request: Emit attention.required for user decision
	 * - session.id: Store session ID for resume capability
	 */
	private handleCodexEvent(sessionId: string, event: CodexEvent): void {
		const codexSession = this.codexSessions.get(sessionId);

		switch (event.type) {
			case "thread.started":
				if (codexSession && event.thread_id) {
					codexSession.threadId = event.thread_id;
					codexSession.codexSessionId = event.thread_id;
					this.sessionManager.setRuntimeSessionId(sessionId, event.thread_id);
				}
				this.emitStatus(sessionId, "running");
				break;

			case "turn.started":
				this.emitStatus(sessionId, "running");
				break;

			case "turn.completed":
				this.emitStatus(sessionId, "idle");
				break;

			case "turn.failed":
				this.emitOutput(sessionId, `Turn failed: ${event.error || "Unknown error"}\n`);
				this.emitStatus(sessionId, "error");
				break;

			case "item.started":
				if (event.item) {
					this.handleItemStarted(sessionId, event.item);
				}
				break;

			case "item.completed":
				if (event.item) {
					this.handleItemCompleted(sessionId, event.item);
				}
				break;

			case "item.message":
				if (event.content) {
					this.emitMessage(sessionId, "assistant", event.content);
				}
				break;

			case "item.command_execution":
				this.emitLegacyCommandEvent(sessionId, event);
				break;

			case "item.file_change":
				this.emitDiffUpdated(sessionId);
				break;

			case "item.approval_request":
				// Route approval requests to mobile app
				this.emitAttention(sessionId, "approval_required", {
					action: event.action,
					description: event.description,
				});
				break;

			case "session.id":
				if (codexSession && event.session_id) {
					codexSession.codexSessionId = event.session_id;
					this.sessionManager.setRuntimeSessionId(sessionId, event.session_id);
				}
				break;

			default:
				break;
		}
	}

	private handleItemStarted(sessionId: string, item: NonNullable<CodexEvent["item"]>): void {
		if (item.type !== "command_execution") {
			return;
		}

		const command = this.asString(item.command);
		const { toolCallId, toolName } = this.registerToolCall(sessionId, item.id, "shell");
		this.emitToolCall(sessionId, toolCallId, toolName, command);
	}

	private handleItemCompleted(sessionId: string, item: NonNullable<CodexEvent["item"]>): void {
		switch (item.type) {
			case "agent_message": {
				const text = this.asString(item.text);
				if (text) {
					this.emitMessage(sessionId, "assistant", text);
				}
				break;
			}

			case "command_execution":
				this.emitCommandExecutionResult(sessionId, item);
				break;

			case "file_change":
				this.emitDiffUpdated(sessionId);
				break;

			case "approval_request":
				this.emitAttention(sessionId, "approval_required", {
					action: this.asString(item.action),
					description: this.asString(item.description),
				});
				break;

			default:
				break;
		}
	}

	private emitCommandExecutionResult(
		sessionId: string,
		item: NonNullable<CodexEvent["item"]>,
	): void {
		const toolName = "shell";
		let toolCallId: string;
		const pending = this.consumeToolCall(sessionId, item.id);
		const command = this.asString(item.command);

		if (pending) {
			toolCallId = pending.toolCallId;
		} else {
			toolCallId = this.generateToolCallId();
			this.emitToolCall(sessionId, toolCallId, toolName, command);
		}

		const output = this.asString(item.aggregated_output);
		const exitCode = this.asNumber(item.exit_code);
		const error =
			exitCode !== null && exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined;
		this.emitToolResult(sessionId, toolCallId, toolName, output, error);
		this.emitDiffUpdated(sessionId);
	}

	private emitLegacyCommandEvent(sessionId: string, event: CodexEvent): void {
		const toolCallId = this.generateToolCallId();
		const toolName = "shell";
		this.emitToolCall(sessionId, toolCallId, toolName, event.command);
		this.emitToolResult(sessionId, toolCallId, toolName, event.output);
	}

	private registerToolCall(
		sessionId: string,
		itemId: string | undefined,
		toolName: string,
	): { toolCallId: string; toolName: string } {
		const codexSession = this.codexSessions.get(sessionId);
		if (!codexSession) {
			return { toolCallId: this.generateToolCallId(), toolName };
		}

		const itemKey = this.asString(itemId);
		if (!itemKey) {
			return { toolCallId: this.generateToolCallId(), toolName };
		}

		const existing = codexSession.pendingToolCalls.get(itemKey);
		if (existing) return existing;

		const pending = {
			toolCallId: this.generateToolCallId(),
			toolName,
		};
		codexSession.pendingToolCalls.set(itemKey, pending);
		return pending;
	}

	private consumeToolCall(
		sessionId: string,
		itemId: string | undefined,
	): { toolCallId: string; toolName: string } | null {
		const codexSession = this.codexSessions.get(sessionId);
		if (!codexSession) return null;

		const itemKey = this.asString(itemId);
		if (!itemKey) return null;

		const pending = codexSession.pendingToolCalls.get(itemKey);
		if (!pending) return null;
		codexSession.pendingToolCalls.delete(itemKey);
		return pending;
	}

	private appendStderr(sessionId: string, line: string): void {
		const codexSession = this.codexSessions.get(sessionId);
		if (!codexSession) return;

		codexSession.stderr += `${line}\n`;
		const maxChars = 8000;
		if (codexSession.stderr.length > maxChars) {
			codexSession.stderr = codexSession.stderr.slice(-maxChars);
		}
	}

	private getStderrSummary(stderr: string): string | null {
		const trimmed = stderr.trim();
		if (!trimmed) return null;
		const lines = trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length === 0) return null;
		return lines.slice(-6).join("\n");
	}

	private asString(value: unknown): string | undefined {
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	private asNumber(value: unknown): number | null {
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	}

	private generateToolCallId(): string {
		return `codex-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}
}
