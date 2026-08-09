import { spawnSync } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SETUP_COMMAND = "pnpm setup:quality";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const BIOME_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json", ".jsonc"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".yaml", ".yml"]);
const DOC_EXCLUDED_PATHS = new Set(["pnpm-lock.yaml"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
	".build",
	".next",
	"DerivedData",
	"SourcePackages",
	"build",
	"build-sim",
	"dist",
	"node_modules",
	"out",
	"playwright-report",
	"test-results",
]);
function splitNul(buffer) {
	return buffer
		.toString("utf8")
		.split("\0")
		.filter((value) => value.length > 0);
}

function runGitCapture(root, args) {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "buffer",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		throw new Error(`git ${args.join(" ")} failed with status ${result.status}`);
	}
	return splitNul(result.stdout);
}

function findRepositoryRoot() {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		throw new Error("check:staged must run inside a Git worktree");
	}
	return result.stdout.trim();
}

function normalizeRepositoryPath(root, candidate) {
	const normalized = relative(root, resolve(root, candidate));
	if (
		normalized.length === 0 ||
		normalized === ".." ||
		normalized.startsWith(`..${sep}`) ||
		isAbsolute(normalized)
	) {
		throw new Error(`Git returned a path outside the repository: ${candidate}`);
	}
	return normalized.split(sep).join("/");
}

function hasExcludedDirectory(path) {
	return path.split("/").some((part) => EXCLUDED_DIRECTORY_NAMES.has(part));
}

export function classifyPath(path) {
	const extension = extname(path).toLowerCase();
	const excludedDirectory = hasExcludedDirectory(path);
	const biome = !excludedDirectory && BIOME_EXTENSIONS.has(extension);
	const source = biome && SOURCE_EXTENSIONS.has(extension);
	const shell = !excludedDirectory && extension === ".sh";
	const docs = !excludedDirectory && DOC_EXTENSIONS.has(extension) && !DOC_EXCLUDED_PATHS.has(path);

	return { biome, docs, shell, source };
}

function classifyStagedPaths(paths) {
	const groups = {
		biome: [],
		docs: [],
		included: [],
		shell: [],
		source: [],
	};

	for (const path of paths) {
		const classification = classifyPath(path);
		let included = false;
		for (const group of ["biome", "docs", "shell", "source"]) {
			if (classification[group]) {
				groups[group].push(path);
				included = true;
			}
		}
		if (included) {
			groups.included.push(path);
		}
	}

	return groups;
}

function runCommand(root, command, args, extraEnv = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		env: { ...process.env, ...extraEnv },
		stdio: "inherit",
	});
	if (result.error) {
		if (result.error.code === "ENOENT") {
			console.error(
				`[check:staged] Required command \`${command}\` is unavailable. Run \`${SETUP_COMMAND}\` and retry.`,
			);
			return { started: false, status: 127 };
		}
		throw result.error;
	}
	return { started: true, status: result.status ?? 1 };
}

function requireTool(root, command, args, label) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "ignore",
	});
	if (!result.error && result.status === 0) {
		return true;
	}

	console.error(`[check:staged] ${label} is unavailable. Run \`${SETUP_COMMAND}\` and retry.`);
	return false;
}

function runFormatter(root, command, args, paths, extraEnv = {}) {
	const result = runCommand(root, command, args, extraEnv);
	if (!result.started) {
		return result.status;
	}

	const stageResult = runCommand(root, "git", ["add", "--force", "--", ...paths]);
	if (stageResult.status !== 0) {
		console.error(
			"[check:staged] Formatting ran, but its changes could not be staged. Stage the reported files and retry.",
		);
		return stageResult.status;
	}
	return result.status;
}

function firstFailure(...statuses) {
	return statuses.find((status) => status !== 0) ?? 0;
}

function runBiome(root, groups) {
	if (groups.biome.length === 0) {
		return 0;
	}

	const formatStatus = runFormatter(
		root,
		"pnpm",
		["exec", "biome", "check", "--write", "--no-errors-on-unmatched", "--", ...groups.biome],
		groups.biome,
	);
	const checkStatus = runCommand(root, "pnpm", [
		"exec",
		"biome",
		"check",
		"--no-errors-on-unmatched",
		"--",
		...groups.biome,
	]).status;
	const biomeStatus = firstFailure(formatStatus, checkStatus);
	if (biomeStatus !== 0) {
		return biomeStatus;
	}

	if (groups.source.length > 0) {
		return runCommand(root, "pnpm", ["typecheck"]).status;
	}
	return 0;
}

function runShell(root, paths) {
	if (paths.length === 0) {
		return 0;
	}

	const formatStatus = runFormatter(root, "shfmt", ["-w", "-i", "2", "-ci", "--", ...paths], paths);
	const lintStatus = runCommand(root, "shellcheck", ["--", ...paths]).status;
	return firstFailure(formatStatus, lintStatus);
}

function runDocs(root, paths) {
	if (paths.length === 0) {
		return 0;
	}

	const formatStatus = runFormatter(
		root,
		"pnpm",
		["exec", "prettier", "--write", "--ignore-path", ".prettierignore", "--", ...paths],
		paths,
	);
	const checkStatus = runCommand(root, "pnpm", [
		"exec",
		"prettier",
		"--check",
		"--ignore-path",
		".prettierignore",
		"--",
		...paths,
	]).status;
	return firstFailure(formatStatus, checkStatus);
}

export function main() {
	try {
		const root = findRepositoryRoot();
		const stagedPaths = runGitCapture(root, [
			"diff",
			"--cached",
			"--name-only",
			"-z",
			"--diff-filter=ACMR",
			"--",
		]).map((path) => normalizeRepositoryPath(root, path));
		const groups = classifyStagedPaths(stagedPaths);
		if (groups.included.length === 0) {
			return 0;
		}

		const unstagedPaths = new Set(
			runGitCapture(root, ["diff", "--name-only", "-z", "--"]).map((path) =>
				normalizeRepositoryPath(root, path),
			),
		);
		const partialPaths = groups.included.filter((path) => unstagedPaths.has(path)).sort();
		if (partialPaths.length > 0) {
			console.error("[check:staged] These included staged files also have unstaged changes:");
			for (const path of partialPaths) {
				console.error(`  ${path}`);
			}
			console.error(
				"Stage each complete file or separate the staged and unstaged work before committing. No formatter ran.",
			);
			return 1;
		}

		for (const [run, paths] of [
			[() => runBiome(root, groups), groups.biome],
			[() => runShell(root, groups.shell), groups.shell],
			[() => runDocs(root, groups.docs), groups.docs],
		]) {
			if (paths.length === 0) {
				continue;
			}
			const status = run();
			if (status !== 0) {
				return status;
			}
		}
		return 0;
	} catch (error) {
		console.error(`[check:staged] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main();
}
