import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import spawn from "cross-spawn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechEngines, killTree } from "./engine.js";
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

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded poll for a pid file. Generously bounded: nothing is killing its writer. */
async function waitForPid(path: string): Promise<number> {
	for (let i = 0; i < 200; i++) {
		try {
			const pid = Number((await readFile(path, "utf8")).trim());
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			// not written yet
		}
		await sleep(25);
	}
	throw new Error(`no pid was recorded at ${path} within 5s`);
}

/**
 * `ps` state rather than `process.kill(pid, 0)`, which succeeds for a zombie.
 *
 * The group kill takes the wrapper down along with its child, so the child is
 * orphaned and reparented to PID 1. Where PID 1 does not reap promptly — the
 * normal case in a minimal container — it lingers as a zombie. A zombie has
 * terminated and holds nothing but a process-table slot, which satisfies "the
 * grandchild was killed". `state=` prints nothing when no process matches, and
 * a leading `Z` for a terminated one; both are dead.
 */
async function isDead(pid: number): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "state=", "-p", String(pid)]);
		const state = stdout.trim();
		return state === "" || state.startsWith("Z");
	} catch {
		// ps exits non-zero when the pid matches nothing.
		return true;
	}
}

async function waitUntilDead(pid: number): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if (await isDead(pid)) return true;
		await sleep(20);
	}
	return false;
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

		it("spawns the engine as its own process-group leader", async () => {
			// killTree signals the negative pid, which reaches the whole tree only
			// while the child leads its own group. Dropping `detached` from runChild
			// would leave the tree-kill test green — it spawns its own child — and
			// silently break the production path, so pin group leadership here.
			const groupLog = join(testDir, "group.log");
			const kokoroBin = await writeStub(
				"group-reporter",
				`ps -o pgid= -p $$ > "${groupLog}"
printf '%s' $$ >> "${groupLog}"
${kokoroStub(fixtureWav)}`,
			);
			const engines = new SpeechEngines(config({ kokoroBin }));

			await engines.synthesize({ text: "hello" });

			const [pgidLine, pidLine] = (await readFile(groupLog, "utf8")).split("\n");
			const pgid = Number(pgidLine?.trim());
			const pid = Number(pidLine?.trim());
			expect(Number.isInteger(pid)).toBe(true);
			expect(pgid).toBe(pid);
		});

		it("kills the whole process tree, not just the wrapper it spawned", async () => {
			// A configured engine path is often a wrapper script. Killing only the
			// wrapper reports a kill that did not happen and leaves the real work
			// running while the concurrency slot is released.
			//
			// killTree is called directly rather than reached through a deadline:
			// racing the wrapper's startup against a wall-clock timeout made this
			// test fail on its own precondition under suite parallelism, which
			// proves nothing about the kill. runChild spawns detached for exactly
			// the reason reproduced here, so the spawn below mirrors it.
			const grandchildPid = join(testDir, "grandchild.pid");
			const wrapper = await writeStub(
				"wrapper",
				`sleep 300 &
printf '%s' "$!" > "${grandchildPid}"
wait`,
			);
			const child = spawn(wrapper, [], { stdio: "ignore", detached: true });
			child.on("error", () => undefined);

			try {
				// Nothing is killing the wrapper yet, so this cannot race.
				const pid = await waitForPid(grandchildPid);

				killTree(child, "SIGTERM");

				expect(await waitUntilDead(pid)).toBe(true);
			} finally {
				// Backstop for an early throw. Guarded because killTree signals a
				// process group by number: once the wrapper has exited and been
				// reaped, that number can belong to somebody else.
				if (child.exitCode === null && child.signalCode === null) {
					killTree(child, "SIGKILL");
				}
			}
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

		it("reports a zero exit with an error line as unreadable audio, not silence", async () => {
			// whisper exits zero for a file it could not read at all, so without this
			// a corrupt or m4a upload is indistinguishable from a silent recording.
			const whisperBin = await writeStub(
				"whisper",
				`printf "error: failed to read audio file 'in.wav'\\n" >&2
exit 0`,
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const error = await expectSpeechError(engines.transcribe(makeWav(2400)), "unreadable_audio");
			expect(error.statusCode).toBe(400);
			expect(error.message).toContain("wav, mp3, ogg and flac");
			expect(error.message).toContain("m4a");
			expect(error.detail).toContain("failed to read audio file 'in.wav'");
		});

		it("blames the language, not the audio, when whisper does not know the code", async () => {
			// whisper rejects an unknown language at exit 0 too. Reporting that as
			// unreadable audio tells the caller to re-encode a file that was fine,
			// which is a retry loop with no exit.
			const whisperBin = await writeStub(
				"whisper",
				`printf "error: unknown language 'jp'\\n" >&2
printf ' this recording is perfectly fine\\n'
exit 0`,
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const error = await expectSpeechError(
				engines.transcribe(makeWav(2400), "jp"),
				"invalid_request",
			);
			expect(error.statusCode).toBe(400);
			expect(error.message).toContain('"jp"');
			expect(error.message).toContain("ja not jp");
			expect(error.detail).toContain("unknown language 'jp'");
		});

		it("charges an unrecognised error line to the engine, not to the caller", async () => {
			// Safe degradation: a phrasing whisper adds later must not be blamed on
			// the caller's bytes, and must still never be reported as silence.
			const whisperBin = await writeStub(
				"whisper",
				`printf 'error: something we have never seen\\n' >&2
exit 0`,
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const error = await expectSpeechError(engines.transcribe(makeWav(2400)), "engine_failed");
			expect(error.statusCode).toBe(500);
			expect(error.detail).toContain("something we have never seen");
		});

		it("treats a clean run with no output as silence, not a failure", async () => {
			// The inverse defect: reporting an error for a legitimately silent
			// recording breaks a working case.
			const whisperBin = await writeStub("whisper", "exit 0");
			const engines = new SpeechEngines(config({ whisperBin }));

			const result = await engines.transcribe(makeWav(2400));

			expect(result.text).toBe("");
		});

		it("does not mistake benign stderr chatter for an error", async () => {
			const whisperBin = await writeStub(
				"whisper",
				`printf 'warning: model was trained elsewhere\\n' >&2
printf 'whisper_print_timings: total = 0 errors\\n' >&2
printf ' the build is green\\n'
exit 0`,
			);
			const engines = new SpeechEngines(config({ whisperBin }));

			const result = await engines.transcribe(makeWav(2400));

			expect(result.text).toBe("the build is green");
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
