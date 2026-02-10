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
	/** Accumulated stdout for final output */
	stdout: string;
}

/**
 * Codex event types from JSON Lines output
 *
 * Codex CLI emits these events to stderr when run with --json flag.
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
}

/**
 * Codex CLI executor - controls Codex via subprocess
 *
 * This executor spawns Codex CLI with `codex exec --json` for machine-readable
 * output. It parses JSON Lines events from stderr and maps them to our unified
 * StreamEvent types.
 *
 * Key CLI flags used:
 * - `exec`: Run in non-interactive mode
 * - `--json`: Output JSON Lines events to stderr
 * - `--sandbox <mode>`: Control file access permissions
 * - `--ask-for-approval <policy>`: Control when to ask for confirmation
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
	 * from stderr using readline and maps them to our unified event types.
	 * Final output is captured from stdout.
	 */
	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const args = this.buildArgs(options.initialPrompt);

		const codexSession: CodexSession = {
			process: null,
			codexSessionId: null,
			threadId: null,
			running: true,
			stdout: "",
		};

		this.codexSessions.set(session.id, codexSession);

		// Spawn Codex process
		const proc = spawn(this.config.codexPath, args, {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
				// CODEX_API_KEY should be in environment
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		codexSession.process = proc;

		// Parse JSON Lines from stderr using readline
		if (proc.stderr) {
			const stderrReader = createInterface({ input: proc.stderr });
			stderrReader.on("line", (line) => {
				this.handleJsonLine(session.id, line);
			});
		}

		// Capture stdout (final output)
		if (proc.stdout) {
			proc.stdout.on("data", (data: Buffer) => {
				codexSession.stdout += data.toString();
			});
		}

		// Handle process exit
		proc.on("exit", (code) => {
			codexSession.running = false;

			if (code === 0) {
				// Emit final output from stdout
				if (codexSession.stdout.trim()) {
					this.emitOutput(session.id, `\n--- Final Output ---\n${codexSession.stdout}\n`);
				}
				this.emitStatus(session.id, "ended");
			} else {
				this.emitStatus(session.id, "error");
			}
		});

		// Handle spawn errors
		proc.on("error", (error) => {
			codexSession.running = false;
			this.emitOutput(session.id, `Error: ${error.message}\n`);
			this.emitStatus(session.id, "error");
		});
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

		const args = ["exec", "resume", codexSessionId, "--json"];

		// Add sandbox and approval policy
		args.push("--sandbox", this.config.sandbox);
		args.push("--ask-for-approval", this.config.approvalPolicy);

		// Add follow-up message if provided
		if (followUp) {
			args.push(followUp);
		}

		const codexSession: CodexSession = {
			process: null,
			codexSessionId,
			threadId: null,
			running: true,
			stdout: "",
		};

		this.codexSessions.set(session.id, codexSession);

		// Spawn Codex resume process
		const proc = spawn(this.config.codexPath, args, {
			cwd: session.workspace.workingDir,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		codexSession.process = proc;

		// Set up event handlers (same as doStartRun)
		if (proc.stderr) {
			const stderrReader = createInterface({ input: proc.stderr });
			stderrReader.on("line", (line) => {
				this.handleJsonLine(session.id, line);
			});
		}

		if (proc.stdout) {
			proc.stdout.on("data", (data: Buffer) => {
				codexSession.stdout += data.toString();
			});
		}

		proc.on("exit", (code) => {
			codexSession.running = false;
			if (code === 0) {
				if (codexSession.stdout.trim()) {
					this.emitOutput(session.id, `\n--- Final Output ---\n${codexSession.stdout}\n`);
				}
				this.emitStatus(session.id, "ended");
			} else {
				this.emitStatus(session.id, "error");
			}
		});

		proc.on("error", (error) => {
			codexSession.running = false;
			this.emitOutput(session.id, `Error: ${error.message}\n`);
			this.emitStatus(session.id, "error");
		});
	}

	// ========================================
	// Private helper methods
	// ========================================

	/**
	 * Build command line arguments for codex exec
	 */
	private buildArgs(task: string): string[] {
		const args: string[] = ["exec", "--json"];

		// Sandbox mode
		args.push("--sandbox", this.config.sandbox);

		// Approval policy
		args.push("--ask-for-approval", this.config.approvalPolicy);

		// Output schema if configured
		if (this.config.outputSchema) {
			args.push("--output-schema", this.config.outputSchema);
		}

		// The task as the final argument
		args.push(task);

		return args;
	}

	/**
	 * Handle a line of JSON output from stderr
	 *
	 * Attempts to parse the line as JSON. If successful, processes it
	 * as a Codex event. Otherwise, emits as raw output.
	 */
	private handleJsonLine(sessionId: string, line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		try {
			const event = JSON.parse(trimmed) as CodexEvent;
			this.handleCodexEvent(sessionId, event);
		} catch {
			// Not valid JSON, emit as raw output
			// This handles any non-JSON diagnostic output from Codex
			this.emitOutput(sessionId, `${line}\n`);
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
				}
				this.emitStatus(sessionId, "running");
				break;

			case "turn.started":
				this.emitOutput(sessionId, "[Turn started]\n");
				break;

			case "turn.completed":
				this.emitStatus(sessionId, "idle");
				break;

			case "turn.failed":
				this.emitOutput(sessionId, `Turn failed: ${event.error || "Unknown error"}\n`);
				this.emitStatus(sessionId, "error");
				break;

			case "item.message":
				if (event.content) {
					this.emitOutput(sessionId, `${event.content}\n`);
				}
				break;

			case "item.command_execution":
				this.emitOutput(sessionId, `[Command: ${event.command || "unknown"}]\n`);
				if (event.output) {
					this.emitOutput(sessionId, `${event.output}\n`);
				}
				break;

			case "item.file_change":
				this.emitOutput(sessionId, `[File: ${event.path || "unknown"}]\n`);
				// Notify that workspace diff has changed
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
				// Log unknown event types for debugging
				// but don't emit them as output to avoid noise
				break;
		}
	}
}
