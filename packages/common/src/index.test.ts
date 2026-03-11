import { describe, expect, it } from "vitest";
import { RUNTIME_MODELS, type RuntimeType, type StreamEvent, VERSION } from "./index";

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

	it("RUNTIME_MODELS entries include cost and capability tiers", () => {
		const claudeModels = RUNTIME_MODELS["claude"];
		const sonnet = claudeModels.find((m) => m.id === "sonnet");
		expect(sonnet).toBeDefined();
		expect(sonnet?.costTier).toBe("medium");
		expect(sonnet?.capabilityTier).toBe("standard");

		const opus = claudeModels.find((m) => m.id === "opus");
		expect(opus).toBeDefined();
		expect(opus?.costTier).toBe("high");
		expect(opus?.capabilityTier).toBe("advanced");

		const haiku = claudeModels.find((m) => m.id === "haiku");
		expect(haiku).toBeDefined();
		expect(haiku?.costTier).toBe("low");
		expect(haiku?.capabilityTier).toBe("basic");
	});
});
