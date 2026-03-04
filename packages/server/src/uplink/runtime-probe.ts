import { exec } from "node:child_process";
import { platform } from "node:os";
import type { RuntimeType } from "@codemote/common";

const RUNTIME_CLI_NAMES: Record<RuntimeType, string> = {
	claude: "claude",
	opencode: "opencode",
	codex: "codex",
	gemini: "gemini",
};

export async function probeInstalledRuntimes(candidates: RuntimeType[]): Promise<RuntimeType[]> {
	const isWindows = platform() === "win32";
	const results = await Promise.all(
		candidates.map(async (runtime) => {
			const cliName = RUNTIME_CLI_NAMES[runtime];
			const cmd = isWindows ? `where.exe ${cliName}` : `command -v ${cliName}`;
			try {
				await new Promise<void>((resolve, reject) => {
					exec(cmd, { timeout: 2000 }, (error) => {
						if (error) reject(error);
						else resolve();
					});
				});
				return runtime;
			} catch {
				return null;
			}
		}),
	);
	return results.filter((r): r is RuntimeType => r !== null);
}
