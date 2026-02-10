import type { RuntimeType, StreamEvent } from "@codemote/common";
import { WebSocket, WebSocketServer } from "ws";
import { EventBus } from "./events.js";
import type { BaseExecutor } from "./executor.js";
import {
	ClaudeExecutor,
	CodexExecutor,
	GeminiExecutor,
	OpenCodeExecutor,
} from "./executors/index.js";
import { MockExecutor } from "./mock-executor.js";
import { SessionManager } from "./session.js";
import type { Session, UplinkCommand, UplinkConfig, UplinkResponse } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * Uplink WebSocket server
 */
export class UplinkServer {
	private config: UplinkConfig;
	private wss: WebSocketServer | null = null;
	private workspaceManager: WorkspaceManager;
	private sessionManager: SessionManager;
	private eventBus: EventBus;
	private executors = new Map<RuntimeType, BaseExecutor>();
	private clients = new Set<WebSocket>();

	constructor(config: Partial<UplinkConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.workspaceManager = new WorkspaceManager(this.config.repoPath);
		this.sessionManager = new SessionManager();
		this.eventBus = new EventBus();

		// Register mock executor for testing
		this.registerExecutor(
			new MockExecutor(this.workspaceManager, this.sessionManager, this.eventBus),
		);

		// Register OpenCode executor
		if (this.config.runtimes.includes("opencode")) {
			this.registerExecutor(
				new OpenCodeExecutor(
					this.workspaceManager,
					this.sessionManager,
					this.eventBus,
					this.config.runtimeConfigs?.opencode,
				),
			);
		}

		// Register Claude executor
		if (this.config.runtimes.includes("claude")) {
			this.registerExecutor(
				new ClaudeExecutor(
					this.workspaceManager,
					this.sessionManager,
					this.eventBus,
					this.config.runtimeConfigs?.claude,
				),
			);
		}

		// Register Codex executor
		if (this.config.runtimes.includes("codex")) {
			this.registerExecutor(
				new CodexExecutor(
					this.workspaceManager,
					this.sessionManager,
					this.eventBus,
					this.config.runtimeConfigs?.codex,
				),
			);
		}

		// Register Gemini executor
		if (this.config.runtimes.includes("gemini")) {
			this.registerExecutor(
				new GeminiExecutor(
					this.workspaceManager,
					this.sessionManager,
					this.eventBus,
					this.config.runtimeConfigs?.gemini,
				),
			);
		}

		// Subscribe to all events and broadcast to clients
		this.eventBus.subscribe((event) => this.broadcast({ type: "event", payload: event }));
	}

	/**
	 * Register an executor for a runtime type
	 */
	registerExecutor(executor: BaseExecutor): void {
		this.executors.set(executor.type, executor);
	}

	/**
	 * Get an executor by runtime type
	 */
	getExecutor(type: RuntimeType): BaseExecutor | undefined {
		return this.executors.get(type);
	}

	/**
	 * Start the WebSocket server
	 */
	async start(): Promise<void> {
		if (!this.isLoopbackHost(this.config.host)) {
			throw new Error(
				`Refusing to start uplink on non-loopback host (${this.config.host}). Uplink must be loopback-only for safety.`,
			);
		}

		return new Promise((resolve, reject) => {
			const wss = new WebSocketServer({
				port: this.config.port,
				host: this.config.host,
				maxPayload: 256 * 1024,
			});
			this.wss = wss;

			let listening = false;
			wss.on("error", (err) => {
				console.error("Uplink server error:", err);
				if (!listening) {
					this.wss = null;
					try {
						wss.close();
					} catch {
						// ignore
					}
					reject(err);
				}
			});

			wss.on("connection", (ws) => this.handleConnection(ws));

			wss.on("listening", () => {
				listening = true;
				console.log(`Uplink server listening on ${this.config.host}:${this.config.port}`);
				resolve();
			});
		});
	}

	/**
	 * Stop the server
	 */
	async stop(): Promise<void> {
		// Stop all active sessions
		for (const session of this.sessionManager.listActive()) {
			const executor = this.executors.get(session.runtime);
			await executor?.stop(session.id);
		}

		// Close all client connections
		for (const client of this.clients) {
			client.close();
		}
		this.clients.clear();

		// Close server
		return new Promise((resolve) => {
			if (this.wss) {
				this.wss.close(() => resolve());
			} else {
				resolve();
			}
		});
	}

	private handleConnection(ws: WebSocket): void {
		this.clients.add(ws);
		console.log("Client connected");

		ws.on("message", async (data) => {
			try {
				const command = JSON.parse(data.toString()) as UplinkCommand;
				const response = await this.handleCommand(command);
				ws.send(JSON.stringify(response));
			} catch (error) {
				const safe = this.toSafeError(error);
				console.error("Uplink WS command failed:", error);
				ws.send(
					JSON.stringify({
						type: "error",
						payload: safe,
					} satisfies UplinkResponse),
				);
			}
		});

		ws.on("close", () => {
			this.clients.delete(ws);
			console.log("Client disconnected");
		});

		ws.on("error", (error) => {
			console.error("WebSocket error:", error);
			this.clients.delete(ws);
		});
	}

	private toSafeError(error: unknown): { message: string; code: string } {
		if (error instanceof SyntaxError) {
			return { message: "Invalid request", code: "BAD_REQUEST" };
		}

		const msg = error instanceof Error ? error.message : "";
		if (msg === "Session not found" || msg === "Run not found") {
			return { message: msg, code: "NOT_FOUND" };
		}
		if (msg === "Unknown command type") {
			return { message: "Unsupported request", code: "UNSUPPORTED" };
		}

		return { message: "Request failed", code: "COMMAND_FAILED" };
	}

	private async handleCommand(command: UplinkCommand): Promise<UplinkResponse> {
		switch (command.type) {
			case "ping":
				return { type: "pong" };

			case "list_sessions":
				return { type: "sessions", payload: this.sessionManager.list() };

			case "start_run": {
				const executor = this.executors.get(command.payload.profile);
				if (!executor) {
					throw new Error(`No executor for runtime: ${command.payload.profile}`);
				}
				const result = await executor.startRun(command.payload);
				return { type: "run_started", payload: result };
			}

			case "send_input": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const executor = this.executors.get(session.runtime);
				if (!executor) throw new Error("Executor not found");
				await executor.sendInput(command.payload.sessionId, command.payload.input);
				return { type: "input_sent", payload: { sessionId: command.payload.sessionId } };
			}

			case "stop": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const executor = this.executors.get(session.runtime);
				await executor?.stop(command.payload.sessionId);
				return { type: "stopped", payload: { sessionId: command.payload.sessionId } };
			}

			case "get_diff": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const executor = this.executors.get(session.runtime);
				if (!executor) throw new Error("Executor not found");
				const diff = await executor.getDiff(command.payload.sessionId, command.payload.scope);
				return { type: "diff", payload: { sessionId: command.payload.sessionId, diff } };
			}

			default:
				throw new Error("Unknown command type");
		}
	}

	private broadcast(response: UplinkResponse): void {
		const message = JSON.stringify(response);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(message);
			}
		}
	}

	private isLoopbackHost(host: string): boolean {
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	}
}
