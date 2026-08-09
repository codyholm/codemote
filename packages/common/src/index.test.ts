import { describe, expect, it } from "vitest";
import { RUNTIME_MODELS, type RuntimeType } from "./index";

describe("common", () => {
	it("defines a usable static model catalog for every runtime", () => {
		const runtimes: RuntimeType[] = ["opencode", "claude", "codex", "gemini"];
		for (const runtime of runtimes) {
			const models = RUNTIME_MODELS[runtime];
			expect(models.length).toBeGreaterThan(0);
			expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
			for (const model of models) {
				expect(model.id.trim()).not.toBe("");
				expect(model.label.trim()).not.toBe("");
				expect(model.costTier).toMatch(/^(low|medium|high)$/);
				expect(model.capabilityTier).toMatch(/^(basic|standard|advanced)$/);
			}
		}
	});
});
