import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UplinkServer } from "./server.js";

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		ws.once("open", resolve);
		ws.once("error", reject);
		setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
	});
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		ws.once("message", (data) => resolve(JSON.parse(data.toString())));
		setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);
	});
}

function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", (err) => {
			server.close(() => reject(err));
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Failed to reserve port")));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

async function startUplinkServer(): Promise<{ server: UplinkServer; port: number }> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const port = await reserveFreePort();
		const server = new UplinkServer({ port, host: "127.0.0.1", runtimes: [] });
		try {
			await server.start();
			return { server, port };
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
				continue;
			}
			throw error;
		}
	}

	throw new Error("Could not find a free port to start uplink server");
}

describe("UplinkServer list_directory", () => {
	let port = 0;
	let server: UplinkServer;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = join(tmpdir(), `listdir-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		// Create a git repo subdir
		mkdirSync(join(tempDir, "my-git-project"));
		execSync("git init", { cwd: join(tempDir, "my-git-project"), stdio: "ignore" });

		// Create a regular subdir
		mkdirSync(join(tempDir, "regular-dir"));

		// Create a hidden subdir (should be excluded)
		mkdirSync(join(tempDir, ".hidden-dir"));

		const started = await startUplinkServer();
		server = started.server;
		port = started.port;
	}, 30_000);

	afterAll(async () => {
		await server.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}, 30_000);

	it("lists directories with git detection, excludes hidden dirs, sorts git repos first", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "list_directory", payload: { path: tempDir } }));
			const msg = await msgPromise;

			expect(msg["type"]).toBe("directory_listing");
			const payload = msg["payload"] as {
				path: string;
				entries: Array<{ name: string; isDirectory: boolean; isGitRepo: boolean }>;
			};
			expect(payload.path).toBe(tempDir);

			// Hidden dir should be excluded
			const names = payload.entries.map((e) => e.name);
			expect(names).not.toContain(".hidden-dir");

			// Both visible dirs should be listed
			expect(names).toContain("my-git-project");
			expect(names).toContain("regular-dir");

			// Git repo should come first. The fixture controls the directories but the
			// server produces the array, so name an empty listing rather than let a
			// regression surface as an unrelated TypeError on a missing element.
			const [firstEntry] = payload.entries;
			if (!firstEntry) {
				throw new Error("directory listing returned no entries");
			}
			expect(firstEntry.name).toBe("my-git-project");
			expect(firstEntry.isGitRepo).toBe(true);
			expect(firstEntry.isDirectory).toBe(true);

			// Regular dir should not be a git repo
			const regularEntry = payload.entries.find((e) => e.name === "regular-dir");
			expect(regularEntry?.isGitRepo).toBe(false);
		} finally {
			ws.close();
		}
	});

	it("defaults to home directory when path omitted", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "list_directory", payload: {} }));
			const msg = await msgPromise;

			expect(msg["type"]).toBe("directory_listing");
			const payload = msg["payload"] as { path: string; entries: unknown[] };

			// Should resolve to process.cwd() (server WorkingDirectory)
			expect(payload.path).toBe(process.cwd());
			expect(Array.isArray(payload.entries)).toBe(true);
		} finally {
			ws.close();
		}
	});

	it("caps entries after sorting so git repositories are prioritized", async () => {
		const bigDir = join(tempDir, "many-projects");
		mkdirSync(bigDir, { recursive: true });

		for (let i = 0; i < 240; i += 1) {
			mkdirSync(join(bigDir, `project-${i.toString().padStart(3, "0")}`));
		}

		for (let i = 0; i < 5; i += 1) {
			const repoPath = join(bigDir, `z-git-${i.toString().padStart(2, "0")}`);
			mkdirSync(repoPath, { recursive: true });
			execSync("git init", { cwd: repoPath, stdio: "ignore" });
		}

		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(JSON.stringify({ type: "list_directory", payload: { path: bigDir } }));
			const msg = await msgPromise;
			expect(msg["type"]).toBe("directory_listing");

			const payload = msg["payload"] as {
				path: string;
				entries: Array<{ name: string; isDirectory: boolean; isGitRepo: boolean }>;
			};

			expect(payload.entries.length).toBe(200);
			expect(payload.entries.slice(0, 5).every((entry) => entry.isGitRepo)).toBe(true);

			const names = payload.entries.map((entry) => entry.name);
			expect(names).toContain("z-git-00");
			expect(names).toContain("z-git-04");
		} finally {
			ws.close();
		}
	});

	it("returns error for nonexistent path", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await waitForOpen(ws);
		try {
			const msgPromise = waitForMessage(ws);
			ws.send(
				JSON.stringify({
					type: "list_directory",
					payload: { path: "/nonexistent/path/that/does/not/exist" },
				}),
			);
			const msg = await msgPromise;

			expect(msg["type"]).toBe("error");
			const payload = msg["payload"] as { message: string; code: string };
			expect(payload.code).toBe("COMMAND_FAILED");
		} finally {
			ws.close();
		}
	});
});
