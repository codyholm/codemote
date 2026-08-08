import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import type { DirectoryLocation } from "./types.js";

const WINDOWS_DRIVE_DISCOVERY_TIMEOUT_MS = 2_000;
const WINDOWS_DRIVE_DISCOVERY_CACHE_TTL_MS = 30_000;
const WINDOWS_DRIVE_DISCOVERY_SCRIPT =
	"$roots = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { $_.RootDirectory.FullName }); ConvertTo-Json -Compress -InputObject $roots";

export interface PathOperations {
	sep: string;
	resolve(...paths: string[]): string;
	join(...paths: string[]): string;
	dirname(path: string): string;
	parse(path: string): { root: string };
}

export interface DirectoryPathResolution {
	path: string;
	homePath: string;
}

interface ResolveDirectoryPathOptions {
	requestedPath: string;
	cwd: string;
	homePath: string;
	platform?: NodeJS.Platform;
	pathApi?: PathOperations;
}

interface NavigationMetadataOptions {
	platform?: NodeJS.Platform;
	pathApi?: PathOperations;
	discoverWindowsDrives?: () => Promise<string[]>;
}

interface CanonicalizeDirectoryPathOptions {
	platform?: NodeJS.Platform;
	canonicalize?: (path: string) => Promise<string>;
}

interface ProcessResult {
	stdout: string;
}

export type ProcessRunner = (
	file: string,
	args: string[],
	options: { timeout: number; windowsHide: boolean },
) => Promise<ProcessResult>;

function expandHomePath(
	requestedPath: string,
	homePath: string,
	platform: NodeJS.Platform,
	pathApi: PathOperations,
): string {
	if (requestedPath === "~") {
		return homePath;
	}

	const hasHomeSeparator =
		requestedPath.startsWith(`~${pathApi.sep}`) ||
		(platform === "win32" && (requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")));
	if (!hasHomeSeparator) {
		return requestedPath;
	}

	return pathApi.join(homePath, requestedPath.slice(2));
}

export function resolveDirectoryPaths({
	requestedPath,
	cwd,
	homePath,
	platform = process.platform,
	pathApi = nodePath,
}: ResolveDirectoryPathOptions): DirectoryPathResolution {
	const canonicalHomePath = pathApi.resolve(cwd, homePath);
	const expandedPath = expandHomePath(requestedPath, canonicalHomePath, platform, pathApi);
	return {
		path: pathApi.resolve(cwd, expandedPath),
		homePath: canonicalHomePath,
	};
}

export function directoryEntryPath(
	directoryPath: string,
	entryName: string,
	pathApi: PathOperations = nodePath,
): string {
	return pathApi.join(directoryPath, entryName);
}

export async function canonicalizeDirectoryPath(
	path: string,
	{ platform = process.platform, canonicalize = realpath }: CanonicalizeDirectoryPathOptions = {},
): Promise<string> {
	return platform === "win32" ? canonicalize(path) : path;
}

function runProcess(
	file: string,
	args: string[],
	options: { timeout: number; windowsHide: boolean },
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				timeout: options.timeout,
				windowsHide: options.windowsHide,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout });
			},
		);
	});
}

export function parseWindowsDriveRoots(stdout: string): string[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
		throw new Error("PowerShell returned an invalid drive list");
	}
	return parsed;
}

export async function discoverWindowsDriveRoots(
	runner: ProcessRunner = runProcess,
): Promise<string[]> {
	const result = await runner(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DRIVE_DISCOVERY_SCRIPT],
		{ timeout: WINDOWS_DRIVE_DISCOVERY_TIMEOUT_MS, windowsHide: true },
	);
	return parseWindowsDriveRoots(result.stdout);
}

interface WindowsDriveRootCacheOptions {
	discover?: () => Promise<string[]>;
	now?: () => number;
	ttlMs?: number;
}

export function createWindowsDriveRootDiscoveryCache({
	discover = discoverWindowsDriveRoots,
	now = Date.now,
	ttlMs = WINDOWS_DRIVE_DISCOVERY_CACHE_TTL_MS,
}: WindowsDriveRootCacheOptions = {}): () => Promise<string[]> {
	let cached: { expiresAt: number; roots: string[] } | undefined;
	let pending: Promise<string[]> | undefined;

	return async () => {
		if (cached && now() < cached.expiresAt) {
			return [...cached.roots];
		}
		if (pending) {
			return pending;
		}

		const discovery = discover()
			.catch(() => [])
			.then((roots) => {
				cached = { expiresAt: now() + ttlMs, roots: [...roots] };
				return [...roots];
			})
			.finally(() => {
				if (pending === discovery) pending = undefined;
			});
		pending = discovery;
		return discovery;
	};
}

const discoverCachedWindowsDriveRoots = createWindowsDriveRootDiscoveryCache();

function rootName(rootPath: string, platform: NodeJS.Platform): string {
	if (platform !== "win32") {
		return rootPath;
	}
	if (/^[A-Za-z]:[\\/]$/.test(rootPath)) {
		return rootPath.slice(0, 2).toUpperCase();
	}
	return rootPath.replace(/[\\/]+$/, "");
}

function canonicalRoot(candidate: string, pathApi: PathOperations): string | null {
	const root = pathApi.parse(candidate).root;
	return root.length > 0 ? root : null;
}

export async function buildDirectoryNavigationMetadata(
	currentPath: string,
	homePath: string,
	{
		platform = process.platform,
		pathApi = nodePath,
		discoverWindowsDrives = discoverCachedWindowsDriveRoots,
	}: NavigationMetadataOptions = {},
): Promise<{ parentPath: string | null; roots: DirectoryLocation[] }> {
	const parent = pathApi.dirname(currentPath);
	const parentPath = parent === currentPath ? null : parent;
	const rootCandidates = [pathApi.parse(currentPath).root, pathApi.parse(homePath).root];

	if (platform === "win32") {
		try {
			rootCandidates.push(...(await discoverWindowsDrives()));
		} catch {
			// Optional drive shortcuts must not turn a successful directory listing into an error.
		}
	}

	const rootsByPath = new Map<string, DirectoryLocation>();
	for (const candidate of rootCandidates) {
		const rootPath = canonicalRoot(candidate, pathApi);
		if (!rootPath) continue;
		const key = platform === "win32" ? rootPath.toLocaleLowerCase("en-US") : rootPath;
		if (!rootsByPath.has(key)) {
			rootsByPath.set(key, { name: rootName(rootPath, platform), path: rootPath });
		}
	}

	const roots = [...rootsByPath.values()].sort((a, b) => {
		const nameComparison = a.name.localeCompare(b.name);
		return nameComparison !== 0 ? nameComparison : a.path.localeCompare(b.path);
	});

	return { parentPath, roots };
}
