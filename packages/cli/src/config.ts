import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CodemoteConfig } from "@codemote/common";

const CONFIG_DIR = join(homedir(), ".codemote");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const STATUS_DIR = join(CONFIG_DIR, "status");

/**
 * Load user-level config from ~/.codemote/config.json.
 * Returns empty config on missing or invalid file.
 */
export async function loadConfig(): Promise<CodemoteConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf-8");
		return JSON.parse(content) as CodemoteConfig;
	} catch {
		return {};
	}
}

/**
 * Save user-level config to ~/.codemote/config.json.
 */
export async function saveConfig(config: CodemoteConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Write an empty signal file to request a cache refresh from the running server.
 * Derives the signal directory from CODEMOTE_STATUS_FILE when set, so the
 * refresh targets the same directory the running server is watching.
 */
export async function runCacheRefresh(): Promise<void> {
	const statusFileOverride = process.env["CODEMOTE_STATUS_FILE"]?.trim();
	const signalDir = statusFileOverride ? dirname(statusFileOverride) : STATUS_DIR;
	const signalPath = join(signalDir, "refresh-requested");
	await mkdir(dirname(signalPath), { recursive: true });
	await writeFile(signalPath, "", "utf8");
	console.log("Cache refresh requested. The server will refresh on its next poll cycle.");
}

/**
 * Handle `codemote config <subcommand>` invocations.
 */
export async function runConfigSubcommand(args: string[]): Promise<void> {
	const action = args[0];

	if (!action || action === "list") {
		const config = await loadConfig();
		if (Object.keys(config).length === 0) {
			console.log(`No configuration set. Config file: ${CONFIG_PATH}`);
			return;
		}
		console.log(JSON.stringify(config, null, 2));
		return;
	}

	if (action === "get") {
		const key = args[1];
		if (!key) {
			console.error("Usage: codemote config get <key>");
			process.exitCode = 1;
			return;
		}
		const config = await loadConfig();
		const value = getNestedValue(config as Record<string, unknown>, key);
		if (value === undefined) {
			console.log("(not set)");
		} else {
			console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
		}
		return;
	}

	if (action === "set") {
		const key = args[1];
		const rawValue = args[2];
		if (!key || rawValue === undefined) {
			console.error("Usage: codemote config set <key> <value>");
			process.exitCode = 1;
			return;
		}
		const config = await loadConfig();
		setNestedValue(config as Record<string, unknown>, key, rawValue);
		await saveConfig(config);
		console.log(`Set ${key} = ${rawValue}`);
		return;
	}

	if (action === "path") {
		console.log(CONFIG_PATH);
		return;
	}

	console.error(`Unknown config action: ${action}. Use: list, get, set, path`);
	process.exitCode = 1;
}

/**
 * Read a dot-separated key path from a nested object.
 */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
	const keys = keyPath.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/**
 * Set a dot-separated key path on a nested object, creating intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, keyPath: string, rawValue: string): void {
	const keys = keyPath.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i] as string;
		if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	const lastKey = keys[keys.length - 1] as string;
	current[lastKey] = (() => {
		try {
			return JSON.parse(rawValue);
		} catch {
			return rawValue;
		}
	})();
}
