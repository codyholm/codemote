import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
	/**
	 * How long a prompt write may stay unflushed before the session's input channel
	 * is declared dead. A claude process that stops draining stdin would otherwise
	 * park the write forever.
	 */
	stdinWriteTimeoutMs: number;
}

const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
	claudePath: "claude",
	extraArgs: [],
	dangerouslySkipPermissions: false,
	permissionMode: "acceptEdits",
	stdinWriteTimeoutMs: 30_000,
};

const CLAUDE_DEBUG =
	process.env["CODEMOTE_DEBUG"] === "1" || process.env["CODEMOTE_DEBUG"] === "true";

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
	/** Temperature override (optional) */
	temperature: number | null;
	/** Max tokens override (optional) */
	maxTokens: number | null;
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
/** A content block inside a Claude API message (tool_use, tool_result, or text). */
interface ClaudeContentBlock {
	type: string;
	/** text content (type=text) */
	text?: string;
	/** tool_use block ID (type=tool_use) */
	id?: string;
	/** tool name (type=tool_use) */
	name?: string;
	/** tool input (type=tool_use) */
	input?: unknown;
	/** tool_use_id reference (type=tool_result) */
	tool_use_id?: string;
	/** tool result content — string or array (type=tool_result) */
	content?: unknown;
	/** whether tool execution errored (type=tool_result) */
	is_error?: boolean;
}

/** Wrapper for the full API message object inside "assistant"/"user" events. */
interface ClaudeApiMessage {
	role?: string;
	content?: ClaudeContentBlock[];
}

interface ClaudeStreamEvent {
	type: string;
	session_id?: string;
	content?: string;
	tool_name?: string;
	description?: string;
	args?: unknown;
	output?: string;
	/** Full API message (present on "assistant" / "user" wrapper events) */
	message?: ClaudeApiMessage | string;
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
		const resumeSessionId = options.resumeSessionId?.trim() || null;
		const assignedSessionId = !resumeSessionId && options.projectStart ? randomUUID() : null;
		const model = options.model?.trim() ? options.model.trim() : null;
		const temperature =
			typeof options.temperature === "number" && options.temperature >= 0
				? options.temperature
				: null;
		const maxTokens =
			typeof options.maxTokens === "number" && options.maxTokens > 0 ? options.maxTokens : null;
		const claudeSession: ClaudeSession = {
			claudeSessionId: resumeSessionId ?? assignedSessionId,
			model,
			temperature,
			maxTokens,
			process: null,
			buffer: "",
			running: false,
			pendingToolCalls: new Map(),
		};

		this.claudeSessions.set(session.id, claudeSession);
		if (assignedSessionId) this.sessionManager.setRuntimeSessionId(session.id, assignedSessionId);
		const proc = await this.spawnClaude(
			session,
			claudeSession,
			resumeSessionId ?? undefined,
			assignedSessionId ?? undefined,
		);

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
	}

	protected override async doRecoverRun(
		session: Session,
		runtimeSessionId: string,
	): Promise<boolean> {
		this.claudeSessions.set(session.id, {
			claudeSessionId: runtimeSessionId,
			model: null,
			temperature: null,
			maxTokens: null,
			process: null,
			buffer: "",
			running: false,
			pendingToolCalls: new Map(),
		});
		return true;
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
		if (!claudeSession) {
			throw new Error("Claude session not running");
		}
		if (!claudeSession.process && !claudeSession.running && claudeSession.claudeSessionId) {
			await this.spawnClaude(session, claudeSession, claudeSession.claudeSessionId);
		}
		if (!claudeSession.process || !claudeSession.running) {
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

		const stdin = claudeSession.process.stdin;
		const timeoutMs = this.config.stdinWriteTimeoutMs;
		// Wait for the write to actually reach the OS rather than firing and forgetting.
		// If stdin is dead — claude exited or closed the pipe while the session is still
		// tracked as running — the write fails here, and the caller needs to hear about
		// it. Acking an input the runtime never received is worse than reporting the
		// failure: the user sits waiting for a reply to a prompt that was dropped.
		//
		// A claude process that stops draining stdin fails neither way, so the wait is
		// bounded. Destroying the stream at the deadline is what keeps the report honest:
		// the terminating newline is the last byte written, so a callback that has not
		// fired means the newline never reached the kernel and claude cannot have parsed
		// a message. Only an unparseable fragment is discarded. Without the destroy, a
		// wedged child that later drains stdin would deliver a prompt the client was
		// already told had failed, duplicating it if the user retried. It also makes
		// every later send fail fast instead of stacking up behind the stall.
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				stdin.destroy();
				reject(
					new Error(
						`Claude session input could not be delivered: write did not flush within ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			stdin.write(`${message}\n`, (error) => {
				// Destroying the stream above fires this callback with ERR_STREAM_DESTROYED;
				// the send is already settled, so it must not settle again.
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					reject(new Error(`Claude session input could not be delivered: ${error.message}`));
					return;
				}
				resolve();
			});
		});

		// Follow-up turns should immediately transition to running. Only a delivered
		// write earns this, so a failed send never looks like a turn in progress.
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

	private async spawnClaude(
		session: Session,
		claudeSession: ClaudeSession,
		resumeSessionId?: string,
		newSessionId?: string,
	): Promise<ChildProcessWithoutNullStreams> {
		const args = this.buildArgs(
			resumeSessionId,
			claudeSession.model,
			claudeSession.temperature,
			claudeSession.maxTokens,
			newSessionId,
		);
		claudeSession.running = true;
		const proc = spawn(this.config.claudePath, args, {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
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
		proc.stdin.on("error", (error) => {
			logClaudeDebug(`[Claude stdin] ${session.id.slice(0, 8)}...: ${error.message}`);
		});
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
		proc.on("error", (error) => {
			if (!claudeSession.running) return;
			claudeSession.running = false;
			this.emitOutput(session.id, `Error: ${error.message}\n`);
			this.emitStatus(session.id, "error");
		});
		proc.on("exit", (exitCode) => {
			if (!claudeSession.running) return;
			claudeSession.running = false;
			if (claudeSession.buffer.trim()) {
				this.processLine(session.id, claudeSession.buffer);
				claudeSession.buffer = "";
			}
			this.emitStatus(session.id, exitCode === 0 ? "ended" : "error");
		});

		try {
			await this.waitForSpawn(proc);
		} catch (error) {
			this.claudeSessions.delete(session.id);
			throw error;
		}
		return proc;
	}

	private waitForSpawn(proc: ChildProcessWithoutNullStreams): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = (): void => {
				proc.removeListener("spawn", onSpawn);
				proc.removeListener("error", onError);
			};
			const onSpawn = (): void => {
				cleanup();
				resolve();
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			proc.once("spawn", onSpawn);
			proc.once("error", onError);
		});
	}

	/**
	 * Build command line arguments for claude CLI
	 *
	 * Uses print mode with bidirectional stream-json for programmatic control.
	 * The session stays alive as long as stdin remains open. If a resume ID
	 * is provided, Claude resumes that persisted conversation thread.
	 */
	private buildArgs(
		resumeSessionId?: string,
		model?: string | null,
		temperature?: number | null,
		maxTokens?: number | null,
		newSessionId?: string,
	): string[] {
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

		if (typeof temperature === "number" && temperature >= 0) {
			args.push("--temperature", String(temperature));
		}

		if (typeof maxTokens === "number" && maxTokens > 0) {
			args.push("--max-tokens", String(maxTokens));
		}

		const resumeId = resumeSessionId?.trim();
		if (resumeId && resumeId.length > 0) {
			args.push("--resume", resumeId);
		} else if (newSessionId) {
			args.push("--session-id", newSessionId);
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

			case "assistant":
				// stream-json wrapper: message.content[] contains text and tool_use blocks
				this.handleAssistantWrapper(sessionId, event, parentToolUseId);
				break;

			case "user":
				// stream-json wrapper: message.content[] contains tool_result blocks
				this.handleUserWrapper(sessionId, event, parentToolUseId);
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

			case "error": {
				const errMsg = typeof event.message === "string" ? event.message : event.error;
				this.emitOutput(sessionId, `Error: ${errMsg || "Unknown error"}\n`);
				this.emitStatus(sessionId, "error");
				break;
			}

			case "end":
			case "session_end":
				this.emitStatus(sessionId, "idle");
				break;

			default:
				break;
		}
	}

	/**
	 * Handle "assistant" wrapper events from stream-json output.
	 * These wrap the full API message, whose content[] may include
	 * text blocks and tool_use blocks.
	 */
	private handleAssistantWrapper(
		sessionId: string,
		event: ClaudeStreamEvent,
		parentToolUseId: string | undefined,
	): void {
		const claudeSession = this.claudeSessions.get(sessionId);
		const msg = typeof event.message === "object" ? event.message : undefined;
		if (!msg?.content) return;

		const textParts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "text" && block.text) {
				textParts.push(block.text);
			} else if (block.type === "tool_use") {
				if (claudeSession) {
					const toolCallId = this.generateToolCallId();
					const toolName = block.name || "unknown";
					if (block.id) {
						claudeSession.pendingToolCalls.set(block.id, { toolCallId, toolName });
					}
					const argsString = block.input !== undefined ? JSON.stringify(block.input) : undefined;
					this.emitToolCall(sessionId, toolCallId, toolName, argsString, parentToolUseId);
				}
			}
		}
		if (textParts.length > 0) {
			this.emitMessage(sessionId, "assistant", textParts.join("\n"), parentToolUseId);
		}
	}

	/**
	 * Handle "user" wrapper events from stream-json output.
	 * These wrap tool_result blocks that complete pending tool calls.
	 */
	private handleUserWrapper(
		sessionId: string,
		event: ClaudeStreamEvent,
		parentToolUseId: string | undefined,
	): void {
		const claudeSession = this.claudeSessions.get(sessionId);
		const msg = typeof event.message === "object" ? event.message : undefined;
		if (!msg?.content) return;

		for (const block of msg.content) {
			if (block.type === "tool_result" && block.tool_use_id) {
				const output =
					typeof block.content === "string"
						? block.content
						: block.content !== undefined
							? JSON.stringify(block.content)
							: undefined;

				const pending = claudeSession?.pendingToolCalls.get(block.tool_use_id);
				if (pending) {
					claudeSession?.pendingToolCalls.delete(block.tool_use_id);
					const error = block.is_error ? (output ?? "Tool execution failed") : undefined;
					this.emitToolResult(
						sessionId,
						pending.toolCallId,
						pending.toolName,
						block.is_error ? undefined : output,
						error,
						parentToolUseId,
					);
				} else if (output) {
					// Fallback: no matching tool_use found, emit as raw output
					this.emitOutput(sessionId, `${output}\n`);
				}
			}
		}
	}
}
