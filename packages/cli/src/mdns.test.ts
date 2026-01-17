/**
 * Tests for mDNS service advertisement
 */

import { Bonjour } from "bonjour-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MDNSAdvertiser, advertiseService } from "./mdns.js";

describe("MDNSAdvertiser", () => {
	let advertiser: MDNSAdvertiser;

	beforeEach(() => {
		advertiser = new MDNSAdvertiser();
	});

	afterEach(() => {
		if (advertiser) {
			advertiser.destroy();
		}
	});

	describe("advertise", () => {
		it("should advertise a service with required config", () => {
			const config = {
				port: 3000,
				pin: "123456",
			};

			advertiser.advertise(config);

			expect(advertiser.isAdvertising()).toBe(true);
			const currentConfig = advertiser.getConfig();
			expect(currentConfig).toEqual({
				port: 3000,
				pin: "123456",
				pairingCode: "123456",
				version: "1",
			});
		});

		it("should advertise with custom version", () => {
			const config = {
				port: 3000,
				pin: "123456",
				version: "2",
			};

			advertiser.advertise(config);

			expect(advertiser.isAdvertising()).toBe(true);
			const currentConfig = advertiser.getConfig();
			expect(currentConfig?.version).toBe("2");
		});

		it("should stop previous service when advertising again", () => {
			advertiser.advertise({ port: 3000, pin: "111111" });
			const firstConfig = advertiser.getConfig();

			advertiser.advertise({ port: 3001, pin: "222222" });
			const secondConfig = advertiser.getConfig();

			expect(secondConfig?.port).toBe(3001);
			expect(secondConfig?.pairingCode).toBe("222222");
			expect(firstConfig?.port).toBe(3000);
		});
	});

	describe("updatePairingCode", () => {
		it("should update the PIN and re-advertise", () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			advertiser.updatePairingCode("654321");

			const config = advertiser.getConfig();
			expect(config?.pairingCode).toBe("654321");
			expect(config?.port).toBe(3000); // Port should remain the same
			expect(advertiser.isAdvertising()).toBe(true);
		});

		it("should throw error if not advertising", () => {
			expect(() => advertiser.updatePairingCode("654321")).toThrow(
				"Cannot update pairing code: service is not currently advertising",
			);
		});
	});

	describe("stop", () => {
		it("should stop advertising", () => {
			advertiser.advertise({ port: 3000, pin: "123456" });
			expect(advertiser.isAdvertising()).toBe(true);

			advertiser.stop();

			expect(advertiser.isAdvertising()).toBe(false);
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should be safe to call stop multiple times", () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			advertiser.stop();
			advertiser.stop();

			expect(advertiser.isAdvertising()).toBe(false);
		});

		it("should be safe to call stop without advertising", () => {
			expect(() => advertiser.stop()).not.toThrow();
			expect(advertiser.isAdvertising()).toBe(false);
		});
	});

	describe("destroy", () => {
		it("should stop service and destroy bonjour instance", () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			advertiser.destroy();

			expect(advertiser.isAdvertising()).toBe(false);
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should be safe to call destroy multiple times", () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			advertiser.destroy();
			advertiser.destroy();

			expect(advertiser.isAdvertising()).toBe(false);
		});
	});

	describe("getConfig", () => {
		it("should return null when not advertising", () => {
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should return a copy of the config", () => {
			const originalConfig = { port: 3000, pin: "123456" };
			advertiser.advertise(originalConfig);

			const config = advertiser.getConfig();
			expect(config).not.toBe(originalConfig); // Different object reference
			expect(config).toEqual({
				port: 3000,
				pin: "123456",
				pairingCode: "123456",
				version: "1",
			});
		});
	});
});

describe("advertiseService", () => {
	it("should create and advertise a service", () => {
		const advertiser = advertiseService(3000, "123456");

		expect(advertiser.isAdvertising()).toBe(true);
		expect(advertiser.getConfig()).toEqual({
			port: 3000,
			pin: "123456",
			pairingCode: "123456",
			version: "1",
		});

		advertiser.destroy();
	});
});

describe("Integration: Service Discovery", () => {
	it("should be discoverable by another Bonjour instance", async () => {
		const advertiser = new MDNSAdvertiser();
		advertiser.advertise({
			port: 3000,
			pin: "123456",
		});

		// Give the service time to publish
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				const browser = new Bonjour();
				const finder = browser.find({ type: "guildremote" });

				finder.on("up", (service) => {
					expect(service.type).toBe("guildremote");
					expect(service.port).toBe(3000);
					expect(service.txt?.pin).toBe("123456");
					expect(service.txt?.version).toBe("1");

					// Cleanup
					finder.stop?.();
					browser.destroy();
					advertiser.destroy();
					resolve();
				});
			}, 100);
		});
	}, 5000); // 5 second timeout for network operations
});
