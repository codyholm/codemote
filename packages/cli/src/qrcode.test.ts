import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";

describe("buildPairingURL", () => {
	const tlsPin = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

	it("should build correct deep link URL", () => {
		const url = buildPairingURL("192.168.1.100", 3000, "123456", { tlsPin });
		expect(url).toBe(
			"guildremote://pair?host=192.168.1.100&port=3000&relay=wss://192.168.1.100:3000&pin=123456&tlsPin=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&code=123456",
		);
	});

	it("should handle different ports", () => {
		const url = buildPairingURL("10.0.0.5", 8080, "abcdef", { tlsPin });
		expect(url).toBe(
			"guildremote://pair?host=10.0.0.5&port=8080&relay=wss://10.0.0.5:8080&pin=abcdef&tlsPin=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&code=abcdef",
		);
	});

	it("should handle hostname instead of IP", () => {
		const url = buildPairingURL("localhost", 3000, "999999", { tlsPin });
		expect(url).toBe(
			"guildremote://pair?host=localhost&port=3000&relay=wss://localhost:3000&pin=999999&tlsPin=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&code=999999",
		);
	});

	it("should remain compatible with older parsers", () => {
		const url = buildPairingURL("192.168.1.100", 3000, "123456");
		expect(url).toBe("guildremote://pair?host=192.168.1.100&port=3000&pin=123456&code=123456");
	});
});

describe("getLocalIP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("should prefer en0 interface on macOS", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			lo: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8",
				},
			],
			en0: [
				{
					address: "192.168.1.100",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "192.168.1.100/24",
				},
			],
			en1: [
				{
					address: "192.168.1.101",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:00",
					internal: false,
					cidr: "192.168.1.101/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("192.168.1.100");
	});

	it("should prefer eth0 interface on Linux", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			lo: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8",
				},
			],
			eth0: [
				{
					address: "10.0.0.5",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "10.0.0.5/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("10.0.0.5");
	});

	it("should skip docker interfaces", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			docker0: [
				{
					address: "172.17.0.1",
					netmask: "255.255.0.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "172.17.0.1/16",
				},
			],
			eth0: [
				{
					address: "192.168.1.200",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:00",
					internal: false,
					cidr: "192.168.1.200/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("192.168.1.200");
	});

	it("should skip internal interfaces", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			lo: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8",
				},
			],
			en0: [
				{
					address: "192.168.1.50",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "192.168.1.50/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("192.168.1.50");
	});

	it("should skip link-local addresses (169.254.x.x)", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			en0: [
				{
					address: "169.254.10.20",
					netmask: "255.255.0.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "169.254.10.20/16",
				},
			],
			en1: [
				{
					address: "192.168.1.75",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:00",
					internal: false,
					cidr: "192.168.1.75/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("192.168.1.75");
	});

	it("should fallback to 127.0.0.1 if no valid interface found", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			lo: [
				{
					address: "127.0.0.1",
					netmask: "255.0.0.0",
					family: "IPv4",
					mac: "00:00:00:00:00:00",
					internal: true,
					cidr: "127.0.0.1/8",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("127.0.0.1");
	});

	it("should handle IPv6 interfaces gracefully", () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({
			en0: [
				{
					address: "fe80::1",
					netmask: "ffff:ffff:ffff:ffff::",
					family: "IPv6",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "fe80::1/64",
					scopeid: 1,
				},
				{
					address: "192.168.1.88",
					netmask: "255.255.255.0",
					family: "IPv4",
					mac: "aa:bb:cc:dd:ee:ff",
					internal: false,
					cidr: "192.168.1.88/24",
				},
			],
		});

		const ip = getLocalIP();
		expect(ip).toBe("192.168.1.88");
	});
});

describe("generateQRCode", () => {
	it("should generate QR code for valid URL", async () => {
		const url = "guildremote://pair?host=192.168.1.100&port=3000&code=123456";
		const qrCode = await generateQRCode(url);

		expect(qrCode).toBeDefined();
		expect(typeof qrCode).toBe("string");
		expect(qrCode.length).toBeGreaterThan(0);
	});

	it("should handle different URLs", async () => {
		const url1 = "guildremote://pair?host=10.0.0.1&port=8080&code=abc123";
		const url2 = "guildremote://pair?host=192.168.1.1&port=3000&code=xyz789";

		const qr1 = await generateQRCode(url1);
		const qr2 = await generateQRCode(url2);

		expect(qr1).toBeDefined();
		expect(qr2).toBeDefined();
		// Different URLs should produce different QR codes
		expect(qr1).not.toBe(qr2);
	});
});
