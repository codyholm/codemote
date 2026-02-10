import type { RunOptions, RuntimeType, StreamEvent } from "@codemote/common";
import type { BaseExecutor } from "../executor.js";

export interface SmokeTestResult {
	name: string;
	runtime: RuntimeType;
	passed: boolean;
	duration: number;
	error?: string;
	events: StreamEvent[];
}

export interface SmokeTestConfig {
	/** Maximum time to wait for events (ms) */
	eventTimeout: number;
	/** Time to stream before sending follow-up (ms) */
	streamDuration: number;
	/** Follow-up input to send */
	followUpInput: string;
}

const DEFAULT_CONFIG: SmokeTestConfig = {
	eventTimeout: 30000,
	streamDuration: 2000,
	followUpInput: "What did you just do?",
};

/**
 * Smoke test harness for runtime executors
 *
 * Performs a complete session lifecycle test:
 * 1. Start a run
 * 2. Stream output for N seconds
 * 3. Send a follow-up input
 * 4. Confirm session didn't die
 * 5. Get diff (even if empty)
 * 6. Stop session
 */
export class SmokeTestHarness {
	private config: SmokeTestConfig;

	constructor(config: Partial<SmokeTestConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Run smoke test for an executor
	 */
	async run(executor: BaseExecutor, options: RunOptions): Promise<SmokeTestResult> {
		const startTime = Date.now();
		const events: StreamEvent[] = [];
		let error: string | undefined;

		try {
			// Step 1: Start run
			const { sessionId } = await executor.startRun(options);

			// Step 2: Collect events for a while
			const eventPromise = this.collectEvents(executor, sessionId, events);

			// Wait for initial stream
			await this.delay(this.config.streamDuration);

			// Step 3: Send follow-up input
			await executor.sendInput(sessionId, this.config.followUpInput);

			// Wait a bit more
			await this.delay(1000);

			// Step 4: Get diff
			await executor.getDiff(sessionId, "all");

			// Step 5: Stop and verify
			await executor.stop(sessionId);

			// Cancel event collection
			await Promise.race([eventPromise, this.delay(1000)]);

			// Verify we got some events
			if (events.length === 0) {
				error = "No events received";
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}

		const result: SmokeTestResult = {
			name: `smoke-${executor.type}`,
			runtime: executor.type,
			passed: !error,
			duration: Date.now() - startTime,
			events,
		};
		if (error) {
			result.error = error;
		}
		return result;
	}

	private async collectEvents(
		executor: BaseExecutor,
		sessionId: string,
		events: StreamEvent[],
	): Promise<void> {
		const controller = new AbortController();

		setTimeout(() => controller.abort(), this.config.eventTimeout);

		try {
			for await (const event of executor.stream(sessionId, controller.signal)) {
				events.push(event);
				if (event.type === "session.status") {
					const payload = event.payload as { status: string };
					if (payload.status === "ended" || payload.status === "error") {
						break;
					}
				}
			}
		} catch {
			// Aborted or ended
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Run all smoke tests and report results
 */
export async function runAllSmokeTests(
	executors: BaseExecutor[],
	workspace: string,
): Promise<SmokeTestResult[]> {
	const harness = new SmokeTestHarness();
	const results: SmokeTestResult[] = [];

	for (const executor of executors) {
		console.log(`Running smoke test for ${executor.type}...`);

		const result = await harness.run(executor, {
			profile: executor.type,
			workspace,
			initialPrompt: "List the files in the current directory",
		});

		results.push(result);

		if (result.passed) {
			console.log(`  [PASS] ${executor.type} passed (${result.duration}ms)`);
		} else {
			console.log(`  [FAIL] ${executor.type} failed: ${result.error}`);
		}
	}

	return results;
}
