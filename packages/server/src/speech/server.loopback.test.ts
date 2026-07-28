import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createConnection, createServer } from "node:net";
import { networkInterfaces, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SpeechServerHandle, createSpeechServer, isLoopbackHost } from "./server.js";

interface ConnectOutcome {
	connected: boolean;
	code: string | null;
}

const CONNECT_TIMEOUT_MS = 2000;
/** Refusal codes that count as proof the port is not reachable at an address. */
const REFUSED_CODES = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];

function externalIPv4Addresses(): string[] {
	const addresses: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
		}
	}
	return addresses;
}

function attemptConnect(host: string, port: number): Promise<ConnectOutcome> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const settle = (outcome: ConnectOutcome): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(outcome);
		};
		socket.setTimeout(CONNECT_TIMEOUT_MS);
		socket.on("connect", () => settle({ connected: true, code: null }));
		socket.on("timeout", () => settle({ connected: false, code: "ETIMEDOUT" }));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			settle({ connected: false, code: error.code ?? "UNKNOWN" }),
		);
	});
}

function listen(server: Server, port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const address = server.address();
			if (address === null || typeof address !== "object") {
				reject(new Error("server reported no address"));
				return;
			}
			resolve(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
	const probe = createServer();
	const port = await listen(probe, 0, "127.0.0.1");
	await close(probe);
	return port;
}

describe.skipIf(platform() === "win32")("speech service loopback binding", () => {
	let testDir: string;
	let discoveryFilePath: string;
	let started: SpeechServerHandle[];
	let sockets: Server[];

	beforeEach(async () => {
		started = [];
		sockets = [];
		testDir = await mkdtemp(join(tmpdir(), "speech-loopback-test-"));
		discoveryFilePath = join(testDir, "speech.json");
	});

	afterEach(async () => {
		for (const server of started) await server.stop().catch(() => undefined);
		for (const socket of sockets) await close(socket).catch(() => undefined);
		await rm(testDir, { recursive: true, force: true });
	});

	function build(host: string, port: number): SpeechServerHandle {
		// Point both engines at paths that cannot resolve: this suite never calls
		// /speak or /transcribe, and it keeps startup off the PATH probe.
		const server = createSpeechServer({
			host,
			port,
			discoveryFilePath,
			kokoroBin: join(testDir, "absent-kokoro"),
			whisperBin: join(testDir, "absent-whisper"),
			playerBin: join(testDir, "absent-player"),
		});
		started.push(server);
		return server;
	}

	describe("isLoopbackHost", () => {
		it("accepts exactly the three loopback spellings uplink accepts", () => {
			expect(isLoopbackHost("127.0.0.1")).toBe(true);
			expect(isLoopbackHost("localhost")).toBe(true);
			expect(isLoopbackHost("::1")).toBe(true);
			expect(isLoopbackHost("0.0.0.0")).toBe(false);
			expect(isLoopbackHost("::")).toBe(false);
			expect(isLoopbackHost("127.0.0.2")).toBe(false);
			expect(isLoopbackHost("")).toBe(false);
		});
	});

	describe("startup refusal", () => {
		const hosts = ["0.0.0.0", "::", ...externalIPv4Addresses().slice(0, 1)];

		it.each(hosts)("refuses to start on %s and leaves no listener behind", async (host) => {
			const port = await freePort();
			const server = build(host, port);

			await expect(server.start()).rejects.toThrow(
				/Refusing to start speech service on non-loopback host/,
			);

			// If start() had opened a socket before throwing, this bind would fail.
			const probe = createServer();
			sockets.push(probe);
			await expect(listen(probe, port, "0.0.0.0")).resolves.toBe(port);
		});
	});

	describe("external reachability sweep", () => {
		it("is reachable on loopback and refused on every observable external address", async (ctx) => {
			const speech = build("127.0.0.1", 0);
			await speech.start();

			// Anti-vacuity, part one: the port must really be live, otherwise every
			// refusal below would be a refusal of nothing.
			const loopback = await attemptConnect("127.0.0.1", speech.port);
			expect(loopback.connected).toBe(true);

			const control = createServer((socket) => socket.end());
			sockets.push(control);
			const controlPort = await listen(control, 0, "0.0.0.0");

			const observable: string[] = [];
			const unobservable: string[] = [];
			for (const address of externalIPv4Addresses()) {
				const reachable = await attemptConnect(address, controlPort);
				// A control that cannot be reached (host firewall, odd interface)
				// means this address can observe nothing. Exclude it; never count
				// it as a pass.
				if (reachable.connected) observable.push(address);
				else unobservable.push(`${address} (control: ${reachable.code})`);
			}

			if (observable.length === 0) {
				const criterion =
					"A26 UNPROVEN: no external address could observe the 0.0.0.0 control server, so loopback-only behaviour was not demonstrated on this host. Re-run on a host with a LAN or Tailscale address.";
				if (process.env["CODEMOTE_SPEECH_LOOPBACK_SWEEP"] === "skip") {
					console.warn(criterion);
					ctx.skip();
					return;
				}
				// Default to failure: a false green here ships an unauthenticated
				// open speech service.
				throw new Error(
					`${criterion} Excluded addresses: ${unobservable.join(", ") || "none found"}`,
				);
			}

			const results: string[] = [];
			for (const address of observable) {
				const outcome = await attemptConnect(address, speech.port);
				results.push(
					`${address}\tcontrol(0.0.0.0): REACHABLE | speech(127.0.0.1): ${
						outcome.connected ? "CONNECTED" : outcome.code
					}`,
				);
				expect(outcome.connected).toBe(false);
				expect(REFUSED_CODES).toContain(outcome.code);
			}
			console.log(
				`[A26] speech port ${speech.port}, control port ${controlPort}\n${results.join("\n")}`,
			);
		});
	});
});
