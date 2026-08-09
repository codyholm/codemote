import { defineConfig } from "vitest/config";
import { GIT_INTEGRATION_TEST_FILES } from "./vitest.suites.js";

export default defineConfig({
	test: {
		globals: true,
		include: GIT_INTEGRATION_TEST_FILES,
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
	},
});
