import type { RunOptions, RuntimeType } from "@codemote/common";
import { BaseExecutor } from "./executor.js";
import type { Session } from "./types.js";

/**
 * Mock executor for testing the framework
 */
export class MockExecutor extends BaseExecutor {
	readonly type: RuntimeType = "opencode";

	private activeProcesses = new Map<string, NodeJS.Timeout>();

	protected async doStartRun(session: Session, options: RunOptions): Promise<void> {
		// Simulate startup delay
		await this.delay(100);

		// Start simulated output
		this.startSimulation(session.id, options.initialPrompt);
	}

	protected async doSendInput(session: Session, input: string): Promise<void> {
		this.emitOutput(session.id, `\n> Received input: ${input}\n`);
		await this.delay(50);
		this.emitOutput(session.id, `Processing: "${input}"...\n`);
	}

	protected async doStop(session: Session): Promise<void> {
		const timeout = this.activeProcesses.get(session.id);
		if (timeout) {
			clearTimeout(timeout);
			this.activeProcesses.delete(session.id);
		}
	}

	private startSimulation(sessionId: string, prompt: string): void {
		const messages = [
			`Starting mock execution for: "${prompt}"`,
			"Analyzing request...",
			"Reading relevant files...",
			"Planning changes...",
			"Implementing solution...",
			"Running tests...",
			"All checks passed!",
		];

		let index = 0;
		const emit = () => {
			if (index < messages.length) {
				this.emitOutput(sessionId, `${messages[index]}\n`);
				index++;
				const timeout = setTimeout(emit, 200 + Math.random() * 300);
				this.activeProcesses.set(sessionId, timeout);
			} else {
				this.activeProcesses.delete(sessionId);
				this.emitStatus(sessionId, "idle");
				this.emitDiffUpdated(sessionId);
			}
		};

		emit();
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
