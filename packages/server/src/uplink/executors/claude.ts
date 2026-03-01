import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunOptions, RuntimeType } from "@codemote/common";
import spawn from "cross-spawn";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

/**
 * Claude Code configuration
 */
export interface ClaudeConfig {
	/** Path to claude CLI (default: finds in PATH) */
	claudePath: string;
	/** Additional CLI arguments */
	extraArgs: string[];
	/** Whether to allow dangerous operations without prompt */
	dangerouslySkipPermissions: boolean;
	/** Permission mode for claude print mode sessions */
	permissionMode: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
}

const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
	claudePath: "claude",
	extraArgs: [],
	dangerouslySkipPermissions: false,
	permissionMode: "acceptEdits",
};

const CLAUDE_DEBUG =
	process.env["GUILD_REMOTE_DEBUG"] === "1" || process.env["GUILD_REMOTE_DEBUG"] === "true";

function logClaudeDebug(message: string): void {
	if (CLAUDE_DEBUG) {
		console.log(message);
	}
}

/**
 * Claude session state
 */
interface ClaudeSession {
	/** Claude's session ID (for resume) */
	claudeSessionId: string | null;
	/** Selected model override (optional) */
	model: string | null;
	/** Child process (stdio pipes) */
	process: ChildProcessWithoutNullStreams | null;
	/** Data buffer for incomplete JSON lines */
	buffer: string;
	/** Whether process is running */
	running: boolean;
	/** Map from Claude SDK tool_use block ID to our generated toolCallId */
	pendingToolCalls: Map<string, { toolCallId: string; toolName: string }>;
}

/**
 * Claude stream event types from --output-format stream-json
 */
interface ClaudeStreamEvent {
	type: string;
	session_id?: string;
	content?: string;
	tool_name?: string;
	description?: string;
	args?: unknown;
	output?: string;
	message?: string;
	error?: string;
	/** Tool use block ID from Claude SDK (present on tool_use events) */
	id?: string;
	/** Tool use block ID reference (present on tool_result events to match back to the tool_use) */
	tool_use_id?: string;
	/** Parent tool use ID (non-null when event is from a sub-agent spawned by Task) */
	parent_tool_use_id?: string;
}

/**
 * Claude Code executor - controls Claude via CLI subprocess
 *
 * This executor spawns Claude Code in print mode with bidirectional
 * streaming JSON for both input and output. This allows multi-turn
 * conversations by keeping stdin open and sending follow-up messages
 * as JSON.
 *
 * Key CLI flags used:
 * - `-p`: Print mode (required for programmatic control)
 * - `--input-format stream-json`: Accept JSON messages on stdin
 * - `--output-format stream-json`: Emit JSON events on stdout
 * - `--verbose`: Include detailed events in output
 *
 * IMPORTANT: We do NOT close stdin after the initial prompt. This keeps
 * the session alive for follow-up messages via doSendInput().
 *
 * Environment variables:
 * - CLAUDE_PATH: Override path to claude binary
 */
export class ClaudeExecutor extends BaseExecutor {
	readonly type: RuntimeType = "claude";

	private config: ClaudeConfig;
	private claudeSessions = new Map<string, ClaudeSession>();

	constructor(
		workspaceManager: ConstructorParameters<typeof BaseExecutor>[0],
		sessionManager: ConstructorParameters<typeof BaseExecutor>[1],
		eventBus: ConstructorParameters<typeof BaseExecutor>[2],
		config: Partial<ClaudeConfig> = {},
	) {
		super(workspaceManager, sessionManager, eventBus);
		this.config = { ...DEFAULT_CLAUDE_CONFIG, ...config };

		// Allow env override for claude path
		if (process.env["CLAUDE_PATH"]) {
			this.config.claudePath = process.env["CLAUDE_PATH"];
		}
		const envPermissionMode = process.env["CLAUDE_PERMISSION_MODE"];
		if (this.isValidPermissionMode(envPermissionMode)) {
			this.config.permissionMode = envPermissionMode;
		}
	}

	/**
	 * Start a new Claude Code session
	 *
	 * Spawns Claude CLI in print mode with bidirectional stream-json.
	 * The session stays open because we keep stdin open for follow-up messages.
	 *
	 * Parses streaming JSON events and maps them to our unified event types.
	 */
	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const model = options.model?.trim() ? options.model.trim() : null;
		const args = this.buildArgs(options.resumeSessionId, model);

		const claudeSession: ClaudeSession = {
			claudeSessionId: null,
			model,
			process: null,
			buffer: "",
			running: true,
			pendingToolCalls: new Map(),
		};

		this.claudeSessions.set(session.id, claudeSession);

		const proc = spawn(this.config.claudePath, args, {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
				// Headless environment settings
				CI: "true",
				TERM: "dumb",
			},
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;

		if (!proc.stdout || !proc.stderr || !proc.stdin) {
			proc.kill("SIGTERM");
			claudeSession.running = false;
			this.claudeSessions.delete(session.id);
			this.emitOutput(session.id, "Error: Claude stdio streams not available\n");
			this.emitStatus(session.id, "error");
			throw new Error("Claude stdio streams not available");
		}

		claudeSession.process = proc;

		// Handle output (stdout + stderr).
		proc.stdout.on("data", (chunk) => {
			const data = chunk.toString("utf8");
			logClaudeDebug(`[Claude stdout] ${session.id.slice(0, 8)}...: ${data.slice(0, 200)}`);
			this.handleOutput(session.id, data);
		});
		proc.stderr.on("data", (chunk) => {
			const data = chunk.toString("utf8");
			logClaudeDebug(`[Claude stderr] ${session.id.slice(0, 8)}...: ${data.slice(0, 200)}`);
			this.handleOutput(session.id, data);
		});

		// Send initial prompt as JSON message (for stream-json input format)
		// Format: {"type":"user","message":{"role":"user","content":"..."}}
		// NOTE: We do NOT close stdin - keeping it open allows follow-up messages
		const initialMessage = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: options.initialPrompt,
			},
		});
		proc.stdin.write(`${initialMessage}\n`);
		// Some Claude builds don't emit a distinct session_start event.
		// Mark the turn as running immediately after enqueueing input.
		this.emitStatus(session.id, "running");

		// Handle spawn errors (e.g., binary missing / not executable). Without this,
		// Node can emit an unhandled 'error' event and crash the uplink process.
		proc.on("error", (error) => {
			if (!claudeSession.running) return;
			claudeSession.running = false;
			this.emitOutput(session.id, `Error: ${error.message}\n`);
			this.emitStatus(session.id, "error");
		});

		// Handle process exit
		proc.on("exit", (exitCode) => {
			if (!claudeSession.running) return;
			claudeSession.running = false;

			// Process any remaining buffer content
			if (claudeSession.buffer.trim()) {
				this.processLine(session.id, claudeSession.buffer);
				claudeSession.buffer = "";
			}

			if (exitCode === 0) {
				this.emitStatus(session.id, "ended");
			} else {
				this.emitStatus(session.id, "error");
			}
		});
	}

	/**
	 * Send a follow-up input to the Claude session
	 *
	 * With --input-format stream-json, we send messages as JSON objects.
	 * Format: {"type":"user","message":{"role":"user","content":"..."}}
	 * The session stays alive as long as we keep stdin open.
	 */
	protected async doSendInput(session: Session, input: string): Promise<void> {
		const claudeSession = this.claudeSessions.get(session.id);
		if (!claudeSession?.process || !claudeSession.running) {
			throw new Error("Claude session not running");
		}

		// Send as JSON message for stream-json input format
		const message = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: input,
			},
		});
		claudeSession.process.stdin.write(`${message}\n`);
		// Follow-up turns should immediately transition to running.
		this.emitStatus(session.id, "running");
	}

	/**
	 * Stop the Claude session
	 *
	 * Sends SIGTERM for graceful shutdown. If the process doesn't
	 * exit within 1 second, sends SIGKILL to force termination.
	 */
	protected async doStop(session: Session): Promise<void> {
		const claudeSession = this.claudeSessions.get(session.id);
		if (!claudeSession) return;

		if (claudeSession.process && claudeSession.running) {
			if (claudeSession.process.stdin.writable) {
				claudeSession.process.stdin.end();
			}

			// Send SIGTERM for graceful shutdown
			claudeSession.process.kill("SIGTERM");

			// Wait a bit for graceful exit
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Force kill if still running
			if (claudeSession.running) {
				claudeSession.process.kill("SIGKILL");
			}
		}

		claudeSession.running = false;
		this.claudeSessions.delete(session.id);
	}

	// ========================================
	// Private helper methods
	// ========================================

	/**
	 * Build command line arguments for claude CLI
	 *
	 * Uses print mode with bidirectional stream-json for programmatic control.
	 * The session stays alive as long as stdin remains open. If a resume ID
	 * is provided, Claude resumes that persisted conversation thread.
	 */
	private buildArgs(resumeSessionId?: string, model?: string | null): string[] {
		const args: string[] = [
			"-p", // Print mode (required for programmatic control)
			"--verbose", // Include detailed events
			"--input-format",
			"stream-json", // Accept JSON messages on stdin
			"--output-format",
			"stream-json", // Emit JSON events on stdout
			"--permission-mode",
			this.config.permissionMode,
		];

		// Add permission handling flag if configured to skip
		if (this.config.dangerouslySkipPermissions) {
			args.push("--dangerously-skip-permissions");
		}

		const selectedModel = model?.trim();
		if (selectedModel && selectedModel.length > 0) {
			args.push("--model", selectedModel);
		}

		const resumeId = resumeSessionId?.trim();
		if (resumeId && resumeId.length > 0) {
			args.push("--resume", resumeId);
		}

		// Add any extra configured args last so config can override defaults
		args.push(...this.config.extraArgs);

		return args;
	}

	private isValidPermissionMode(
		value: string | undefined,
	): value is ClaudeConfig["permissionMode"] {
		return (
			value === "acceptEdits" ||
			value === "bypassPermissions" ||
			value === "default" ||
			value === "delegate" ||
			value === "dontAsk" ||
			value === "plan"
		);
	}

	private generateToolCallId(): string {
		return `tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Handle raw output data from the Claude process
	 *
	 * Accumulates data in a buffer and processes complete lines.
	 * Each line should be a JSON event in stream-json mode.
	 */
	private handleOutput(sessionId: string, data: string): void {
		const claudeSession = this.claudeSessions.get(sessionId);
		if (!claudeSession) return;

		// Accumulate data in buffer
		claudeSession.buffer += data;

		// Process complete lines
		const lines = claudeSession.buffer.split("\n");
		claudeSession.buffer = lines.pop() || ""; // Keep incomplete line in buffer

		for (const line of lines) {
			this.processLine(sessionId, line);
		}
	}

	/**
	 * Process a single line of output
	 */
	private processLine(sessionId: string, line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		try {
			const event = JSON.parse(trimmed) as ClaudeStreamEvent;
			this.handleClaudeEvent(sessionId, event);
		} catch {
			// Not JSON, emit as raw output
			// This handles any non-JSON output from Claude
			this.emitOutput(sessionId, `${line}\n`);
		}
	}

	/**
	 * Handle a parsed Claude stream event
	 *
	 * Maps Claude's event types to our unified StreamEvent types:
	 * - session_start: Extract session ID, emit running status
	 * - assistant_message/message: Emit as output
	 * - partial_message: Emit as incremental output
	 * - tool_use: Emit tool usage notification
	 * - tool_result: Emit tool output
	 * - permission_request: Emit attention.required
	 * - error: Emit error status
	 * - end/session_end: Emit idle status (process remains alive for follow-up input)
	 */
	private handleClaudeEvent(sessionId: string, event: ClaudeStreamEvent): void {
		const claudeSession = this.claudeSessions.get(sessionId);
		const parentToolUseId = event.parent_tool_use_id ?? undefined;

		switch (event.type) {
			case "result":
				// JSON output format returns a single result object
				if (claudeSession && event.session_id) {
					claudeSession.claudeSessionId = event.session_id;
					this.sessionManager.setRuntimeSessionId(sessionId, event.session_id);
				}
				// Emit the result as a structured message
				if ((event as unknown as { result?: string }).result) {
					this.emitMessage(
						sessionId,
						"assistant",
						(event as unknown as { result: string }).result,
						parentToolUseId,
					);
				}
				this.emitStatus(sessionId, "idle");
				break;

			case "session_start":
				if (claudeSession && event.session_id) {
					claudeSession.claudeSessionId = event.session_id;
					this.sessionManager.setRuntimeSessionId(sessionId, event.session_id);
				}
				this.emitStatus(sessionId, "running");
				break;

			case "assistant_message":
			case "message":
				if (event.content) {
					this.emitMessage(sessionId, "assistant", event.content, parentToolUseId);
				}
				break;

			case "partial_message":
				// Streaming text deltas go through session.output for real-time display
				if (event.content) {
					this.emitOutput(sessionId, event.content);
				}
				break;

			case "tool_use":
				if (claudeSession) {
					const toolCallId = this.generateToolCallId();
					const toolName = event.tool_name || "unknown";
					// Track by Claude SDK block ID so we can match tool_result later
					if (event.id) {
						claudeSession.pendingToolCalls.set(event.id, { toolCallId, toolName });
					}
					const argsString = event.args !== undefined ? JSON.stringify(event.args) : undefined;
					this.emitToolCall(sessionId, toolCallId, toolName, argsString, parentToolUseId);
				} else {
					// Fallback if somehow session not found
					this.emitOutput(sessionId, `[Tool: ${event.tool_name || "unknown"}]\n`);
				}
				break;

			case "tool_result":
				if (claudeSession && event.tool_use_id) {
					const pending = claudeSession.pendingToolCalls.get(event.tool_use_id);
					if (pending) {
						claudeSession.pendingToolCalls.delete(event.tool_use_id);
						this.emitToolResult(
							sessionId,
							pending.toolCallId,
							pending.toolName,
							event.output,
							event.error,
							parentToolUseId,
						);
						break;
					}
				}
				// Fallback: no matching tool_use found, emit as raw output
				if (event.output) {
					this.emitOutput(sessionId, `${event.output}\n`);
				}
				break;

			case "permission_request":
				this.emitAttention(sessionId, "permission_required", {
					tool: event.tool_name,
					description: event.description,
					args: event.args,
				});
				break;

			case "error":
				this.emitOutput(sessionId, `Error: ${event.message || event.error || "Unknown error"}\n`);
				this.emitStatus(sessionId, "error");
				break;

			case "end":
			case "session_end":
				this.emitStatus(sessionId, "idle");
				break;

			default:
				break;
		}
	}
}
