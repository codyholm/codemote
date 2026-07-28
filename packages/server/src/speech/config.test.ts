import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSpeechConfig, speechEnabled, speechPortOverride } from "./config.js";
import { DEFAULT_SPEECH_CONFIG } from "./types.js";

const SPEECH_ENV_KEYS = [
	"CODEMOTE_SPEECH",
	"CODEMOTE_SPEECH_PORT",
	"CODEMOTE_KOKORO_BIN",
	"CODEMOTE_KOKORO_MODEL_DIR",
	"CODEMOTE_WHISPER_BIN",
	"CODEMOTE_WHISPER_MODEL",
	"CODEMOTE_SPEECH_PLAYER",
	"CODEMOTE_SPEECH_DISCOVERY_FILE",
];

describe("speech config", () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const key of SPEECH_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of SPEECH_ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.restoreAllMocks();
	});

	it("returns the defaults when nothing is set", () => {
		const config = loadSpeechConfig();
		expect(config).toEqual(DEFAULT_SPEECH_CONFIG);
		expect(config.port).toBe(8082);
		expect(config.host).toBe("127.0.0.1");
		expect(config.maxConcurrent).toBe(2);
		expect(config.probeTimeoutMs).toBe(2000);
		expect(config.transcribeTimeoutMs).toBe(120000);
		expect("kokoroBin" in config).toBe(false);
		expect("whisperBin" in config).toBe(false);
	});

	it("does not return the shared defaults object", () => {
		expect(loadSpeechConfig()).not.toBe(DEFAULT_SPEECH_CONFIG);
	});

	it("honours every environment override", () => {
		process.env["CODEMOTE_SPEECH_PORT"] = "9100";
		process.env["CODEMOTE_KOKORO_BIN"] = "/opt/kokoro";
		process.env["CODEMOTE_KOKORO_MODEL_DIR"] = "/opt/kokoro-models";
		process.env["CODEMOTE_WHISPER_BIN"] = "/opt/whisper";
		process.env["CODEMOTE_WHISPER_MODEL"] = "/opt/ggml.bin";
		process.env["CODEMOTE_SPEECH_PLAYER"] = "/opt/player";
		process.env["CODEMOTE_SPEECH_DISCOVERY_FILE"] = "/tmp/speech.json";

		expect(loadSpeechConfig()).toMatchObject({
			port: 9100,
			kokoroBin: "/opt/kokoro",
			kokoroModelDir: "/opt/kokoro-models",
			whisperBin: "/opt/whisper",
			whisperModel: "/opt/ggml.bin",
			playerBin: "/opt/player",
			discoveryFilePath: "/tmp/speech.json",
		});
	});

	it("accepts port 0 so an ephemeral port can be requested", () => {
		process.env["CODEMOTE_SPEECH_PORT"] = "0";
		expect(loadSpeechConfig().port).toBe(0);
	});

	it.each(["not-a-number", "8082.5", "-1", "70000"])(
		"warns and falls back to the default port for %s",
		(value) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			process.env["CODEMOTE_SPEECH_PORT"] = value;

			expect(loadSpeechConfig().port).toBe(DEFAULT_SPEECH_CONFIG.port);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain("CODEMOTE_SPEECH_PORT");
		},
	);

	it("ignores empty overrides rather than blanking a path", () => {
		process.env["CODEMOTE_WHISPER_MODEL"] = "";
		process.env["CODEMOTE_SPEECH_PORT"] = "";
		const config = loadSpeechConfig();
		expect(config.whisperModel).toBe(DEFAULT_SPEECH_CONFIG.whisperModel);
		expect(config.port).toBe(DEFAULT_SPEECH_CONFIG.port);
	});

	describe("speechPortOverride", () => {
		it("is null when unset", () => {
			expect(speechPortOverride()).toBeNull();
		});

		it("reports a valid override", () => {
			process.env["CODEMOTE_SPEECH_PORT"] = "9100";
			expect(speechPortOverride()).toBe(9100);
		});

		it("is null for an invalid value, so callers keep their own default", () => {
			// The presence of the variable says nothing: loadSpeechConfig has already
			// discarded an unusable value, so a caller placing the service relative
			// to another port must not treat "set" as "chosen".
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			process.env["CODEMOTE_SPEECH_PORT"] = "abc";

			expect(speechPortOverride()).toBeNull();
			// loadSpeechConfig owns the warning; this must not duplicate it.
			expect(warn).not.toHaveBeenCalled();
		});
	});

	it.each([
		["unset", undefined, true],
		["0", "0", false],
		["false", "false", false],
		["1", "1", true],
		["true", "true", true],
		["yes", "yes", true],
	])("speechEnabled() is %s -> %s", (_label, value, expected) => {
		// beforeEach already cleared it, so "unset" means simply not setting it.
		if (value !== undefined) process.env["CODEMOTE_SPEECH"] = value;
		expect(speechEnabled()).toBe(expected);
	});
});
