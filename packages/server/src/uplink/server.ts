import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ModelInfo,
	type ProjectStartFailureDetails,
	RUNTIME_MODELS,
	type RuntimeType,
	type StreamEvent,
} from "@codemote/common";
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
import { discoverOpenCodeModels } from "./opencode-models.js";
import { ProjectRegistry, ProjectRegistryError } from "./projectRegistry.js";
import { ProjectStartCoordinator, ProjectStartError } from "./projectStart.js";
import { ProjectStartJournal, ProjectStartJournalError } from "./projectStartJournal.js";
import { buildProjectState, projectStateSignature } from "./projectState.js";
import { probeInstalledRuntimes } from "./runtime-probe.js";
import { SessionManager } from "./session.js";
import type {
	DirectoryEntry,
	ProjectStateAggregate,
	Session,
	UplinkCommand,
	UplinkConfig,
	UplinkResponse,
} from "./types.js";
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
	private projectRegistry: ProjectRegistry;
	private projectStartCoordinator: ProjectStartCoordinator | null = null;
	private executors = new Map<RuntimeType, BaseExecutor>();
	private availableRuntimes: RuntimeType[] = [];
	private dynamicModels = new Map<RuntimeType, ModelInfo[]>();
	private clients = new Set<WebSocket>();
	private lastProjectStateSignature: string | null = null;
	private static readonly LIST_DIRECTORY_STAT_CONCURRENCY = 50;

	constructor(config: Partial<UplinkConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.workspaceManager = new WorkspaceManager(this.config.repoPath);
		this.sessionManager = new SessionManager();
		this.eventBus = new EventBus();
		this.projectRegistry = new ProjectRegistry(
			this.config.projectRegistryPath ?? join(homedir(), ".codemote", "projects.json"),
		);
		// Register mock executor for testing
		this.registerExecutor(
			new MockExecutor(this.workspaceManager, this.sessionManager, this.eventBus),
		);

		// Subscribe to all events and broadcast to clients
		this.eventBus.subscribe((event) => this.broadcast({ type: "event", payload: event }));

		// Only these two event types can change the aggregate. session.output fires
		// per token, and session.message / .tool_call / .tool_result / git.diff_updated
		// move nothing the aggregate carries. Subscribing per type rather than
		// filtering inside a global handler keeps the per-token flood away entirely.
		this.eventBus.subscribeType("session.status", () => this.publishProjectState());
		this.eventBus.subscribeType("attention.required", () => this.publishProjectState());
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
	 * Refresh runtime probe results and dynamic model caches.
	 * Called during start() and on-demand via the refresh_cache command.
	 */
	async refreshCaches(): Promise<void> {
		this.availableRuntimes = await probeInstalledRuntimes(this.config.runtimes);
		for (const runtime of this.availableRuntimes) {
			this.registerRuntimeExecutor(runtime);
		}
		if (this.availableRuntimes.includes("opencode")) {
			try {
				const models = await discoverOpenCodeModels(
					this.config.runtimeConfigs?.opencode?.opencodePath,
				);
				if (models.length > 0) {
					this.dynamicModels.set("opencode", models);
				}
			} catch {
				// Keep existing cache
			}
		}
	}

	/**
	 * Return a snapshot of cached runtime/model state for status reporting.
	 */
	getCacheSnapshot(): {
		availableRuntimes: RuntimeType[];
		modelCounts: Record<string, number>;
		refreshedAt: string;
	} {
		const modelCounts: Record<string, number> = {};
		for (const [runtime, models] of this.dynamicModels) {
			modelCounts[runtime] = models.length;
		}
		return {
			availableRuntimes: this.availableRuntimes,
			modelCounts,
			refreshedAt: new Date().toISOString(),
		};
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

		await this.refreshCaches();

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
			let requestId: string | undefined;
			try {
				const command = JSON.parse(data.toString()) as UplinkCommand;
				requestId = command.requestId;
				const response = await this.handleCommand(command);
				ws.send(JSON.stringify(response));
			} catch (error) {
				const safe = this.toSafeError(error);
				console.error("Uplink WS command failed:", error);
				const errorResponse: UplinkResponse = {
					type: "error",
					payload: safe,
				};
				if (requestId) {
					errorResponse.requestId = requestId;
				}
				ws.send(JSON.stringify(errorResponse));
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

	private toSafeError(error: unknown): {
		message: string;
		code: string;
		details?: ProjectStartFailureDetails;
	} {
		if (error instanceof ProjectStartError) {
			return {
				message: error.message,
				code: error.code,
				...(error.details ? { details: error.details } : {}),
			};
		}
		if (error instanceof ProjectRegistryError) {
			return { message: error.message, code: error.code };
		}
		if (
			error instanceof ProjectStartJournalError &&
			(error.code === "INVALID_PROJECT_START_JOURNAL" || error.code === "PROJECT_START_JOURNAL_IO")
		) {
			return {
				message: error.message,
				code: error.code,
				...(error.details ? { details: error.details } : {}),
			};
		}

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
		const { requestId } = command;
		const response = await this.handleCommandInner(command);
		if (requestId) {
			response.requestId = requestId;
		}
		return response;
	}

	private async handleCommandInner(command: UplinkCommand): Promise<UplinkResponse> {
		switch (command.type) {
			case "ping":
				return { type: "pong" };

			case "list_sessions":
				return { type: "sessions", payload: this.sessionManager.list() };

			case "get_project_state":
				return { type: "project_state", payload: this.currentProjectState() };

			case "get_project_start_state":
				return {
					type: "project_start_state",
					payload: await this.getProjectStartCoordinator().inspect(command.payload.projectPath),
				};

			case "list_projects":
				return { type: "project_state", payload: this.currentProjectState() };

			case "add_project": {
				const project = this.projectRegistry.add(command.payload.name, command.payload.path);
				this.publishProjectState();
				return {
					type: "project_registry_result",
					payload: { operation: "add", path: project.path, success: true },
				};
			}

			case "rename_project": {
				const project = this.projectRegistry.rename(command.payload.path, command.payload.name);
				this.publishProjectState();
				return {
					type: "project_registry_result",
					payload: { operation: "rename", path: project.path, success: true },
				};
			}

			case "remove_project": {
				const project = this.projectRegistry.remove(command.payload.path);
				this.publishProjectState();
				return {
					type: "project_registry_result",
					payload: { operation: "remove", path: project.path, success: true },
				};
			}

			case "list_runtimes":
				return { type: "runtime_list", payload: { runtimes: this.availableRuntimes } };

			case "list_models": {
				const runtime = command.payload.profile;
				const models = this.getModelsForRuntime(runtime);
				return { type: "model_list", payload: { runtime, models } };
			}

			case "start_run": {
				const executor = this.executors.get(command.payload.profile);
				if (!executor) {
					throw new Error(`No executor for runtime: ${command.payload.profile}`);
				}
				const result = command.payload.projectStart
					? await this.getProjectStartCoordinator().start(command.payload, (options, context) =>
							executor.startRun(options, context),
						)
					: await executor.startRun(command.payload);
				return { type: "run_started", payload: result };
			}

			case "send_input": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const executor = this.executors.get(session.runtime);
				if (!executor) throw new Error("Executor not found");
				await executor.sendInput(command.payload.sessionId, command.payload.input);
				// clearAttention fires inside sendInput and emits no event of its own,
				// so without this an answered approval would keep reading as blocked
				// until the turn ended.
				this.publishProjectState();
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

			case "git_status": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const status = await this.workspaceManager.getStatus(session.workspace.id);
				return {
					type: "git_status_result",
					payload: { sessionId: command.payload.sessionId, status },
				};
			}

			case "git_pull": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const summary = await this.workspaceManager.pull(session.workspace.id);
				return {
					type: "git_pull_result",
					payload: { sessionId: command.payload.sessionId, summary },
				};
			}

			case "git_push": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const summary = await this.workspaceManager.push(session.workspace.id);
				return {
					type: "git_push_result",
					payload: { sessionId: command.payload.sessionId, summary },
				};
			}

			case "git_worktree_add": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const result = await this.workspaceManager.addWorktree(
					session.workspace.id,
					command.payload.branch,
				);
				return {
					type: "git_worktree_result",
					payload: { sessionId: command.payload.sessionId, ...result },
				};
			}

			case "git_submit_pr": {
				const session = this.sessionManager.get(command.payload.sessionId);
				if (!session) throw new Error("Session not found");
				const url = await this.workspaceManager.submitPR(
					session.workspace.id,
					command.payload.title,
					command.payload.body,
				);
				return {
					type: "git_pr_result",
					payload: { sessionId: command.payload.sessionId, url },
				};
			}

			case "list_directory": {
				const requestedPath = command.payload.path?.trim() || process.cwd();
				const resolvedPath = resolve(requestedPath);
				const entries = await this.listDirectory(resolvedPath);
				return { type: "directory_listing", payload: { path: resolvedPath, entries } };
			}

			case "refresh_cache": {
				await this.refreshCaches();
				const snap = this.getCacheSnapshot();
				return {
					type: "cache_refreshed",
					payload: {
						availableRuntimes: snap.availableRuntimes,
						modelCounts: snap.modelCounts,
					},
				};
			}

			default:
				throw new Error("Unknown command type");
		}
	}

	private async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
		const dirents = await readdir(dirPath, { withFileTypes: true });
		const candidates = dirents.filter(
			(d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."),
		);

		const results = await this.mapWithConcurrencyLimit(
			candidates,
			UplinkServer.LIST_DIRECTORY_STAT_CONCURRENCY,
			async (d): Promise<DirectoryEntry | null> => {
				const fullPath = join(dirPath, d.name);

				// For symlinks, verify the target is actually a directory
				if (d.isSymbolicLink()) {
					try {
						const targetStat = await stat(fullPath);
						if (!targetStat.isDirectory()) return null;
					} catch {
						return null; // broken symlink
					}
				}

				let isGitRepo = false;
				try {
					await stat(join(fullPath, ".git"));
					isGitRepo = true;
				} catch {
					// not a git repo
				}
				return { name: d.name, isDirectory: true, isGitRepo };
			},
		);

		const entries = results.filter((e): e is DirectoryEntry => e !== null);

		entries.sort((a, b) => {
			if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return entries.slice(0, 200);
	}

	private async mapWithConcurrencyLimit<T, TResult>(
		items: T[],
		limit: number,
		handler: (item: T, index: number) => Promise<TResult>,
	): Promise<TResult[]> {
		if (items.length === 0) {
			return [];
		}

		const results = new Array<TResult>(items.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, items.length));

		const workers = Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) {
					return;
				}
				if (!(index in items)) {
					continue;
				}
				const item = items[index] as T;
				results[index] = await handler(item, index);
			}
		});

		await Promise.all(workers);
		return results;
	}

	private currentProjectState(): ProjectStateAggregate {
		return buildProjectState(this.sessionManager.list(), this.projectRegistry.list(), Date.now());
	}

	/**
	 * Broadcast the aggregate, but only when it actually changed.
	 *
	 * The comparison is over the signature, not the snapshot: updateStatus writes
	 * lastActivityAt unconditionally and the codex executor re-emits "running" on
	 * every turn, so a snapshot comparison would differ on precisely the no-op write
	 * this exists to suppress.
	 */
	private publishProjectState(): void {
		const state = this.currentProjectState();
		const signature = projectStateSignature(state);
		if (signature === this.lastProjectStateSignature) return;

		this.lastProjectStateSignature = signature;
		this.broadcast({ type: "project_state_push", payload: state });
	}

	private broadcast(response: UplinkResponse): void {
		const message = JSON.stringify(response);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(message);
			}
		}
	}

	private getModelsForRuntime(runtime: RuntimeType): ModelInfo[] {
		return this.dynamicModels.get(runtime) ?? RUNTIME_MODELS[runtime];
	}

	private getProjectStartCoordinator(): ProjectStartCoordinator {
		if (!this.projectStartCoordinator) {
			this.projectStartCoordinator = new ProjectStartCoordinator({
				journal: new ProjectStartJournal(
					this.config.projectStartJournalPath ??
						join(homedir(), ".codemote", "project-start-operations.json"),
				),
				registry: this.projectRegistry,
				sessionManager: this.sessionManager,
				...(this.config.managedWorktreeRoot
					? { managedWorktreeRoot: this.config.managedWorktreeRoot }
					: {}),
			});
		}
		return this.projectStartCoordinator;
	}

	private isLoopbackHost(host: string): boolean {
		return host === "127.0.0.1" || host === "localhost" || host === "::1";
	}

	private registerRuntimeExecutor(runtime: RuntimeType): void {
		switch (runtime) {
			case "opencode":
				this.registerExecutor(
					new OpenCodeExecutor(
						this.workspaceManager,
						this.sessionManager,
						this.eventBus,
						this.config.runtimeConfigs?.opencode,
					),
				);
				break;
			case "claude":
				this.registerExecutor(
					new ClaudeExecutor(
						this.workspaceManager,
						this.sessionManager,
						this.eventBus,
						this.config.runtimeConfigs?.claude,
					),
				);
				break;
			case "codex":
				this.registerExecutor(
					new CodexExecutor(
						this.workspaceManager,
						this.sessionManager,
						this.eventBus,
						this.config.runtimeConfigs?.codex,
					),
				);
				break;
			case "gemini":
				this.registerExecutor(
					new GeminiExecutor(
						this.workspaceManager,
						this.sessionManager,
						this.eventBus,
						this.config.runtimeConfigs?.gemini,
					),
				);
				break;
		}
	}
}
