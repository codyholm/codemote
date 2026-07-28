import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechEngines } from "./engine.js";
import { DEFAULT_SPEECH_CONFIG, type SpeechConfig, type SpeechErrorCode } from "./types.js";
import { SpeechError } from "./types.js";

function makeWav(frames: number): Buffer {
	const bytesPerFrame = 2;
	const payload = Buffer.alloc(frames * bytesPerFrame);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + payload.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(24000, 24);
	header.writeUInt32LE(24000 * bytesPerFrame, 28);
	header.writeUInt16LE(bytesPerFrame, 32);
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

async function expectSpeechError(
	promise: Promise<unknown>,
	code: SpeechErrorCode,
): Promise<SpeechError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(SpeechError);
		const speechError = error as SpeechError;
		expect(speechError.code).toBe(code);
		return speechError;
	}
	throw new Error(`expected a SpeechError with code ${code}`);
}

describe.skipIf(platform() === "win32")("SpeechEngines", { timeout: 20000 }, () => {
	let testDir: string;
	let modelDir: string;
	let whisperModel: string;
	let argsLog: string;
	let stdinLog: string;
	let fixtureWav: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "speech-engine-test-"));
		modelDir = join(testDir, "kokoro-models");
		await mkdir(modelDir, { recursive: true });
		await writeFile(join(modelDir, "kokoro-v1.0.onnx"), "model");
		await writeFile(join(modelDir, "voices-v1.0.bin"), "voices");
		whisperModel = join(testDir, "ggml-base.en.bin");
		await writeFile(whisperModel, "model");
		argsLog = join(testDir, "args.log");
		stdinLog = join(testDir, "stdin.log");
		fixtureWav = join(testDir, "fixture.wav");
		await writeFile(fixtureWav, makeWav(2400));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	async function writeStub(name: string, body: string): Promise<string> {
		const path = join(testDir, name);
		await writeFile(path, `#!/bin/bash\n${body}\n`);
		await chmod(path, 0o755);
		return path;
	}

	/** Records argv and stdin, then copies `payload` to the `-o` path. */
	function kokoroStub(payload: string): string {
		return `printf '%s\\n' "$*" >> "${argsLog}"
cat > "${stdinLog}"
out=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-o) out="$2"; shift 2;;
		*) shift;;
	esac
done
cp "${payload}" "$out"
exit 0`;
	}

	function config(overrides: Partial<SpeechConfig>): SpeechConfig {
		return {
			...DEFAULT_SPEECH_CONFIG,
			kokoroModelDir: modelDir,
			whisperModel,
			discoveryFilePath: join(testDir, "speech.json"),
			...overrides,
		};
	}

	describe("synthesize", () => {
		it("passes text over stdin and never over argv", async () => {
			const kokoroBin = await writeStub("kokoro", kokoroStub(fixtureWav));
			const engines = new SpeechEngines(config({ kokoroBin }));

			const result = await engines.synthesize({ text: "Hello from Codemote", voice: "af_heart" });

			expect(result.info.sampleRate).toBe(24000);
			expect(result.info.channels).toBe(1);
			expect(result.info.frames).toBe(2400);
			expect(await readFile(stdinLog, "utf8")).toBe("Hello from Codemote");
			const argv = await readFile(argsLog, "utf8");
			expect(argv).not.toContain("Hello from Codemote");
			expect(argv).toContain("--stdin");
			expect(argv).toContain("-v af_heart");
		});

		it("does not let option-shaped text reach argv", async () => {
			const kokoroBin = await writeStub("kokoro", kokoroStub(fixtureWav));
			const engines = new SpeechEngines(config({ kokoroBin }));

			await engines.synthesize({ text: "-v evil --speed 9" });

			expect(await readFile(stdinLog, "utf8")).toBe("-v evil --speed 9");
			const argv = await readFile(argsLog, "utf8");
			expect(argv).not.toContain("evil");
			expect(argv).not.toContain("--speed");
		});

		it("rejects a zero exit that wrote no output file", async () => {
			const kokoroBin = await writeStub("kokoro", "exit 0");
			const engines = new SpeechEngines(config({ kokoroBin }));

			const error = await expectSpeechError(engines.synthesize({ text: "hello" }), "empty_output");
			expect(error.message).toBe("engine reported success but wrote no output file");
		});

		it("rejects a zero exit that wrote a headerless file", async () => {
			const kokoroBin = await writeStub(
				"kokoro",
				`out=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-o) out="$2"; shift 2;;
		*) shift;;
	esac
done
printf 'xxxxxxxxxx' > "$out"
exit 0`,
			);
			const engines = new SpeechEngines(config({ kokoroBin }));

			const error = await expectSpeechError(engines.synthesize({ text: "hello" }), "empty_output");
			expect(error.message).toContain("too short to be a WAV");
		});

		it("rejects a zero exit that wrote a WAV with no frames", async () => {
			const emptyWav = join(testDir, "empty.wav");
			await writeFile(emptyWav, makeWav(0));
			const kokoroBin = await writeStub("kokoro", kokoroStub(emptyWav));
			const engines = new SpeechEngines(config({ kokoroBin }));

			const error = await expectSpeechError(engines.synthesize({ text: "hello" }), "empty_output");
			expect(error.message).toBe("WAV data chunk is empty");
		});

		it("reports a non-zero exit as engine_failed with the engine's error line", async () => {
			const kokoroBin = await writeStub(
				"kokoro",
				`printf 'chatter about voices\\n' >&2
printf 'Error: Empty text provided.\\n' >&2
exit 1`,
			);
			const engines = new SpeechEngines(config({ kokoroBin }));

			const error = await expectSpeechError(engines.synthesize({ text: "hello" }), "engine_failed");
			expect(error.message).toContain("exited with code 1");
			expect(error.detail).toContain("Empty text provided.");
			expect(error.detail).not.toContain("chatter about voices");
			expect(error.detail).not.toContain("engine.ts");
			expect(error.detail).not.toContain("    at ");
		});

		it("kills a child that exceeds its deadline", async () => {
			const marker = join(testDir, "finished");
			const kokoroBin = await writeStub("kokoro", `sleep 5\ntouch "${marker}"\nexit 0`);
			const engines = new SpeechEngines(config({ kokoroBin, synthesizeTimeoutMs: 300 }));

			const error = await expectSpeechError(
				engines.synthesize({ text: "hello" }),
				"engine_timeout",
			);
			expect(error.message).toContain("300ms");
			await new Promise((resolve) => setTimeout(resolve, 800));
			expect(await exists(marker)).toBe(false);
		});

		it("kills the whole process tree, not just the wrapper it spawned", async () => {
			// A configured engine path is often a wrapper script. Killing only the
			// wrapper reports a kill that did not happen and leaves the real work
			// running while the concurrency slot is released.
			const grandchildPid = join(testDir, "grandchild.pid");
			const kokoroBin = await writeStub(
				"wrapper",
				`sleep 300 &
printf '%s' "$!" > "${grandchildPid}"
wait`,
			);
			// Generous deadline on purpose: the wrapper has to actually start and
			// record its grandchild before the kill, or the test proves nothing.
			const engines = new SpeechEngines(config({ kokoroBin, synthesizeTimeoutMs: 2000 }));

			await expectSpeechError(engines.synthesize({ text: "hello" }), "engine_timeout");

			expect(await exists(grandchildPid)).toBe(true);
			const pid = Number(await readFile(grandchildPid, "utf8"));
			expect(Number.isInteger(pid)).toBe(true);
			let alive = true;
			for (let i = 0; i < 30 && alive; i++) {
				try {
					process.kill(pid, 0);
					await new Promise((resolve) => setTimeout(resolve, 100));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		});

		it("does not settle until a child that ignores SIGTERM is actually dead", async () => {
			// Settling at SIGTERM would release the concurrency slot while the
			// process is still running, and tell the caller it "was killed" first.
			// A single `sleep 300` would not do: the group SIGTERM kills the sleep
			// even though bash ignores it, and the script would exit immediately.
			const kokoroBin = await writeStub(
				"stubborn",
				"trap '' TERM\nfor _ in $(seq 1 300); do sleep 1; done",
			);
			// Deliberately long deadline: the stub must have started and armed its
			// trap before the SIGTERM lands, or the test proves nothing. A loaded
			// full-suite run was observed taking over 2s to get there.
			const engines = new SpeechEngines(config({ kokoroBin, synthesizeTimeoutMs: 4000 }));

			const startedAt = Date.now();
			const error = await expectSpeechError(
				engines.synthesize({ text: "hello" }),
				"engine_timeout",
			);
			const elapsed = Date.now() - startedAt;

			// SIGTERM at 4s is ignored; SIGKILL follows 2s after that.
			expect(elapsed).toBeGreaterThanOrEqual(5900);
			expect(error.message).toContain("4000ms");
			expect(error.message).toContain("was killed");
		});

		it("names the configured path when the binary is missing", async () => {
			const kokoroBin = join(testDir, "nope", "kokoro-tts-tool");
			const engines = new SpeechEngines(config({ kokoroBin }));

			const error = await expectSpeechError(
				engines.synthesize({ text: "hello" }),
				"engine_missing",
			);
			expect(error.message).toContain(kokoroBin);
			expect(error.message).toContain("CODEMOTE_KOKORO_BIN");
		});

		it("detects a missing model before spawning the engine", async () => {
			const kokoroBin = await writeStub("kokoro", kokoroStub(fixtureWav));
			const engines = new SpeechEngines(
				config({ kokoroBin, kokoroModelDir: join(testDir, "gone") }),
			);

			const error = await expectSpeechError(engines.synthesize({ text: "hello" }), "model_missing");
			expect(error.message).toContain("kokoro-v1.0.onnx");
			expect(await exists(argsLog)).toBe(false);
		});

		it.each([
			["empty text", { text: "" }],
			["whitespace text", { text: "   " }],
			["over-long text", { text: "a".repeat(2001) }],
			["spaced voice", { text: "hi", voice: "af heart" }],
			["shell-shaped voice", { text: "hi", voice: "$(id)" }],
			["slow speed", { text: "hi", speed: 0.1 }],
			["fast speed", { text: "hi", speed: 5 }],
			["NaN speed", { text: "hi", speed: Number.NaN }],
		])("rejects %s without spawning", async (_label, options) => {
			const kokoroBin = await writeStub("kokoro", kokoroStub(fixtureWav));
			const engines = new SpeechEngines(config({ kokoroBin }));

			await expectSpeechError(engines.synthesize(options), "invalid_request");
			expect(await exists(argsLog)).toBe(false);
		});
	});

	describe("transcribe", () => {
		/** Records the `-f` path it was handed, then runs `body`. */
		function whisperStub(inputPathLog: string, body: string): string {
			return `while [[ $# -gt 0 ]]; do
	case "$1" in
		-f) printf '%s' "$2" > "${inputPathLog}"; shift 2;;
		*) shift;;
	esac
done
${body}`;
		}

		it("returns the trimmed stdout and cleans up its temp directory", async () => {
			const inputPathLog = join(testDir, "input.log");
			const whisperBin = await writeStub(
				"whisper",
				whisperStub(
					inputPathLog,
					`printf 'whisper_init_with_params_no_state: Metal chatter\\n' >&2
printf ' Codemote speech service is online.\\n'
exit 0`,
				),
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const result = await engines.transcribe(makeWav(2400));

			expect(result.text).toBe("Codemote speech service is online.");
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			const handedPath = await readFile(inputPathLog, "utf8");
			expect(await exists(dirname(handedPath))).toBe(false);
		});

		it("treats a zero exit with a blank-audio marker as an empty transcript", async () => {
			const whisperBin = await writeStub("whisper", "printf '[BLANK_AUDIO]\\n'\nexit 0");
			const engines = new SpeechEngines(config({ whisperBin }));

			const result = await engines.transcribe(makeWav(2400));

			expect(result.text).toBe("");
		});

		it("reports a non-zero exit with empty stdout as engine_failed, not silence", async () => {
			const whisperBin = await writeStub(
				"whisper",
				`printf 'ggml chatter\\nvad options documentation\\n' >&2
printf 'error: failed to initialize whisper context\\n' >&2
exit 3`,
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const error = await expectSpeechError(engines.transcribe(makeWav(2400)), "engine_failed");
			expect(error.message).toContain("exited with code 3");
			expect(error.detail).toContain("failed to initialize whisper context");
			expect(error.detail).not.toContain("vad options documentation");
		});

		it("detects a missing whisper model before spawning", async () => {
			const invocations = join(testDir, "whisper-ran");
			const whisperBin = await writeStub("whisper", `touch "${invocations}"\nexit 0`);
			const engines = new SpeechEngines(
				config({ whisperBin, whisperModel: join(testDir, "gone.bin") }),
			);

			const error = await expectSpeechError(engines.transcribe(makeWav(2400)), "model_missing");
			expect(error.message).toContain("gone.bin");
			expect(await exists(invocations)).toBe(false);
		});

		it("rejects an empty body", async () => {
			const whisperBin = await writeStub("whisper", "exit 0");
			const engines = new SpeechEngines(config({ whisperBin }));

			await expectSpeechError(engines.transcribe(Buffer.alloc(0)), "invalid_request");
		});

		it("rejects a malformed language code", async () => {
			const whisperBin = await writeStub("whisper", "exit 0");
			const engines = new SpeechEngines(config({ whisperBin }));

			await expectSpeechError(engines.transcribe(makeWav(10), "english"), "invalid_request");
		});
	});

	describe("play", () => {
		it("hands the validated audio to the platform player", async () => {
			const playedLog = join(testDir, "played.log");
			const playerBin = await writeStub("player", `printf '%s' "$1" > "${playedLog}"\nexit 0`);
			const engines = new SpeechEngines(config({ playerBin }));
			const audio = makeWav(2400);

			await engines.play(audio, {
				sampleRate: 24000,
				channels: 1,
				bitsPerSample: 16,
				frames: 2400,
				durationMs: 100,
			});

			const handedPath = await readFile(playedLog, "utf8");
			expect(handedPath).toMatch(/\.wav$/);
			expect(await exists(dirname(handedPath))).toBe(false);
		});

		it("plays exactly the binary that status() reported", async () => {
			// health must not name a player that play() would fail to resolve.
			const playedLog = join(testDir, "agreed.log");
			const playerBin = await writeStub(
				"agreed-player",
				`printf '%s' "$1" > "${playedLog}"\nexit 0`,
			);
			const engines = new SpeechEngines(config({ playerBin }));

			const status = await engines.status();
			await engines.play(makeWav(10), {
				sampleRate: 24000,
				channels: 1,
				bitsPerSample: 16,
				frames: 10,
				durationMs: 1,
			});

			expect(status.playback.available).toBe(true);
			expect(status.playback.path).toBe(playerBin);
			expect(await exists(playedLog)).toBe(true);
		});

		it("refuses to play when status() reports playback unavailable", async () => {
			const engines = new SpeechEngines(config({ playerBin: join(testDir, "absent-player") }));

			const status = await engines.status();
			const error = await expectSpeechError(
				engines.play(makeWav(10), {
					sampleRate: 24000,
					channels: 1,
					bitsPerSample: 16,
					frames: 10,
					durationMs: 1,
				}),
				"engine_missing",
			);

			expect(status.playback.available).toBe(false);
			expect(status.playback.reason).toBe(error.message);
		});

		it("reports a failing player as engine_failed", async () => {
			const playerBin = await writeStub("player", "printf 'no audio device\\n' >&2\nexit 1");
			const engines = new SpeechEngines(config({ playerBin }));

			const error = await expectSpeechError(
				engines.play(makeWav(10), {
					sampleRate: 24000,
					channels: 1,
					bitsPerSample: 16,
					frames: 10,
					durationMs: 1,
				}),
				"engine_failed",
			);
			expect(error.detail).toContain("no audio device");
		});
	});

	describe("status", () => {
		it("reports unavailable engines with a reason instead of throwing", async () => {
			const engines = new SpeechEngines(
				config({
					kokoroBin: join(testDir, "no-kokoro"),
					whisperBin: join(testDir, "no-whisper"),
				}),
			);

			const status = await engines.status();

			expect(status.tts.available).toBe(false);
			expect(status.tts.reason).toContain("no-kokoro");
			expect(status.stt.available).toBe(false);
			expect(status.stt.reason).toContain("no-whisper");
			expect(typeof status.playback.available).toBe("boolean");
		});

		it("reports a resolved binary with a missing model as unavailable", async () => {
			const kokoroBin = await writeStub("kokoro", "exit 0");
			const whisperBin = await writeStub("whisper", "exit 0");
			const engines = new SpeechEngines(
				config({
					kokoroBin,
					whisperBin,
					kokoroModelDir: join(testDir, "gone"),
					whisperModel: join(testDir, "gone.bin"),
				}),
			);

			const status = await engines.status();

			expect(status.tts).toMatchObject({ available: false, path: kokoroBin });
			expect(status.tts.reason).toContain("kokoro-v1.0.onnx");
			expect(status.stt).toMatchObject({ available: false, path: whisperBin });
			expect(status.stt.reason).toContain("gone.bin");
		});

		it("remembers a failed resolution briefly, then re-probes", async () => {
			// /health re-probes on every call and bypasses the concurrency gate, so
			// an unresolved engine must not spawn a probe per request.
			const kokoroBin = join(testDir, "later-kokoro");
			const engines = new SpeechEngines(config({ kokoroBin }));

			expect((await engines.status()).tts.available).toBe(false);

			await writeFile(kokoroBin, "#!/bin/bash\nexit 0\n");
			await chmod(kokoroBin, 0o755);

			// Still refused: the failure is cached for a short window.
			expect((await engines.status()).tts.available).toBe(false);

			try {
				vi.useFakeTimers();
				vi.setSystemTime(Date.now() + 6000);
				expect((await engines.status()).tts.available).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("reports available engines when binaries and models resolve", async () => {
			const kokoroBin = await writeStub("kokoro", "exit 0");
			const whisperBin = await writeStub("whisper", "exit 0");
			const engines = new SpeechEngines(config({ kokoroBin, whisperBin }));

			const status = await engines.status();

			expect(status.tts).toEqual({ available: true, path: kokoroBin });
			expect(status.stt).toEqual({ available: true, path: whisperBin });
		});
	});
});
