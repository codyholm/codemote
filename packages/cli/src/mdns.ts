/**
 * mDNS/Bonjour service advertisement for Codemote
 * Advertises the service on the local network for iOS discovery
 */

import os from "node:os";
import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";
import { DnsSdAdvertiser } from "./mdns-dnssd.js";

/**
 * Configuration for advertising the Codemote service
 */
export interface ServiceConfig {
	/** Port number where the service is listening */
	port: number;
	/** Canonical onboarding token: 6-digit numeric PIN */
	pin: string;
	/** Back-compat token field */
	pairingCode?: string;
	/** Protocol version (default: "1") */
	version?: string;
}

/**
 * Strategy interface for mDNS service advertisement.
 * Platform-specific implementations handle the details of registering
 * and tearing down the service record.
 */
export interface MDNSAdvertiser {
	advertise(config: ServiceConfig): void;
	updatePairingCode(newPairingCode: string): void;
	stop(): void;
	destroy(): Promise<void>;
	isAdvertising(): boolean;
	getConfig(): ServiceConfig | null;
}

/**
 * Advertises Codemote service via the bonjour-service npm package.
 * Works cross-platform but runs its own mDNS responder on port 5353,
 * which can conflict with macOS's built-in mDNSResponder.
 */
export class BonjourAdvertiser implements MDNSAdvertiser {
	private bonjour: Bonjour;
	private service: Service | null = null;
	private currentConfig: ServiceConfig | null = null;

	constructor() {
		this.bonjour = new Bonjour();
	}

	/**
	 * Advertises the Codemote service on the local network
	 * @param config - Service configuration including port and pairing code
	 */
	advertise(config: ServiceConfig): void {
		// Stop existing service if running
		if (this.service) {
			this.stop();
		}

		const { port, pin, pairingCode, version = "1" } = config;
		const token = pairingCode ?? pin;
		// Store config with version included
		this.currentConfig = { port, pin: token, pairingCode: token, version };

		this.service = this.bonjour.publish({
			name: `Codemote on ${os.hostname()}`,
			type: "codemote", // becomes _codemote._tcp
			port,
			txt: {
				version,
				hostname: os.hostname(),
				port: String(port),
			},
		});
	}

	/**
	 * Updates the pairing code used for pairing
	 * Stops and re-advertises the service with the new code
	 * @param newPairingCode - New pairing code to advertise
	 */
	updatePairingCode(newPairingCode: string): void {
		if (!this.currentConfig) {
			throw new Error("Cannot update pairing code: service is not currently advertising");
		}

		this.advertise({
			...this.currentConfig,
			pin: newPairingCode,
			pairingCode: newPairingCode,
		});
	}

	/**
	 * Stops advertising the service and cleans up resources
	 */
	stop(): void {
		this.service?.stop?.();
		this.service = null;
		this.currentConfig = null;
	}

	/**
	 * Destroys the Bonjour instance and stops all services.
	 * Waits for goodbye packets (TTL=0) before closing the socket.
	 */
	async destroy(): Promise<void> {
		if (!this.service) {
			try {
				this.bonjour.destroy();
			} catch {
				// Already destroyed
			}
			return;
		}
		const goodbyeTimeout = 2000;
		await Promise.race([
			new Promise<void>((resolve) => {
				this.bonjour.unpublishAll(() => resolve());
			}),
			new Promise<void>((resolve) => setTimeout(resolve, goodbyeTimeout)),
		]);
		this.bonjour.destroy();
		this.service = null;
		this.currentConfig = null;
	}

	/**
	 * Checks if the service is currently advertising
	 */
	isAdvertising(): boolean {
		return this.service !== null;
	}

	/**
	 * Gets the current service configuration
	 */
	getConfig(): ServiceConfig | null {
		return this.currentConfig ? { ...this.currentConfig } : null;
	}
}

/**
 * Creates a platform-appropriate mDNS advertiser.
 * On macOS, uses dns-sd(1) to delegate to the OS mDNSResponder.
 * On other platforms, uses bonjour-service.
 */
export function createAdvertiser(): MDNSAdvertiser {
	if (process.platform === "darwin") {
		return new DnsSdAdvertiser();
	}
	return new BonjourAdvertiser();
}

/** @deprecated Use createAdvertiser() instead */
export function advertiseService(port: number, pin: string): MDNSAdvertiser {
	const advertiser = createAdvertiser();
	advertiser.advertise({ port, pin });
	return advertiser;
}
