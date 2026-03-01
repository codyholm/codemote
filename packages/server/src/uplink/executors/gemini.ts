import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunOptions, RuntimeType } from "@codemote/common";
import spawn from "cross-spawn";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

/**
 * Gemini CLI configuration
 */
export interface GeminiConfig {
	/** Path to gemini CLI (default: finds in PATH) */
	geminiPath: string;
	/** Additional CLI arguments (optional) */
	extraArgs: string[];
}

const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
	geminiPath: "gemini",
	extraArgs: [],
};

interface GeminiSession {
	process: ChildProcessWithoutNullStreams | null;
	running: boolean;
	hasHistory: boolean;
	runtimeSessionId: string | null;
}

interface GeminiHeadlessResponse {
	session_id?: unknown;
	sessionId?: unknown;
	response?: unknown;
	candidates?: unknown;
	content?: unknown;
}

/**
 * Gemini CLI executor - controls Gemini via subprocess
 *
 * This executor runs Gemini in headless mode per turn (`--prompt`), captures
 * JSON output, and resumes follow-up turns with Gemini's persisted session ID.
 *
 * Environment variables:
 * - GEMINI_PATH: Override path to gemini binary
 */
export class GeminiExecutor extends BaseExecutor {
	readonly type: RuntimeType = "gemini";

	private config: GeminiConfig;
	private geminiSessions = new Map<string, GeminiSession>();

	constructor(
		workspaceManager: ConstructorParameters<typeof BaseExecutor>[0],
		sessionManager: ConstructorParameters<typeof BaseExecutor>[1],
		eventBus: ConstructorParameters<typeof BaseExecutor>[2],
		config: Partial<GeminiConfig> = {},
	) {
		super(workspaceManager, sessionManager, eventBus);
		this.config = { ...DEFAULT_GEMINI_CONFIG, ...config };

		if (process.env["GEMINI_PATH"]) {
			this.config.geminiPath = process.env["GEMINI_PATH"];
		}
	}

	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const resumeSessionId = options.resumeSessionId?.trim();
		const geminiSession: GeminiSession = {
			process: null,
			running: false,
			hasHistory: !!resumeSessionId,
			runtimeSessionId: resumeSessionId && resumeSessionId.length > 0 ? resumeSessionId : null,
		};
		if (geminiSession.runtimeSessionId) {
			this.sessionManager.setRuntimeSessionId(session.id, geminiSession.runtimeSessionId);
		}
		this.geminiSessions.set(session.id, geminiSession);
		await this.runPromptTurn(session, options.initialPrompt);
	}

	protected async doSendInput(session: Session, input: string): Promise<void> {
		const geminiSession = this.geminiSessions.get(session.id);
		if (!geminiSession) {
			throw new Error("Gemini session not found");
		}
		await this.runPromptTurn(session, input);
	}

	protected async doStop(session: Session): Promise<void> {
		const geminiSession = this.geminiSessions.get(session.id);
		if (!geminiSession) return;

		if (geminiSession.process && geminiSession.running) {
			geminiSession.process.kill("SIGTERM");

			await new Promise((resolve) => setTimeout(resolve, 1000));

			if (geminiSession.running) {
				geminiSession.process.kill("SIGKILL");
			}
		}

		geminiSession.running = false;
		this.geminiSessions.delete(session.id);
	}

	private async runPromptTurn(session: Session, prompt: string): Promise<void> {
		const geminiSession = this.geminiSessions.get(session.id);
		if (!geminiSession) {
			throw new Error("Gemini session not found");
		}
		if (geminiSession.running) {
			throw new Error("Gemini session is already processing a prompt");
		}

		geminiSession.running = true;
		this.emitStatus(session.id, "running");

		const args = this.buildPromptArgs(
			prompt,
			geminiSession.runtimeSessionId,
			geminiSession.hasHistory,
		);
		const proc = spawn(this.config.geminiPath, args, {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
				CI: "true",
				TERM: "dumb",
			},
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;

		if (!proc.stdout || !proc.stderr) {
			proc.kill("SIGTERM");
			geminiSession.running = false;
			this.geminiSessions.delete(session.id);
			this.emitOutput(session.id, "Error: Gemini stdio streams not available\n");
			this.emitStatus(session.id, "error");
			throw new Error("Gemini stdio streams not available");
		}

		geminiSession.process = proc;

		let stdoutBuffer = "";
		let stderrBuffer = "";
		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk) => {
			stderrBuffer += chunk.toString("utf8");
		});

		await new Promise<void>((resolve, reject) => {
			proc.on("error", (error) => {
				this.emitOutput(session.id, `Error: ${error.message}\n`);
				this.emitStatus(session.id, "error");
				reject(error);
			});

			proc.on("exit", (exitCode) => {
				if (exitCode === 0) {
					this.handleSuccessfulTurn(session.id, geminiSession, stdoutBuffer, stderrBuffer);
					geminiSession.hasHistory = true;
					this.emitStatus(session.id, "idle");
					resolve();
					return;
				}
				this.emitBufferedOutput(session.id, stdoutBuffer);
				this.emitBufferedOutput(session.id, stderrBuffer);
				this.emitStatus(session.id, "error");
				reject(new Error(`Gemini exited with code ${exitCode ?? "unknown"}`));
			});
		}).finally(() => {
			geminiSession.running = false;
			geminiSession.process = null;
		});
	}

	private handleSuccessfulTurn(
		sessionId: string,
		geminiSession: GeminiSession,
		stdout: string,
		stderr: string,
	): void {
		const parsed = this.parseHeadlessJson(stdout);
		let emittedStructured = false;
		if (parsed) {
			if (parsed.sessionId) {
				geminiSession.runtimeSessionId = parsed.sessionId;
				this.sessionManager.setRuntimeSessionId(sessionId, parsed.sessionId);
			}
			if (parsed.response !== null && parsed.response !== undefined) {
				emittedStructured = this.emitStructuredResponse(sessionId, parsed.response);
				if (!emittedStructured) {
					this.emitBufferedOutput(sessionId, this.stringifyJsonValue(parsed.response) ?? "");
				}
			}
		}

		if (!parsed) {
			this.emitBufferedOutput(sessionId, stdout);
		}

		this.emitBufferedOutput(sessionId, stderr);
	}

	private parseHeadlessJson(
		stdout: string,
	): { sessionId: string | null; response: unknown | null } | null {
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			return null;
		}

		const lines = trimmed.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (!lines[i]?.trimStart().startsWith("{")) {
				continue;
			}
			const candidate = lines.slice(i).join("\n");
			try {
				const parsed = JSON.parse(candidate) as GeminiHeadlessResponse;
				const sessionId =
					typeof parsed.session_id === "string" && parsed.session_id.length > 0
						? parsed.session_id
						: typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
							? parsed.sessionId
							: null;
				const response = this.resolveResponseCandidate(parsed);
				if (!sessionId && !response) {
					continue;
				}
				return { sessionId, response };
			} catch {
				// Keep scanning in case non-JSON preamble contains braces.
			}
		}

		return null;
	}

	private resolveResponseCandidate(parsed: GeminiHeadlessResponse): unknown | null {
		if (parsed.response !== undefined) {
			return parsed.response;
		}
		if (parsed.candidates !== undefined) {
			return parsed.candidates;
		}
		if (parsed.content !== undefined) {
			return parsed.content;
		}
		return null;
	}

	private emitStructuredResponse(sessionId: string, response: unknown): boolean {
		const pendingToolCalls = new Map<string, { toolCallId: string; toolName: string }>();
		const seen = new Set<object>();
		return this.walkGeminiValue(sessionId, response, pendingToolCalls, seen);
	}

	private walkGeminiValue(
		sessionId: string,
		value: unknown,
		pendingToolCalls: Map<string, { toolCallId: string; toolName: string }>,
		seen: Set<object>,
		parentToolUseId?: string,
	): boolean {
		if (value === null || value === undefined) {
			return false;
		}

		if (typeof value === "string") {
			const text = this.sanitizeAssistantText(value).trim();
			if (!text) {
				return false;
			}
			this.emitMessage(sessionId, "assistant", text, parentToolUseId);
			return true;
		}

		if (Array.isArray(value)) {
			let emitted = false;
			for (const entry of value) {
				emitted =
					this.walkGeminiValue(sessionId, entry, pendingToolCalls, seen, parentToolUseId) ||
					emitted;
			}
			return emitted;
		}

		const record = this.asRecord(value);
		if (!record) {
			return false;
		}
		if (seen.has(record)) {
			return false;
		}
		seen.add(record);

		const resolvedParent = this.resolveParentToolUseId(record, parentToolUseId);
		let emitted = false;

		const functionCall =
			this.asRecord(record["functionCall"]) ??
			this.asRecord(record["function_call"]) ??
			this.asRecord(record["toolCall"]) ??
			this.asRecord(record["tool_call"]);
		if (functionCall) {
			emitted =
				this.emitGeminiToolCall(sessionId, functionCall, pendingToolCalls, resolvedParent) ||
				emitted;
		}

		const functionResponse =
			this.asRecord(record["functionResponse"]) ??
			this.asRecord(record["function_response"]) ??
			this.asRecord(record["toolResult"]) ??
			this.asRecord(record["tool_result"]);
		if (functionResponse) {
			emitted =
				this.emitGeminiToolResult(sessionId, functionResponse, pendingToolCalls, resolvedParent) ||
				emitted;
		}

		const directText =
			this.asNonEmptyString(record["text"]) ??
			this.asNonEmptyString(record["output_text"]) ??
			this.asNonEmptyString(record["message"]);
		if (directText) {
			const sanitized = this.sanitizeAssistantText(directText).trim();
			if (sanitized.length > 0) {
				this.emitMessage(sessionId, "assistant", sanitized, resolvedParent);
				emitted = true;
			}
		}

		const nestedKeys: Array<keyof typeof record> = [
			"parts",
			"content",
			"candidates",
			"response",
			"messages",
			"items",
			"data",
			"value",
		];
		for (const key of nestedKeys) {
			if (!(key in record)) {
				continue;
			}
			emitted =
				this.walkGeminiValue(sessionId, record[key], pendingToolCalls, seen, resolvedParent) ||
				emitted;
		}

		return emitted;
	}

	private emitGeminiToolCall(
		sessionId: string,
		record: Record<string, unknown>,
		pendingToolCalls: Map<string, { toolCallId: string; toolName: string }>,
		parentToolUseId?: string,
	): boolean {
		const toolName = this.asNonEmptyString(record["name"]) ?? "tool";
		const callId =
			this.asNonEmptyString(record["id"]) ??
			this.asNonEmptyString(record["toolCallId"]) ??
			this.generateToolCallId();
		const args =
			this.stringifyJsonValue(record["args"]) ??
			this.stringifyJsonValue(record["arguments"]) ??
			this.stringifyJsonValue(record["input"]) ??
			undefined;
		this.emitToolCall(sessionId, callId, toolName, args, parentToolUseId);
		pendingToolCalls.set(callId, { toolCallId: callId, toolName });
		return true;
	}

	private emitGeminiToolResult(
		sessionId: string,
		record: Record<string, unknown>,
		pendingToolCalls: Map<string, { toolCallId: string; toolName: string }>,
		parentToolUseId?: string,
	): boolean {
		const explicitId =
			this.asNonEmptyString(record["id"]) ?? this.asNonEmptyString(record["toolCallId"]);
		const explicitName = this.asNonEmptyString(record["name"]) ?? "tool";
		const pending = explicitId ? pendingToolCalls.get(explicitId) : undefined;
		const toolCallId = pending?.toolCallId ?? explicitId ?? this.generateToolCallId();
		const toolName = pending?.toolName ?? explicitName;

		const rawOutput =
			record["response"] ?? record["result"] ?? record["output"] ?? record["content"] ?? record;
		const output = this.stringifyJsonValue(rawOutput) ?? undefined;
		const error = this.asNonEmptyString(record["error"]);

		this.emitToolResult(sessionId, toolCallId, toolName, output, error, parentToolUseId);
		return true;
	}

	private resolveParentToolUseId(
		record: Record<string, unknown>,
		parentToolUseId?: string,
	): string | undefined {
		const own =
			this.asNonEmptyString(record["parentToolUseId"]) ??
			this.asNonEmptyString(record["parent_tool_use_id"]);
		return own ?? parentToolUseId;
	}

	private asRecord(value: unknown): Record<string, unknown> | null {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		return value as Record<string, unknown>;
	}

	private asNonEmptyString(value: unknown): string | undefined {
		if (typeof value !== "string") {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	private stringifyJsonValue(value: unknown): string | null {
		if (value === null || value === undefined) {
			return null;
		}
		if (typeof value === "string") {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	private sanitizeAssistantText(text: string): string {
		return text
			.replaceAll(/Loaded cached credentials\.\s*/gi, "")
			.replaceAll(/Loading extension:[^\n]*(\n|$)/gi, "")
			.replaceAll(/\n{3,}/g, "\n\n");
	}

	private generateToolCallId(): string {
		return `gemini-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	private emitBufferedOutput(sessionId: string, text: string): void {
		const sanitized = this.sanitizeAssistantText(text);
		const trimmed = sanitized.trim();
		if (trimmed.length === 0) {
			return;
		}
		this.emitOutput(sessionId, sanitized.endsWith("\n") ? sanitized : `${sanitized}\n`);
	}

	private buildPromptArgs(
		prompt: string,
		runtimeSessionId: string | null,
		hasHistory: boolean,
	): string[] {
		const args: string[] = [];
		const resumeId = runtimeSessionId?.trim();
		if (resumeId && resumeId.length > 0) {
			args.push("--resume", resumeId);
		} else if (hasHistory) {
			args.push("--resume", "latest");
		}
		args.push("--prompt", prompt, "--output-format", "json");
		args.push(...this.config.extraArgs);
		return args;
	}
}
