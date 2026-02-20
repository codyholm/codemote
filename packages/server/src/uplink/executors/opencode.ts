import { type ChildProcess, spawn } from "node:child_process";
import type { RunOptions, RuntimeType } from "@codemote/common";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

const OPENCODE_HTTP_TIMEOUT_MS = 5000; // 5 seconds for local requests
const OPENCODE_HISTORY_RECOVERY_TIMEOUT_MS = 30_000;
const OPENCODE_HISTORY_POLL_INTERVAL_MS = 500;
const OPENCODE_SERVER_BOOT_TIMEOUT_MS = 10_000;
const OPENCODE_SERVER_BOOT_POLL_INTERVAL_MS = 250;

export interface OpenCodePermissionRule {
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
}

/**
 * OpenCode server configuration
 */
export interface OpenCodeConfig {
	/** Server URL (default: http://127.0.0.1:4096) */
	serverUrl: string;
	/** Basic auth username (default: opencode) */
	username: string;
	/** Basic auth password (from env or config) */
	password: string | null;
	/** Binary path used when auto-starting the OpenCode daemon */
	commandPath: string;
	/** Auto-start local OpenCode daemon when server URL is unreachable */
	autoStartServer: boolean;
	/** Permission rules applied when creating new OpenCode sessions */
	permissionRules: OpenCodePermissionRule[];
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeConfig = {
	serverUrl: "http://127.0.0.1:4096",
	username: "opencode",
	password: null,
	commandPath: "opencode",
	autoStartServer: true,
	permissionRules: [{ permission: "*", pattern: "*", action: "allow" }],
};

/**
 * OpenCode session state
 */
interface OpenCodeSession {
	/** OpenCode's session ID */
	openCodeSessionId: string;
	/** Abort controller for cleanup */
	abortController: AbortController;
}

/**
 * OpenCode response payload for `/session/:id/message`
 */
interface OpenCodeMessagePart {
	type: string;
	text?: string;
	message?: string;
	action?: string;
	description?: string;
	[key: string]: unknown;
}

interface OpenCodeMessageResponse {
	info?: {
		role?: string;
		[key: string]: unknown;
	};
	parts?: OpenCodeMessagePart[];
	[key: string]: unknown;
}

interface OpenCodeHistoryMessage {
	info?: {
		role?: string;
		[key: string]: unknown;
	};
	parts?: OpenCodeMessagePart[];
	[key: string]: unknown;
}

interface OpenCodeRequestOptions extends RequestInit {
	query?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * OpenCode executor - controls OpenCode server via REST API
 *
 * This executor communicates with an OpenCode server running locally
 * (started via `opencode serve`). It creates sessions, sends prompts,
 * and streams events back through the unified StreamEvent interface.
 *
 * Environment variables:
 * - OPENCODE_SERVER_URL: Override server URL
 * - OPENCODE_SERVER_USERNAME: Basic auth username
 * - OPENCODE_SERVER_PASSWORD: Basic auth password
 */
export class OpenCodeExecutor extends BaseExecutor {
	readonly type: RuntimeType = "opencode";

	private config: OpenCodeConfig;
	private openCodeSessions = new Map<string, OpenCodeSession>();
	private serverProcess: ChildProcess | null = null;
	private serverBootTask: Promise<void> | null = null;

	constructor(
		workspaceManager: ConstructorParameters<typeof BaseExecutor>[0],
		sessionManager: ConstructorParameters<typeof BaseExecutor>[1],
		eventBus: ConstructorParameters<typeof BaseExecutor>[2],
		config: Partial<OpenCodeConfig> = {},
	) {
		super(workspaceManager, sessionManager, eventBus);
		this.config = { ...DEFAULT_OPENCODE_CONFIG, ...config };

		// Allow env override
		if (process.env["OPENCODE_SERVER_URL"]) {
			this.config.serverUrl = process.env["OPENCODE_SERVER_URL"];
		}
		if (process.env["OPENCODE_SERVER_PASSWORD"]) {
			this.config.password = process.env["OPENCODE_SERVER_PASSWORD"];
		}
		if (process.env["OPENCODE_SERVER_USERNAME"]) {
			this.config.username = process.env["OPENCODE_SERVER_USERNAME"];
		}
		if (process.env["OPENCODE_PATH"]) {
			this.config.commandPath = process.env["OPENCODE_PATH"];
		}
		const autoStart = this.parseBooleanEnv(process.env["OPENCODE_AUTO_START_SERVER"]);
		if (autoStart !== null) {
			this.config.autoStartServer = autoStart;
		}
	}

	/**
	 * Start a new OpenCode session
	 *
	 * Creates or resumes a session via the OpenCode REST API and sends
	 * the initial prompt as a message part.
	 */
	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		const abortController = new AbortController();
		const resumeSessionId = options.resumeSessionId?.trim();

		const openCodeSessionId =
			resumeSessionId && resumeSessionId.length > 0
				? resumeSessionId
				: await this.createSession(session.workspace.workingDir, abortController.signal);

		// Store OpenCode session mapping
		this.openCodeSessions.set(session.id, {
			openCodeSessionId,
			abortController,
		});
		this.sessionManager.setRuntimeSessionId(session.id, openCodeSessionId);

		// Mark as running before waiting on the first response.
		this.emitStatus(session.id, "running");
		// Send initial prompt
		await this.sendMessage(session.id, options.initialPrompt);
	}

	/**
	 * Send a follow-up input to the session
	 */
	protected async doSendInput(session: Session, input: string): Promise<void> {
		await this.sendMessage(session.id, input);
	}

	/**
	 * Stop the OpenCode session
	 *
	 * Aborts in-flight requests and the active run, but keeps the
	 * runtime session so it can be resumed later.
	 */
	protected async doStop(session: Session): Promise<void> {
		const ocSession = this.openCodeSessions.get(session.id);
		if (!ocSession) return;

		// Cancel pending requests
		ocSession.abortController.abort();

		// Abort current run via API (best effort).
		// Keep remote session intact so it can be resumed.
		try {
			await this.apiRequest(`/session/${encodeURIComponent(ocSession.openCodeSessionId)}/abort`, {
				method: "POST",
				query: { directory: session.workspace.workingDir },
			});
		} catch {
			// Ignore errors on cleanup
		}

		this.openCodeSessions.delete(session.id);
	}

	// ========================================
	// Private helper methods
	// ========================================

	/**
	 * Send a message to the OpenCode session
	 */
	private async sendMessage(sessionId: string, content: string): Promise<void> {
		const session = this.sessionManager.get(sessionId);
		const ocSession = this.openCodeSessions.get(sessionId);
		if (!ocSession || !session) throw new Error("OpenCode session not found");
		this.emitStatus(sessionId, "running");

		const request = {
			method: "POST",
			query: { directory: session.workspace.workingDir },
			body: JSON.stringify({
				parts: [{ type: "text", text: content }],
			}),
			signal: ocSession.abortController.signal,
		} satisfies OpenCodeRequestOptions;

		let payload: OpenCodeMessageResponse | null = null;
		try {
			const response = await this.apiRequest(
				`/session/${encodeURIComponent(ocSession.openCodeSessionId)}/message`,
				request,
			);

			if (!response.ok) {
				throw new Error(
					`Failed to send OpenCode message: ${response.status} ${await this.getErrorBody(response)}`,
				);
			}

			payload = (await response.json()) as OpenCodeMessageResponse;
		} catch (error) {
			if (!this.shouldAttemptHistoryRecovery(error)) {
				throw error;
			}

			payload = await this.recoverTimedOutMessage(
				ocSession.openCodeSessionId,
				session.workspace.workingDir,
				content,
				ocSession.abortController.signal,
			);
			if (!payload) {
				throw new Error("Request failed");
			}
		}

		let handled = this.handleOpenCodeMessageResponse(sessionId, payload);
		if (!handled.hasError && !handled.emittedAnyPart) {
			const recovered = await this.recoverTimedOutMessage(
				ocSession.openCodeSessionId,
				session.workspace.workingDir,
				content,
				ocSession.abortController.signal,
			);
			if (recovered) {
				handled = this.handleOpenCodeMessageResponse(sessionId, recovered);
			}
		}
		if (!handled.hasError) {
			this.emitStatus(sessionId, "idle");
		}
	}

	private shouldAttemptHistoryRecovery(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}

		return (
			error.name === "SyntaxError" ||
			error.message.includes("Unexpected end of JSON input") ||
			error.message.includes("timed out")
		);
	}

	private async recoverTimedOutMessage(
		openCodeSessionId: string,
		workingDir: string,
		submittedPrompt: string,
		signal: AbortSignal,
	): Promise<OpenCodeMessageResponse | null> {
		const deadline = Date.now() + OPENCODE_HISTORY_RECOVERY_TIMEOUT_MS;

		while (Date.now() < deadline) {
			if (signal.aborted) {
				return null;
			}

			try {
				const messages = await this.fetchMessageHistory(openCodeSessionId, workingDir, signal);
				const recovered = this.extractAssistantResponseFromHistory(messages, submittedPrompt);
				if (recovered) {
					return recovered;
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					return null;
				}
			}

			await new Promise((resolve) => setTimeout(resolve, OPENCODE_HISTORY_POLL_INTERVAL_MS));
		}

		return null;
	}

	private async fetchMessageHistory(
		openCodeSessionId: string,
		workingDir: string,
		signal: AbortSignal,
	): Promise<OpenCodeHistoryMessage[]> {
		const response = await this.apiRequest(
			`/session/${encodeURIComponent(openCodeSessionId)}/message`,
			{
				method: "GET",
				query: { directory: workingDir },
				signal,
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to fetch OpenCode message history: ${response.status} ${await this.getErrorBody(response)}`,
			);
		}

		const payload = (await response.json()) as unknown;
		return Array.isArray(payload) ? (payload as OpenCodeHistoryMessage[]) : [];
	}

	private extractAssistantResponseFromHistory(
		messages: OpenCodeHistoryMessage[],
		submittedPrompt: string,
	): OpenCodeMessageResponse | null {
		const normalizedPrompt = submittedPrompt.trim();
		if (normalizedPrompt.length === 0) {
			return null;
		}

		let promptIndex = -1;
		for (let idx = messages.length - 1; idx >= 0; idx--) {
			const message = messages[idx];
			if (!message || !Array.isArray(message.parts) || message.parts.length !== 1) {
				continue;
			}
			const [part] = message.parts;
			if (part?.type !== "text") {
				continue;
			}
			const text = typeof part.text === "string" ? part.text.trim() : "";
			if (text === normalizedPrompt) {
				promptIndex = idx;
				break;
			}
		}

		if (promptIndex < 0 || promptIndex >= messages.length - 1) {
			return null;
		}

		const responseMessages = messages.slice(promptIndex + 1);
		const assistantMessage = responseMessages.find((message) =>
			typeof message.info?.role === "string"
				? message.info.role === "assistant"
				: Array.isArray(message.parts) && message.parts.some((part) => part.type !== "text"),
		);

		if (!assistantMessage || !Array.isArray(assistantMessage.parts)) {
			return null;
		}
		const hasRenderableParts = assistantMessage.parts.some((part) => {
			if (part.type === "text") {
				return typeof part.text === "string" && part.text.length > 0;
			}
			return (
				part.type === "error" ||
				part.type === "permission_request" ||
				part.type === "tool" ||
				part.type === "file_change"
			);
		});
		if (!hasRenderableParts) {
			return null;
		}

		return {
			info: {
				role:
					typeof assistantMessage.info?.role === "string"
						? assistantMessage.info.role
						: "assistant",
			},
			parts: assistantMessage.parts,
		};
	}

	/**
	 * Handle incoming OpenCode response and map to StreamEvent types
	 */
	private handleOpenCodeMessageResponse(
		sessionId: string,
		response: OpenCodeMessageResponse,
	): { hasError: boolean; emittedAnyPart: boolean } {
		if (!Array.isArray(response.parts)) {
			return { hasError: false, emittedAnyPart: false };
		}

		let hasError = false;
		let emittedAnyPart = false;
		for (const part of response.parts) {
			switch (part.type) {
				case "text":
					if (typeof part.text === "string" && part.text.length > 0) {
						this.emitOutput(sessionId, part.text);
						emittedAnyPart = true;
					}
					break;
				case "permission_request":
					this.emitAttention(sessionId, "permission_required", {
						action: part.action,
						description: part.description,
					});
					emittedAnyPart = true;
					break;
				case "file_change":
				case "tool":
					this.emitDiffUpdated(sessionId);
					emittedAnyPart = true;
					break;
				case "error":
					hasError = true;
					emittedAnyPart = true;
					this.emitStatus(sessionId, "error");
					if (typeof part.message === "string" && part.message.length > 0) {
						this.emitOutput(sessionId, `Error: ${part.message}\n`);
					}
					break;
			}
		}
		return { hasError, emittedAnyPart };
	}

	/**
	 * Make an authenticated API request to the OpenCode server
	 */
	private async apiRequest(path: string, options: OpenCodeRequestOptions = {}): Promise<Response> {
		const { query, ...requestInit } = options;
		const url = new URL(path, this.ensureTrailingSlash(this.config.serverUrl));
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined || value === null || value === "") continue;
				url.searchParams.set(key, String(value));
			}
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...((requestInit.headers as Record<string, string>) || {}),
		};

		// Add basic auth if password is configured
		if (this.config.password) {
			const credentials = Buffer.from(
				`${this.config.username}:${this.config.password}`,
				"utf-8",
			).toString("base64");
			headers["Authorization"] = `Basic ${credentials}`;
		}

		try {
			return await this.fetchWithTimeout(url, requestInit, headers);
		} catch (error) {
			if (await this.shouldRetryAfterBoot(error, url, requestInit.signal)) {
				return this.fetchWithTimeout(url, requestInit, headers);
			}
			throw error;
		}
	}

	private async fetchWithTimeout(
		url: URL,
		requestInit: RequestInit,
		headers: Record<string, string>,
	): Promise<Response> {
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), OPENCODE_HTTP_TIMEOUT_MS);
		const signal = requestInit.signal
			? AbortSignal.any([requestInit.signal, timeoutController.signal])
			: timeoutController.signal;

		try {
			return await fetch(url, {
				...requestInit,
				headers,
				signal,
			});
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				if (timeoutController.signal.aborted) {
					throw new Error(
						`OpenCode request timed out after ${OPENCODE_HTTP_TIMEOUT_MS}ms: ${url.pathname}`,
					);
				}
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async shouldRetryAfterBoot(
		error: unknown,
		url: URL,
		signal: AbortSignal | null | undefined,
	): Promise<boolean> {
		if (!this.config.autoStartServer || signal?.aborted) {
			return false;
		}
		if (!this.isLoopbackURL(url)) {
			return false;
		}
		if (!this.isConnectionRefusedError(error)) {
			return false;
		}

		await this.ensureLocalServerRunning(url, signal);
		return true;
	}

	private async ensureLocalServerRunning(
		url: URL,
		signal: AbortSignal | null | undefined,
	): Promise<void> {
		if (await this.isServerReachable(url, signal)) {
			return;
		}

		if (this.serverBootTask) {
			await this.serverBootTask;
			return;
		}

		this.serverBootTask = this.bootServer(url, signal).finally(() => {
			this.serverBootTask = null;
		});
		await this.serverBootTask;
	}

	private async bootServer(url: URL, signal: AbortSignal | null | undefined): Promise<void> {
		const parsedPort = Number.parseInt(url.port, 10);
		if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
			throw new Error(`Cannot auto-start OpenCode server for URL without explicit port: ${url}`);
		}

		const stderrLimit = 4000;
		let stderr = "";
		let stderrTruncated = false;
		const spawnState: { errorMessage: string | null } = { errorMessage: null };
		if (!this.serverProcess || this.serverProcess.exitCode !== null) {
			const args = ["serve", "--hostname", url.hostname, "--port", String(parsedPort)];
			const child = spawn(this.config.commandPath, args, {
				stdio: ["ignore", "ignore", "pipe"],
			});
			this.serverProcess = child;
			child.on("error", (error) => {
				spawnState.errorMessage =
					error instanceof Error ? error.message : new Error(String(error)).message;
				if (this.serverProcess === child) {
					this.serverProcess = null;
				}
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
				if (stderr.length > stderrLimit) {
					stderr = stderr.slice(-stderrLimit);
					stderrTruncated = true;
				}
			});
			child.on("exit", () => {
				if (this.serverProcess === child) {
					this.serverProcess = null;
				}
			});
		}

		const deadline = Date.now() + OPENCODE_SERVER_BOOT_TIMEOUT_MS;

		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error("OpenCode server startup aborted");
			}
			const spawnErrorMessage = spawnState.errorMessage;
			if (spawnErrorMessage) {
				const detail = stderr.trim();
				const truncationNote = stderrTruncated
					? ` [stderr truncated to last ${stderrLimit} chars]`
					: "";
				throw new Error(
					detail.length > 0
						? `Failed to start OpenCode server: ${spawnErrorMessage}. ${detail}${truncationNote}`
						: `Failed to start OpenCode server: ${spawnErrorMessage}`,
				);
			}
			if (await this.isServerReachable(url, signal)) {
				return;
			}
			const exited = this.serverProcess?.exitCode;
			if (typeof exited === "number") {
				const detail = stderr.trim();
				const truncationNote = stderrTruncated
					? ` [stderr truncated to last ${stderrLimit} chars]`
					: "";
				throw new Error(
					detail.length > 0
						? `OpenCode server exited during startup (${exited}): ${detail}${truncationNote}`
						: `OpenCode server exited during startup (${exited})`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, OPENCODE_SERVER_BOOT_POLL_INTERVAL_MS));
		}

		throw new Error(
			`Timed out waiting for OpenCode server at ${url.protocol}//${url.hostname}:${parsedPort}`,
		);
	}

	private async isServerReachable(
		url: URL,
		signal: AbortSignal | null | undefined,
	): Promise<boolean> {
		const probeController = new AbortController();
		const timeoutId = setTimeout(() => probeController.abort(), 1000);
		const probeSignal = signal
			? AbortSignal.any([signal, probeController.signal])
			: probeController.signal;

		try {
			await fetch(url, { method: "GET", signal: probeSignal });
			return true;
		} catch {
			return false;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private isLoopbackURL(url: URL): boolean {
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return false;
		}
		return (
			url.hostname === "localhost" ||
			url.hostname === "::1" ||
			url.hostname.startsWith("127.") ||
			url.hostname.startsWith("::ffff:127.")
		);
	}

	private isConnectionRefusedError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const cause = error.cause as { code?: string } | undefined;
		if (cause?.code === "ECONNREFUSED") {
			return true;
		}
		return error.message.includes("ECONNREFUSED");
	}

	private parseBooleanEnv(value: string | undefined): boolean | null {
		if (!value) {
			return null;
		}
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "yes") {
			return true;
		}
		if (normalized === "0" || normalized === "false" || normalized === "no") {
			return false;
		}
		return null;
	}

	private async createSession(workingDir: string, signal: AbortSignal): Promise<string> {
		const createPayload: { permission?: OpenCodePermissionRule[] } = {};
		if (this.config.permissionRules.length > 0) {
			createPayload.permission = this.config.permissionRules;
		}

		const response = await this.apiRequest("/session", {
			method: "POST",
			query: { directory: workingDir },
			body: JSON.stringify(createPayload),
			signal,
		});

		if (!response.ok) {
			throw new Error(
				`Failed to create OpenCode session: ${response.status} ${await this.getErrorBody(response)}`,
			);
		}

		const data = (await response.json()) as { id?: string };
		const id = data.id?.trim();
		if (!id) {
			throw new Error("Failed to create OpenCode session: missing session id");
		}
		return id;
	}

	private async getErrorBody(response: Response): Promise<string> {
		try {
			const text = (await response.text()).trim();
			return text.length > 0 ? text : "(empty body)";
		} catch {
			return "(failed to read error body)";
		}
	}

	private ensureTrailingSlash(url: string): string {
		return url.endsWith("/") ? url : `${url}/`;
	}
}
