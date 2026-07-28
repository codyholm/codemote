import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import { SpeechEngines, type SynthesizeOptions } from "./engine.js";
import {
	DEFAULT_SPEECH_CONFIG,
	type SpeechConfig,
	SpeechError,
	type SpeechHealth,
} from "./types.js";

export const SPEECH_VERSION = "0.1.0";

const AUDIO_CONTENT_TYPES = [
	"audio/wav",
	"audio/x-wav",
	"audio/wave",
	"audio/mpeg",
	"audio/mp3",
	"audio/flac",
	"audio/ogg",
	"application/octet-stream",
];

/**
 * Identical in semantics to `isLoopbackHost` in `uplink/server.ts`.
 *
 * The duplication is deliberate: uplink is owned by another lane, and a shared
 * helper would mean editing a file this one must not touch. If a third copy
 * ever appears, extract it then.
 */
export function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export interface SpeechServerHandle {
	readonly port: number;
	readonly url: string;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface SpeechDiscoveryFile {
	url: string;
	port: number;
	pid: number;
	startedAt: string;
	engines: {
		tts: "available" | "unavailable";
		stt: "available" | "unavailable";
		playback: "available" | "unavailable";
	};
}

interface SpeakBody {
	text?: unknown;
	voice?: unknown;
	speed?: unknown;
	play?: unknown;
}

/**
 * The host part of a `Host` header, with any port stripped and IPv6 brackets
 * removed. Returns null when the header is absent or unparseable.
 */
function hostHeaderName(header: string | undefined): string | null {
	if (header === undefined) return null;
	const value = header.trim();
	if (value === "") return null;
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		return end === -1 ? null : value.slice(1, end);
	}
	const firstColon = value.indexOf(":");
	// An unbracketed value with several colons is a bare IPv6 literal.
	if (firstColon !== -1 && firstColon === value.lastIndexOf(":")) {
		return value.slice(0, firstColon);
	}
	return value;
}

function formatUrl(host: string, port: number): string {
	return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

export function createSpeechServer(config: Partial<SpeechConfig> = {}): SpeechServerHandle {
	const cfg: SpeechConfig = { ...DEFAULT_SPEECH_CONFIG, ...config };
	const engines = new SpeechEngines(cfg);

	const app = Fastify({
		logger: true,
		bodyLimit: 10 * 1024 * 1024,
	});

	let assignedPort = cfg.port;
	let inFlight = 0;
	/** Only this instance's own file may be removed on stop. */
	let wroteDiscoveryFile = false;

	// Binding to loopback stops other machines. It does not stop a browser on
	// THIS machine: a hostile page whose DNS resolves to 127.0.0.1 is same-origin
	// to the browser, so CORS never applies and it could read /health (username,
	// home directory, installed tooling) or drive /speak. The Host header is the
	// part of such a request the attacker cannot forge away, and no browser can
	// suppress Origin on a cross-origin request.
	app.addHook("onRequest", async (request) => {
		if (request.headers.origin !== undefined) {
			throw new SpeechError(
				"forbidden_host",
				"refused a request carrying an Origin header; the speech service does not serve browser callers",
			);
		}
		const host = hostHeaderName(request.headers.host);
		if (host === null || !isLoopbackHost(host)) {
			throw new SpeechError(
				"forbidden_host",
				`refused Host header "${request.headers.host ?? ""}"; the speech service only answers to 127.0.0.1, localhost or [::1]`,
			);
		}
	});

	// Minimal hardening for the small HTTP surface, matching relay/server.ts.
	app.addHook("onSend", async (_req, reply, payload) => {
		reply.header("X-Content-Type-Options", "nosniff");
		reply.header("X-Frame-Options", "DENY");
		reply.header("Referrer-Policy", "no-referrer");
		return payload;
	});

	// Fastify parses text/plain out of the box, which would turn an unsupported
	// content type on /transcribe into a confusing 400 instead of a 415.
	app.removeContentTypeParser("text/plain");

	for (const contentType of AUDIO_CONTENT_TYPES) {
		app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_req, body, done) => {
			done(null, body);
		});
	}

	app.setErrorHandler((error, request, reply) => {
		if (error instanceof SpeechError) {
			if (error.code === "busy") reply.header("Retry-After", "1");
			reply.status(error.statusCode).send({
				error: {
					code: error.code,
					message: error.message,
					...(error.detail !== undefined ? { detail: error.detail } : {}),
				},
			});
			return;
		}

		// `instanceof SpeechError` above narrows this branch away from the union,
		// so read the Fastify status through an explicit shape.
		const fastifyError = error as Error & { statusCode?: number };
		const status = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;
		if (status >= 500) {
			// Never serialize an internal failure to the caller.
			request.log.error(fastifyError);
			reply.status(status).send({ error: { code: "internal", message: "Internal error" } });
			return;
		}
		// Fastify's own client errors (413 body too large, 415 unsupported media
		// type) keep their built-in shape rather than being re-wrapped.
		reply.status(status).send(fastifyError);
	});

	async function withGate<T>(fn: () => Promise<T>): Promise<T> {
		if (inFlight >= cfg.maxConcurrent) {
			throw new SpeechError(
				"busy",
				`speech service is at capacity (${cfg.maxConcurrent} concurrent jobs); retry shortly`,
			);
		}
		inFlight += 1;
		try {
			return await fn();
		} finally {
			inFlight -= 1;
		}
	}

	app.get("/health", { logLevel: "silent" }, async (): Promise<SpeechHealth> => {
		const status = await engines.status();
		return {
			status: "ok",
			service: "speech",
			version: SPEECH_VERSION,
			tts: status.tts,
			stt: status.stt,
			playback: status.playback,
		};
	});

	app.post("/speak", { bodyLimit: 64 * 1024 }, async (request, reply) => {
		return await withGate(async () => {
			const body = request.body;
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				throw new SpeechError("invalid_request", "body must be a JSON object");
			}
			const { text, voice, speed, play } = body as SpeakBody;
			if (typeof text !== "string") {
				throw new SpeechError("invalid_request", "text is required and must be a string");
			}
			if (voice !== undefined && typeof voice !== "string") {
				throw new SpeechError("invalid_request", "voice must be a string");
			}
			if (speed !== undefined && typeof speed !== "number") {
				throw new SpeechError("invalid_request", "speed must be a number");
			}
			if (play !== undefined && typeof play !== "boolean") {
				throw new SpeechError("invalid_request", "play must be a boolean");
			}

			const options: SynthesizeOptions = {
				text,
				...(voice !== undefined ? { voice } : {}),
				...(speed !== undefined ? { speed } : {}),
			};
			const { audio, info } = await engines.synthesize(options);

			if (play === true) {
				await engines.play(audio, info);
				return { played: true, bytes: audio.length, durationMs: info.durationMs };
			}

			// Declare the format from the validated header so it cannot drift.
			reply
				.header("Content-Type", "audio/wav")
				.header("Content-Length", String(audio.length))
				.header("X-Speech-Sample-Rate", String(info.sampleRate))
				.header("X-Speech-Channels", String(info.channels))
				.header("X-Speech-Bits-Per-Sample", String(info.bitsPerSample))
				.header("X-Speech-Duration-Ms", String(info.durationMs));
			return reply.send(audio);
		});
	});

	app.post("/transcribe", async (request) => {
		return await withGate(async () => {
			const body = request.body;
			if (!Buffer.isBuffer(body)) {
				throw new SpeechError("invalid_request", "request body must be raw audio bytes");
			}
			const { language } = request.query as { language?: string };
			return await engines.transcribe(body, language);
		});
	});

	async function writeDiscoveryFile(): Promise<void> {
		try {
			const status = await engines.status();
			const contents: SpeechDiscoveryFile = {
				url: formatUrl(cfg.host, assignedPort),
				port: assignedPort,
				pid: process.pid,
				startedAt: new Date().toISOString(),
				engines: {
					tts: status.tts.available ? "available" : "unavailable",
					stt: status.stt.available ? "available" : "unavailable",
					playback: status.playback.available ? "available" : "unavailable",
				},
			};
			await mkdir(dirname(cfg.discoveryFilePath), { recursive: true });
			await writeFile(cfg.discoveryFilePath, `${JSON.stringify(contents, null, 2)}\n`, {
				mode: 0o600,
			});
			wroteDiscoveryFile = true;
		} catch (error) {
			// The service is still usable at a known port; do not fail startup.
			app.log.warn(
				`Could not write speech discovery file at ${cfg.discoveryFilePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return {
		get port() {
			return assignedPort;
		},
		get url() {
			return formatUrl(cfg.host, assignedPort);
		},
		async start() {
			// Refuse before a socket exists, matching uplink/server.ts. A service
			// bound wide and filtered afterwards is still a service on the LAN.
			if (!isLoopbackHost(cfg.host)) {
				throw new Error(
					`Refusing to start speech service on non-loopback host (${cfg.host}). The speech service must be loopback-only.`,
				);
			}
			await app.listen({ port: cfg.port, host: cfg.host });
			const address = app.server.address();
			if (address !== null && typeof address === "object") {
				assignedPort = address.port;
			}
			await writeDiscoveryFile();
		},
		async stop() {
			await app.close();
			// Remove the endpoint record only while it is still ours. A second
			// instance sharing this path replaces the record, and deleting that
			// would leave a service that is still listening undiscoverable.
			if (wroteDiscoveryFile) {
				wroteDiscoveryFile = false;
				try {
					const existing = JSON.parse(
						await readFile(cfg.discoveryFilePath, "utf8"),
					) as SpeechDiscoveryFile;
					if (existing.pid === process.pid) {
						await rm(cfg.discoveryFilePath, { force: true });
					}
				} catch {
					// Gone, unreadable, or not our JSON: leave it where it is.
				}
			}
		},
	};
}
