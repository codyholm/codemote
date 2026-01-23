import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
	 * Defaults to `~/.guild-remote/tls`.
	 *
	 * Primarily intended for tests.
	 */
	tlsDir?: string;
};

function defaultTLSDir(): string {
	return path.join(os.homedir(), ".guild-remote", "tls");
}

function tlsPinFromCertPEM(certPem: string): string {
	const leaf = new crypto.X509Certificate(certPem);
	return crypto.createHash("sha256").update(leaf.raw).digest("hex");
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
	const attrs = [{ name: "commonName", value: "guild-remote" }];

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
					{ type: 2, value: "guild-remote.local" },
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
 * - `~/.guild-remote/tls/cert.pem`
 * - `~/.guild-remote/tls/key.pem`
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
