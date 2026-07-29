import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPath } from "./check-staged.mjs";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "check-staged.mjs");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function git(root, args) {
	const result = run("git", args, { cwd: root });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function write(root, path, contents) {
	const absolutePath = join(root, path);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, contents, "utf8");
}

function createFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "codemote-check-staged-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "quality-test@example.com"]);
	git(root, ["config", "user.name", "Quality Test"]);
	git(root, ["config", "commit.gpgsign", "false"]);

	const bin = join(root, "fake-bin");
	const log = join(root, "tool-log.jsonl");
	mkdirSync(bin);
	const fakeTool = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const log = process.env["CHECK_STAGED_TOOL_LOG"];
if (log) {
	appendFileSync(log, \`\${JSON.stringify({ args, tool })}\\n\`, "utf8");
}

if (tool === "pnpm" && args[0] === "format:exports") {
	const result = spawnSync(
		process.execPath,
		[process.env["CHECK_STAGED_FORMAT_EXPORTS_PATH"], ...args.slice(2)],
		{ stdio: "inherit" },
	);
	if (result.error) {
		throw result.error;
	}
	process.exit(result.status ?? 1);
}

const separator = args.lastIndexOf("--");
const paths = separator === -1 ? [] : args.slice(separator + 1);
const formats =
	(tool === "pnpm" && args.includes("--write")) ||
	(tool === "xcrun" && args.includes("format")) ||
	tool === "shfmt";
if (formats) {
	for (const path of paths) {
		writeFileSync(path, \`\${readFileSync(path, "utf8").trimEnd()}\\nformatted\\n\`, "utf8");
	}
}

const failureMatch = process.env["CHECK_STAGED_FAKE_FAIL_MATCH"];
if (failureMatch && \`\${tool} \${args.join(" ")}\`.includes(failureMatch)) {
	process.exit(9);
}
`;
	for (const tool of ["mint", "pnpm", "shellcheck", "shfmt", "xcrun"]) {
		const toolPath = join(bin, tool);
		writeFileSync(toolPath, fakeTool, "utf8");
		chmodSync(toolPath, 0o755);
	}

	const env = {
		...process.env,
		CHECK_STAGED_FORMAT_EXPORTS_PATH: resolve(dirname(scriptPath), "format-exports.mjs"),
		CHECK_STAGED_TOOL_LOG: log,
		PATH: `${bin}:${process.env["PATH"]}`,
	};
	return { env, log, root };
}

function createRealToolsFixture(t) {
	const fixture = createFixture(t);
	const repositoryRoot = resolve(dirname(scriptPath), "..");
	const realBinRoot = resolve(dirname(scriptPath), "..", "node_modules", ".bin");
	const pnpmPath = join(fixture.root, "fake-bin", "pnpm");
	const pnpmWrapper = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env["CHECK_STAGED_TOOL_LOG"];
if (log) {
	appendFileSync(log, \`\${JSON.stringify({ args, tool: "pnpm" })}\\n\`, "utf8");
}
if (args[0] === "format:exports") {
	const result = spawnSync(
		process.execPath,
		[process.env["CHECK_STAGED_FORMAT_EXPORTS_PATH"], ...args.slice(2)],
		{ stdio: "inherit" },
	);
	if (result.error) {
		throw result.error;
	}
	process.exit(result.status ?? 1);
}
if (args[0] === "typecheck") {
	process.exit(0);
}
if (args[0] !== "exec" || !args[1]) {
	process.exit(2);
}
const binary = join(process.env["CHECK_STAGED_REAL_BIN_ROOT"], args[1]);
const result = spawnSync(binary, args.slice(2), { stdio: "inherit" });
if (result.error) {
	throw result.error;
}
process.exit(result.status ?? 1);
`;
	writeFileSync(pnpmPath, pnpmWrapper, "utf8");
	chmodSync(pnpmPath, 0o755);
	for (const tool of ["mint", "shellcheck", "shfmt", "xcrun"]) {
		rmSync(join(fixture.root, "fake-bin", tool));
	}

	for (const config of [
		".prettierignore",
		".prettierrc.json",
		".swift-format",
		".swiftlint.yml",
		"biome.json",
	]) {
		copyFileSync(join(repositoryRoot, config), join(fixture.root, config));
	}
	fixture.env.CHECK_STAGED_FORMAT_EXPORTS_PATH = join(
		repositoryRoot,
		"scripts",
		"format-exports.mjs",
	);
	fixture.env.CHECK_STAGED_REAL_BIN_ROOT = realBinRoot;
	return fixture;
}

function runHook(fixture, extraEnv = {}) {
	return run(process.execPath, [scriptPath], {
		cwd: fixture.root,
		env: { ...fixture.env, ...extraEnv },
	});
}

function readLog(path) {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

describe("classifyPath", () => {
	test("assigns one formatter group and preserves Android exclusions", () => {
		assert.deepEqual(classifyPath("packages/server/src/app.ts"), {
			biome: true,
			docs: false,
			shell: false,
			source: true,
			swift: false,
		});
		assert.equal(classifyPath("packages/mobile-ios/Sources/App.swift").swift, true);
		assert.equal(classifyPath("scripts/release.sh").shell, true);
		assert.equal(classifyPath("docs/setup guide.md").docs, true);
		assert.equal(classifyPath("packages/mobile-android/gradlew.sh").shell, false);
		assert.equal(classifyPath("pnpm-lock.yaml").docs, false);
		assert.equal(classifyPath(".guild/ops/plans/.archive/old.md").docs, false);
	});
});

test("uses the Xcode 16-compatible multiline string configuration shape", () => {
	const repositoryRoot = resolve(dirname(scriptPath), "..");
	const configuration = JSON.parse(readFileSync(join(repositoryRoot, ".swift-format"), "utf8"));

	assert.deepEqual(configuration.reflowMultilineStringLiterals, { never: {} });
});

describe("check-staged", () => {
	test("exits without invoking tools when no included files are staged", (t) => {
		const fixture = createFixture(t);
		const result = runHook(fixture);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readLog(fixture.log), []);
	});

	test("formats and restages a staged path containing spaces", (t) => {
		const fixture = createFixture(t);
		write(fixture.root, ".git/info/exclude", "docs/\n");
		write(fixture.root, "docs/setup guide.md", "# Setup");
		git(fixture.root, ["add", "--force", "--", "docs/setup guide.md"]);

		const result = runHook(fixture);

		assert.equal(result.status, 0, result.stderr);
		assert.match(git(fixture.root, ["show", ":docs/setup guide.md"]), /formatted/);
		const prettierWrite = readLog(fixture.log).find(
			(entry) => entry.tool === "pnpm" && entry.args.includes("--write"),
		);
		assert.ok(prettierWrite);
		assert.equal(prettierWrite.args.at(-1), "docs/setup guide.md");
	});

	test("rejects partial staging before any formatter mutates the file or index", (t) => {
		const fixture = createFixture(t);
		write(fixture.root, "README.md", "baseline\n");
		git(fixture.root, ["add", "--", "README.md"]);
		git(fixture.root, ["commit", "-qm", "baseline"]);
		write(fixture.root, "README.md", "staged\n");
		git(fixture.root, ["add", "--", "README.md"]);
		write(fixture.root, "README.md", "unstaged\n");
		const stagedBefore = git(fixture.root, ["show", ":README.md"]);

		const result = runHook(fixture);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /README\.md/);
		assert.equal(git(fixture.root, ["show", ":README.md"]), stagedBefore);
		assert.equal(readFileSync(join(fixture.root, "README.md"), "utf8"), "unstaged\n");
		assert.deepEqual(readLog(fixture.log), []);
	});

	for (const worktreeState of ["deleted", "symlink"]) {
		test(`rejects a staged file ${worktreeState} in the worktree before running tools`, (t) => {
			const fixture = createFixture(t);
			write(fixture.root, "README.md", "baseline\n");
			git(fixture.root, ["add", "--", "README.md"]);
			git(fixture.root, ["commit", "-qm", "baseline"]);
			write(fixture.root, "README.md", "staged\n");
			git(fixture.root, ["add", "--", "README.md"]);
			const stagedBefore = git(fixture.root, ["show", ":README.md"]);
			rmSync(join(fixture.root, "README.md"));
			if (worktreeState === "symlink") {
				write(fixture.root, "replacement.md", "replacement\n");
				symlinkSync("replacement.md", join(fixture.root, "README.md"));
			}

			const result = runHook(fixture);

			assert.equal(result.status, 1);
			assert.match(result.stderr, /README\.md/);
			assert.equal(git(fixture.root, ["show", ":README.md"]), stagedBefore);
			assert.deepEqual(readLog(fixture.log), []);
		});
	}

	test("ignores deleted files and Android shell paths", (t) => {
		const fixture = createFixture(t);
		write(fixture.root, "docs/removed.md", "remove me\n");
		git(fixture.root, ["add", "--", "docs/removed.md"]);
		git(fixture.root, ["commit", "-qm", "baseline"]);
		rmSync(join(fixture.root, "docs/removed.md"));
		git(fixture.root, ["add", "--", "docs/removed.md"]);
		write(fixture.root, "packages/mobile-android/generated.sh", "#!/bin/sh\n");
		git(fixture.root, ["add", "--", "packages/mobile-android/generated.sh"]);

		const result = runHook(fixture);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readLog(fixture.log), []);
	});

	test("selects only the command groups required by staged extensions", (t) => {
		const fixture = createFixture(t);
		for (const [path, contents] of [
			["packages/server/src/app.ts", "export const value=1\n"],
			[".guild/exports/example/manifest.json", '{"name":"example"}\n'],
			["packages/mobile-ios/Sources/App.swift", "let value=1\n"],
			["scripts/release.sh", "#!/bin/sh\necho ok\n"],
			["docs/config.yml", "enabled:true\n"],
		]) {
			write(fixture.root, path, contents);
			git(fixture.root, ["add", "--force", "--", path]);
		}

		const result = runHook(fixture);

		assert.equal(result.status, 0, result.stderr);
		const commands = readLog(fixture.log).map(
			(entry) => `${basename(entry.tool)} ${entry.args.join(" ")}`,
		);
		assert.ok(
			commands.some(
				(command) => command === "pnpm format:exports -- .guild/exports/example/manifest.json",
			),
		);
		assert.ok(commands.some((command) => command.startsWith("pnpm exec biome check --write")));
		assert.ok(commands.some((command) => command === "pnpm typecheck"));
		assert.ok(commands.some((command) => command.startsWith("xcrun swift-format format")));
		assert.ok(commands.some((command) => command.startsWith("mint run swiftlint")));
		assert.ok(commands.some((command) => command.startsWith("shfmt -w")));
		assert.ok(commands.some((command) => command.startsWith("shellcheck --")));
		assert.ok(commands.some((command) => command.startsWith("pnpm exec prettier --write")));
	});

	test("does not run the export formatter for an unrelated unstaged manifest", (t) => {
		const fixture = createFixture(t);
		const manifestPath = ".guild/exports/example/manifest.json";
		write(fixture.root, manifestPath, '{"name":"baseline"}\n');
		git(fixture.root, ["add", "--force", "--", manifestPath]);
		git(fixture.root, ["commit", "-qm", "baseline"]);
		write(fixture.root, manifestPath, '{"name":"unrelated work"}\n');
		write(fixture.root, "packages/server/src/fixture.jsx", "export const value=1\n");
		git(fixture.root, ["add", "--", "packages/server/src/fixture.jsx"]);

		const result = runHook(fixture);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(join(fixture.root, manifestPath), "utf8"),
			'{"name":"unrelated work"}\n',
		);
		assert.equal(
			git(fixture.root, ["diff", "--cached", "--name-only"]).trim(),
			"packages/server/src/fixture.jsx",
		);
		assert.equal(
			readLog(fixture.log).some(
				(entry) => entry.tool === "pnpm" && entry.args[0] === "format:exports",
			),
			false,
		);
	});

	test("rejects a staged export-manifest symlink without modifying its target", (t) => {
		const fixture = createFixture(t);
		const externalRoot = mkdtempSync(join(tmpdir(), "codemote-export-target-"));
		t.after(() => rmSync(externalRoot, { force: true, recursive: true }));
		const externalPath = join(externalRoot, "manifest.json");
		const originalContents = '{"name":"outside"}\n';
		writeFileSync(externalPath, originalContents, "utf8");
		const manifestPath = ".guild/exports/example/manifest.json";
		mkdirSync(dirname(join(fixture.root, manifestPath)), { recursive: true });
		symlinkSync(externalPath, join(fixture.root, manifestPath));
		git(fixture.root, ["add", "--force", "--", manifestPath]);

		const result = runHook(fixture);

		assert.notEqual(result.status, 0);
		assert.match(result.stdout + result.stderr, /regular non-symlink file/);
		assert.equal(readFileSync(externalPath, "utf8"), originalContents);
	});

	test("restages formatter output while preserving its nonzero status", (t) => {
		const fixture = createFixture(t);
		write(fixture.root, "README.md", "# Setup");
		git(fixture.root, ["add", "--", "README.md"]);

		const result = runHook(fixture, {
			CHECK_STAGED_FAKE_FAIL_MATCH: "prettier --write",
		});

		assert.equal(result.status, 9);
		assert.match(git(fixture.root, ["show", ":README.md"]), /formatted/);
	});

	test("does not let Mint install SwiftLint from inside the hook", (t) => {
		const fixture = createFixture(t);
		write(fixture.root, "packages/mobile-ios/Sources/App.swift", "let value=1\n");
		git(fixture.root, ["add", "--", "packages/mobile-ios/Sources/App.swift"]);

		const result = runHook(fixture, {
			CHECK_STAGED_FAKE_FAIL_MATCH: "mint which swiftlint",
		});

		assert.equal(result.status, 127);
		assert.match(result.stderr, /pnpm setup:quality/);
		const mintCommands = readLog(fixture.log)
			.filter((entry) => entry.tool === "mint")
			.map((entry) => entry.args);
		assert.deepEqual(mintCommands, [["which", "swiftlint"]]);
	});

	test(
		"real tools format and restage every included group idempotently",
		{ skip: process.env["CHECK_STAGED_REAL_TOOLS"] !== "1" },
		(t) => {
			const fixture = createRealToolsFixture(t);
			write(fixture.root, "unrelated.txt", "baseline\n");
			git(fixture.root, ["add", "--", "unrelated.txt"]);
			git(fixture.root, ["commit", "-qm", "baseline"]);
			write(fixture.root, "unrelated.txt", "unfinished\n");

			const files = new Map([
				["packages/server/src/fixture.ts", "export const fixture={answer:1}\n"],
				[".guild/exports/example/manifest.json", '{"name":"fixture"}\n'],
				["packages/mobile-ios/Sources/Fixture.swift", "struct Fixture{let value:Int}\n"],
				["scripts/fixture.sh", "#!/bin/sh\nif true;then echo ok;fi\n"],
				["docs/fixture.md", "#   Fixture\n"],
				["docs/fixture.yml", "enabled:    true\n"],
			]);
			for (const [path, contents] of files) {
				write(fixture.root, path, contents);
				git(fixture.root, ["add", "--force", "--", path]);
			}

			const firstResult = runHook(fixture);

			assert.equal(firstResult.status, 0, firstResult.stderr);
			for (const [path, original] of files) {
				assert.notEqual(git(fixture.root, ["show", `:${path}`]), original);
			}
			assert.equal(readFileSync(join(fixture.root, "unrelated.txt"), "utf8"), "unfinished\n");
			assert.deepEqual(
				git(fixture.root, ["diff", "--cached", "--name-only"]).trim().split("\n").sort(),
				[...files.keys()].sort(),
			);

			const stagedDiff = git(fixture.root, ["diff", "--cached", "--binary"]);
			const secondResult = runHook(fixture);

			assert.equal(secondResult.status, 0, secondResult.stderr);
			assert.equal(git(fixture.root, ["diff", "--cached", "--binary"]), stagedDiff);
		},
	);

	test(
		"real ShellCheck findings reject after shfmt output is restaged",
		{ skip: process.env["CHECK_STAGED_REAL_TOOLS"] !== "1" },
		(t) => {
			const fixture = createRealToolsFixture(t);
			write(fixture.root, "scripts/failing.sh", "#!/bin/sh\nvalue=$1\necho $value\n");
			git(fixture.root, ["add", "--", "scripts/failing.sh"]);

			const result = runHook(fixture);

			assert.notEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /SC2086/);
			assert.match(git(fixture.root, ["show", ":scripts/failing.sh"]), /echo \$value/);
		},
	);
});
