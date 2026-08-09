export const GIT_INTEGRATION_TEST_FILES = [
	"packages/cli/src/server.test.ts",
	"packages/server/src/uplink/managedWorktree.test.ts",
	"packages/server/src/uplink/projectStart.test.ts",
	"packages/server/src/uplink/server.projectStart.test.ts",
];

export const SERVICE_INTEGRATION_TEST_FILES = [
	"packages/cli/src/bridge.key-exchange.test.ts",
	"packages/cli/src/bridge.projectState.test.ts",
	"packages/cli/src/bridge.test.ts",
	"packages/cli/src/mdns.test.ts",
	"packages/cli/src/service.test.ts",
	"packages/cli/src/speech.test.ts",
	"packages/cli/src/tailscale.test.ts",
	"packages/cli/src/tls.test.ts",
	"packages/server/src/relay/routes/ws.test.ts",
	"packages/server/src/speech/engine.test.ts",
	"packages/server/src/speech/server.loopback.test.ts",
	"packages/server/src/speech/server.test.ts",
	"packages/server/src/uplink/executors/claude.test.ts",
	"packages/server/src/uplink/executors/codex.test.ts",
	"packages/server/src/uplink/executors/gemini.test.ts",
	"packages/server/src/uplink/executors/opencode.test.ts",
	"packages/server/src/uplink/server.cache.test.ts",
	"packages/server/src/uplink/server.listdir.test.ts",
	"packages/server/src/uplink/server.models.test.ts",
	"packages/server/src/uplink/server.projectState.test.ts",
	"packages/server/src/uplink/server.security.test.ts",
	"packages/server/src/uplink/workspace.test.ts",
];

export const INTEGRATION_TEST_FILES = [
	...SERVICE_INTEGRATION_TEST_FILES,
	...GIT_INTEGRATION_TEST_FILES,
];
