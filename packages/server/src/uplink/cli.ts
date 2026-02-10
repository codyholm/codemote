#!/usr/bin/env node

import { loadConfig, validateConfig } from "./config.js";
import type { BaseExecutor } from "./executor.js";
import { UplinkServer } from "./server.js";

async function main(): Promise<void> {
	// Handle --smoke flag for smoke tests
	if (process.argv.includes("--smoke")) {
		console.log("Uplink - Smoke Test Runner");
		console.log("==========================\n");

		const config = await loadConfig();

		// Create minimal setup for smoke tests
		const { spawnSync } = await import("node:child_process");
		const { WorkspaceManager } = await import("./workspace.js");
		const { SessionManager } = await import("./session.js");
		const { EventBus } = await import("./events.js");
		const { MockExecutor } = await import("./mock-executor.js");
		const { OpenCodeExecutor, ClaudeExecutor, CodexExecutor } = await import(
			"./executors/index.js"
		);
		const { runAllSmokeTests } = await import("./smoke/index.js");

		const workspaceManager = new WorkspaceManager(config.repoPath);
		const sessionManager = new SessionManager();
		const eventBus = new EventBus();

		const executors: BaseExecutor[] = [
			new MockExecutor(workspaceManager, sessionManager, eventBus),
		];

		const canSpawn = (cmd: string): boolean => {
			const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
			if (result.error) return false;
			return result.status === 0 || result.status === 1;
		};

		const canReach = async (url: string): Promise<boolean> => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 1000);
			try {
				await fetch(url, { method: "GET", signal: controller.signal });
				return true;
			} catch {
				return false;
			} finally {
				clearTimeout(timeout);
			}
		};

		if (
			config.runtimes.includes("opencode") &&
			(config.runtimeConfigs?.opencode || process.env["OPENCODE_SERVER_URL"])
		) {
			const serverUrl =
				process.env["OPENCODE_SERVER_URL"] ||
				config.runtimeConfigs?.opencode?.serverUrl ||
				"http://127.0.0.1:4096";
			if (await canReach(serverUrl)) {
				executors.push(
					new OpenCodeExecutor(workspaceManager, sessionManager, eventBus, {
						...config.runtimeConfigs?.opencode,
						serverUrl,
					}),
				);
			} else {
				console.log(`[SKIP] opencode (server unreachable at ${serverUrl})`);
			}
		}

		if (
			config.runtimes.includes("claude") &&
			(config.runtimeConfigs?.claude || process.env["CLAUDE_PATH"])
		) {
			const claudePath =
				process.env["CLAUDE_PATH"] || config.runtimeConfigs?.claude?.claudePath || "claude";
			if (canSpawn(claudePath)) {
				executors.push(
					new ClaudeExecutor(workspaceManager, sessionManager, eventBus, {
						...config.runtimeConfigs?.claude,
						claudePath,
					}),
				);
			} else {
				console.log(`[SKIP] claude (binary not runnable: ${claudePath})`);
			}
		}

		if (config.runtimes.includes("codex") && process.env["CODEX_API_KEY"]) {
			const codexPath =
				process.env["CODEX_PATH"] || config.runtimeConfigs?.codex?.codexPath || "codex";
			if (canSpawn(codexPath)) {
				executors.push(
					new CodexExecutor(workspaceManager, sessionManager, eventBus, {
						...config.runtimeConfigs?.codex,
						codexPath,
					}),
				);
			} else {
				console.log(`[SKIP] codex (binary not runnable: ${codexPath})`);
			}
		}

		console.log("Running smoke tests...\n");
		const results = await runAllSmokeTests(executors, config.repoPath);

		const passed = results.filter((r) => r.passed).length;
		const failed = results.filter((r) => !r.passed).length;

		console.log(`\nResults: ${passed} passed, ${failed} failed`);
		process.exit(failed > 0 ? 1 : 0);
	}

	console.log("Uplink - Codemote Companion Service");
	console.log("========================================\n");

	const config = await loadConfig();
	const errors = validateConfig(config);

	if (errors.length > 0) {
		console.error("Configuration errors:");
		for (const error of errors) {
			console.error(`  - ${error}`);
		}
		process.exit(1);
	}

	const server = new UplinkServer(config);

	// Handle shutdown
	const shutdown = async () => {
		console.log("\nShutting down...");
		await server.stop();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await server.start();
	console.log(`\nReady. Configured runtimes: ${config.runtimes.join(", ")}`);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
