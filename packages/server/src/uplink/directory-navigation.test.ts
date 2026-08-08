import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildDirectoryNavigationMetadata,
	directoryEntryPath,
	discoverWindowsDriveRoots,
	parseWindowsDriveRoots,
	resolveDirectoryPaths,
} from "./directory-navigation.js";

describe("directory navigation", () => {
	it("resolves POSIX paths and reports the POSIX root", async () => {
		const resolved = resolveDirectoryPaths({
			requestedPath: "~/projects/codemote",
			cwd: "/srv/codemote",
			homePath: "/Users/tester",
			platform: "darwin",
			pathApi: posix,
		});
		const navigation = await buildDirectoryNavigationMetadata(resolved.path, resolved.homePath, {
			platform: "darwin",
			pathApi: posix,
		});

		expect(resolved).toEqual({
			path: "/Users/tester/projects/codemote",
			homePath: "/Users/tester",
		});
		expect(navigation).toEqual({
			parentPath: "/Users/tester/projects",
			roots: [{ name: "/", path: "/" }],
		});
		expect(directoryEntryPath(resolved.path, "packages", posix)).toBe(
			"/Users/tester/projects/codemote/packages",
		);
	});

	it("uses win32 semantics for drive paths, tilde expansion, and entry paths", async () => {
		const resolved = resolveDirectoryPaths({
			requestedPath: "~\\src",
			cwd: "C:\\service",
			homePath: "C:\\Users\\Tester",
			platform: "win32",
			pathApi: win32,
		});
		const navigation = await buildDirectoryNavigationMetadata(resolved.path, resolved.homePath, {
			platform: "win32",
			pathApi: win32,
			discoverWindowsDrives: async () => ["D:\\", "c:\\", "C:\\"],
		});

		expect(resolved).toEqual({
			path: "C:\\Users\\Tester\\src",
			homePath: "C:\\Users\\Tester",
		});
		expect(navigation).toEqual({
			parentPath: "C:\\Users\\Tester",
			roots: [
				{ name: "C:", path: "C:\\" },
				{ name: "D:", path: "D:\\" },
			],
		});
		expect(directoryEntryPath(resolved.path, "project", win32)).toBe(
			"C:\\Users\\Tester\\src\\project",
		);
	});

	it("reports the canonical Windows home with its parent and drive roots", async () => {
		const resolved = resolveDirectoryPaths({
			requestedPath: "~",
			cwd: "C:\\service",
			homePath: "C:\\Users\\Tester",
			platform: "win32",
			pathApi: win32,
		});
		const navigation = await buildDirectoryNavigationMetadata(resolved.path, resolved.homePath, {
			platform: "win32",
			pathApi: win32,
			discoverWindowsDrives: async () => ["C:\\", "D:\\"],
		});

		expect(resolved.path).toBe("C:\\Users\\Tester");
		expect(navigation.parentPath).toBe("C:\\Users");
		expect(navigation.roots).toEqual([
			{ name: "C:", path: "C:\\" },
			{ name: "D:", path: "D:\\" },
		]);
		expect(directoryEntryPath(resolved.path, "project", win32)).toBe("C:\\Users\\Tester\\project");
	});

	it("accepts either slash after tilde on Windows and leaves other tildes relative", () => {
		const base = {
			cwd: "C:\\service",
			homePath: "C:\\Users\\Tester",
			platform: "win32" as const,
			pathApi: win32,
		};

		expect(resolveDirectoryPaths({ ...base, requestedPath: "~/src" }).path).toBe(
			"C:\\Users\\Tester\\src",
		);
		expect(resolveDirectoryPaths({ ...base, requestedPath: "~" }).path).toBe("C:\\Users\\Tester");
		expect(resolveDirectoryPaths({ ...base, requestedPath: "~other" }).path).toBe(
			"C:\\service\\~other",
		);
	});

	it("reports no parent at a drive root and includes another discovered drive", async () => {
		const anotherDrive = resolveDirectoryPaths({
			requestedPath: "D:\\src",
			cwd: "C:\\service",
			homePath: "C:\\Users\\Tester",
			platform: "win32",
			pathApi: win32,
		});
		const navigation = await buildDirectoryNavigationMetadata("C:\\", "D:\\Users\\Tester", {
			platform: "win32",
			pathApi: win32,
			discoverWindowsDrives: async () => ["E:\\"],
		});

		expect(anotherDrive.path).toBe("D:\\src");
		expect(navigation).toEqual({
			parentPath: null,
			roots: [
				{ name: "C:", path: "C:\\" },
				{ name: "D:", path: "D:\\" },
				{ name: "E:", path: "E:\\" },
			],
		});
	});

	it("preserves UNC share roots and nested UNC parents", async () => {
		const nestedPath = "\\\\server\\share\\projects\\codemote";
		const navigation = await buildDirectoryNavigationMetadata(nestedPath, "C:\\Users\\Tester", {
			platform: "win32",
			pathApi: win32,
			discoverWindowsDrives: async () => [],
		});
		const rootNavigation = await buildDirectoryNavigationMetadata(
			"\\\\server\\share\\",
			"C:\\Users\\Tester",
			{
				platform: "win32",
				pathApi: win32,
				discoverWindowsDrives: async () => [],
			},
		);

		expect(navigation.parentPath).toBe("\\\\server\\share\\projects");
		expect(navigation.roots).toEqual([
			{ name: "\\\\server\\share", path: "\\\\server\\share\\" },
			{ name: "C:", path: "C:\\" },
		]);
		expect(directoryEntryPath(nestedPath, "packages", win32)).toBe(
			"\\\\server\\share\\projects\\codemote\\packages",
		);
		expect(rootNavigation.parentPath).toBeNull();
	});

	it("falls back to current and home roots when drive discovery times out", async () => {
		const discoverWindowsDrives = vi.fn(async (): Promise<string[]> => {
			throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
		});

		const navigation = await buildDirectoryNavigationMetadata(
			"\\\\server\\share\\projects",
			"C:\\Users\\Tester",
			{ platform: "win32", pathApi: win32, discoverWindowsDrives },
		);

		expect(discoverWindowsDrives).toHaveBeenCalledOnce();
		expect(navigation.roots).toEqual([
			{ name: "\\\\server\\share", path: "\\\\server\\share\\" },
			{ name: "C:", path: "C:\\" },
		]);
	});

	it("runs bounded non-shell PowerShell discovery and parses ready roots", async () => {
		const runner = vi.fn(
			async (
				_file: string,
				_args: string[],
				_options: { timeout: number; windowsHide: boolean },
			) => ({ stdout: JSON.stringify(["C:\\", "D:\\"]) }),
		);

		await expect(discoverWindowsDriveRoots(runner)).resolves.toEqual(["C:\\", "D:\\"]);
		expect(runner).toHaveBeenCalledOnce();
		const [file, args, options] = runner.mock.calls[0] ?? [];
		expect(file).toBe("powershell.exe");
		expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
		expect(options).toEqual({ timeout: 2_000, windowsHide: true });
	});

	it("rejects malformed drive discovery output for graceful caller fallback", () => {
		expect(() => parseWindowsDriveRoots("not-json")).toThrow();
		expect(() => parseWindowsDriveRoots(JSON.stringify("C:\\"))).toThrow(
			"PowerShell returned an invalid drive list",
		);
	});
});
