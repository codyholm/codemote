import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunOptions, RuntimeType } from "@codemote/common";
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
	response?: unknown;
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
		});
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
		if (parsed) {
			if (parsed.sessionId) {
				geminiSession.runtimeSessionId = parsed.sessionId;
				this.sessionManager.setRuntimeSessionId(sessionId, parsed.sessionId);
			}
			if (parsed.response) {
				this.emitBufferedOutput(sessionId, parsed.response);
			}
		} else {
			this.emitBufferedOutput(sessionId, stdout);
		}
		this.emitBufferedOutput(sessionId, stderr);
	}

	private parseHeadlessJson(
		stdout: string,
	): { sessionId: string | null; response: string | null } | null {
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
						: null;
				const response =
					typeof parsed.response === "string" && parsed.response.length > 0
						? parsed.response
						: null;
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

	private emitBufferedOutput(sessionId: string, text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}
		this.emitOutput(sessionId, text.endsWith("\n") ? text : `${text}\n`);
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
