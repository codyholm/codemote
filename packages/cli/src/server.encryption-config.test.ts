import { describe, expect, it, vi } from "vitest";
import { parseKeyRotationInterval, resolveEncryptionMode } from "./server.js";

describe("resolveEncryptionMode", () => {
	it('returns "off" when undefined', () => {
		expect(resolveEncryptionMode(undefined)).toBe("off");
	});

	it('returns "off" for valid "off"', () => {
		expect(resolveEncryptionMode("off")).toBe("off");
	});

	it('returns "opportunistic" for valid "opportunistic"', () => {
		expect(resolveEncryptionMode("opportunistic")).toBe("opportunistic");
	});

	it('falls back to "opportunistic" for "required" with warning', () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveEncryptionMode("required")).toBe("opportunistic");
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('falls back to "off" for invalid values with warning', () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveEncryptionMode("garbage")).toBe("off");
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});
});

describe("parseKeyRotationInterval", () => {
	it("returns undefined for undefined input", () => {
		expect(parseKeyRotationInterval(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseKeyRotationInterval("")).toBeUndefined();
	});

	it("returns 0 for zero (disabled)", () => {
		expect(parseKeyRotationInterval("0")).toBe(0);
	});

	it("returns the parsed integer for valid positive values", () => {
		expect(parseKeyRotationInterval("60000")).toBe(60000);
		expect(parseKeyRotationInterval("1800000")).toBe(1800000);
	});

	it("returns 0 for negative values with warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(parseKeyRotationInterval("-1")).toBe(0);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("returns undefined for non-numeric values with warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(parseKeyRotationInterval("abc")).toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});
});
