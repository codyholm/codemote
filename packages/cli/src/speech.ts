/**
 * `codemote speech` — the local, loopback-only speech service.
 *
 * `serve` runs it standalone (no pairing, no mDNS, no TLS), `status` tells an
 * operator or an agent where it is and whether the engines are usable, and
 * `say` speaks a line through the same HTTP path an agent would use.
 */

import { readFile } from "node:fs/promises";
import {
	type SpeechDiscoveryFile,
	type SpeechHealth,
	createSpeechServer,
	loadSpeechConfig,
} from "@codemote/server";

const HEALTH_TIMEOUT_MS = 3000;

/**
 * How long to wait for `say`, derived from the server's own deadlines rather
 * than a fixed number: a long line can legitimately take minutes, and aborting
 * mid-sentence would report a failure while the machine is still speaking.
 * Mirrors synthesis (15s + 60ms/char, capped at 90s) plus playback
 * (audio duration + 10s, and audio runs at roughly 60ms per character), plus a
 * small margin. Still bounded.
 */
function sayTimeoutMs(textLength: number): number {
	const synthesis = Math.min(90_000, 15_000 + textLength * 60);
	const playback = textLength * 60 + 10_000;
	return Math.min(300_000, synthesis + playback + 5_000);
}

interface Flags {
	port?: number;
	voice?: string;
	speed?: number;
	rest: string[];
}

function parseFlags(args: string[]): Flags {
	const rest: string[] = [];
	let port: number | undefined;
	let voice: string | undefined;
	let speed: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--port" && args[i + 1] !== undefined) {
			port = Number(args[++i]);
		} else if (arg === "--voice" && args[i + 1] !== undefined) {
			voice = args[++i];
		} else if (arg === "--speed" && args[i + 1] !== undefined) {
			speed = Number(args[++i]);
		} else if (arg !== undefined) {
			rest.push(arg);
		}
	}

	return {
		...(port !== undefined ? { port } : {}),
		...(voice !== undefined ? { voice } : {}),
		...(speed !== undefined ? { speed } : {}),
		rest,
	};
}

async function readDiscoveryFile(path: string): Promise<SpeechDiscoveryFile | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as SpeechDiscoveryFile;
	} catch {
		return null;
	}
}

async function fetchHealth(url: string): Promise<SpeechHealth | null> {
	try {
		const response = await fetch(`${url}/health`, {
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return (await response.json()) as SpeechHealth;
	} catch {
		return null;
	}
}

function printUsage(): void {
	console.error(`Usage:
  codemote speech serve [--port <n>]   Run the local speech service
  codemote speech status               Show the endpoint and engine state
  codemote speech say "<text>"         Speak a line out loud [--voice <v>] [--speed <n>]`);
}

function notRunning(): void {
	console.error("Speech service is not running.");
	console.error("Start it with: codemote speech serve");
	process.exitCode = 1;
}

async function runServe(flags: Flags): Promise<void> {
	const config = loadSpeechConfig();
	const server = createSpeechServer({
		...config,
		...(flags.port !== undefined ? { port: flags.port } : {}),
	});

	await server.start();
	console.log(`Speech service listening on ${server.url}`);
	console.log(`Endpoint file: ${config.discoveryFilePath}`);
	console.log("Run 'codemote speech status' in another shell for usage examples.");
	console.log("Press Ctrl+C to stop.");

	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});

	console.log("\nStopping speech service...");
	await server.stop();
}

async function runStatus(): Promise<void> {
	const config = loadSpeechConfig();
	const discovery = await readDiscoveryFile(config.discoveryFilePath);
	if (!discovery) {
		notRunning();
		return;
	}

	const health = await fetchHealth(discovery.url);
	if (!health) {
		console.error(
			`Speech service did not answer at ${discovery.url} (recorded pid ${discovery.pid}).`,
		);
		console.error(`The endpoint file at ${config.discoveryFilePath} is stale.`);
		console.error("Start it with: codemote speech serve");
		process.exitCode = 1;
		return;
	}

	console.log(`Speech service: ${discovery.url} (pid ${discovery.pid})`);
	console.log("");
	for (const [label, engine] of [
		["text to speech", health.tts],
		["speech to text", health.stt],
		["playback", health.playback],
	] as const) {
		if (engine.available) {
			console.log(`  ${label.padEnd(15)} available  ${engine.path ?? ""}`.trimEnd());
		} else {
			console.log(`  ${label.padEnd(15)} UNAVAILABLE ${engine.reason ?? "unknown reason"}`);
		}
	}
	console.log(`
For an agent with a Bash tool:

  # Discover the endpoint
  cat ${config.discoveryFilePath}

  # Speak text into a WAV file (24000 Hz, mono, 16-bit)
  curl -sS -X POST ${discovery.url}/speak \\
    -H 'content-type: application/json' \\
    -d '{"text":"Your text here."}' -o /tmp/speech.wav

  # Transcribe a recording (wav, mp3, ogg or flac)
  curl -sS -X POST ${discovery.url}/transcribe \\
    -H 'content-type: audio/wav' --data-binary @/tmp/speech.wav`);
}

async function runSay(flags: Flags): Promise<void> {
	const text = flags.rest.join(" ").trim();
	if (!text) {
		console.error('Usage: codemote speech say "<text>"');
		process.exitCode = 1;
		return;
	}

	const config = loadSpeechConfig();
	const discovery = await readDiscoveryFile(config.discoveryFilePath);
	if (!discovery) {
		notRunning();
		return;
	}

	let response: Response;
	try {
		// Deliberately the same HTTP path an agent uses, rather than calling the
		// engine directly, so this doubles as a smoke check of the real route.
		response = await fetch(`${discovery.url}/speak`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text,
				play: true,
				...(flags.voice !== undefined ? { voice: flags.voice } : {}),
				...(flags.speed !== undefined ? { speed: flags.speed } : {}),
			}),
			signal: AbortSignal.timeout(sayTimeoutMs(text.length)),
		});
	} catch (error) {
		console.error(
			`Could not reach the speech service at ${discovery.url}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		process.exitCode = 1;
		return;
	}

	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		console.error(
			`Speech failed (${response.status} ${body?.error?.code ?? "unknown"}): ${
				body?.error?.message ?? "no message"
			}`,
		);
		process.exitCode = 1;
		return;
	}

	const result = (await response.json()) as { bytes?: number; durationMs?: number };
	console.log(`Spoke ${result.bytes ?? 0} bytes (${result.durationMs ?? 0} ms).`);
}

/** Handle `codemote speech <subcommand>` invocations. */
export async function runSpeechSubcommand(args: string[]): Promise<void> {
	const action = args[0];
	const flags = parseFlags(args.slice(1));

	if (action === "serve") {
		await runServe(flags);
		return;
	}
	if (action === "status") {
		await runStatus();
		return;
	}
	if (action === "say") {
		await runSay(flags);
		return;
	}

	if (action !== undefined) console.error(`Unknown speech action: ${action}`);
	printUsage();
	process.exitCode = 1;
}
