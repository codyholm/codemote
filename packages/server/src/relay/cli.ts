#!/usr/bin/env node

import { createRelayServer } from "./server.js";

async function main() {
	const port = Number.parseInt(process.env["PORT"] || "8080", 10);
	const host = process.env["HOST"] || "0.0.0.0";
	const pairingStorePath = process.env["CODEMOTE_PAIRING_STORE_PATH"] ?? process.env["DB_PATH"];
	const tlsKeyPath = process.env["TLS_KEY_PATH"];
	const tlsCertPath = process.env["TLS_CERT_PATH"];

	if ((tlsKeyPath && !tlsCertPath) || (!tlsKeyPath && tlsCertPath)) {
		throw new Error("To enable TLS, set both TLS_KEY_PATH and TLS_CERT_PATH.");
	}

	console.log("Codemote Relay Server");
	console.log("=========================\n");
	console.log("Zero-knowledge relay for encrypted message routing.\n");

	const server = await createRelayServer({
		port,
		host,
		...(pairingStorePath && { pairingStorePath }),
		...(tlsKeyPath && tlsCertPath
			? {
					tls: {
						keyPath: tlsKeyPath,
						certPath: tlsCertPath,
					},
				}
			: {}),
	});

	// Graceful shutdown handlers
	process.on("SIGINT", async () => {
		console.log("\nShutting down...");
		await server.stop();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await server.stop();
		process.exit(0);
	});

	await server.start();
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
