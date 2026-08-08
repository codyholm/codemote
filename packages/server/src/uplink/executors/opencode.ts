import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunOptions, RuntimeType } from "@codemote/common";
import spawn from "cross-spawn";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

const STDERR_BUFFER_LIMIT = 8_000;

/**
 * OpenCode CLI configuration
 */
export interface OpenCodeConfig {
	/** Path to opencode CLI (default: finds in PATH) */
	opencodePath: string;
	/** Additional CLI arguments (optional) */
	extraArgs: string[];
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeConfig = {
	opencodePath: "opencode",
	extraArgs: [],
};

/**
 * OpenCode session state
 */
interface OpenCodeSession {
	/** Child process for the active turn */
	process: ChildProcess | null;
	/** Whether a turn is currently running */
	running: boolean;
	/** OpenCode session id used for resume */
	runtimeSessionId: string | null;
	/** Selected model override (optional) */
	model: string | null;
	/** Temperature override (optional) */
	temperature: number | null;
	/** Max tokens override (optional) */
	maxTokens: number | null;
	/** Tool calls we have already emitted for this session */
	seenToolCallIds: Set<string>;
	/** Recent stderr for diagnostics */
	stderrBuffer: string;
}

interface OpenCodeJsonEvent {
	type?: unknown;
	sessionID?: unknown;
	part?: unknown;
	parentToolUseId?: unknown;
	parent_tool_use_id?: unknown;
	[key: string]: unknown;
}

export class OpenCodeExecutor extends BaseExecutor {
	readonly type: RuntimeType = "opencode";

	private config: OpenCodeConfig;
	private openCodeSessions = new Map<string, OpenCodeSession>();

	constructor(
		workspaceManager: ConstructorParameters<typeof BaseExecutor>[0],
		sessionManager: ConstructorParameters<typeof BaseExecutor>[1],
		eventBus: ConstructorParameters<typeof BaseExecutor>[2],
		config: Partial<OpenCodeConfig> = {},
	) {
		super(workspaceManager, sessionManager, eventBus);
		this.config = { ...DEFAULT_OPENCODE_CONFIG, ...config };

		if (process.env["OPENCODE_PATH"]) {
			this.config.opencodePath = process.env["OPENCODE_PATH"];
		}
	}

	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const resumeSessionId = options.resumeSessionId?.trim();
		const model = options.model?.trim() ? options.model.trim() : null;
		const temperature =
			typeof options.temperature === "number" && options.temperature >= 0
				? options.temperature
				: null;
		const maxTokens =
			typeof options.maxTokens === "number" && options.maxTokens > 0 ? options.maxTokens : null;
		const openCodeSession: OpenCodeSession = {
			process: null,
			running: false,
			runtimeSessionId: resumeSessionId && resumeSessionId.length > 0 ? resumeSessionId : null,
			model,
			temperature,
			maxTokens,
			seenToolCallIds: new Set(),
			stderrBuffer: "",
		};
		if (openCodeSession.runtimeSessionId) {
			this.sessionManager.setRuntimeSessionId(session.id, openCodeSession.runtimeSessionId);
		}
		this.openCodeSessions.set(session.id, openCodeSession);
		await this.runTurn(session, options.initialPrompt);
	}

	protected override async doRecoverRun(
		session: Session,
		runtimeSessionId: string,
	): Promise<boolean> {
		this.openCodeSessions.set(session.id, {
			process: null,
			running: false,
			runtimeSessionId,
			model: null,
			temperature: null,
			maxTokens: null,
			seenToolCallIds: new Set(),
			stderrBuffer: "",
		});
		return true;
	}

	protected async doSendInput(session: Session, input: string): Promise<void> {
		const openCodeSession = this.openCodeSessions.get(session.id);
		if (!openCodeSession) {
			throw new Error("OpenCode session not found");
		}
		if (!openCodeSession.runtimeSessionId) {
			throw new Error(
				"OpenCode runtime session id is missing; cannot send follow-up input without --session",
			);
		}
		await this.runTurn(session, input);
	}

	protected async doStop(session: Session): Promise<void> {
		const openCodeSession = this.openCodeSessions.get(session.id);
		if (!openCodeSession) return;

		const activeProcess = openCodeSession.process;
		if (activeProcess && openCodeSession.running) {
			await this.terminateProcess(activeProcess);
		}

		openCodeSession.running = false;
		openCodeSession.process = null;
		this.openCodeSessions.delete(session.id);
	}

	private async runTurn(session: Session, prompt: string): Promise<void> {
		const openCodeSession = this.openCodeSessions.get(session.id);
		if (!openCodeSession) {
			throw new Error("OpenCode session not found");
		}
		if (openCodeSession.running) {
			throw new Error("OpenCode session is already processing a prompt");
		}

		openCodeSession.running = true;
		openCodeSession.stderrBuffer = "";
		this.emitStatus(session.id, "running");

		const proc = spawn(this.config.opencodePath, this.buildRunArgs(prompt, openCodeSession), {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
				CI: "true",
				TERM: "dumb",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		openCodeSession.process = proc;

		if (!proc.stdout || !proc.stderr) {
			proc.kill("SIGTERM");
			openCodeSession.running = false;
			openCodeSession.process = null;
			this.emitOutput(session.id, "Error: OpenCode stdout/stderr streams not available\n");
			this.emitStatus(session.id, "error");
			throw new Error("OpenCode stdout/stderr streams not available");
		}

		const stdoutLines = createInterface({ input: proc.stdout });
		const stderrLines = createInterface({ input: proc.stderr });

		stdoutLines.on("line", (line) => {
			this.handleStdoutLine(session.id, openCodeSession, line);
		});
		stderrLines.on("line", (line) => {
			this.handleStderrLine(session.id, openCodeSession, line);
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const finish = (handler: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				handler();
			};

			proc.on("error", (error) => {
				finish(() => {
					const message = error instanceof Error ? error.message : String(error);
					this.emitOutput(session.id, `Error: ${message}\n`);
					this.emitStatus(session.id, "error");
					reject(error instanceof Error ? error : new Error(message));
				});
			});

			proc.on("exit", (exitCode) => {
				finish(() => {
					if (exitCode === 0) {
						this.emitStatus(session.id, "idle");
						resolve();
						return;
					}

					if (openCodeSession.stderrBuffer.trim().length > 0) {
						this.emitOutput(session.id, openCodeSession.stderrBuffer);
					}
					this.emitStatus(session.id, "error");
					reject(new Error(`OpenCode exited with code ${exitCode ?? "unknown"}`));
				});
			});
		}).finally(() => {
			stdoutLines.close();
			stderrLines.close();
			openCodeSession.running = false;
			openCodeSession.process = null;
		});
	}

	private buildRunArgs(prompt: string, openCodeSession: OpenCodeSession): string[] {
		const args = ["run", "--format", "json"];
		const resumeSessionId = openCodeSession.runtimeSessionId?.trim();
		if (resumeSessionId && resumeSessionId.length > 0) {
			args.push("--session", resumeSessionId);
		}
		const selectedModel = openCodeSession.model?.trim();
		if (selectedModel && selectedModel.length > 0) {
			args.push("--model", selectedModel);
		}
		if (typeof openCodeSession.temperature === "number" && openCodeSession.temperature >= 0) {
			args.push("--temperature", String(openCodeSession.temperature));
		}
		if (typeof openCodeSession.maxTokens === "number" && openCodeSession.maxTokens > 0) {
			args.push("--max-tokens", String(openCodeSession.maxTokens));
		}
		args.push(prompt);
		args.push(...this.config.extraArgs);
		return args;
	}

	private handleStdoutLine(
		sessionId: string,
		openCodeSession: OpenCodeSession,
		line: string,
	): void {
		if (line.trim().length === 0) {
			return;
		}

		let parsed: OpenCodeJsonEvent;
		try {
			parsed = JSON.parse(line) as OpenCodeJsonEvent;
		} catch {
			this.emitOutput(sessionId, `${line}\n`);
			return;
		}

		const sessionID =
			typeof parsed.sessionID === "string" && parsed.sessionID.trim().length > 0
				? parsed.sessionID.trim()
				: null;
		if (sessionID && sessionID !== openCodeSession.runtimeSessionId) {
			openCodeSession.runtimeSessionId = sessionID;
			this.sessionManager.setRuntimeSessionId(sessionId, sessionID);
		}

		const eventType = typeof parsed.type === "string" ? parsed.type : "";
		if (eventType === "text") {
			const part = this.asRecord(parsed.part);
			if (!part) {
				return;
			}
			if (part["type"] !== "text") {
				return;
			}
			const text = typeof part["text"] === "string" ? part["text"] : "";
			if (text.trim().length === 0) {
				return;
			}
			const parentToolUseId = this.extractParentToolUseId(parsed, part);
			this.emitMessage(sessionId, "assistant", text, parentToolUseId);
			return;
		}

		if (eventType === "tool_use") {
			this.handleToolUseEvent(sessionId, openCodeSession, parsed);
		}
	}

	private handleToolUseEvent(
		sessionId: string,
		openCodeSession: OpenCodeSession,
		event: OpenCodeJsonEvent,
	): void {
		const part = this.asRecord(event.part);
		if (!part) {
			return;
		}

		const rawCallId = typeof part["callID"] === "string" ? part["callID"].trim() : "";
		const toolCallId =
			rawCallId.length > 0
				? rawCallId
				: `opencode-call-${Date.now()}-${openCodeSession.seenToolCallIds.size}`;

		if (openCodeSession.seenToolCallIds.has(toolCallId)) {
			return;
		}
		openCodeSession.seenToolCallIds.add(toolCallId);

		const toolName =
			typeof part["tool"] === "string" && part["tool"].trim().length > 0
				? part["tool"].trim()
				: "tool";
		const toolState = this.asRecord(part["state"]);
		const serializedInput = this.stringifyValue(toolState?.["input"]);
		const parentToolUseId = this.extractParentToolUseId(event, part, toolState);
		this.emitToolCall(
			sessionId,
			toolCallId,
			toolName,
			serializedInput ?? undefined,
			parentToolUseId,
		);

		const { output, error } = this.extractToolResult(toolName, toolState);
		this.emitToolResult(sessionId, toolCallId, toolName, output, error, parentToolUseId);

		if (this.toolStateHasDiff(toolState)) {
			this.emitDiffUpdated(sessionId);
		}
	}

	private extractToolResult(
		toolName: string,
		toolState: Record<string, unknown> | null,
	): { output?: string; error?: string } {
		const status =
			typeof toolState?.["status"] === "string" ? toolState["status"].toLowerCase() : "";
		const failure = this.isFailureStatus(status);
		const errorText =
			typeof toolState?.["error"] === "string" && toolState["error"].trim().length > 0
				? toolState["error"].trim()
				: failure
					? `${toolName} failed${status ? ` (${status})` : ""}`
					: undefined;

		const outputText =
			this.stringifyValue(toolState?.["output"]) ??
			this.stringifyValue(toolState?.["title"]) ??
			(failure ? undefined : this.stringifyValue(toolState));

		return {
			...(outputText ? { output: outputText } : {}),
			...(errorText ? { error: errorText } : {}),
		};
	}

	private toolStateHasDiff(toolState: Record<string, unknown> | null): boolean {
		const metadata = this.asRecord(toolState?.["metadata"]);
		if (!metadata) {
			return false;
		}

		const diff = metadata["diff"];
		if (typeof diff === "string" && diff.trim().length > 0) {
			return true;
		}

		const files = metadata["files"];
		return Array.isArray(files) && files.length > 0;
	}

	private isFailureStatus(status: string): boolean {
		return ["error", "failed", "cancelled", "rejected", "denied"].includes(status);
	}

	private handleStderrLine(
		sessionId: string,
		openCodeSession: OpenCodeSession,
		line: string,
	): void {
		const withoutAnsi = this.stripAnsi(line).replace(/\r/g, "");
		if (withoutAnsi.trim().length === 0) {
			return;
		}

		const normalized = withoutAnsi.endsWith("\n") ? withoutAnsi : `${withoutAnsi}\n`;
		openCodeSession.stderrBuffer += normalized;
		if (openCodeSession.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
			openCodeSession.stderrBuffer = openCodeSession.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
		}

		this.emitOutput(sessionId, normalized);
	}

	private stripAnsi(text: string): string {
		let result = "";
		for (let index = 0; index < text.length; index += 1) {
			const char = text[index];
			if (char === "\u001b" && text[index + 1] === "[") {
				index += 2;
				while (index < text.length) {
					const code = text.charCodeAt(index);
					if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
						break;
					}
					index += 1;
				}
				continue;
			}
			result += char;
		}
		return result;
	}

	private async terminateProcess(process: ChildProcess): Promise<void> {
		if (process.exitCode !== null) {
			return;
		}

		process.kill("SIGTERM");
		const exited = await this.waitForExit(process, 1000);
		if (!exited && process.exitCode === null) {
			process.kill("SIGKILL");
			await this.waitForExit(process, 1000);
		}
	}

	private async waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (process.exitCode !== null) {
			return true;
		}

		return new Promise((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				cleanup();
				resolve(false);
			}, timeoutMs);

			const onExit = (): void => {
				cleanup();
				resolve(true);
			};

			const cleanup = (): void => {
				process.off("exit", onExit);
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
				}
			};

			process.on("exit", onExit);
		});
	}

	private asRecord(value: unknown): Record<string, unknown> | null {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		return value as Record<string, unknown>;
	}

	private extractParentToolUseId(
		...values: Array<Record<string, unknown> | OpenCodeJsonEvent | null>
	): string | undefined {
		for (const value of values) {
			if (!value) {
				continue;
			}
			const candidateA = value["parentToolUseId"];
			if (typeof candidateA === "string" && candidateA.trim().length > 0) {
				return candidateA.trim();
			}
			const candidateB = value["parent_tool_use_id"];
			if (typeof candidateB === "string" && candidateB.trim().length > 0) {
				return candidateB.trim();
			}
		}
		return undefined;
	}

	private stringifyValue(value: unknown): string | null {
		if (value === undefined || value === null) {
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
}
