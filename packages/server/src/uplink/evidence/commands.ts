import { spawn } from "node:child_process";

export interface CommandResult {
	command: string;
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	duration: number;
}

export interface CommandOptions {
	maxOutput: number;
	timeout: number;
}

/**
 * Execute a command and capture output
 */
export function executeCommand(
	command: string,
	cwd: string,
	options: CommandOptions,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const startTime = Date.now();
		let stdout = "";
		let stderr = "";

		const proc = spawn(command, {
			cwd,
			shell: true,
			env: { ...process.env, CI: "true" },
		});

		const timeout = setTimeout(() => {
			proc.kill("SIGKILL");
		}, options.timeout);

		proc.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stdout.length < options.maxOutput) {
				stdout += chunk.slice(0, options.maxOutput - stdout.length);
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stderr.length < options.maxOutput) {
				stderr += chunk.slice(0, options.maxOutput - stderr.length);
			}
		});

		proc.on("exit", (code) => {
			clearTimeout(timeout);
			resolve({
				command,
				success: code === 0,
				exitCode: code ?? -1,
				stdout,
				stderr,
				duration: Date.now() - startTime,
			});
		});

		proc.on("error", (error) => {
			clearTimeout(timeout);
			resolve({
				command,
				success: false,
				exitCode: -1,
				stdout,
				stderr: error.message,
				duration: Date.now() - startTime,
			});
		});
	});
}
