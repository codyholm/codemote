import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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
	model: string | null;
	temperature: number | null;
	maxTokens: number | null;
	stderrBuffer: string;
	toolNames: Map<string, string>;
}

const STDERR_BUFFER_LIMIT = 8_000;

/**
 * Gemini CLI executor - controls Gemini via subprocess
 *
 * Uses `--output-format stream-json` to receive JSONL events in real time,
 * mapping each event type to the appropriate StreamEvent emission.
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
		const model = options.model?.trim() ? options.model.trim() : null;
		const temperature =
			typeof options.temperature === "number" && options.temperature >= 0
				? options.temperature
				: null;
		const maxTokens =
			typeof options.maxTokens === "number" && options.maxTokens > 0 ? options.maxTokens : null;
		const geminiSession: GeminiSession = {
			process: null,
			running: false,
			hasHistory: !!resumeSessionId,
			runtimeSessionId: resumeSessionId && resumeSessionId.length > 0 ? resumeSessionId : null,
			model,
			temperature,
			maxTokens,
			stderrBuffer: "",
			toolNames: new Map(),
		};
		if (geminiSession.runtimeSessionId) {
			this.sessionManager.setRuntimeSessionId(session.id, geminiSession.runtimeSessionId);
		}
		this.geminiSessions.set(session.id, geminiSession);
		await this.runPromptTurn(session, options.initialPrompt);
	}

	protected override async doRecoverRun(
		session: Session,
		runtimeSessionId: string,
	): Promise<boolean> {
		this.geminiSessions.set(session.id, {
			process: null,
			running: false,
			hasHistory: true,
			runtimeSessionId,
			model: null,
			temperature: null,
			maxTokens: null,
			stderrBuffer: "",
			toolNames: new Map(),
		});
		return true;
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
		geminiSession.stderrBuffer = "";
		this.emitStatus(session.id, "running");

		const args = this.buildPromptArgs(
			prompt,
			geminiSession.runtimeSessionId,
			geminiSession.hasHistory,
			geminiSession.model,
			geminiSession.temperature,
			geminiSession.maxTokens,
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

		const stdoutLines = createInterface({ input: proc.stdout });
		const stderrLines = createInterface({ input: proc.stderr });

		stdoutLines.on("line", (line) => {
			this.handleStdoutLine(session.id, geminiSession, line);
		});
		stderrLines.on("line", (line) => {
			this.handleStderrLine(session.id, geminiSession, line);
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const finish = (handler: () => void): void => {
				if (settled) return;
				settled = true;
				handler();
			};

			proc.on("error", (error) => {
				finish(() => {
					this.emitOutput(session.id, `Error: ${error.message}\n`);
					this.emitStatus(session.id, "error");
					reject(error);
				});
			});

			proc.on("exit", (exitCode) => {
				finish(() => {
					if (exitCode === 0) {
						geminiSession.hasHistory = true;
						this.emitStatus(session.id, "idle");
						resolve();
						return;
					}

					if (geminiSession.stderrBuffer.trim().length > 0) {
						this.emitOutput(session.id, geminiSession.stderrBuffer);
					}
					this.emitStatus(session.id, "error");
					reject(new Error(`Gemini exited with code ${exitCode ?? "unknown"}`));
				});
			});
		}).finally(() => {
			stdoutLines.close();
			stderrLines.close();
			geminiSession.running = false;
			geminiSession.process = null;
		});
	}

	private handleStdoutLine(sessionId: string, geminiSession: GeminiSession, line: string): void {
		if (line.trim().length === 0) {
			return;
		}

		let event: { type?: unknown; [key: string]: unknown };
		try {
			event = JSON.parse(line) as { type?: unknown; [key: string]: unknown };
		} catch {
			this.emitOutput(sessionId, `${line}\n`);
			return;
		}

		this.handleStreamEvent(sessionId, geminiSession, event);
	}

	private handleStreamEvent(
		sessionId: string,
		geminiSession: GeminiSession,
		event: { type?: unknown; [key: string]: unknown },
	): void {
		const eventType = typeof event["type"] === "string" ? event["type"] : "";

		switch (eventType) {
			case "init": {
				const runtimeSessionId =
					typeof event["session_id"] === "string" && event["session_id"].length > 0
						? event["session_id"]
						: null;
				if (runtimeSessionId) {
					geminiSession.runtimeSessionId = runtimeSessionId;
					this.sessionManager.setRuntimeSessionId(sessionId, runtimeSessionId);
				}
				this.emitStatus(sessionId, "running");
				break;
			}
			case "message": {
				const role = typeof event["role"] === "string" ? event["role"] : "";
				const content = typeof event["content"] === "string" ? event["content"] : "";
				if (role === "assistant" && content.length > 0) {
					if (event["delta"]) {
						this.emitOutput(sessionId, content);
					} else {
						this.emitMessage(sessionId, "assistant", content);
					}
				}
				break;
			}
			case "tool_use": {
				const toolId =
					typeof event["tool_id"] === "string" ? event["tool_id"] : this.generateToolCallId();
				const toolName = typeof event["tool_name"] === "string" ? event["tool_name"] : "tool";
				geminiSession.toolNames.set(toolId, toolName);
				const parameters = this.stringifyJsonValue(event["parameters"]);
				this.emitToolCall(sessionId, toolId, toolName, parameters ?? undefined);
				break;
			}
			case "tool_result": {
				const toolId =
					typeof event["tool_id"] === "string" ? event["tool_id"] : this.generateToolCallId();
				const status = typeof event["status"] === "string" ? event["status"] : "";
				const output = typeof event["output"] === "string" ? event["output"] : undefined;
				const errorObj = event["error"];
				const errorMessage =
					errorObj && typeof errorObj === "object" && !Array.isArray(errorObj)
						? typeof (errorObj as Record<string, unknown>)["message"] === "string"
							? ((errorObj as Record<string, unknown>)["message"] as string)
							: undefined
						: undefined;

				const isError = status === "error";
				const resultOutput = isError ? undefined : output;
				const resultError = isError ? (errorMessage ?? "Tool error") : undefined;
				const toolName = geminiSession.toolNames.get(toolId) ?? "tool";

				this.emitToolResult(sessionId, toolId, toolName, resultOutput, resultError);
				break;
			}
			case "error": {
				const message = typeof event["message"] === "string" ? event["message"] : "Unknown error";
				this.emitOutput(sessionId, `Error: ${message}\n`);
				break;
			}
			case "result": {
				const status = typeof event["status"] === "string" ? event["status"] : "";
				if (status === "error") {
					const errorObj = event["error"];
					const errorMessage =
						errorObj && typeof errorObj === "object" && !Array.isArray(errorObj)
							? typeof (errorObj as Record<string, unknown>)["message"] === "string"
								? ((errorObj as Record<string, unknown>)["message"] as string)
								: "Unknown error"
							: "Unknown error";
					this.emitOutput(sessionId, `Session error: ${errorMessage}\n`);
				}
				break;
			}
		}
	}

	private handleStderrLine(sessionId: string, geminiSession: GeminiSession, line: string): void {
		if (line.trim().length === 0) {
			return;
		}

		const normalized = line.endsWith("\n") ? line : `${line}\n`;
		geminiSession.stderrBuffer += normalized;
		if (geminiSession.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
			geminiSession.stderrBuffer = geminiSession.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
		}
	}

	private generateToolCallId(): string {
		return `gemini-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

	private buildPromptArgs(
		prompt: string,
		runtimeSessionId: string | null,
		hasHistory: boolean,
		model: string | null,
		temperature: number | null = null,
		maxTokens: number | null = null,
	): string[] {
		const args: string[] = [];
		const resumeId = runtimeSessionId?.trim();
		if (resumeId && resumeId.length > 0) {
			args.push("--resume", resumeId);
		} else if (hasHistory) {
			args.push("--resume", "latest");
		}
		args.push("--output-format", "stream-json");
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
		args.push(...this.config.extraArgs);
		args.push(prompt);
		return args;
	}
}
