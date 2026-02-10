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
}

/**
 * Gemini CLI executor - controls Gemini via subprocess
 *
 * This executor spawns the Gemini CLI in interactive mode (stdin/stdout pipes).
 * It sends the initial prompt to stdin and streams stdout/stderr back as output
 * events.
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
		const geminiSession: GeminiSession = { process: null, running: true };
		this.geminiSessions.set(session.id, geminiSession);

		const proc = spawn(this.config.geminiPath, this.config.extraArgs, {
			cwd: session.workspace.workingDir,
			env: {
				...process.env,
				CI: "true",
				TERM: "dumb",
			},
			stdio: "pipe",
		});

		geminiSession.process = proc;

		proc.stdout.on("data", (chunk) => {
			this.emitOutput(session.id, chunk.toString("utf8"));
		});
		proc.stderr.on("data", (chunk) => {
			this.emitOutput(session.id, chunk.toString("utf8"));
		});

		proc.on("exit", (exitCode) => {
			geminiSession.running = false;
			if (exitCode === 0) {
				this.emitStatus(session.id, "ended");
			} else {
				this.emitStatus(session.id, "error");
			}
		});

		proc.on("error", (error) => {
			geminiSession.running = false;
			this.emitOutput(session.id, `Error: ${error.message}\n`);
			this.emitStatus(session.id, "error");
		});

		proc.stdin.write(`${options.initialPrompt}\n`);
	}

	protected async doSendInput(session: Session, input: string): Promise<void> {
		const geminiSession = this.geminiSessions.get(session.id);
		if (!geminiSession?.process || !geminiSession.running) {
			throw new Error("Gemini session not running");
		}

		geminiSession.process.stdin.write(`${input}\n`);
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
}
