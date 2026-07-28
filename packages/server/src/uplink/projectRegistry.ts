import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RegisteredProject } from "@codemote/common";
import {
	restrictDirPermissions,
	restrictFilePermissions,
} from "../relay/services/win-permissions.js";

type ProjectRegistryErrorCode =
	| "INVALID_PROJECT"
	| "PROJECT_ALREADY_EXISTS"
	| "PROJECT_NOT_FOUND"
	| "PROJECT_REGISTRY_IO";

interface ProjectRegistryFile {
	projects: RegisteredProject[];
}

export class ProjectRegistryError extends Error {
	readonly code: ProjectRegistryErrorCode;

	constructor(code: ProjectRegistryErrorCode, message: string) {
		super(message);
		this.name = "ProjectRegistryError";
		this.code = code;
	}
}

function normalizeName(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProjectRegistryError("INVALID_PROJECT", "Project name must be a non-empty string");
	}
	return value.trim();
}

function normalizePath(value: unknown): string {
	if (typeof value !== "string") {
		throw new ProjectRegistryError("INVALID_PROJECT", "Project path must be an absolute path");
	}

	const trimmed = value.trim();
	if (!isAbsolute(trimmed)) {
		throw new ProjectRegistryError("INVALID_PROJECT", "Project path must be an absolute path");
	}
	return resolve(trimmed);
}

function normalizeProject(value: unknown): RegisteredProject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectRegistryError("INVALID_PROJECT", "Project registry contains an invalid entry");
	}

	const candidate = value as { name?: unknown; path?: unknown };
	return {
		name: normalizeName(candidate.name),
		path: normalizePath(candidate.path),
	};
}

function sortProjects(projects: RegisteredProject[]): RegisteredProject[] {
	return projects.sort((a, b) => a.path.localeCompare(b.path));
}

function parseRegistryFile(value: unknown): RegisteredProject[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectRegistryError("INVALID_PROJECT", "Invalid project registry format");
	}

	const file = value as { projects?: unknown };
	if (!Array.isArray(file.projects)) {
		throw new ProjectRegistryError("INVALID_PROJECT", "Invalid project registry format");
	}

	const projects: RegisteredProject[] = [];
	const paths = new Set<string>();
	for (const value of file.projects) {
		const project = normalizeProject(value);
		if (paths.has(project.path)) {
			throw new ProjectRegistryError(
				"INVALID_PROJECT",
				`Project registry contains a duplicate path: ${project.path}`,
			);
		}
		paths.add(project.path);
		projects.push(project);
	}
	return sortProjects(projects);
}

/**
 * Machine-local registry of explicitly named absolute project paths.
 *
 * Mutations publish new in-memory state only after the complete candidate snapshot
 * has been persisted successfully.
 */
export class ProjectRegistry {
	private readonly filePath: string;
	private projects: RegisteredProject[];

	constructor(filePath: string) {
		this.filePath = filePath;
		this.projects = this.load();
	}

	list(): RegisteredProject[] {
		return this.projects.map((project) => ({ ...project }));
	}

	add(name: string, path: string): RegisteredProject {
		const project = {
			name: normalizeName(name),
			path: normalizePath(path),
		};
		if (this.projects.some((existing) => existing.path === project.path)) {
			throw new ProjectRegistryError(
				"PROJECT_ALREADY_EXISTS",
				`Project already exists: ${project.path}`,
			);
		}

		const candidate = sortProjects([...this.projects, project]);
		this.persist(candidate);
		this.projects = candidate;
		return { ...project };
	}

	rename(path: string, name: string): RegisteredProject {
		const normalizedPath = normalizePath(path);
		const normalizedName = normalizeName(name);
		if (!this.projects.some((project) => project.path === normalizedPath)) {
			throw new ProjectRegistryError("PROJECT_NOT_FOUND", `Project not found: ${normalizedPath}`);
		}

		const candidate = this.projects.map((project) =>
			project.path === normalizedPath ? { ...project, name: normalizedName } : project,
		);
		this.persist(candidate);
		this.projects = candidate;
		return { name: normalizedName, path: normalizedPath };
	}

	remove(path: string): RegisteredProject {
		const normalizedPath = normalizePath(path);
		const removed = this.projects.find((project) => project.path === normalizedPath);
		if (!removed) {
			throw new ProjectRegistryError("PROJECT_NOT_FOUND", `Project not found: ${normalizedPath}`);
		}

		const candidate = this.projects.filter((project) => project.path !== normalizedPath);
		this.persist(candidate);
		this.projects = candidate;
		return { ...removed };
	}

	private load(): RegisteredProject[] {
		if (!existsSync(this.filePath)) return [];

		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			throw new ProjectRegistryError("PROJECT_REGISTRY_IO", "Failed to read project registry");
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProjectRegistryError("INVALID_PROJECT", "Invalid project registry format");
		}
		return parseRegistryFile(parsed);
	}

	private persist(projects: RegisteredProject[]): void {
		const file: ProjectRegistryFile = {
			projects: projects.map((project) => ({ ...project })),
		};
		const tmpPath = `${this.filePath}.tmp`;

		try {
			const parent = dirname(this.filePath);
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			restrictDirPermissions(parent);
			writeFileSync(tmpPath, `${JSON.stringify(file, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			restrictFilePermissions(tmpPath);
			chmodSync(tmpPath, 0o600);

			// Match the existing persistence convention for Windows, where rename
			// does not replace an existing file.
			if (process.platform === "win32") {
				try {
					unlinkSync(this.filePath);
				} catch {
					// The target may not exist on the first mutation.
				}
			}
			renameSync(tmpPath, this.filePath);
		} catch {
			throw new ProjectRegistryError("PROJECT_REGISTRY_IO", "Failed to persist project registry");
		}
	}
}
