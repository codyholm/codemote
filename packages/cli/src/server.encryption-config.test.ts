import { describe, expect, it, vi } from "vitest";
import { resolveEncryptionMode } from "./server.js";

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
