import { describe, expect, it } from "vitest";
import { type RuntimeType, type StreamEvent, VERSION } from "./index";

describe("common", () => {
	it("exports VERSION", () => {
		expect(VERSION).toBe("0.1.0");
	});

	it("RuntimeType includes all supported runtimes", () => {
		const runtimes: RuntimeType[] = ["opencode", "claude", "codex", "gemini"];
		expect(runtimes).toHaveLength(4);
	});

	it("StreamEvent type is properly defined", () => {
		const event: StreamEvent = {
			type: "session.output",
			timestamp: Date.now(),
			sessionId: "test-123",
			payload: { text: "Hello" },
		};
		expect(event.type).toBe("session.output");
	});
});
