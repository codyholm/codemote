import { DEFAULT_SPEECH_CONFIG, type SpeechConfig } from "./types.js";

function readPort(raw: string | undefined, warn: boolean): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 65535) {
		// A bad environment variable must not stop the rest of the control plane.
		if (warn) {
			console.warn(
				`[Speech] Ignoring CODEMOTE_SPEECH_PORT="${raw}": expected an integer in [0, 65535]. Using ${DEFAULT_SPEECH_CONFIG.port}.`,
			);
		}
		return null;
	}
	return value;
}

function readPath(raw: string | undefined): string | null {
	if (raw === undefined || raw.trim() === "") return null;
	return raw;
}

/**
 * Layers the speech environment variables over DEFAULT_SPEECH_CONFIG.
 *
 * Never called from a constructor, so tests can build a config by hand and
 * ignore the environment entirely.
 */
export function loadSpeechConfig(): SpeechConfig {
	const config: SpeechConfig = { ...DEFAULT_SPEECH_CONFIG };

	const port = readPort(process.env["CODEMOTE_SPEECH_PORT"], true);
	if (port !== null) config.port = port;

	const kokoroBin = readPath(process.env["CODEMOTE_KOKORO_BIN"]);
	if (kokoroBin !== null) config.kokoroBin = kokoroBin;

	const kokoroModelDir = readPath(process.env["CODEMOTE_KOKORO_MODEL_DIR"]);
	if (kokoroModelDir !== null) config.kokoroModelDir = kokoroModelDir;

	const whisperBin = readPath(process.env["CODEMOTE_WHISPER_BIN"]);
	if (whisperBin !== null) config.whisperBin = whisperBin;

	const whisperModel = readPath(process.env["CODEMOTE_WHISPER_MODEL"]);
	if (whisperModel !== null) config.whisperModel = whisperModel;

	// The engine layer names this variable when an explicit player fails to
	// resolve, so it has to be honoured here or that message would be a lie.
	const playerBin = readPath(process.env["CODEMOTE_SPEECH_PLAYER"]);
	if (playerBin !== null) config.playerBin = playerBin;

	const discoveryFilePath = readPath(process.env["CODEMOTE_SPEECH_DISCOVERY_FILE"]);
	if (discoveryFilePath !== null) config.discoveryFilePath = discoveryFilePath;

	return config;
}

/**
 * The port a *valid* CODEMOTE_SPEECH_PORT asked for, or null.
 *
 * Callers that place the service relative to another port need to know whether
 * the operator really chose a port. Re-testing the raw environment variable is
 * wrong: an invalid value is discarded by `loadSpeechConfig`, so its presence
 * says nothing about the port actually configured.
 */
export function speechPortOverride(): number | null {
	// loadSpeechConfig already warns about a bad value; do not warn twice.
	return readPort(process.env["CODEMOTE_SPEECH_PORT"], false);
}

/** False only for an explicit opt-out; unset means enabled. */
export function speechEnabled(): boolean {
	const raw = process.env["CODEMOTE_SPEECH"];
	return raw !== "0" && raw !== "false";
}
