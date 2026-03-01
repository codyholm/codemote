import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectTailscaleEndpoint } from "./tailscale.js";

describe.skipIf(platform() === "win32")("detectTailscaleEndpoint", () => {
	const originalPath = process.env["PATH"];
	const tempDirs: string[] = [];

	afterEach(async () => {
		if (originalPath === undefined) {
			Reflect.deleteProperty(process.env, "PATH");
		} else {
			process.env["PATH"] = originalPath;
		}
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("uses tailscale status DNSName and normalizes trailing dot", async () => {
		const binDir = await mkdtemp(join(tmpdir(), "codemote-tailscale-test-"));
		tempDirs.push(binDir);
		const scriptPath = join(binDir, "tailscale");
		await writeFile(
			scriptPath,
			`#!/bin/sh
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
	printf '%s\n' '{"Self":{"DNSName":"devbox.tailnet.ts.net.","TailscaleIPs":["100.64.0.5"]}}'
	exit 0
fi
exit 1
`,
			"utf8",
		);
		await chmod(scriptPath, 0o755);
		process.env["PATH"] = `${binDir}${delimiter}${originalPath ?? ""}`;

		const endpoint = await detectTailscaleEndpoint({ port: 8080, secure: true });

		expect(endpoint).toEqual({
			host: "devbox.tailnet.ts.net",
			url: "wss://devbox.tailnet.ts.net:8080/ws",
		});
	});

	it("falls back to tailscale ip -4 when status json fails", async () => {
		const binDir = await mkdtemp(join(tmpdir(), "codemote-tailscale-test-"));
		tempDirs.push(binDir);
		const scriptPath = join(binDir, "tailscale");
		await writeFile(
			scriptPath,
			`#!/bin/sh
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
	echo 'status failed' >&2
	exit 1
fi
if [ "$1" = "ip" ] && [ "$2" = "-4" ]; then
	printf '%s\n' '100.88.22.7'
	exit 0
fi
exit 1
`,
			"utf8",
		);
		await chmod(scriptPath, 0o755);
		process.env["PATH"] = `${binDir}${delimiter}${originalPath ?? ""}`;

		const endpoint = await detectTailscaleEndpoint({ port: 9090, secure: false });

		expect(endpoint).toEqual({
			host: "100.88.22.7",
			url: "ws://100.88.22.7:9090/ws",
		});
	});

	it("returns null when tailscale does not return a usable endpoint", async () => {
		const binDir = await mkdtemp(join(tmpdir(), "codemote-tailscale-test-"));
		tempDirs.push(binDir);
		const scriptPath = join(binDir, "tailscale");
		await writeFile(
			scriptPath,
			`#!/bin/sh
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
	printf '%s\n' '{"Self":{}}'
	exit 0
fi
if [ "$1" = "ip" ] && [ "$2" = "-4" ]; then
	exit 1
fi
exit 1
`,
			"utf8",
		);
		await chmod(scriptPath, 0o755);
		process.env["PATH"] = `${binDir}${delimiter}${originalPath ?? ""}`;

		const endpoint = await detectTailscaleEndpoint({ port: 8080, secure: true });

		expect(endpoint).toBeNull();
	});
});
