import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SpeechServerHandle, createSpeechServer } from "./server.js";
import type { SpeechConfig } from "./types.js";
import { parsePlayableWav } from "./wav.js";

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

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(platform() === "win32")("speech HTTP service", () => {
	let testDir: string;
	let discoveryFilePath: string;
	let kokoroBin: string;
	let whisperBin: string;
	let playerBin: string;
	let playedLog: string;
	let modelDir: string;
	let whisperModel: string;
	let servers: SpeechServerHandle[];

	async function writeStub(name: string, body: string): Promise<string> {
		const path = join(testDir, name);
		await writeFile(path, `#!/bin/bash\n${body}\n`);
		await chmod(path, 0o755);
		return path;
	}

	beforeEach(async () => {
		servers = [];
		testDir = await mkdtemp(join(tmpdir(), "speech-server-test-"));
		discoveryFilePath = join(testDir, "discovery", "speech.json");
		modelDir = join(testDir, "kokoro-models");
		await mkdir(modelDir, { recursive: true });
		await writeFile(join(modelDir, "kokoro-v1.0.onnx"), "model");
		await writeFile(join(modelDir, "voices-v1.0.bin"), "voices");
		whisperModel = join(testDir, "ggml-base.en.bin");
		await writeFile(whisperModel, "model");

		const fixture = join(testDir, "fixture.wav");
		await writeFile(fixture, makeWav(2400));
		kokoroBin = await writeStub(
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
		);
		whisperBin = await writeStub("whisper", "printf ' hello from whisper\\n'\nexit 0");
		playedLog = join(testDir, "played.log");
		playerBin = await writeStub("player", `printf '%s' "$1" > "${playedLog}"\nexit 0`);
	});

	afterEach(async () => {
		for (const server of servers) {
			await server.stop().catch(() => undefined);
		}
		await rm(testDir, { recursive: true, force: true });
	});

	async function startServer(overrides: Partial<SpeechConfig> = {}): Promise<SpeechServerHandle> {
		const server = createSpeechServer({
			host: "127.0.0.1",
			port: 0,
			kokoroBin,
			whisperBin,
			playerBin,
			kokoroModelDir: modelDir,
			whisperModel,
			discoveryFilePath,
			...overrides,
		});
		servers.push(server);
		await server.start();
		return server;
	}

	describe("GET /health", () => {
		it("reports the service and all three engines", async () => {
			const server = await startServer();

			const response = await fetch(`${server.url}/health`);

			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body).toMatchObject({ status: "ok", service: "speech" });
			expect(body["tts"]).toMatchObject({ available: true, path: kokoroBin });
			expect(body["stt"]).toMatchObject({ available: true, path: whisperBin });
			expect(body["playback"]).toMatchObject({ available: true, path: playerBin });
			expect(typeof body["version"]).toBe("string");
		});

		it("stays 200 while an engine is missing", async () => {
			const server = await startServer({ kokoroBin: join(testDir, "absent") });

			const response = await fetch(`${server.url}/health`);

			expect(response.status).toBe(200);
			const body = (await response.json()) as { tts: { available: boolean; reason?: string } };
			expect(body.tts.available).toBe(false);
			expect(body.tts.reason).toContain("absent");
		});

		it("sets the hardening headers", async () => {
			const server = await startServer();

			const response = await fetch(`${server.url}/health`);

			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("x-frame-options")).toBe("DENY");
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		});
	});

	describe("POST /speak", () => {
		async function speak(server: SpeechServerHandle, body: unknown): Promise<Response> {
			return await fetch(`${server.url}/speak`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		}

		it("returns validated WAV bytes and declares the format", async () => {
			const server = await startServer();

			const response = await speak(server, { text: "hello" });

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("audio/wav");
			expect(response.headers.get("x-speech-sample-rate")).toBe("24000");
			expect(response.headers.get("x-speech-channels")).toBe("1");
			expect(response.headers.get("x-speech-bits-per-sample")).toBe("16");
			expect(response.headers.get("x-speech-duration-ms")).toBe("100");
			const audio = Buffer.from(await response.arrayBuffer());
			expect(response.headers.get("content-length")).toBe(String(audio.length));
			expect(parsePlayableWav(audio).frames).toBe(2400);
		});

		it.each([
			["empty text", { text: "" }],
			["missing text", { voice: "af_heart" }],
			["out-of-range speed", { text: "hi", speed: 9 }],
			["malformed voice", { text: "hi", voice: "not a voice" }],
			["non-boolean play", { text: "hi", play: "yes" }],
			["array body", ["hi"]],
		])("rejects %s with 400 invalid_request", async (_label, body) => {
			const server = await startServer();

			const response = await speak(server, body);

			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: { code: string } };
			expect(payload.error.code).toBe("invalid_request");
		});

		it("returns 503 engine_missing when the binary cannot be resolved", async () => {
			const missing = join(testDir, "no-kokoro");
			const server = await startServer({ kokoroBin: missing });

			const response = await speak(server, { text: "hi" });

			expect(response.status).toBe(503);
			const payload = (await response.json()) as { error: { code: string; message: string } };
			expect(payload.error.code).toBe("engine_missing");
			expect(payload.error.message).toContain(missing);
		});

		it("plays through the platform player and answers with JSON", async () => {
			const server = await startServer();

			const response = await speak(server, { text: "hi", play: true });

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(await response.json()).toEqual({ played: true, bytes: 4844, durationMs: 100 });
			expect(await readFile(playedLog, "utf8")).toMatch(/\.wav$/);
		});

		it("rejects a body over the route limit with 413", async () => {
			const server = await startServer();

			const response = await speak(server, { text: "x".repeat(70 * 1024) });

			expect(response.status).toBe(413);
		});

		it("leaks neither a stack nor a repository path", async () => {
			const server = await startServer({
				kokoroBin: await writeStub("boom", "printf 'kaboom\\n' >&2\nexit 4"),
			});

			const response = await speak(server, { text: "hi" });

			expect(response.status).toBe(500);
			const raw = await response.text();
			expect(raw).toContain("engine_failed");
			expect(raw).toContain("kaboom");
			expect(raw).not.toContain("stack");
			expect(raw).not.toContain("packages/server");
			expect(raw).not.toContain(".ts:");
		});
	});

	describe("POST /transcribe", () => {
		it("accepts raw audio bytes and returns the transcript", async () => {
			const server = await startServer();

			const response = await fetch(`${server.url}/transcribe`, {
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(makeWav(2400)),
			});

			expect(response.status).toBe(200);
			const body = (await response.json()) as { text: string; durationMs: number };
			expect(body.text).toBe("hello from whisper");
			expect(body.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("honours the language query parameter", async () => {
			const argsLog = join(testDir, "whisper-args.log");
			const server = await startServer({
				whisperBin: await writeStub(
					"whisper-args",
					`printf '%s\\n' "$*" > "${argsLog}"\nprintf 'bonjour\\n'\nexit 0`,
				),
			});

			const response = await fetch(`${server.url}/transcribe?language=fr`, {
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(makeWav(10)),
			});

			expect(response.status).toBe(200);
			expect(await readFile(argsLog, "utf8")).toContain("-l fr");
		});

		it("rejects a malformed language with 400", async () => {
			const server = await startServer();

			const response = await fetch(`${server.url}/transcribe?language=francais`, {
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(makeWav(10)),
			});

			expect(response.status).toBe(400);
		});

		it("answers 400 unreadable_audio when whisper could not read the bytes", async () => {
			const server = await startServer({
				whisperBin: await writeStub(
					"whisper-unreadable",
					`printf "error: failed to read audio file 'in.wav'\\n" >&2\nexit 0`,
				),
			});

			const response = await fetch(`${server.url}/transcribe`, {
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(makeWav(2400)),
			});

			expect(response.status).toBe(400);
			const payload = (await response.json()) as {
				error: { code: string; message: string; detail: string };
			};
			expect(payload.error.code).toBe("unreadable_audio");
			expect(payload.error.message).toContain("wav, mp3, ogg and flac");
			expect(payload.error.detail).toContain("failed to read audio file");
		});

		it("answers 400 invalid_request when whisper does not know the language", async () => {
			// The language passes /^[a-z]{2}$/ but whisper knows only its own list,
			// and rejects the rest at exit 0. Blaming the audio would be wrong.
			const server = await startServer({
				whisperBin: await writeStub(
					"whisper-language",
					`printf "error: unknown language 'jp'\\n" >&2\nprintf ' fine recording\\n'\nexit 0`,
				),
			});

			const response = await fetch(`${server.url}/transcribe?language=jp`, {
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(makeWav(2400)),
			});

			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: { code: string; message: string } };
			expect(payload.error.code).toBe("invalid_request");
			expect(payload.error.message).toContain('"jp"');
			expect(payload.error.message).not.toContain("m4a");
		});

		it("rejects an unsupported content type with 415", async () => {
			const server = await startServer();

			const response = await fetch(`${server.url}/transcribe`, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "not audio",
			});

			expect(response.status).toBe(415);
		});
	});

	describe("concurrency gate", () => {
		it("answers 429 busy with Retry-After once saturated", async () => {
			const slow = await writeStub(
				"slow-kokoro",
				`out=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-o) out="$2"; shift 2;;
		*) shift;;
	esac
done
cat > /dev/null
sleep 1
cp "${join(testDir, "fixture.wav")}" "$out"
exit 0`,
			);
			const server = await startServer({ kokoroBin: slow, maxConcurrent: 1 });

			const [first, second] = await Promise.all([
				fetch(`${server.url}/speak`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: "one" }),
				}),
				fetch(`${server.url}/speak`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: "two" }),
				}),
			]);

			const statuses = [first.status, second.status].sort();
			expect(statuses).toEqual([200, 429]);
			const busy = first.status === 429 ? first : second;
			expect(busy.headers.get("retry-after")).toBe("1");
			const payload = (await busy.json()) as { error: { code: string } };
			expect(payload.error.code).toBe("busy");
			await (first.status === 429 ? second : first).arrayBuffer();
		});

		it("does not gate /health", async () => {
			const server = await startServer({ maxConcurrent: 1 });

			const responses = await Promise.all([
				fetch(`${server.url}/health`),
				fetch(`${server.url}/health`),
				fetch(`${server.url}/health`),
			]);

			expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
		});
	});

	describe("Host and Origin validation", () => {
		// Binding to loopback keeps other machines out. It does not keep out a
		// browser on this machine: a page whose DNS resolves to 127.0.0.1 is
		// same-origin, so CORS never applies. The Host header is what such a
		// request cannot hide.
		function rawRequest(
			port: number,
			path: string,
			headers: Record<string, string>,
		): Promise<{ status: number; body: string }> {
			return new Promise((resolve, reject) => {
				const req = httpRequest(
					{ host: "127.0.0.1", port, path, method: "GET", headers },
					(res) => {
						let body = "";
						res.on("data", (chunk: Buffer) => {
							body += chunk.toString();
						});
						res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
					},
				);
				req.on("error", reject);
				req.end();
			});
		}

		it("refuses a request whose Host header is a foreign name", async () => {
			const server = await startServer();

			const response = await rawRequest(server.port, "/health", {
				host: "attacker.example.com",
			});

			expect(response.status).toBe(403);
			const payload = JSON.parse(response.body) as { error: { code: string; message: string } };
			expect(payload.error.code).toBe("forbidden_host");
			expect(payload.error.message).toContain("attacker.example.com");
			expect(response.body).not.toContain("kokoro");
		});

		it("refuses a request carrying an Origin header", async () => {
			const server = await startServer();

			const response = await rawRequest(server.port, "/health", {
				host: `127.0.0.1:${server.port}`,
				origin: "http://attacker.example.com",
			});

			expect(response.status).toBe(403);
			expect(JSON.parse(response.body).error.code).toBe("forbidden_host");
		});

		it.each(["127.0.0.1", "localhost", "[::1]"])("accepts Host %s", async (host) => {
			const server = await startServer();

			const response = await rawRequest(server.port, "/health", {
				host: `${host}:${server.port}`,
			});

			expect(response.status).toBe(200);
			expect(JSON.parse(response.body).service).toBe("speech");
		});

		it("refuses a foreign Host on /speak too", async () => {
			const server = await startServer();

			const response = await new Promise<number>((resolve, reject) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: server.port,
						path: "/speak",
						method: "POST",
						headers: { host: "evil.test", "content-type": "application/json" },
					},
					(res) => resolve(res.statusCode ?? 0),
				);
				req.on("error", reject);
				req.end(JSON.stringify({ text: "hi" }));
			});

			expect(response).toBe(403);
		});
	});

	describe("routing and discovery", () => {
		it("answers 404 for an unknown route", async () => {
			const server = await startServer();
			expect((await fetch(`${server.url}/nope`)).status).toBe(404);
		});

		it("writes the discovery file on start and removes it on stop", async () => {
			const server = await startServer();

			const contents = JSON.parse(await readFile(discoveryFilePath, "utf8")) as {
				url: string;
				port: number;
				pid: number;
				startedAt: string;
				engines: Record<string, string>;
			};
			expect(contents.port).toBe(server.port);
			expect(contents.url).toBe(`http://127.0.0.1:${server.port}`);
			expect(contents.pid).toBe(process.pid);
			expect(Number.isNaN(Date.parse(contents.startedAt))).toBe(false);
			expect(contents.engines).toEqual({
				tts: "available",
				stt: "available",
				playback: "available",
			});
			expect((await stat(discoveryFilePath)).mode & 0o777).toBe(0o600);

			await server.stop();
			expect(await exists(discoveryFilePath)).toBe(false);
		});

		it("still starts when the discovery file cannot be written", async () => {
			// kokoroBin is a file, so mkdir() of its "directory" fails with ENOTDIR.
			const unwritable = join(kokoroBin, "speech.json");
			const server = await startServer({ discoveryFilePath: unwritable });

			expect((await fetch(`${server.url}/health`)).status).toBe(200);
			expect(await exists(unwritable)).toBe(false);
		});

		it("leaves the endpoint file alone when another instance has replaced it", async () => {
			// Two services sharing the path: the second one's record must survive
			// the first one's shutdown, or a listening service becomes invisible.
			const server = await startServer();
			const replacement = {
				url: "http://127.0.0.1:9999",
				port: 9999,
				pid: process.pid + 1,
				startedAt: new Date().toISOString(),
				engines: { tts: "available", stt: "available", playback: "available" },
			};
			await writeFile(discoveryFilePath, JSON.stringify(replacement));

			await server.stop();

			expect(JSON.parse(await readFile(discoveryFilePath, "utf8"))).toEqual(replacement);
		});

		it("leaves an unparseable endpoint file alone", async () => {
			const server = await startServer();
			await writeFile(discoveryFilePath, "not json");

			await server.stop();

			expect(await readFile(discoveryFilePath, "utf8")).toBe("not json");
		});

		it("does not delete a file at that path it did not write", async () => {
			const occupied = join(testDir, "not-ours.json");
			await writeFile(occupied, "keep me");
			await chmod(occupied, 0o400);
			const server = await startServer({ discoveryFilePath: occupied });

			expect((await fetch(`${server.url}/health`)).status).toBe(200);
			await server.stop();

			expect(await readFile(occupied, "utf8")).toBe("keep me");
		});
	});
});
