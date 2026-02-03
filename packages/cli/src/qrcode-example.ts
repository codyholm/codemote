/**
 * Example usage of QR code generation
 * Run with: node dist/qrcode-example.js
 */
import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";

async function main() {
	// Example configuration
	const port = 3000;
	const pin = "123456";

	// Get local IP
	const host = getLocalIP();
	console.log(`Local IP: ${host}`);

	// Build pairing URL
	const url = buildPairingURL(host, port, pin);
	console.log(`Pairing URL: ${url}`);

	// Generate and display QR code
	console.log("\nScan this QR code with the Codemote mobile app:\n");
	const qrCode = await generateQRCode(url);
	console.log(qrCode);

	console.log(`\nPIN: ${pin}`);
	console.log(`Port: ${port}`);
}

main().catch(console.error);
