/**
 * codemote - CLI tools for Codemote
 */

export {
	generatePIN,
	RateLimiter,
	type RateLimiterConfig,
	type RateLimitResult,
} from "./pairing.js";

export {
	MDNSAdvertiser,
	advertiseService,
	type ServiceConfig,
} from "./mdns.js";

export {
	startServer,
	type ServerConfig,
	type ServerHandle,
} from "./server.js";

export {
	renderUI,
	updateStatus,
	formatPIN,
	formatPairingCode,
	type UIState,
} from "./ui.js";

export {
	generateQRCode,
	buildPairingURL,
	getLocalIP,
} from "./qrcode.js";

export { ensureLocalTLS, type EnsureLocalTLSOptions, type LocalTLSInfo } from "./tls.js";
