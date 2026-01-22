#!/usr/bin/env node

/**
 * CLI Entry Point for Guild Remote
 *
 * Main executable that starts the server, displays the UI, and handles
 * graceful shutdown. This is the entry point for `npx guild-remote`.
 *
 * RESPONSIBILITIES:
 * 1. Start relay + uplink server on configured port
 * 2. Generate QR code for mobile pairing
 * 3. Advertise service via mDNS/Bonjour
 * 4. Display terminal UI with status updates
 * 5. Graceful shutdown on SIGINT/SIGTERM
 *
 * USAGE:
 * ```bash
 * # Default port 8080
 * npx guild-remote
 *
 * # Custom port
 * PORT=3000 npx guild-remote
 * ```
 */

import { advertiseService } from "./mdns.js";
import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";
import { startServer } from "./server.js";
import { renderUI, updateStatus } from "./ui.js";

async function main() {
	const port = Number.parseInt(process.env["PORT"] || "8080", 10);

	console.log("Starting Guild Remote...");

	// Start the server (relay + uplink + bridge)
	const server = await startServer({
		port,
		onClientConnected: () => {
			updateStatus("   ✓ Device connected");
		},
	});

	// Get local IP and build QR code URL
	const host = getLocalIP();
	const pairingURL = buildPairingURL(host, port, server.pin);
	const qrCode = await generateQRCode(pairingURL);

	// Start mDNS advertisement
	const mdns = advertiseService(port, server.pin);

	console.log(`[CLI] mDNS advertising on port ${port}`);

	// Render the UI
	await renderUI({
		qrCode,
		pin: server.pin,
		localURL: `ws://${host}:${port}`,
		status: "ready",
	});

	// Handle shutdown
	const cleanup = async () => {
		console.log("\n[CLI] Shutting down...");
		mdns.destroy();
		await server.stop();
		console.log("[CLI] Goodbye!");
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// Keep process alive
	// The server and mDNS advertiser are now running in the background
}

main().catch((err) => {
	console.error("[CLI] Failed to start:", err);
	process.exit(1);
});
