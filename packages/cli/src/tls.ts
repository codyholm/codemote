import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";

export type LocalTLSInfo = {
	certPath: string;
	keyPath: string;
	tlsPin: string;
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
		days: 3650,
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

	if (existingCertPem && existingKeyPem) {
		try {
			const tlsPin = tlsPinFromCertPEM(existingCertPem);
			return { certPath, keyPath, tlsPin };
		} catch {
			// fall through to regeneration
		}
	}

	const { certPem, keyPem } = generateSelfSigned();

	await fs.writeFile(keyPath, keyPem, { encoding: "utf8", mode: 0o600 });
	await fs.writeFile(certPath, certPem, { encoding: "utf8", mode: 0o644 });

	const tlsPin = tlsPinFromCertPEM(certPem);
	return { certPath, keyPath, tlsPin };
}
