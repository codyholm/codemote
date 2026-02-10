import { describe, expect, it } from "vitest";
import {
	BaseExecutor,
	DEFAULT_CONFIG,
	EventBus,
	MockExecutor,
	SessionManager,
	UplinkServer,
	WorkspaceManager,
} from "./index";

describe("uplink", () => {
	it("exports BaseExecutor class", () => {
		expect(BaseExecutor).toBeDefined();
	});

	it("exports MockExecutor class", () => {
		expect(MockExecutor).toBeDefined();
	});

	it("exports UplinkServer class", () => {
		expect(UplinkServer).toBeDefined();
	});

	it("exports manager classes", () => {
		expect(WorkspaceManager).toBeDefined();
		expect(SessionManager).toBeDefined();
		expect(EventBus).toBeDefined();
	});

	it("exports default config", () => {
		expect(DEFAULT_CONFIG.port).toBe(9876);
		expect(DEFAULT_CONFIG.host).toBe("127.0.0.1");
	});
});
