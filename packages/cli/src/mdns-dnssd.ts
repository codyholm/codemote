/**
 * macOS-native mDNS advertiser using dns-sd(1)
 *
 * Delegates to the OS's own mDNSResponder via `dns-sd -R`, avoiding the
 * competing UDP socket that bonjour-service creates on port 5353. This
 * eliminates hostname collisions and the LocalHostName rename popup that
 * occurs when two responders claim the same A records.
 *
 * mDNSResponder automatically sends goodbye packets (TTL=0) when the
 * dns-sd child process is killed — no manual teardown needed.
 */

import { execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import type { MDNSAdvertiser, ServiceConfig } from "./mdns.js";

let cachedHostname: string | null = null;

/**
 * Returns the stable ComputerName (e.g. "Cody's MacBook Air") via scutil.
 * Unlike os.hostname() which returns LocalHostName and changes on mDNS
 * collisions, ComputerName only changes when the user explicitly renames
 * their Mac in System Settings.
 */
function getStableHostname(): string {
	if (cachedHostname) return cachedHostname;
	try {
		cachedHostname = execSync("scutil --get ComputerName", {
			encoding: "utf-8",
		}).trim();
	} catch {
		cachedHostname = os.hostname();
	}
	return cachedHostname;
}

export class DnsSdAdvertiser implements MDNSAdvertiser {
	private child: ChildProcess | null = null;
	private currentConfig: ServiceConfig | null = null;

	advertise(config: ServiceConfig): void {
		if (this.child) {
			this.stop();
		}

		const { port, pin, pairingCode, version = "1" } = config;
		const token = pairingCode ?? pin;
		this.currentConfig = { port, pin: token, pairingCode: token, version };

		const serviceName = `Codemote on ${getStableHostname()}`;
		const args = [
			"-R",
			serviceName,
			"_codemote._tcp",
			"local",
			String(port),
			`version=${version}`,
			`hostname=${os.hostname()}`,
			`port=${String(port)}`,
		];

		const child = spawn("dns-sd", args, { stdio: "ignore" });

		child.on("error", (err) => {
			console.error(`[mDNS] dns-sd spawn failed: ${err.message}`);
			this.child = null;
			this.currentConfig = null;
		});

		child.on("exit", (code) => {
			// Only log if this was unexpected (not triggered by our stop())
			if (this.child !== null) {
				console.error(`[mDNS] dns-sd process exited unexpectedly (code ${code})`);
				this.child = null;
				this.currentConfig = null;
			}
		});

		this.child = child;
	}

	stop(): void {
		if (!this.child) return;

		const proc = this.child;
		// Clear state before killing so exit handler doesn't log "unexpected"
		this.child = null;
		this.currentConfig = null;
		proc.kill("SIGTERM");
	}

	async destroy(): Promise<void> {
		this.stop();
	}

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

	isAdvertising(): boolean {
		return this.child !== null;
	}

	getConfig(): ServiceConfig | null {
		return this.currentConfig ? { ...this.currentConfig } : null;
	}
}
