import { defineConfig } from "vitest/config";
import { INTEGRATION_TEST_FILES } from "./vitest.suites.js";

export default defineConfig({
	test: {
		globals: true,
		include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
		exclude: INTEGRATION_TEST_FILES,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
	},
});
