import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./commands.js";

export interface EvidenceData {
	diff: string;
	commandResults: CommandResult[];
	timestamp: number;
}

/**
 * Stores evidence artifacts to filesystem
 */
export class EvidenceStorage {
	private basePath: string;

	constructor(basePath = ".guild/evidence") {
		this.basePath = basePath;
	}

	/**
	 * Store evidence for a run
	 */
	async store(runId: string, data: EvidenceData): Promise<string> {
		const dir = join(this.basePath, runId);
		await mkdir(dir, { recursive: true });

		// Write diff
		if (data.diff) {
			await writeFile(join(dir, "diff.patch"), data.diff);
		}

		// Write command results
		for (let i = 0; i < data.commandResults.length; i++) {
			const result = data.commandResults[i];
			if (!result) continue;
			const prefix = `cmd-${i + 1}`;

			await writeFile(
				join(dir, `${prefix}-output.txt`),
				[
					`Command: ${result.command}`,
					`Exit code: ${result.exitCode}`,
					`Duration: ${result.duration}ms`,
					`Success: ${result.success}`,
					"",
					"=== STDOUT ===",
					result.stdout,
					"",
					"=== STDERR ===",
					result.stderr,
				].join("\n"),
			);
		}

		// Write summary
		await writeFile(
			join(dir, "summary.json"),
			JSON.stringify(
				{
					runId,
					timestamp: data.timestamp,
					filesChanged: data.diff
						? data.diff.split("\n").filter((l) => l.startsWith("diff --git")).length
						: 0,
					commandsRun: data.commandResults.length,
					commandsPassed: data.commandResults.filter((r) => r.success).length,
				},
				null,
				2,
			),
		);

		return dir;
	}
}
