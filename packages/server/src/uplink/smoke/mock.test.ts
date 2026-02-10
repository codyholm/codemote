import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events.js";
import { MockExecutor } from "../mock-executor.js";
import { SessionManager } from "../session.js";
import { WorkspaceManager } from "../workspace.js";
import { SmokeTestHarness } from "./harness.js";

describe("Mock Executor Smoke Test", () => {
	let testDir: string;
	let workspaceManager: WorkspaceManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let executor: MockExecutor;
	let harness: SmokeTestHarness;

	beforeEach(async () => {
		// Setup test repo
		testDir = await mkdtemp(join(tmpdir(), "smoke-mock-"));
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
		executor = new MockExecutor(workspaceManager, sessionManager, eventBus);
		harness = new SmokeTestHarness({ streamDuration: 500 });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("passes smoke test", async () => {
		const result = await harness.run(executor, {
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Hello world",
		});

		expect(result.passed).toBe(true);
		expect(result.events.length).toBeGreaterThan(0);
	});

	it("receives session events", async () => {
		const result = await harness.run(executor, {
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Test prompt",
		});

		const outputEvents = result.events.filter((e) => e.type === "session.output");
		expect(outputEvents.length).toBeGreaterThan(0);
	});

	it("handles follow-up input", async () => {
		const result = await harness.run(executor, {
			profile: "opencode",
			workspace: testDir,
			initialPrompt: "Initial prompt",
		});

		// Should have received events including response to follow-up
		expect(result.passed).toBe(true);
	});
});
