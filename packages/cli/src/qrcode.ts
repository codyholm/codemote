import os from "node:os";
import qrcode from "qrcode-terminal";

/**
 * Build the deep link URL for pairing
 * @param host - IP address or hostname
 * @param port - Port number
 * @param pin - Pairing PIN (canonical)
 * @returns Deep link URL string
 */
export function buildPairingURL(host: string, port: number, pin: string): string {
	// Back-compat: include both `pin` (canonical) and `code` (legacy)
	return `guildremote://pair?host=${host}&port=${port}&pin=${pin}&code=${pin}`;
}

/**
 * Get local IP address from network interfaces
 * Prefers en0 (macOS) or eth0 (Linux), excludes loopback and docker interfaces
 * @returns Local IP address or fallback to 127.0.0.1
 */
export function getLocalIP(): string {
	const interfaces = os.networkInterfaces();

	// Priority order for interface names
	const preferredInterfaces = ["en0", "eth0", "en1", "wlan0"];

	// First pass: try preferred interfaces
	for (const ifaceName of preferredInterfaces) {
		const iface = interfaces[ifaceName];
		if (iface) {
			for (const addr of iface) {
				// IPv4, not internal, not link-local
				if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) {
					return addr.address;
				}
			}
		}
	}

	// Second pass: try any interface that's not docker, loopback, or virtual
	for (const [ifaceName, addresses] of Object.entries(interfaces)) {
		// Skip docker, virtual, and loopback interfaces
		if (
			ifaceName.startsWith("docker") ||
			ifaceName.startsWith("veth") ||
			ifaceName.startsWith("br-") ||
			ifaceName === "lo"
		) {
			continue;
		}

		if (addresses) {
			for (const addr of addresses) {
				// IPv4, not internal, not link-local
				if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) {
					return addr.address;
				}
			}
		}
	}

	// Fallback to localhost
	return "127.0.0.1";
}

/**
 * Generate QR code string for terminal display
 * @param url - URL to encode in QR code
 * @returns Promise resolving to QR code ASCII string
 */
export function generateQRCode(url: string): Promise<string> {
	return new Promise((resolve) => {
		qrcode.generate(url, { small: true }, (code: string) => {
			resolve(code);
		});
	});
}
