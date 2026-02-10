import type { Session } from "../types.js";
import type { WorkspaceManager } from "../workspace.js";
import { type CommandResult, executeCommand } from "./commands.js";
import { EvidenceStorage } from "./storage.js";

export interface EvidenceConfig {
	/** Commands to run for evidence (e.g., npm test, npm run build) */
	testCommands: string[];
	/** Whether to capture screenshots */
	captureScreenshots: boolean;
	/** Maximum output size per command */
	maxOutputSize: number;
}

const DEFAULT_CONFIG: EvidenceConfig = {
	testCommands: [],
	captureScreenshots: false,
	maxOutputSize: 100000,
};

interface EvidenceArtifacts {
	summary: string;
	changes: string[];
	evidence: string[];
	decisions: string[];
}

/**
 * Collects evidence for a completed session
 */
export class EvidenceCollector {
	private config: EvidenceConfig;
	private storage: EvidenceStorage;
	private workspaceManager: WorkspaceManager;

	constructor(
		workspaceManager: WorkspaceManager,
		config: Partial<EvidenceConfig> = {},
		storage?: EvidenceStorage,
	) {
		this.workspaceManager = workspaceManager;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.storage = storage ?? new EvidenceStorage();
	}

	/**
	 * Collect evidence for a session
	 */
	async collect(session: Session): Promise<EvidenceArtifacts> {
		const results: CommandResult[] = [];
		const evidence: string[] = [];

		// Get git diff
		const diff = await this.workspaceManager.getDiff(session.workspace.id, "all");

		// Run test commands
		for (const cmd of this.config.testCommands) {
			const result = await executeCommand(cmd, session.workspace.workingDir, {
				maxOutput: this.config.maxOutputSize,
				timeout: 60000,
			});
			results.push(result);
			evidence.push(`${cmd}: ${result.success ? "PASSED" : "FAILED"}`);
		}

		// Store evidence
		await this.storage.store(session.runId, {
			diff,
			commandResults: results,
			timestamp: Date.now(),
		});

		// Build summary
		const summary = this.buildSummary(session, diff, results);

		return {
			summary,
			changes: this.extractChangedFiles(diff),
			evidence,
			decisions: [],
		};
	}

	private buildSummary(session: Session, diff: string, results: CommandResult[]): string {
		const lines = [
			`Session ${session.id} completed`,
			`Runtime: ${session.runtime}`,
			`Workspace: ${session.workspace.workingDir}`,
			`Duration: ${Date.now() - session.startedAt}ms`,
			"",
			`Files changed: ${this.extractChangedFiles(diff).length}`,
			`Tests run: ${results.length}`,
			`Tests passed: ${results.filter((r) => r.success).length}`,
		];

		return lines.join("\n");
	}

	private extractChangedFiles(diff: string): string[] {
		const files: string[] = [];
		const regex = /^diff --git a\/(.+) b\//gm;
		for (const match of diff.matchAll(regex)) {
			if (match[1]) files.push(match[1]);
		}
		return files;
	}
}
