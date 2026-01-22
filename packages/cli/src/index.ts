/**
 * @guild-remote/cli - CLI tools for Guild Remote
 */

export {
	generatePIN,
	RateLimiter,
	PINManager,
	type RateLimiterConfig,
	type RateLimitResult,
	type OnRegenerateCallback,
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
