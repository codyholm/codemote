import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UplinkConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const CONFIG_FILENAME = "uplink.json";

/**
 * Load configuration from file or use defaults
 */
export async function loadConfig(repoPath?: string): Promise<UplinkConfig> {
	const basePath = repoPath || process.cwd();
	const configPath = join(basePath, CONFIG_FILENAME);

	try {
		const content = await readFile(configPath, "utf-8");
		const fileConfig = JSON.parse(content) as Partial<UplinkConfig>;
		return { ...DEFAULT_CONFIG, ...fileConfig, repoPath: basePath };
	} catch {
		// Config file doesn't exist or is invalid, use defaults
		return { ...DEFAULT_CONFIG, repoPath: basePath };
	}
}

/**
 * Validate configuration
 */
export function validateConfig(config: UplinkConfig): string[] {
	const errors: string[] = [];

	if (config.port < 1 || config.port > 65535) {
		errors.push("Port must be between 1 and 65535");
	}

	if (!config.repoPath) {
		errors.push("Repository path is required");
	}

	if (config.runtimes.length === 0) {
		errors.push("At least one runtime must be configured");
	}

	return errors;
}
