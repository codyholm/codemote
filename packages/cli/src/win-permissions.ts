import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function formatExecFileError(error: unknown): string {
	if (error instanceof Error) {
		const code = "code" in error ? String((error as { code?: unknown }).code) : "";
		const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
		const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";

		const details = [
			code && code !== "undefined" ? `code=${code}` : "",
			stderr.trim().length > 0 ? `stderr=${stderr.trim()}` : "",
			stdout.trim().length > 0 ? `stdout=${stdout.trim()}` : "",
		]
			.filter(Boolean)
			.join(", ");
		return details ? `${error.message} (${details})` : error.message;
	}

	return String(error);
}

function resolveIcaclsFallbackPath(): string | undefined {
	const systemRoot = process.env["SystemRoot"]?.trim();
	if (!systemRoot) return undefined;
	return join(systemRoot, "System32", "icacls.exe");
}

async function runIcacls(args: string[]): Promise<void> {
	try {
		await execFileAsync("icacls", args);
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") {
			const fallbackPath = resolveIcaclsFallbackPath();
			if (fallbackPath) {
				await execFileAsync(fallbackPath, args);
				return;
			}
		}
		throw error;
	}
}

function resolveWindowsUsername(): string {
	const username = process.env["USERNAME"]?.trim();
	const userDomain = process.env["USERDOMAIN"]?.trim();
	const computerName = process.env["COMPUTERNAME"]?.trim();
	if (username && userDomain && userDomain !== computerName) {
		return `${userDomain}\\${username}`;
	}
	if (username) return username;
	return userInfo().username;
}

export async function restrictFilePermissions(filePath: string): Promise<void> {
	if (process.platform !== "win32") return;
	const username = resolveWindowsUsername();
	try {
		await runIcacls([filePath, "/inheritance:r", "/grant:r", `${username}:(R,W)`]);
	} catch (error) {
		throw new Error(
			`Failed to restrict file permissions for ${filePath} using icacls. Ensure icacls is available (usually %SystemRoot%\\System32\\icacls.exe). ${formatExecFileError(
				error,
			)}`,
		);
	}
}

export async function restrictDirPermissions(dirPath: string): Promise<void> {
	if (process.platform !== "win32") return;
	const username = resolveWindowsUsername();
	try {
		await runIcacls([dirPath, "/inheritance:r", "/grant:r", `${username}:(OI)(CI)(F)`]);
	} catch (error) {
		throw new Error(
			`Failed to restrict directory permissions for ${dirPath} using icacls. Ensure icacls is available (usually %SystemRoot%\\System32\\icacls.exe). ${formatExecFileError(
				error,
			)}`,
		);
	}
}
