import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import selfsigned from "selfsigned";

export type LocalTLSInfo = {
	certPath: string;
	keyPath: string;
	tlsPin: string;
	/** Certificate `validTo` as epoch millis (UTC). */
	certValidToMs: number;
	status: "existing" | "generated" | "regenerated";
	regenerateReason?: "missing" | "expired" | "invalid";
};

export type EnsureLocalTLSOptions = {
	/**
	 * Defaults to `~/.codemote/tls`.
	 *
	 * Primarily intended for tests.
	 */
	tlsDir?: string;
};

function defaultTLSDir(): string {
	return path.join(os.homedir(), ".codemote", "tls");
}

function tlsPinFromDer(derBytes: Buffer): string {
	return crypto.createHash("sha256").update(derBytes).digest("hex");
}

function tlsPinFromCertPEM(certPem: string): string {
	const leaf = new crypto.X509Certificate(certPem);
	return tlsPinFromDer(leaf.raw);
}

/**
 * Fetch the active leaf certificate pin from a remote WSS relay.
 *
 * Intended for embedding a trust pin into QR/deep links when running against
 * a hosted relay endpoint.
 */
export async function fetchRelayTlsPin(relayUrl: string, timeoutMs = 5_000): Promise<string> {
	const parsed = new URL(relayUrl);
	if (parsed.protocol.toLowerCase() !== "wss:") {
		throw new Error("Relay URL must use wss:// to derive a TLS pin");
	}
	const allowInsecureRelayPinFetch =
		process.env["GUILD_REMOTE_ALLOW_INSECURE_RELAY_PIN_FETCH"] === "1" ||
		process.env["GUILD_REMOTE_ALLOW_INSECURE_RELAY_PIN_FETCH"] === "true";
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
	if (!Number.isFinite(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid relay port in URL: ${relayUrl}`);
	}

	return await new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (result: string): void => {
			if (settled) return;
			settled = true;
			socket.end();
			resolve(result);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(error);
		};
		const socket = tls.connect(
			{
				host: parsed.hostname,
				port,
				servername: parsed.hostname,
				rejectUnauthorized: !allowInsecureRelayPinFetch,
			},
			() => {
				const cert = socket.getPeerCertificate(true) as { raw?: Buffer };
				if (!cert.raw) {
					fail(new Error(`No peer certificate presented by relay ${relayUrl}`));
					return;
				}
				finish(tlsPinFromDer(cert.raw));
			},
		);
		socket.setTimeout(timeoutMs, () => {
			fail(new Error(`Timed out retrieving relay certificate from ${relayUrl}`));
		});
		socket.on("error", fail);
	});
}

/**
 * Derive a short, human-checkable verification code from a TLS pin.
 *
 * The code is not a secret; it is intended for out-of-band comparison on first connect.
 */
export function verifyCodeFromTlsPin(tlsPin: string): string {
	if (!/^[0-9a-f]{64}$/i.test(tlsPin)) {
		throw new Error("Invalid tlsPin (expected 64 hex chars)");
	}

	const bytes = Buffer.from(tlsPin, "hex");
	const value = bytes.readUInt32BE(0);
	return String(value % 10_000).padStart(4, "0");
}

function certValidToMs(certPem: string): number {
	const leaf = new crypto.X509Certificate(certPem);
	const ms = Date.parse(leaf.validTo);
	if (!Number.isFinite(ms)) {
		throw new Error("Failed to parse certificate validTo");
	}
	return ms;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return undefined;
		}
		throw err;
	}
}

function generateSelfSigned(): { certPem: string; keyPem: string } {
	const attrs = [{ name: "commonName", value: "codemote" }];

	const pems = selfsigned.generate(attrs, {
		algorithm: "sha256",
		// 1 year validity; auto-regenerate on expiry (re-pair required).
		days: 365,
		keySize: 2048,
		extensions: [
			{ name: "basicConstraints", cA: false },
			{
				name: "keyUsage",
				digitalSignature: true,
				keyEncipherment: true,
			},
			{ name: "extKeyUsage", serverAuth: true },
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					{ type: 2, value: "codemote.local" },
					{ type: 7, ip: "127.0.0.1" },
				],
			},
		],
	});

	return { certPem: pems.cert, keyPem: pems.private };
}

/**
 * Ensures a persisted self-signed certificate exists for LAN TLS.
 *
 * Default location:
 * - `~/.codemote/tls/cert.pem`
 * - `~/.codemote/tls/key.pem`
 *
 * `tlsPin` is SHA-256 of the leaf certificate DER (hex).
 */
export async function ensureLocalTLS(options: EnsureLocalTLSOptions = {}): Promise<LocalTLSInfo> {
	const tlsDir = options.tlsDir ?? defaultTLSDir();
	const certPath = path.join(tlsDir, "cert.pem");
	const keyPath = path.join(tlsDir, "key.pem");

	await fs.mkdir(tlsDir, { recursive: true, mode: 0o700 });

	const existingCertPem = await readFileIfExists(certPath);
	const existingKeyPem = await readFileIfExists(keyPath);

	const now = Date.now();
	if (existingCertPem && existingKeyPem) {
		try {
			const validToMs = certValidToMs(existingCertPem);
			if (validToMs <= now) {
				throw new Error("expired");
			}
			const tlsPin = tlsPinFromCertPEM(existingCertPem);
			return {
				certPath,
				keyPath,
				tlsPin,
				certValidToMs: validToMs,
				status: "existing",
			};
		} catch (err) {
			const reason: LocalTLSInfo["regenerateReason"] =
				err instanceof Error && err.message === "expired" ? "expired" : "invalid";
			const { certPem, keyPem } = generateSelfSigned();
			await fs.writeFile(keyPath, keyPem, { encoding: "utf8", mode: 0o600 });
			await fs.writeFile(certPath, certPem, { encoding: "utf8", mode: 0o644 });
			return {
				certPath,
				keyPath,
				tlsPin: tlsPinFromCertPEM(certPem),
				certValidToMs: certValidToMs(certPem),
				status: "regenerated",
				regenerateReason: reason,
			};
		}
	}

	const { certPem, keyPem } = generateSelfSigned();
	await fs.writeFile(keyPath, keyPem, { encoding: "utf8", mode: 0o600 });
	await fs.writeFile(certPath, certPem, { encoding: "utf8", mode: 0o644 });
	return {
		certPath,
		keyPath,
		tlsPin: tlsPinFromCertPEM(certPem),
		certValidToMs: certValidToMs(certPem),
		status: "generated",
		regenerateReason: "missing",
	};
}
