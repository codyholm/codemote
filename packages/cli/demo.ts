/**
 * Demo script showing PIN generation and rate limiting
 */

import { RateLimiter, generatePIN } from "./src/index.js";

console.log("=== PIN Generation Demo ===\n");

// Generate some PINs
console.log("Generated PINs:");
for (let i = 0; i < 5; i++) {
	console.log(`  ${generatePIN()}`);
}

console.log("\n=== Rate Limiter Demo ===\n");

// Create rate limiter
const limiter = new RateLimiter({
	maxAttempts: 3,
	windowMs: 60_000,
	backoffMs: [1000, 2000, 4000],
	lockoutMs: 5000,
});

async function attemptPairing(clientIP: string, success: boolean) {
	const result = await limiter.checkAndRecord(clientIP, success);
	console.log(`Attempt for ${clientIP}: ${result.allowed ? "ALLOWED" : "BLOCKED"}`);
	if (!result.allowed) {
		console.log(`  Reason: ${result.message}`);
		console.log(`  Wait: ${result.waitMs}ms`);
	}
}

// Simulate failed attempts
await attemptPairing("192.168.1.1", false);
await attemptPairing("192.168.1.1", false); // Should be blocked immediately
console.log("");

console.log("\n=== Demo Complete ===");
