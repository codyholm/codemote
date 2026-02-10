import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./commands.js";

describe("evidence/commands", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "uplink-evidence-cmd-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("captures stdout and stderr", async () => {
		const result = await executeCommand(
			"node -e \"console.log('out'); console.error('err');\"",
			cwd,
			{ maxOutput: 10000, timeout: 5000 },
		);

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("out");
		expect(result.stderr).toContain("err");
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});

	it("marks non-zero exit codes as failure", async () => {
		const result = await executeCommand('node -e "process.exit(2)"', cwd, {
			maxOutput: 10000,
			timeout: 5000,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(2);
	});

	it("truncates output to maxOutput", async () => {
		const result = await executeCommand("node -e \"console.log('xxxxxxxxxxxxxxxxxxxx')\"", cwd, {
			maxOutput: 5,
			timeout: 5000,
		});

		expect(result.stdout.length).toBeLessThanOrEqual(5);
	});
});
