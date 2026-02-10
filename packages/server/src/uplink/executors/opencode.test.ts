import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { OpenCodeExecutor } from "./opencode.js";

interface CapturedRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

describe("OpenCodeExecutor", () => {
	let testDir: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let mockServer: Server;
	let serverPort: number;
	let activeExecutor: OpenCodeExecutor | null = null;
	let activeSessionId: string | null = null;
	let requests: CapturedRequest[] = [];

	beforeEach(async () => {
		activeExecutor = null;
		activeSessionId = null;
		requests = [];

		// Create test git repo
		testDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");
		await writeFile(join(testDir, "README.md"), "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		workspaceManager = new WorkspaceManager(testDir);
		sessionManager = new SessionManager();
		eventBus = new EventBus();

		await new Promise<void>((resolve) => {
			mockServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const body = await readJsonBody(req);
				requests.push({
					method: req.method ?? "GET",
					path: url.pathname,
					query: Object.fromEntries(url.searchParams.entries()),
					body,
				});

				res.setHeader("Content-Type", "application/json");

				if (req.method === "POST" && url.pathname === "/session") {
					res.statusCode = 200;
					res.end(
						JSON.stringify({
							id: "mock-session-123",
							directory: url.searchParams.get("directory"),
						}),
					);
					return;
				}

				const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
				if (req.method === "POST" && messageMatch) {
					const sessionId = decodeURIComponent(messageMatch[1] ?? "");
					const text =
						typeof body === "object" && body !== null
							? (((body as { parts?: Array<{ type?: string; text?: string }> }).parts ?? []).find(
									(part) => part.type === "text",
								)?.text ?? "")
							: "";

					if (!text) {
						res.statusCode = 400;
						res.end(
							JSON.stringify({
								success: false,
								error: [{ message: "missing text part" }],
							}),
						);
						return;
					}

					res.statusCode = 200;
					res.end(
						JSON.stringify({
							info: { role: "assistant", sessionID: sessionId },
							parts: [{ type: "text", text: `Echo: ${text}` }],
						}),
					);
					return;
				}

				const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
				if (req.method === "POST" && abortMatch) {
					res.statusCode = 200;
					res.end(JSON.stringify({ success: true }));
					return;
				}

				res.statusCode = 404;
				res.end(JSON.stringify({ error: "Not found" }));
			});

			mockServer.listen(0, "127.0.0.1", () => {
				const addr = mockServer.address();
				if (addr && typeof addr !== "string") {
					serverPort = addr.port;
				}
				resolve();
			});
		});
	});

	afterEach(async () => {
		if (activeExecutor && activeSessionId) {
			try {
				await activeExecutor.stop(activeSessionId);
			} catch {
				// Ignore errors during cleanup
			}
		}

		await new Promise<void>((resolve) => mockServer.close(() => resolve()));
		await rm(testDir, { recursive: true, force: true });
	});

	it("creates executor with correct type", () => {
		const executor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		expect(executor.type).toBe("opencode");
	});

	it("starts a run, sets runtime session id, and emits output", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const events: Array<{ type: string; payload: unknown }> = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Hello from test",
		});
		activeSessionId = result.sessionId;

		expect(result.sessionId).toBeDefined();
		expect(result.runId).toBeDefined();
		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("mock-session-123");

		const createRequest = requests.find(
			(request) => request.method === "POST" && request.path === "/session",
		);
		expect(createRequest?.query["directory"]).toBe(testDir);
		expect(createRequest?.body).toEqual({
			permission: [{ permission: "*", pattern: "*", action: "allow" }],
		});

		const messageRequest = requests.find(
			(request) =>
				request.method === "POST" && request.path === "/session/mock-session-123/message",
		);
		expect(messageRequest?.query["directory"]).toBe(testDir);
		expect(messageRequest?.body).toEqual({
			parts: [{ type: "text", text: "Hello from test" }],
		});

		const outputEvents = events.filter((event) => event.type === "session.output");
		expect(outputEvents.length).toBeGreaterThan(0);
		expect((outputEvents[0] as { payload: { text: string } }).payload.text).toContain("Echo:");

		const statusEvents = events.filter((event) => event.type === "session.status");
		const statuses = statusEvents.map((event) => (event.payload as { status: string }).status);
		expect(statuses).toContain("running");
		expect(statuses).toContain("idle");
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");
	});

	it("reuses resume session id instead of creating a new OpenCode session", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Continue this thread",
			resumeSessionId: "resume-session-abc",
		});
		activeSessionId = result.sessionId;

		expect(sessionManager.get(result.sessionId)?.runtimeSessionId).toBe("resume-session-abc");

		const createRequest = requests.find(
			(request) => request.method === "POST" && request.path === "/session",
		);
		expect(createRequest).toBeUndefined();

		const resumeMessageRequest = requests.find(
			(request) =>
				request.method === "POST" && request.path === "/session/resume-session-abc/message",
		);
		expect(resumeMessageRequest?.query["directory"]).toBe(testDir);
	});

	it("sends follow-up input to an active session", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});
		const events: Array<{ type: string; payload: unknown }> = [];
		eventBus.subscribe((event) => events.push(event));

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Initial message",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.sendInput(result.sessionId, "Follow-up message");

		const messageRequests = requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/session/mock-session-123/message",
		);
		expect(messageRequests.length).toBe(2);
		expect(messageRequests[1]?.body).toEqual({
			parts: [{ type: "text", text: "Follow-up message" }],
		});

		const statusEvents = events.filter((event) => event.type === "session.status");
		const statuses = statusEvents.map((event) => (event.payload as { status: string }).status);
		expect(statuses.filter((status) => status === "running").length).toBeGreaterThanOrEqual(2);
		expect(statuses.filter((status) => status === "idle").length).toBeGreaterThanOrEqual(2);
		expect(sessionManager.get(result.sessionId)?.status).toBe("idle");
	});

	it("stops session with abort endpoint and keeps remote session for resume", async () => {
		activeExecutor = new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const result = await activeExecutor.startRun({
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Hello",
		});
		activeSessionId = result.sessionId;

		await activeExecutor.stop(result.sessionId);

		const abortRequest = requests.find(
			(request) => request.method === "POST" && request.path === "/session/mock-session-123/abort",
		);
		expect(abortRequest?.query["directory"]).toBe(testDir);

		const deleteRequest = requests.find((request) => request.method === "DELETE");
		expect(deleteRequest).toBeUndefined();

		const session = sessionManager.get(result.sessionId);
		expect(session?.status).toBe("ended");

		activeSessionId = null;
	});
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) {
		return undefined;
	}

	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) {
		return undefined;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
