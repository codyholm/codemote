import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { type SpeechConfig, type SpeechServerHandle, createSpeechServer } from "@codemote/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig, ServerHandle } from "./server.js";
import { runSpeechSubcommand } from "./speech.js";

type StartServer = (config: ServerConfig) => Promise<ServerHandle>;

function makeWav(frames: number): Buffer {
	const payload = Buffer.alloc(frames * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + payload.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(24000, 24);
	header.writeUInt32LE(48000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(payload.length, 40);
	return Buffer.concat([header, payload]);
}

// Several of these start a real speech service and spawn stub binaries, which
// sits close to vitest's 5000ms default under a loaded full-suite run.
describe.skipIf(platform() === "win32")("codemote speech", { timeout: 30000 }, () => {
	let testDir: string;
	let discoveryFilePath: string;
	let servers: SpeechServerHandle[];
	let logs: string[];
	let errors: string[];
	let stubs: { kokoroBin: string; whisperBin: string; playerBin: string; modelDir: string };
	let suiteMachineStateDir: string | null = null;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let startServerImplementation: StartServer | null = null;

	async function writeStub(name: string, body: string): Promise<string> {
		const path = join(testDir, name);
		await writeFile(path, `#!/bin/bash\n${body}\n`);
		await chmod(path, 0o755);
		return path;
	}

	beforeAll(async () => {
		originalHome = process.env["HOME"];
		originalUserProfile = process.env["USERPROFILE"];
		suiteMachineStateDir = await mkdtemp(join(tmpdir(), "cli-speech-suite-"));
		process.env["HOME"] = suiteMachineStateDir;
		process.env["USERPROFILE"] = suiteMachineStateDir;
		({ startServer: startServerImplementation } = await import("./server.js"));
	});

	afterAll(async () => {
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env["HOME"] = originalHome;
		}
		if (originalUserProfile === undefined) {
			Reflect.deleteProperty(process.env, "USERPROFILE");
		} else {
			process.env["USERPROFILE"] = originalUserProfile;
		}
		if (suiteMachineStateDir) {
			await rm(suiteMachineStateDir, { recursive: true, force: true });
		}
	});

	beforeEach(async () => {
		servers = [];
		logs = [];
		errors = [];
		process.exitCode = undefined;
		testDir = await mkdtemp(join(tmpdir(), "cli-speech-test-"));
		discoveryFilePath = join(testDir, "speech.json");
		vi.stubEnv("CODEMOTE_SPEECH_DISCOVERY_FILE", discoveryFilePath);

		const modelDir = join(testDir, "models");
		await mkdir(modelDir, { recursive: true });
		await writeFile(join(modelDir, "kokoro-v1.0.onnx"), "model");
		await writeFile(join(modelDir, "voices-v1.0.bin"), "voices");
		const fixture = join(testDir, "fixture.wav");
		await writeFile(fixture, makeWav(2400));

		stubs = {
			modelDir,
			kokoroBin: await writeStub(
				"kokoro",
				`out=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-o) out="$2"; shift 2;;
		*) shift;;
	esac
done
cat > /dev/null
cp "${fixture}" "$out"
exit 0`,
			),
			whisperBin: await writeStub("whisper", "printf 'transcript\\n'\nexit 0"),
			playerBin: await writeStub("player", "exit 0"),
		};

		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		for (const server of servers) await server.stop().catch(() => undefined);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.exitCode = undefined;
		await rm(testDir, { recursive: true, force: true });
	});

	async function startService(overrides: Partial<SpeechConfig> = {}): Promise<SpeechServerHandle> {
		const server = createSpeechServer({
			host: "127.0.0.1",
			port: 0,
			discoveryFilePath,
			kokoroBin: stubs.kokoroBin,
			whisperBin: stubs.whisperBin,
			playerBin: stubs.playerBin,
			kokoroModelDir: stubs.modelDir,
			whisperModel: join(stubs.modelDir, "kokoro-v1.0.onnx"),
			...overrides,
		});
		servers.push(server);
		await server.start();
		return server;
	}

	describe("status", () => {
		it("reports not running when there is no endpoint file", async () => {
			await runSpeechSubcommand(["status"]);

			expect(errors.join("\n")).toContain("Speech service is not running.");
			expect(errors.join("\n")).toContain("codemote speech serve");
			expect(process.exitCode).toBe(1);
		});

		it("prints the endpoint, engine state and agent usage block", async () => {
			const server = await startService();

			await runSpeechSubcommand(["status"]);

			const output = logs.join("\n");
			expect(output).toContain(`Speech service: http://127.0.0.1:${server.port}`);
			expect(output).toContain("text to speech  available");
			expect(output).toContain("speech to text  available");
			expect(output).toContain(`cat ${discoveryFilePath}`);
			expect(output).toContain(`curl -sS -X POST http://127.0.0.1:${server.port}/speak`);
			expect(output).toContain(`curl -sS -X POST http://127.0.0.1:${server.port}/transcribe`);
			expect(process.exitCode).toBeUndefined();
		});

		it("names the unavailable engine and its reason", async () => {
			await startService({ kokoroBin: join(testDir, "absent-kokoro") });

			await runSpeechSubcommand(["status"]);

			const output = logs.join("\n");
			expect(output).toContain("text to speech  UNAVAILABLE");
			expect(output).toContain("absent-kokoro");
			expect(output).toContain("speech to text  available");
		});

		it("reports a stale endpoint file naming the recorded pid", async () => {
			const server = await startService();
			const port = server.port;
			await server.stop();
			// Leave an endpoint file pointing at the now-closed port, as a crash would.
			await writeFile(
				discoveryFilePath,
				JSON.stringify({
					url: `http://127.0.0.1:${port}`,
					port,
					pid: 999999,
					startedAt: new Date().toISOString(),
					engines: { tts: "available", stt: "available", playback: "available" },
				}),
			);

			await runSpeechSubcommand(["status"]);

			const output = errors.join("\n");
			expect(output).toContain("did not answer");
			expect(output).toContain("999999");
			expect(output).toContain("is stale");
			expect(process.exitCode).toBe(1);
		});
	});

	describe("say", () => {
		it("speaks through the HTTP service and reports the byte count", async () => {
			await startService();

			await runSpeechSubcommand(["say", "hello", "there"]);

			expect(logs.join("\n")).toContain("Spoke 4844 bytes (100 ms).");
			expect(process.exitCode).toBeUndefined();
		});

		it("surfaces the service's error code when an engine is missing", async () => {
			await startService({ kokoroBin: join(testDir, "absent-kokoro") });

			await runSpeechSubcommand(["say", "hello"]);

			const output = errors.join("\n");
			expect(output).toContain("engine_missing");
			expect(output).toContain("absent-kokoro");
			expect(process.exitCode).toBe(1);
		});

		it("reports not running when the service is not up", async () => {
			await runSpeechSubcommand(["say", "hello"]);

			expect(errors.join("\n")).toContain("Speech service is not running.");
			expect(process.exitCode).toBe(1);
		});

		it("requires text", async () => {
			await startService();

			await runSpeechSubcommand(["say"]);

			expect(errors.join("\n")).toContain('codemote speech say "<text>"');
			expect(process.exitCode).toBe(1);
		});
	});

	// These start a real relay + uplink + bridge, so they carry the same generous
	// timeout as server.test.ts.
	describe("combined process wiring", { timeout: 30000 }, () => {
		const relayPort = 18300;
		let handle: ServerHandle | null = null;
		let blocker: Server | null = null;

		async function startCombinedServer(port: number): Promise<ServerHandle> {
			if (!suiteMachineStateDir || !startServerImplementation) {
				throw new Error("Speech suite machine state is not initialized");
			}
			return startServerImplementation({
				port,
				repoPath: testDir,
				pairingStorePath: join(testDir, "trusted-pairings.json"),
				projectRegistryPath: join(testDir, "projects.json"),
				projectStartJournalPath: join(testDir, "project-start-operations.json"),
				managedWorktreeRoot: join(testDir, "managed-worktrees"),
				tlsDir: join(testDir, "tls"),
			});
		}

		afterEach(async () => {
			if (handle) {
				await handle.stop();
				handle = null;
			}
			if (blocker) {
				await new Promise<void>((resolve) => blocker?.close(() => resolve()));
				blocker = null;
			}
		});

		it("starts the speech service on the relay port plus two", async () => {
			handle = await startCombinedServer(relayPort);

			const discovery = JSON.parse(await readFile(discoveryFilePath, "utf8")) as {
				port: number;
				pid: number;
			};
			expect(discovery.port).toBe(relayPort + 2);
			expect(discovery.pid).toBe(process.pid);
			expect((await fetch(`http://127.0.0.1:${relayPort + 2}/health`)).status).toBe(200);
		});

		it("keeps the control plane running when the speech service cannot start", async () => {
			blocker = createServer();
			await new Promise<void>((resolve) => blocker?.listen(relayPort + 12, "127.0.0.1", resolve));

			handle = await startCombinedServer(relayPort + 10);

			expect(handle.pin).toMatch(/^\d{6}$/);
			expect(logs.join("\n")).toContain("[Server] Speech service unavailable:");
			expect(existsSync(discoveryFilePath)).toBe(false);
		});

		it("falls back to the relative port when CODEMOTE_SPEECH_PORT is unusable", async () => {
			// loadSpeechConfig discards an invalid value, so testing the raw variable
			// for presence would bind the standalone default (8082) instead.
			vi.stubEnv("CODEMOTE_SPEECH_PORT", "not-a-port");
			vi.spyOn(console, "warn").mockImplementation(() => undefined);

			handle = await startCombinedServer(relayPort + 30);

			const discovery = JSON.parse(await readFile(discoveryFilePath, "utf8")) as { port: number };
			expect(discovery.port).toBe(relayPort + 32);
		});

		it("skips the speech service entirely when CODEMOTE_SPEECH=0", async () => {
			vi.stubEnv("CODEMOTE_SPEECH", "0");

			handle = await startCombinedServer(relayPort + 20);

			expect(handle.pin).toMatch(/^\d{6}$/);
			expect(logs.join("\n")).not.toContain("Speech service");
			expect(existsSync(discoveryFilePath)).toBe(false);
		});
	});

	describe("dispatch", () => {
		it("prints usage and fails for an unknown action", async () => {
			await runSpeechSubcommand(["shout"]);

			const output = errors.join("\n");
			expect(output).toContain("Unknown speech action: shout");
			expect(output).toContain("codemote speech serve");
			expect(process.exitCode).toBe(1);
		});

		it("prints usage and fails when no action is given", async () => {
			await runSpeechSubcommand([]);

			expect(errors.join("\n")).toContain("codemote speech status");
			expect(process.exitCode).toBe(1);
		});
	});
});
