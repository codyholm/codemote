import { describe, expect, it } from "vitest";
import { RELAY_VERSION, type RelayEnvelope } from "./index";

describe("relay", () => {
	it("exports RELAY_VERSION", () => {
		expect(RELAY_VERSION).toBe("0.1.0");
	});

	it("RelayEnvelope type is properly defined", () => {
		const envelope: RelayEnvelope = {
			id: "msg-123",
			senderDeviceId: "device-abc",
			payload: { hello: "world" },
			timestamp: Date.now(),
		};
		expect(envelope.id).toBe("msg-123");
	});
});
