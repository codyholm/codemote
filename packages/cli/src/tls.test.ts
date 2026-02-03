import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalTLS } from "./tls.js";

function tlsPinFromCertPEM(certPem: string): string {
	const leaf = new crypto.X509Certificate(certPem);
	return crypto.createHash("sha256").update(leaf.raw).digest("hex");
}

describe("ensureLocalTLS", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemote-tls-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("creates a persisted cert/key and returns a deterministic tlsPin", async () => {
		const first = await ensureLocalTLS({ tlsDir: tmpDir });
		expect(first.tlsPin).toMatch(/^[0-9a-f]{64}$/);
		expect(first.certValidToMs).toBeGreaterThan(Date.now());
		expect(first.status).toBe("generated");
		expect(first.regenerateReason).toBe("missing");

		const certPem1 = await fs.readFile(first.certPath, "utf8");
		const keyPem1 = await fs.readFile(first.keyPath, "utf8");
		expect(certPem1).toContain("BEGIN CERTIFICATE");
		expect(keyPem1).toMatch(/BEGIN (RSA )?PRIVATE KEY/);
		expect(tlsPinFromCertPEM(certPem1)).toBe(first.tlsPin);

		const second = await ensureLocalTLS({ tlsDir: tmpDir });
		const certPem2 = await fs.readFile(second.certPath, "utf8");
		const keyPem2 = await fs.readFile(second.keyPath, "utf8");

		expect(second.tlsPin).toBe(first.tlsPin);
		expect(certPem2).toBe(certPem1);
		expect(keyPem2).toBe(keyPem1);
		expect(second.status).toBe("existing");
	});

	it("regenerates if existing files are invalid", async () => {
		await fs.writeFile(path.join(tmpDir, "cert.pem"), "not a cert", "utf8");
		await fs.writeFile(path.join(tmpDir, "key.pem"), "not a key", "utf8");

		const info = await ensureLocalTLS({ tlsDir: tmpDir });
		expect(info.tlsPin).toMatch(/^[0-9a-f]{64}$/);
		expect(info.certValidToMs).toBeGreaterThan(Date.now());
		expect(info.status).toBe("regenerated");
		expect(info.regenerateReason).toBe("invalid");

		const certPem = await fs.readFile(info.certPath, "utf8");
		expect(certPem).toContain("BEGIN CERTIFICATE");
	});
});
