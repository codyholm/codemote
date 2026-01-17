/**
 * Example usage of the Terminal UI
 * Run with: npx tsx src/ui-example.ts
 */

import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";
import { renderUI } from "./ui.js";
import type { UIState } from "./ui.js";

async function demo() {
	// Generate pairing data
	const host = getLocalIP();
	const port = 3000;
	const pin = "847291"; // In production, generate random PIN
	const pairingURL = buildPairingURL(host, port, pin);
	const qrCode = await generateQRCode(pairingURL);

	// Initial state: starting
	const state: UIState = {
		qrCode,
		pin,
		localURL: `ws://${host}:${port}`,
		status: "starting",
	};

	await renderUI(state);

	// Simulate progression through states
	await sleep(1500);

	// State: ready
	state.status = "ready";
	await renderUI(state);

	await sleep(3000);

	// State: connected
	state.status = "connected";
	await renderUI(state);

	await sleep(2000);

	// Example error state
	state.status = "error";
	state.errorMessage = "Connection lost";
	await renderUI(state);

	await sleep(2000);

	// Return to ready
	state.status = "ready";
	state.errorMessage = "";
	await renderUI(state);

	console.log("\n✨ Demo complete!");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run demo
void demo().catch(console.error);
