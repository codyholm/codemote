import { defineConfig } from "vitest/config";
import { SERVICE_INTEGRATION_TEST_FILES } from "./vitest.suites.js";

export default defineConfig({
	// These files start real runtimes, services, listeners, and subprocess trees.
	// Serial execution prevents unrelated process cleanup from exhausting the
	// default hook deadlines or racing temporary-directory teardown.
	test: {
		globals: true,
		include: SERVICE_INTEGRATION_TEST_FILES,
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
	},
});
