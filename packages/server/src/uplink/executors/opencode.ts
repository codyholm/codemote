import type { RunOptions, RuntimeType } from "@codemote/common";
import { BaseExecutor } from "../executor.js";
import type { Session } from "../types.js";

const OPENCODE_HTTP_TIMEOUT_MS = 5000; // 5 seconds for local requests

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
	/** Permission rules applied when creating new OpenCode sessions */
	permissionRules: OpenCodePermissionRule[];
}

const DEFAULT_OPENCODE_CONFIG: OpenCodeConfig = {
	serverUrl: "http://127.0.0.1:4096",
	username: "opencode",
	password: null,
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

		const response = await this.apiRequest(
			`/session/${encodeURIComponent(ocSession.openCodeSessionId)}/message`,
			{
				method: "POST",
				query: { directory: session.workspace.workingDir },
				body: JSON.stringify({
					parts: [{ type: "text", text: content }],
				}),
				signal: ocSession.abortController.signal,
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to send OpenCode message: ${response.status} ${await this.getErrorBody(response)}`,
			);
		}

		const payload = (await response.json()) as OpenCodeMessageResponse;
		const hasError = this.handleOpenCodeMessageResponse(sessionId, payload);
		if (!hasError) {
			this.emitStatus(sessionId, "idle");
		}
	}

	/**
	 * Handle incoming OpenCode response and map to StreamEvent types
	 */
	private handleOpenCodeMessageResponse(
		sessionId: string,
		response: OpenCodeMessageResponse,
	): boolean {
		if (!Array.isArray(response.parts)) {
			return false;
		}

		let hasError = false;
		for (const part of response.parts) {
			switch (part.type) {
				case "text":
					if (typeof part.text === "string" && part.text.length > 0) {
						this.emitOutput(sessionId, part.text);
					}
					break;
				case "permission_request":
					this.emitAttention(sessionId, "permission_required", {
						action: part.action,
						description: part.description,
					});
					break;
				case "file_change":
				case "tool":
					this.emitDiffUpdated(sessionId);
					break;
				case "error":
					hasError = true;
					this.emitStatus(sessionId, "error");
					if (typeof part.message === "string" && part.message.length > 0) {
						this.emitOutput(sessionId, `Error: ${part.message}\n`);
					}
					break;
			}
		}
		return hasError;
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

		// Add timeout using AbortController
		// Combine timeout with any caller-provided signal so both can abort the request
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), OPENCODE_HTTP_TIMEOUT_MS);

		// Use AbortSignal.any() to respect both timeout and caller signals
		const signal = requestInit.signal
			? AbortSignal.any([requestInit.signal, timeoutController.signal])
			: timeoutController.signal;

		try {
			const response = await fetch(url, {
				...requestInit,
				headers,
				signal,
			});
			clearTimeout(timeoutId);
			return response;
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === "AbortError") {
				// Distinguish between timeout-triggered aborts and caller-triggered aborts
				if (timeoutController.signal.aborted) {
					throw new Error(
						`OpenCode request timed out after ${OPENCODE_HTTP_TIMEOUT_MS}ms: ${url.pathname}`,
					);
				}
				// Re-throw caller's abort as-is
			}
			throw error;
		}
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
