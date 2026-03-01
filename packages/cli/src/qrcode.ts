import os from "node:os";
import qrcode from "qrcode-terminal";

/**
 * Build the deep link URL for pairing
 * @param host - IP address or hostname
 * @param port - Port number
 * @param pin - Pairing PIN (canonical)
 * @param options - Optional extra pairing metadata (TLS, relay URL)
 * @returns Deep link URL string
 */

export type BuildPairingURLOptions = {
	/**
	 * Certificate pin for the relay (sha256 leaf DER, hex64).
	 *
	 * This is delivered via QR for TOFU.
	 */
	tlsPin: string;
	/**
	 * Full relay URL, e.g. `wss://192.168.1.10:8080/ws`.
	 *
	 * If omitted, defaults to `wss://{host}:{port}/ws`.
	 */
	relayUrl?: string;
};

/**
 * Legacy deep link format.
 *
 * Does not include `tlsPin`. This overload is kept for back-compat/tests.
 */
export function buildPairingURL(host: string, port: number, pin: string): string;
export function buildPairingURL(
	host: string,
	port: number,
	pin: string,
	options: BuildPairingURLOptions,
): string;
export function buildPairingURL(
	host: string,
	port: number,
	pin: string,
	options?: BuildPairingURLOptions,
): string {
	// Back-compat: include both `pin` (canonical) and `code` (legacy)
	if (!options) {
		return `codemote://pair?host=${host}&port=${port}&pin=${pin}&code=${pin}`;
	}

	const relayUrl = options.relayUrl ?? `wss://${host}:${port}/ws`;
	const relayEncoded = encodeURIComponent(relayUrl);
	const tlsPinEncoded = encodeURIComponent(options.tlsPin);
	const pinEncoded = encodeURIComponent(pin);
	return `codemote://pair?host=${host}&port=${port}&relay=${relayEncoded}&pin=${pinEncoded}&tlsPin=${tlsPinEncoded}&code=${pinEncoded}`;
}

/**
 * Get local IP address from network interfaces.
 * Prefers common primary adapters on macOS/Linux (en0/eth0/en1/wlan0) and Windows (Ethernet/Wi-Fi),
 * excluding loopback, docker, and virtual interfaces.
 * @returns Local IP address or fallback to 127.0.0.1
 */
export function getLocalIP(): string {
	const interfaces = os.networkInterfaces();

	// Priority order for interface names
	const preferredInterfaces = ["en0", "eth0", "en1", "wlan0", "Ethernet", "Wi-Fi"];

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
			ifaceName.startsWith("vEthernet") ||
			ifaceName === "Loopback Pseudo-Interface 1" ||
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
