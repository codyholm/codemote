/**
 * Example usage of mDNS service advertisement
 * Run with: tsx src/mdns.example.ts
 */

import { BonjourAdvertiser, createAdvertiser } from "./mdns.js";
import { generatePIN } from "./pairing.js";

// Example 1: Quick start with factory function
function quickExample() {
	console.log("Example 1: Quick Start");
	console.log("======================\n");

	const pin = generatePIN();
	const port = 3000;

	console.log(`Advertising Codemote service on port ${port}`);
	console.log(`PIN: ${pin}\n`);

	const advertiser = createAdvertiser();
	advertiser.advertise({ port, pin });

	// Service is now discoverable on the local network
	console.log("Service is advertising...");
	console.log("iOS app can discover this via _codemote._tcp.local\n");

	// Clean up after 5 seconds
	setTimeout(async () => {
		console.log("Stopping advertisement...");
		await advertiser.destroy();
		console.log("Done.\n");
	}, 5000);
}

// Example 2: Full control with BonjourAdvertiser class
function advancedExample() {
	console.log("Example 2: Advanced Usage");
	console.log("=========================\n");

	const advertiser = new BonjourAdvertiser();

	// Start advertising
	const config = {
		port: 3000,
		pin: generatePIN(),
		version: "1",
	};

	console.log("Starting service advertisement...");
	console.log(`Config: ${JSON.stringify(config, null, 2)}\n`);

	advertiser.advertise(config);

	// Check status
	console.log(`Is advertising: ${advertiser.isAdvertising()}`);
	console.log(`Current config: ${JSON.stringify(advertiser.getConfig(), null, 2)}\n`);

	// Simulate PIN regeneration after 3 seconds
	setTimeout(() => {
		const newPIN = generatePIN();
		console.log(`Regenerating PIN to: ${newPIN}`);
		advertiser.updatePairingCode(newPIN);
		console.log(`Updated config: ${JSON.stringify(advertiser.getConfig(), null, 2)}\n`);
	}, 3000);

	// Stop after 6 seconds
	setTimeout(async () => {
		console.log("Stopping service...");
		await advertiser.destroy();
		console.log(`Is advertising: ${advertiser.isAdvertising()}`);
		console.log("Done.");
	}, 6000);
}

// Example 3: Automatic PIN rotation
function pinRotationExample() {
	console.log("Example 3: Automatic PIN Rotation");
	console.log("==================================\n");

	const advertiser = createAdvertiser();
	let currentPIN = generatePIN();

	// Start advertising
	advertiser.advertise({
		port: 3000,
		pin: currentPIN,
	});

	console.log(`Initial PIN: ${currentPIN}`);
	console.log("Waiting for PIN rotation (every 10 seconds)...\n");

	const interval = setInterval(() => {
		currentPIN = generatePIN();
		console.log(`PIN regenerated: ${currentPIN}`);
		if (advertiser.isAdvertising()) {
			advertiser.updatePairingCode(currentPIN);
			console.log("mDNS advertisement updated with new PIN");
		}
	}, 10_000);

	// Run for 25 seconds to see 2 rotations
	setTimeout(async () => {
		console.log("\nCleaning up...");
		clearInterval(interval);
		await advertiser.destroy();
		console.log("Done.");
	}, 25_000);
}

// Run examples
if (import.meta.url === `file://${process.argv[1]}`) {
	console.log("Codemote mDNS Examples");
	console.log("==========================\n");

	// Run quick example
	// quickExample();

	// Or run advanced example
	// advancedExample();

	// Or run PIN rotation example
	pinRotationExample();
}
