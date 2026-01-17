/**
 * Example: Starting a combined relay + uplink server
 *
 * This demonstrates how to use the server integration to run
 * both relay and uplink in a single process with PIN-based pairing.
 *
 * Run this example:
 * ```bash
 * npx tsx src/server-example.ts
 * ```
 */

import { generateQRCode } from "./qrcode.js";
import { startServer } from "./server.js";

async function main() {
	console.log("Starting Guild Remote server...\n");

	// Start the server
	const server = await startServer({
		port: 8080,
		repoPath: process.cwd(),
		runtimes: ["opencode"],

		// Callback when PIN regenerates (every 5 minutes)
		onPINRegenerate: async (pin) => {
			console.log("\n🔄 PIN regenerated");
			await displayPIN(pin);
		},

		// Callback when clients connect
		onClientConnected: () => {
			console.log("\n📱 Client connected!");
		},
	});

	// Display initial PIN
	await displayPIN(server.pin);

	// Handle graceful shutdown
	process.on("SIGINT", async () => {
		console.log("\n\nShutting down...");
		await server.stop();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		console.log("\n\nShutting down...");
		await server.stop();
		process.exit(0);
	});

	// Periodically display stats
	setInterval(async () => {
		try {
			const stats = await server.getStats();
			console.log(`\n[Stats] Rooms: ${stats.rooms}, Connections: ${stats.connections}`);
		} catch (error) {
			console.error("Failed to get stats:", error);
		}
	}, 30_000); // Every 30 seconds

	console.log("\nServer running. Press Ctrl+C to stop.");
}

async function displayPIN(pin: string) {
	console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log("📱 PAIRING PIN");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`\n   PIN: ${pin.split("").join(" ")}`);
	console.log("\n   Valid for: 5 minutes");
	console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

	// Optionally display QR code
	try {
		const qrData = {
			pin,
			url: "ws://localhost:8080/ws",
		};
		console.log("QR Code for mobile app:");
		const qrCode = await generateQRCode(JSON.stringify(qrData));
		console.log(qrCode);
	} catch (error) {
		console.log("(QR code generation failed)");
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
