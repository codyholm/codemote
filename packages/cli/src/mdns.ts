/**
 * mDNS/Bonjour service advertisement for Guild Remote
 * Advertises the service on the local network for iOS discovery
 */

import os from "node:os";
import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";

/**
 * Configuration for advertising the Guild Remote service
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
 * Advertises Guild Remote service via mDNS/Bonjour
 * iOS apps discover this service using _guildremote._tcp.local
 */
export class MDNSAdvertiser {
	private bonjour: Bonjour;
	private service: Service | null = null;
	private currentConfig: ServiceConfig | null = null;

	constructor() {
		this.bonjour = new Bonjour();
	}

	/**
	 * Advertises the Guild Remote service on the local network
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
			name: `Guild Remote on ${os.hostname()}`,
			type: "guildremote", // becomes _guildremote._tcp
			port,
			txt: {
				pin: token,
				pairingCode: token,
				version,
				hostname: os.hostname(),
			},
		});
	}

	/**
	 * Updates the pairing code in TXT records
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
	 * Destroys the Bonjour instance and stops all services
	 * Should be called when completely shutting down
	 */
	destroy(): void {
		this.stop();
		this.bonjour.destroy();
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
 * Convenience function to quickly advertise a service
 * @param port - Port number where the service is listening
 * @param pin - Pairing PIN for authentication
 * @returns MDNSAdvertiser instance (remember to call destroy() when done)
 */
export function advertiseService(port: number, pin: string): MDNSAdvertiser {
	const advertiser = new MDNSAdvertiser();
	advertiser.advertise({ port, pin });
	return advertiser;
}
