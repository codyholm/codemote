import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace";

describe("WorkspaceManager", () => {
	let testDir: string;
	let manager: WorkspaceManager;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "uplink-test-"));
		const git = simpleGit(testDir);
		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.email", "test@test.com");
		await git.addConfig("user.name", "Test");

		const readmePath = join(testDir, "README.md");
		await writeFile(readmePath, "# Test");
		await git.add(".");
		await git.commit("Initial commit");

		manager = new WorkspaceManager(testDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("creates workspace in current repo", async () => {
		const workspace = await manager.create({
			repoPath: testDir,
			workspaceId: "ws-1",
		});

		expect(workspace.id).toBe("ws-1");
		expect(workspace.workingDir).toBe(testDir);
	});

	it("lists workspaces", async () => {
		await manager.create({ repoPath: testDir, workspaceId: "ws-1" });
		await manager.create({ repoPath: testDir, workspaceId: "ws-2" });

		const list = manager.list();
		expect(list).toHaveLength(2);
	});

	it("gets workspace by ID", async () => {
		await manager.create({ repoPath: testDir, workspaceId: "ws-get" });

		const workspace = manager.get("ws-get");
		expect(workspace).toBeDefined();
		expect(workspace?.id).toBe("ws-get");
	});

	it("returns undefined for unknown workspace", () => {
		const workspace = manager.get("nonexistent");
		expect(workspace).toBeUndefined();
	});

	it("removes workspace from list", async () => {
		await manager.create({ repoPath: testDir, workspaceId: "to-remove" });

		expect(manager.get("to-remove")).toBeDefined();
		await manager.remove("to-remove");
		expect(manager.get("to-remove")).toBeUndefined();
	});
});
