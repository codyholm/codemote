import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectRegistry, ProjectRegistryError } from "./projectRegistry.js";

describe("ProjectRegistry", () => {
	let fixtureDir: string;
	let registryPath: string;

	beforeEach(async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "project-registry-test-"));
		registryPath = join(fixtureDir, "registry", "projects.json");
	});

	afterEach(async () => {
		await rm(fixtureDir, { recursive: true, force: true });
	});

	function expectRegistryError(
		action: () => unknown,
		code:
			| "INVALID_PROJECT"
			| "PROJECT_ALREADY_EXISTS"
			| "PROJECT_NOT_FOUND"
			| "PROJECT_REGISTRY_IO",
	): void {
		try {
			action();
			throw new Error(`Expected ${code}`);
		} catch (error) {
			expect(error).toBeInstanceOf(ProjectRegistryError);
			expect((error as ProjectRegistryError).code).toBe(code);
		}
	}

	it("starts empty without creating a file or parent directory", () => {
		const registry = new ProjectRegistry(registryPath);

		expect(registry.list()).toEqual([]);
		expect(existsSync(registryPath)).toBe(false);
		expect(existsSync(dirname(registryPath))).toBe(false);
	});

	it("adds normalized projects and returns defensive path-sorted copies", async () => {
		const registry = new ProjectRegistry(registryPath);
		const projectBPath = join(fixtureDir, "projects", "b");
		const projectAPath = join(fixtureDir, "projects", "a");

		expect(registry.add("  Project B  ", `${projectBPath}/./`)).toEqual({
			name: "Project B",
			path: resolve(projectBPath),
		});
		registry.add("Project A", projectAPath);

		const listed = registry.list();
		expect(listed).toEqual([
			{ name: "Project A", path: resolve(projectAPath) },
			{ name: "Project B", path: resolve(projectBPath) },
		]);
		const firstListed = listed[0];
		expect(firstListed).toBeDefined();
		if (firstListed) firstListed.name = "Changed outside registry";
		expect(registry.list()[0]?.name).toBe("Project A");

		const raw = await readFile(registryPath, "utf8");
		expect(JSON.parse(raw)).toEqual({ projects: registry.list() });

		if (process.platform !== "win32") {
			expect((await stat(dirname(registryPath))).mode & 0o777).toBe(0o700);
			expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
		}
	});

	it("preserves trailing-space path identity", () => {
		const registry = new ProjectRegistry(registryPath);
		const plainPath = join(fixtureDir, "projects", "spaced");
		const trailingSpacePath = `${plainPath} `;

		expect(registry.add("Trailing space", trailingSpacePath)).toEqual({
			name: "Trailing space",
			path: resolve(trailingSpacePath),
		});
		expect(registry.add("Plain", plainPath)).toEqual({
			name: "Plain",
			path: resolve(plainPath),
		});

		const projects = new ProjectRegistry(registryPath).list();
		expect(projects).toHaveLength(2);
		expect(projects).toEqual(
			expect.arrayContaining([
				{ name: "Trailing space", path: resolve(trailingSpacePath) },
				{ name: "Plain", path: resolve(plainPath) },
			]),
		);
	});

	it("rejects duplicate normalized paths and invalid mutation input", async () => {
		const registry = new ProjectRegistry(registryPath);
		const projectPath = join(fixtureDir, "projects", "same");
		registry.add("Project", projectPath);
		const goodFile = await readFile(registryPath, "utf8");

		expectRegistryError(
			() => registry.add("Duplicate", `${projectPath}/./`),
			"PROJECT_ALREADY_EXISTS",
		);
		expectRegistryError(() => registry.add("Project", "relative/path"), "INVALID_PROJECT");
		expectRegistryError(() => registry.add("   ", projectPath), "INVALID_PROJECT");
		expect(registry.list()).toEqual([{ name: "Project", path: resolve(projectPath) }]);
		expect(await readFile(registryPath, "utf8")).toBe(goodFile);
	});

	it("renames and removes projects by normalized absolute path", () => {
		const registry = new ProjectRegistry(registryPath);
		const projectPath = join(fixtureDir, "projects", "rename-me");
		registry.add("Original", projectPath);

		expect(registry.rename(`${projectPath}/./`, "  Renamed  ")).toEqual({
			name: "Renamed",
			path: resolve(projectPath),
		});
		expect(registry.list()).toEqual([{ name: "Renamed", path: resolve(projectPath) }]);
		expect(registry.remove(`${projectPath}/`)).toEqual({
			name: "Renamed",
			path: resolve(projectPath),
		});
		expect(registry.list()).toEqual([]);
		expectRegistryError(() => registry.rename(projectPath, "Missing"), "PROJECT_NOT_FOUND");
		expectRegistryError(() => registry.remove(projectPath), "PROJECT_NOT_FOUND");
	});

	it("rejects a malformed persisted document in full", async () => {
		await mkdir(dirname(registryPath), { recursive: true });
		const projectPath = join(fixtureDir, "projects", "duplicate");
		const malformedDocuments: unknown[] = [
			null,
			{},
			{ projects: "not-an-array" },
			{ projects: [{ name: "Project", path: "relative/path" }] },
			{ projects: [{ name: "  ", path: projectPath }] },
			{
				projects: [
					{ name: "First", path: projectPath },
					{ name: "Second", path: `${projectPath}/./` },
				],
			},
		];

		for (const document of malformedDocuments) {
			await writeFile(registryPath, JSON.stringify(document), "utf8");
			expectRegistryError(() => new ProjectRegistry(registryPath), "INVALID_PROJECT");
		}

		await writeFile(registryPath, "{ invalid json", "utf8");
		expectRegistryError(() => new ProjectRegistry(registryPath), "INVALID_PROJECT");
	});

	it("keeps the last good memory and target when a mutation cannot persist", async () => {
		const registry = new ProjectRegistry(registryPath);
		const firstPath = join(fixtureDir, "projects", "first");
		const secondPath = join(fixtureDir, "projects", "second");
		registry.add("First", firstPath);
		const goodFile = await readFile(registryPath, "utf8");

		await mkdir(`${registryPath}.tmp`);
		expectRegistryError(() => registry.add("Second", secondPath), "PROJECT_REGISTRY_IO");

		expect(registry.list()).toEqual([{ name: "First", path: resolve(firstPath) }]);
		expect(await readFile(registryPath, "utf8")).toBe(goodFile);
		expect(new ProjectRegistry(registryPath).list()).toEqual(registry.list());
	});

	it("recovers the last good snapshot left by an interrupted Windows replacement", async () => {
		const backupPath = `${registryPath}.bak`;
		const tmpPath = `${registryPath}.tmp`;
		const projectPath = join(fixtureDir, "projects", "last-good");
		const lastGood = {
			projects: [{ name: "Last good", path: projectPath }],
		};

		await mkdir(dirname(registryPath), { recursive: true });
		await writeFile(backupPath, JSON.stringify(lastGood), "utf8");
		await writeFile(tmpPath, JSON.stringify({ projects: [] }), "utf8");

		const registry = new ProjectRegistry(registryPath);

		expect(registry.list()).toEqual(lastGood.projects);
		expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual(lastGood);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(tmpPath)).toBe(true);
	});

	it("persists complete add, rename, and remove results across instances", () => {
		const first = new ProjectRegistry(registryPath);
		const keptPath = join(fixtureDir, "projects", "kept");
		const removedPath = join(fixtureDir, "projects", "removed");
		first.add("Kept", keptPath);
		first.add("Removed", removedPath);
		first.rename(keptPath, "Renamed");
		first.remove(removedPath);

		const second = new ProjectRegistry(registryPath);
		expect(second.list()).toEqual([{ name: "Renamed", path: resolve(keptPath) }]);
	});
});
