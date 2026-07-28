// Speech service — local, loopback-only synthesis and transcription.

export {
	createSpeechServer,
	isLoopbackHost,
	SPEECH_VERSION,
	type SpeechDiscoveryFile,
	type SpeechServerHandle,
} from "./server.js";
export { loadSpeechConfig, speechEnabled, speechPortOverride } from "./config.js";
export { SpeechEngines, type SynthesizeOptions, type SynthesizeResult } from "./engine.js";
export { parsePlayableWav, type WavInfo } from "./wav.js";
export {
	DEFAULT_SPEECH_CONFIG,
	SpeechError,
	type EngineStatus,
	type SpeechConfig,
	type SpeechErrorCode,
	type SpeechHealth,
} from "./types.js";
