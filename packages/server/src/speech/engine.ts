import { exec } from "node:child_process";
import { constants, access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";
import type { EngineStatus, SpeechConfig } from "./types.js";
import { SpeechError } from "./types.js";
import { type WavInfo, parsePlayableWav } from "./wav.js";

const STDERR_CAP_BYTES = 64 * 1024;
const DETAIL_CAP_CHARS = 2000;
const KILL_GRACE_MS = 2000;
/** Last resort if `close` never arrives, even after SIGKILL. */
const KILL_BACKSTOP_MS = KILL_GRACE_MS + 2000;
const SYNTHESIS_FLOOR_MS = 15_000;
const SYNTHESIS_MS_PER_CHAR = 60;
const SYNTHESIS_CAP_MS = 90_000;
const MAX_TEXT_LENGTH = 2000;
const NEGATIVE_CACHE_MS = 5000;
const VOICE_PATTERN = /^[a-z]{2}_[a-z]+$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;

/** whisper emits these when it hears nothing; they are not transcript text. */
const NON_SPEECH_MARKERS = /\[(BLANK_AUDIO|SILENCE|NO SPEECH|INAUDIBLE)\]/gi;

export interface SynthesizeOptions {
	text: string;
	voice?: string;
	speed?: number;
}

export interface SynthesizeResult {
	audio: Buffer;
	info: WavInfo;
}

interface BinarySpec {
	/** Cache key, also the name probed on PATH. */
	name: string;
	label: string;
	envVar: string;
	explicit?: string;
	fallbackDirs: string[];
}

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	timeoutMs: number;
	stdin?: string;
}

function isWindows(): boolean {
	return platform() === "win32";
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function probePath(name: string, timeoutMs: number): Promise<string | null> {
	const cmd = isWindows() ? `where.exe ${name}` : `command -v ${name}`;
	return new Promise((resolve) => {
		exec(cmd, { timeout: timeoutMs }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			const first = stdout.split("\n")[0]?.trim();
			resolve(first && first.length > 0 ? first : null);
		});
	});
}

/**
 * whisper interleaves real errors among dozens of lines of GGML/Metal chatter,
 * so a plain tail surfaces option documentation instead of the cause. Prefer
 * the lines the engine marked as errors; fall back to the tail only when there
 * are none.
 */
function extractDetail(stderr: string, exitCode: number | null): string {
	const errorLines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^error:/i.test(line));
	const body = errorLines.length > 0 ? errorLines.join("\n") : stderr.trim();
	const prefix = exitCode === null ? "" : `exit ${exitCode}\n`;
	return `${prefix}${body}`.slice(-DETAIL_CAP_CHARS);
}

export class SpeechEngines {
	private readonly config: SpeechConfig;
	/** Successful resolutions only. A failure is re-probed on the next call so
	 *  installing an engine while the service runs does not need a restart. */
	private readonly resolved = new Map<string, string>();
	/** Failures, remembered briefly so /health cannot spawn a shell per request. */
	private readonly failed = new Map<string, { at: number; message: string }>();

	constructor(config: SpeechConfig) {
		this.config = config;
	}

	async status(): Promise<{ tts: EngineStatus; stt: EngineStatus; playback: EngineStatus }> {
		const [tts, stt, playback] = await Promise.all([
			this.ttsStatus(),
			this.sttStatus(),
			this.playbackStatus(),
		]);
		return { tts, stt, playback };
	}

	async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
		const { text, voice, speed } = validateSynthesizeOptions(options);

		const bin = await this.resolveBinary(this.kokoroSpec());
		await this.requireKokoroModels();

		const timeoutMs =
			this.config.synthesizeTimeoutMs ??
			Math.min(SYNTHESIS_CAP_MS, SYNTHESIS_FLOOR_MS + text.length * SYNTHESIS_MS_PER_CHAR);

		const dir = await mkdtemp(join(tmpdir(), "codemote-speech-"));
		const outPath = join(dir, "out.wav");
		try {
			// text goes over stdin, never argv: agent-supplied text starting with
			// "-" would otherwise be parsed as an option.
			const args = ["synthesize", "--stdin", "-o", outPath];
			if (voice !== undefined) args.push("-v", voice);
			if (speed !== undefined) args.push("--speed", String(speed));

			const result = await runChild(bin, args, { timeoutMs, stdin: text });
			if (result.code !== 0) {
				throw new SpeechError(
					"engine_failed",
					`kokoro-tts-tool exited with code ${result.code}`,
					extractDetail(result.stderr, result.code),
				);
			}

			let audio: Buffer;
			try {
				audio = await readFile(outPath);
			} catch {
				throw new SpeechError("empty_output", "engine reported success but wrote no output file");
			}
			return { audio, info: parsePlayableWav(audio) };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	async play(audio: Buffer, info: WavInfo): Promise<void> {
		// Same resolution as status(), so /health cannot report a player that
		// play() would then fail to find.
		const { bin, label } = await this.resolvePlayer();

		const dir = await mkdtemp(join(tmpdir(), "codemote-speech-"));
		const path = join(dir, "play.wav");
		try {
			await writeFile(path, audio);
			const result = await runChild(bin, [path], { timeoutMs: info.durationMs + 10_000 });
			if (result.code !== 0) {
				throw new SpeechError(
					"engine_failed",
					`${label} exited with code ${result.code}`,
					extractDetail(result.stderr, result.code),
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/**
	 * The one place a player is chosen. status() and play() must agree: a health
	 * report naming a player that play() cannot find is health lying.
	 */
	private async resolvePlayer(): Promise<{ bin: string; label: string }> {
		const spec = this.playerSpec();
		if (!spec) {
			throw new SpeechError(
				"playback_unsupported",
				`no audio player is known for platform ${platform()}; request audio bytes instead of play: true`,
			);
		}
		try {
			return { bin: await this.resolveBinary(spec), label: spec.label };
		} catch (error) {
			// Linux ships either PulseAudio or ALSA; try the other one.
			if (platform() === "linux" && spec.name === "paplay") {
				const alt = { ...spec, name: "aplay", label: "aplay" };
				return { bin: await this.resolveBinary(alt), label: alt.label };
			}
			throw error;
		}
	}

	async transcribe(
		audio: Buffer,
		language?: string,
	): Promise<{ text: string; durationMs: number }> {
		if (audio.length === 0) {
			throw new SpeechError("invalid_request", "audio body is empty");
		}
		if (language !== undefined && !LANGUAGE_PATTERN.test(language)) {
			throw new SpeechError(
				"invalid_request",
				`language must be a two-letter code matching ${LANGUAGE_PATTERN.source}`,
			);
		}

		const bin = await this.resolveBinary(this.whisperSpec());
		if (!(await isReadable(this.config.whisperModel))) {
			throw new SpeechError(
				"model_missing",
				`whisper model is not readable at ${this.config.whisperModel} (set CODEMOTE_WHISPER_MODEL to override)`,
			);
		}

		const dir = await mkdtemp(join(tmpdir(), "codemote-speech-"));
		const inPath = join(dir, "in.wav");
		const startedAt = Date.now();
		try {
			await writeFile(inPath, audio);
			const result = await runChild(
				bin,
				["-m", this.config.whisperModel, "-f", inPath, "-l", language ?? "en", "-nt", "-np"],
				{ timeoutMs: this.config.transcribeTimeoutMs },
			);
			// whisper fails with an empty stdout rather than an error on stdout, so
			// the exit code is the only thing that separates "silence" from "broken".
			if (result.code !== 0) {
				throw new SpeechError(
					"engine_failed",
					`whisper-cli exited with code ${result.code}`,
					extractDetail(result.stderr, result.code),
				);
			}
			// An empty transcript after a zero exit means silence, which is a
			// legitimate result, not a failure.
			const text = result.stdout.replace(NON_SPEECH_MARKERS, " ").replace(/\s+/g, " ").trim();
			return { text, durationMs: Date.now() - startedAt };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	private kokoroSpec(): BinarySpec {
		return {
			name: "kokoro-tts-tool",
			label: "kokoro-tts-tool",
			envVar: "CODEMOTE_KOKORO_BIN",
			...(this.config.kokoroBin !== undefined ? { explicit: this.config.kokoroBin } : {}),
			fallbackDirs: [join(homedir(), ".local", "bin")],
		};
	}

	private whisperSpec(): BinarySpec {
		return {
			name: "whisper-cli",
			label: "whisper-cli",
			envVar: "CODEMOTE_WHISPER_BIN",
			...(this.config.whisperBin !== undefined ? { explicit: this.config.whisperBin } : {}),
			fallbackDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
		};
	}

	private playerSpec(): BinarySpec | null {
		const fallbackDirs = ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"];
		if (this.config.playerBin !== undefined) {
			return {
				name: "codemote-audio-player",
				label: "audio player",
				envVar: "CODEMOTE_SPEECH_PLAYER",
				explicit: this.config.playerBin,
				fallbackDirs: [],
			};
		}
		if (platform() === "darwin") {
			return { name: "afplay", label: "afplay", envVar: "PATH", fallbackDirs };
		}
		if (platform() === "linux") {
			return { name: "paplay", label: "paplay", envVar: "PATH", fallbackDirs };
		}
		return null;
	}

	private async ttsStatus(): Promise<EngineStatus> {
		let bin: string;
		try {
			bin = await this.resolveBinary(this.kokoroSpec());
		} catch (error) {
			return { available: false, reason: messageOf(error) };
		}
		try {
			await this.requireKokoroModels();
		} catch (error) {
			return { available: false, path: bin, reason: messageOf(error) };
		}
		return { available: true, path: bin };
	}

	private async sttStatus(): Promise<EngineStatus> {
		let bin: string;
		try {
			bin = await this.resolveBinary(this.whisperSpec());
		} catch (error) {
			return { available: false, reason: messageOf(error) };
		}
		if (!(await isReadable(this.config.whisperModel))) {
			return {
				available: false,
				path: bin,
				reason: `whisper model is not readable at ${this.config.whisperModel} (set CODEMOTE_WHISPER_MODEL to override)`,
			};
		}
		return { available: true, path: bin };
	}

	private async playbackStatus(): Promise<EngineStatus> {
		try {
			return { available: true, path: (await this.resolvePlayer()).bin };
		} catch (error) {
			return { available: false, reason: messageOf(error) };
		}
	}

	private async requireKokoroModels(): Promise<void> {
		for (const file of ["kokoro-v1.0.onnx", "voices-v1.0.bin"]) {
			const path = join(this.config.kokoroModelDir, file);
			if (!(await isReadable(path))) {
				throw new SpeechError(
					"model_missing",
					`kokoro model is not readable at ${path} (set CODEMOTE_KOKORO_MODEL_DIR to override)`,
				);
			}
		}
	}

	private async resolveBinary(spec: BinarySpec): Promise<string> {
		const cached = this.resolved.get(spec.name);
		if (cached) return cached;

		// /health re-probes on every call and is exempt from the concurrency gate,
		// so an unresolved engine would otherwise spawn a shell per request
		// forever. A short negative window caps that while still noticing an
		// engine installed while the service runs.
		const failure = this.failed.get(spec.name);
		if (failure && Date.now() - failure.at < NEGATIVE_CACHE_MS) {
			throw new SpeechError("engine_missing", failure.message);
		}

		const tried: string[] = [];

		// An explicit path that is wrong is an operator error worth reporting, not
		// something to silently fall through from.
		if (spec.explicit !== undefined) {
			tried.push(spec.explicit);
			if (await isExecutable(spec.explicit)) {
				this.resolved.set(spec.name, spec.explicit);
				this.failed.delete(spec.name);
				return spec.explicit;
			}
			throw this.rememberFailure(
				spec.name,
				`${spec.label} is not executable at the configured path ${spec.explicit} (set by ${spec.envVar}); tried: ${tried.join(", ")}`,
			);
		}

		const onPath = await probePath(spec.name, this.config.probeTimeoutMs);
		if (onPath) {
			this.resolved.set(spec.name, onPath);
			this.failed.delete(spec.name);
			return onPath;
		}
		tried.push(`PATH (${spec.name})`);

		// A launchd- or GUI-started process inherits only /usr/bin:/bin:/usr/sbin:/sbin,
		// and both engines live outside it.
		for (const dir of spec.fallbackDirs) {
			const candidate = join(dir, spec.name);
			tried.push(candidate);
			if (await isExecutable(candidate)) {
				this.resolved.set(spec.name, candidate);
				this.failed.delete(spec.name);
				return candidate;
			}
		}

		throw this.rememberFailure(
			spec.name,
			`${spec.label} was not found (set ${spec.envVar} to its path); tried: ${tried.join(", ")}`,
		);
	}

	private rememberFailure(name: string, message: string): SpeechError {
		this.failed.set(name, { at: Date.now(), message });
		return new SpeechError("engine_missing", message);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validateSynthesizeOptions(options: SynthesizeOptions): {
	text: string;
	voice?: string;
	speed?: number;
} {
	const { text, voice, speed } = options;
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new SpeechError("invalid_request", "text is required and must be a non-empty string");
	}
	if (text.length > MAX_TEXT_LENGTH) {
		throw new SpeechError(
			"invalid_request",
			`text is ${text.length} characters; the maximum is ${MAX_TEXT_LENGTH}`,
		);
	}
	if (voice !== undefined) {
		if (typeof voice !== "string" || voice.length > 32 || !VOICE_PATTERN.test(voice)) {
			throw new SpeechError(
				"invalid_request",
				`voice must match ${VOICE_PATTERN.source} and be at most 32 characters (for example af_heart); run 'kokoro-tts-tool list-voices' for the full list`,
			);
		}
	}
	if (speed !== undefined) {
		if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
			throw new SpeechError("invalid_request", "speed must be a finite number between 0.5 and 2");
		}
	}
	return {
		text,
		...(voice !== undefined ? { voice } : {}),
		...(speed !== undefined ? { speed } : {}),
	};
}

/**
 * Kills the child and anything it started.
 *
 * A configured engine path is often a wrapper script, and killing the wrapper
 * leaves the real workload running while the caller is told it was killed. On
 * POSIX the child leads its own process group (`detached`), so the negative pid
 * reaches the whole tree. The group may already be gone — ESRCH must not throw.
 */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined || isWindows()) {
		try {
			child.kill(signal);
		} catch {
			// already exited
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already exited
		}
	}
}

function runChild(bin: string, args: string[], options: RunOptions): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		// detached only makes the child a process-group leader here; the parent
		// still holds a reference and still waits for close.
		const child = spawn(bin, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows(),
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let killTimer: NodeJS.Timeout | null = null;
		let backstopTimer: NodeJS.Timeout | null = null;

		const timeoutError = (): SpeechError =>
			new SpeechError(
				"engine_timeout",
				`${bin} exceeded its ${options.timeoutMs}ms deadline and was killed`,
			);

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child, "SIGTERM");
			killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
			// The caller is told the child was killed, so do not say so until it
			// is: settling here would release the concurrency slot while the
			// process is still alive. `close` normally arrives well before this
			// backstop, which exists only so a pathological child cannot wedge the
			// request forever.
			backstopTimer = setTimeout(() => finish(() => reject(timeoutError())), KILL_BACKSTOP_MS);
		}, options.timeoutMs);

		function finish(action: () => void): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (backstopTimer) clearTimeout(backstopTimer);
			action();
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString()).slice(-STDERR_CAP_BYTES);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_CAP_BYTES);
		});

		child.on("error", (error: Error) => {
			finish(() =>
				reject(new SpeechError("engine_failed", `failed to start ${bin}`, error.message)),
			);
		});

		child.on("close", (code) => {
			// A timed-out child still reports its exit here; report the timeout,
			// not whatever code the signal produced.
			finish(() => (timedOut ? reject(timeoutError()) : resolve({ code, stdout, stderr })));
		});

		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		} else {
			child.stdin?.end();
		}
	});
}
