import { homedir } from "node:os";
import { join } from "node:path";

export type SpeechErrorCode =
	| "invalid_request"
	| "forbidden_host"
	| "engine_missing"
	| "model_missing"
	| "busy"
	| "engine_timeout"
	| "engine_failed"
	| "empty_output"
	| "playback_unsupported";

const STATUS_BY_CODE: Record<SpeechErrorCode, number> = {
	invalid_request: 400,
	forbidden_host: 403,
	engine_missing: 503,
	model_missing: 503,
	busy: 429,
	engine_timeout: 504,
	engine_failed: 500,
	empty_output: 500,
	playback_unsupported: 501,
};

export class SpeechError extends Error {
	readonly code: SpeechErrorCode;
	readonly statusCode: number;
	readonly detail?: string;

	constructor(code: SpeechErrorCode, message: string, detail?: string) {
		super(message);
		this.name = "SpeechError";
		this.code = code;
		this.statusCode = STATUS_BY_CODE[code];
		if (detail !== undefined) {
			this.detail = detail;
		}
	}
}

export interface EngineStatus {
	available: boolean;
	/** Resolved absolute path when available. */
	path?: string;
	/** Populated only when unavailable: the reason, and every path tried. */
	reason?: string;
}

export interface SpeechHealth {
	status: "ok";
	service: "speech";
	version: string;
	tts: EngineStatus;
	stt: EngineStatus;
	playback: EngineStatus;
}

export interface SpeechConfig {
	port: number;
	host: string;
	kokoroBin?: string;
	kokoroModelDir: string;
	whisperBin?: string;
	whisperModel: string;
	/** Overrides the platform audio player (`afplay`, `paplay`/`aplay`). */
	playerBin?: string;
	discoveryFilePath: string;
	maxConcurrent: number;
	/** Overridable only so tests can use short deadlines. */
	probeTimeoutMs: number;
	transcribeTimeoutMs: number;
	/**
	 * Overrides the length-derived synthesis deadline. Absent in production,
	 * where the deadline is 15s + 60ms per character capped at 90s.
	 */
	synthesizeTimeoutMs?: number;
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
	port: 8082,
	host: "127.0.0.1",
	kokoroModelDir: join(homedir(), ".kokoro-tts", "models"),
	whisperModel: join(homedir(), ".cache", "whisper", "ggml-base.en.bin"),
	discoveryFilePath: join(homedir(), ".codemote", "speech.json"),
	maxConcurrent: 2,
	probeTimeoutMs: 2000,
	transcribeTimeoutMs: 120000,
};
