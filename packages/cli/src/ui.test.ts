import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPIN, renderUI, updateStatus } from "./ui.js";
import type { UIState } from "./ui.js";

describe("formatPIN", () => {
	it("should format a 6-digit PIN with space separator", () => {
		expect(formatPIN("847291")).toBe("847 291");
	});

	it("should handle different PIN values", () => {
		expect(formatPIN("123456")).toBe("123 456");
		expect(formatPIN("000000")).toBe("000 000");
	});
});

describe("renderUI", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleClearSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleClearSpy = vi.spyOn(console, "clear").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleClearSpy.mockRestore();
	});

	it("should clear console and render UI", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█\n█ ███ █\n█▄▄▄▄▄█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "ready",
		};

		await renderUI(state);

		expect(consoleClearSpy).toHaveBeenCalledOnce();
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	it("should display formatted pairing code", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "847291",
			localURL: "http://192.168.1.100:3000",
			status: "ready",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("847 291");
	});

	it("should display status as Starting... for starting state", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "starting",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Starting...");
	});

	it("should display status as Ready for connections for ready state", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "ready",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Ready for connections");
	});

	it("should display status as Device connected for connected state", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "connected",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Device connected");
	});

	it("should display error message for error state", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "error",
			errorMessage: "Failed to start server",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Error: Failed to start server");
	});

	it("should display local URL", async () => {
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "ready",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("192.168.1.100:3000");
	});

	it("should display short server fingerprint when tlsPin is present", async () => {
		const tlsPin = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const state: UIState = {
			qrCode: "█▀▀▀▀▀█",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			tlsPin,
			status: "ready",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Server fingerprint: 01234567");
		expect(allCalls).not.toContain(tlsPin);
	});

	it("should split and display QR code lines", async () => {
		const state: UIState = {
			qrCode: "Line1\nLine2\nLine3",
			pin: "123456",
			localURL: "http://192.168.1.100:3000",
			status: "ready",
		};

		await renderUI(state);

		const allCalls = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(allCalls).toContain("Line1");
		expect(allCalls).toContain("Line2");
		expect(allCalls).toContain("Line3");
	});
});

describe("updateStatus", () => {
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdoutWriteSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>;
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		stdoutWriteSpy.mockRestore();
		consoleLogSpy.mockRestore();
	});

	it("should move cursor and update status line", () => {
		updateStatus("New status message");

		// Should move cursor up 2 lines
		expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1b[2A");
		// Should clear the line
		expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1b[K");
		// Should move cursor down 1 line
		expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1b[1B");
		// Should log the new status
		expect(consoleLogSpy).toHaveBeenCalled();
	});
});
