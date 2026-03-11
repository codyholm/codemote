/**
 * Tests for mDNS service advertisement
 */

import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DnsSdAdvertiser } from "./mdns-dnssd.js";
import { BonjourAdvertiser, advertiseService, createAdvertiser } from "./mdns.js";

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		...actual,
		spawn: vi.fn(),
		execSync: vi.fn(),
	};
});

function createMockChild(): EventEmitter & {
	kill: ReturnType<typeof vi.fn>;
	pid: number;
	stdin: null;
	stdout: null;
	stderr: null;
	stdio: readonly [null, null, null];
} {
	return Object.assign(new EventEmitter(), {
		kill: vi.fn(),
		pid: 12345,
		stdin: null,
		stdout: null,
		stderr: null,
		stdio: [null, null, null] as const,
	});
}

/**
 * Provide a default mock child for spawn so tests that indirectly trigger
 * DnsSdAdvertiser (e.g. advertiseService on macOS) don't crash.
 */
beforeEach(() => {
	const defaultChild = createMockChild();
	vi.mocked(spawn).mockReturnValue(defaultChild as unknown as ChildProcess);
	vi.mocked(execSync).mockReturnValue("Test MacBook\n");
});

afterEach(() => {
	vi.mocked(spawn).mockReset();
	vi.mocked(execSync).mockReset();
});

const shouldRunMdnsIntegration = process.platform === "darwin" && !process.env["CI"];

describe("BonjourAdvertiser", () => {
	let advertiser: BonjourAdvertiser;
	let publishSpy: MockInstance<
		(...args: Parameters<Bonjour["publish"]>) => ReturnType<Bonjour["publish"]>
	>;

	beforeEach(() => {
		advertiser = new BonjourAdvertiser();

		const bonjour = (advertiser as unknown as { bonjour: Bonjour }).bonjour;
		const fakeService = { stop: vi.fn() } as unknown as Service;
		publishSpy = vi.spyOn(bonjour, "publish").mockReturnValue(fakeService);
	});

	afterEach(async () => {
		publishSpy?.mockRestore();
		if (advertiser) {
			await advertiser.destroy();
		}
	});

	describe("advertise", () => {
		it("should advertise a service with required config", () => {
			const config = {
				port: 3000,
				pin: "123456",
			};

			advertiser.advertise(config);

			const publishConfig = publishSpy.mock.calls[0]?.[0] as unknown as {
				port: number;
				txt?: Record<string, string>;
			};
			expect(publishConfig.port).toBe(3000);
			expect(publishConfig.txt).toEqual(
				expect.objectContaining({
					version: "1",
					hostname: expect.any(String),
					port: "3000",
				}),
			);
			expect(publishConfig.txt).not.toHaveProperty("pin");
			expect(publishConfig.txt).not.toHaveProperty("pairingCode");

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

			const publishConfig = publishSpy.mock.calls[0]?.[0] as unknown as {
				txt?: Record<string, string>;
			};
			expect(publishConfig.txt?.["version"]).toBe("2");

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
		it("should stop service and destroy bonjour instance", async () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			await advertiser.destroy();

			expect(advertiser.isAdvertising()).toBe(false);
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should be safe to call destroy multiple times", async () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			await advertiser.destroy();
			await advertiser.destroy();

			expect(advertiser.isAdvertising()).toBe(false);
		});

		it("should call unpublishAll before destroy on bonjour instance", async () => {
			const bonjour = (advertiser as unknown as { bonjour: Bonjour }).bonjour;
			const unpublishAllSpy = vi.spyOn(bonjour, "unpublishAll");
			const destroySpy = vi.spyOn(bonjour, "destroy");

			advertiser.advertise({ port: 3000, pin: "123456" });
			await advertiser.destroy();

			expect(unpublishAllSpy).toHaveBeenCalled();
			expect(destroySpy).toHaveBeenCalled();
		});

		it("should return a Promise that resolves", async () => {
			advertiser.advertise({ port: 3000, pin: "123456" });

			const result = advertiser.destroy();
			expect(result).toBeInstanceOf(Promise);
			await expect(result).resolves.toBeUndefined();
		});

		it("should resolve even if unpublishAll callback never fires", async () => {
			const bonjour = (advertiser as unknown as { bonjour: Bonjour }).bonjour;
			// Make unpublishAll never invoke its callback
			vi.spyOn(bonjour, "unpublishAll").mockImplementation(() => {
				// intentionally never call the callback
			});

			advertiser.advertise({ port: 3000, pin: "123456" });

			// destroy() should still resolve via the timeout path
			await expect(advertiser.destroy()).resolves.toBeUndefined();
		}, 5000);
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

describe("DnsSdAdvertiser", () => {
	let advertiser: DnsSdAdvertiser;
	let mockChild: ReturnType<typeof createMockChild>;

	beforeEach(() => {
		mockChild = createMockChild();
		vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);
		vi.mocked(execSync).mockReturnValue("Test MacBook\n");
		advertiser = new DnsSdAdvertiser();
	});

	afterEach(async () => {
		await advertiser.destroy();
	});

	describe("advertise", () => {
		it("should spawn dns-sd with correct arguments", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });

			expect(spawn).toHaveBeenCalledWith(
				"dns-sd",
				[
					"-R",
					"Codemote on Test MacBook",
					"_codemote._tcp",
					"local",
					"4000",
					"version=1",
					expect.stringContaining("hostname="),
					"port=4000",
				],
				{ stdio: "ignore" },
			);
		});
	});

	describe("stop", () => {
		it("should kill the child process with SIGTERM", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });
			expect(advertiser.isAdvertising()).toBe(true);

			advertiser.stop();

			expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
			expect(advertiser.isAdvertising()).toBe(false);
		});
	});

	describe("destroy", () => {
		it("should return a Promise and call stop internally", async () => {
			advertiser.advertise({ port: 4000, pin: "999888" });

			const result = advertiser.destroy();
			expect(result).toBeInstanceOf(Promise);
			await expect(result).resolves.toBeUndefined();
			expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
		});
	});

	describe("updatePairingCode", () => {
		it("should kill first child and spawn a new one", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });

			const secondChild = createMockChild();
			vi.mocked(spawn).mockReturnValue(secondChild as unknown as ChildProcess);

			advertiser.updatePairingCode("111222");

			// First child killed via stop(), second spawned via advertise()
			expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
			expect(spawn).toHaveBeenCalledTimes(2);
		});

		it("should throw if not currently advertising", () => {
			expect(() => advertiser.updatePairingCode("111222")).toThrow(
				"Cannot update pairing code: service is not currently advertising",
			);
		});
	});

	describe("isAdvertising", () => {
		it("should return true after advertise, false after stop", () => {
			expect(advertiser.isAdvertising()).toBe(false);

			advertiser.advertise({ port: 4000, pin: "999888" });
			expect(advertiser.isAdvertising()).toBe(true);

			advertiser.stop();
			expect(advertiser.isAdvertising()).toBe(false);
		});
	});

	describe("getConfig", () => {
		it("should return a defensive copy", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });

			const config1 = advertiser.getConfig();
			expect(config1).not.toBeNull();
			if (config1) {
				config1.port = 9999;
			}

			const config2 = advertiser.getConfig();
			expect(config2?.port).toBe(4000);
		});
	});

	describe("hostname fallback", () => {
		it("should use os.hostname() when execSync throws", async () => {
			// Reset the cached hostname by re-importing a fresh module
			// Instead, we test the behavior indirectly: if execSync throws,
			// the service name should use os.hostname() as fallback.
			// Since cachedHostname is module-level and may already be set,
			// we need a fresh DnsSdAdvertiser module.
			vi.resetModules();

			// Re-mock child_process for the fresh module
			vi.doMock("node:child_process", async () => {
				const actual =
					await vi.importActual<typeof import("node:child_process")>("node:child_process");
				return {
					...actual,
					spawn: vi.fn(),
					execSync: vi.fn(() => {
						throw new Error("scutil not found");
					}),
				};
			});

			const freshChild = createMockChild();
			const { DnsSdAdvertiser: FreshDnsSd } = await import("./mdns-dnssd.js");
			const { spawn: freshSpawn } = await import("node:child_process");
			vi.mocked(freshSpawn).mockReturnValue(freshChild as unknown as ChildProcess);

			const freshAdvertiser = new FreshDnsSd();
			freshAdvertiser.advertise({ port: 4000, pin: "999888" });

			const spawnCall = vi.mocked(freshSpawn).mock.calls[0];
			const args = spawnCall?.[1] as string[];
			// The service name should contain os.hostname() since execSync threw
			const os = await import("node:os");
			expect(args[1]).toBe(`Codemote on ${os.hostname()}`);

			freshAdvertiser.stop();

			// Restore modules for subsequent tests
			vi.resetModules();
			vi.doMock("node:child_process", async () => {
				const actual =
					await vi.importActual<typeof import("node:child_process")>("node:child_process");
				return {
					...actual,
					spawn: vi.fn(),
					execSync: vi.fn(),
				};
			});
		});
	});

	describe("error handling", () => {
		it("should clear state on spawn error", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });
			expect(advertiser.isAdvertising()).toBe(true);

			mockChild.emit("error", new Error("spawn failed"));

			expect(advertiser.isAdvertising()).toBe(false);
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should clear state on unexpected exit", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });
			expect(advertiser.isAdvertising()).toBe(true);

			mockChild.emit("exit", 1);

			expect(advertiser.isAdvertising()).toBe(false);
			expect(advertiser.getConfig()).toBeNull();
		});

		it("should not error when stop is called before exit fires", () => {
			advertiser.advertise({ port: 4000, pin: "999888" });

			// stop() clears child before kill, so exit handler sees child===null
			advertiser.stop();
			expect(() => mockChild.emit("exit", null)).not.toThrow();
		});
	});
});

describe("createAdvertiser", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("should return DnsSdAdvertiser on darwin", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		const adv = createAdvertiser();
		expect(adv).toBeInstanceOf(DnsSdAdvertiser);
	});

	it("should return BonjourAdvertiser on linux", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		const adv = createAdvertiser();
		expect(adv).toBeInstanceOf(BonjourAdvertiser);
	});

	it("should return BonjourAdvertiser on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const adv = createAdvertiser();
		expect(adv).toBeInstanceOf(BonjourAdvertiser);
	});
});

describe("advertiseService", () => {
	it("should create and advertise a service", async () => {
		const adv = advertiseService(3000, "123456");

		expect(adv.isAdvertising()).toBe(true);
		expect(adv.getConfig()).toEqual({
			port: 3000,
			pin: "123456",
			pairingCode: "123456",
			version: "1",
		});

		await adv.destroy();
	});
});

describe("Integration: Service Discovery", () => {
	(shouldRunMdnsIntegration ? it : it.skip)(
		"should be discoverable by another Bonjour instance",
		async () => {
			const adv = new BonjourAdvertiser();
			adv.advertise({
				port: 3000,
				pin: "123456",
			});

			// Give the service time to publish
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					const browser = new Bonjour();
					const finder = browser.find({ type: "codemote" });

					finder.on("up", (service) => {
						// Other Codemote instances may be running on the network during local dev
						// (e.g. a background `pnpm -C packages/cli start`). Filter for the one we started.
						if (service.port !== 3000) {
							return;
						}

						try {
							expect(service.type).toBe("codemote");
							expect(service.port).toBe(3000);
							expect(service.txt?.pin).toBeUndefined();
							expect(service.txt?.pairingCode).toBeUndefined();
							expect(service.txt?.port).toBe("3000");
							expect(service.txt?.version).toBe("1");

							// Cleanup
							finder.stop?.();
							browser.destroy();
							adv.destroy().then(() => resolve());
						} catch (err) {
							// Ensure cleanup on assertion failure too.
							finder.stop?.();
							browser.destroy();
							adv.destroy().then(() => {
								throw err;
							});
						}
					});
				}, 100);
			});
		},
		5000,
	); // 5 second timeout for network operations
});
