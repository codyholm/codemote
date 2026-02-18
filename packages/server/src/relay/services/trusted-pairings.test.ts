import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustedPairingsStore } from "./trusted-pairings.js";

describe("TrustedPairingsStore", () => {
	let fixtureDir: string;
	let storePath: string;

	beforeEach(async () => {
		fixtureDir = await mkdtemp(join(tmpdir(), "trusted-pairings-test-"));
		storePath = join(fixtureDir, "trusted-pairings.json");
	});

	afterEach(async () => {
		await rm(fixtureDir, { recursive: true, force: true });
	});

	it("persists trusted pairings across store instances", async () => {
		const first = new TrustedPairingsStore({ filePath: storePath });
		first.markPaired("uplink-a", "mobile-1", 1_000);
		first.markSeen("uplink-a", "mobile-1", 2_000);

		const second = new TrustedPairingsStore({ filePath: storePath });
		expect(second.isTrusted("uplink-a", "mobile-1")).toBe(true);

		const listed = second.listForUplink("uplink-a");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.pairedAt).toBe(1_000);
		expect(listed[0]?.lastSeenAt).toBe(2_000);
	});

	it("updates lastSeenAt and supports multi-device listing", () => {
		const store = new TrustedPairingsStore({ filePath: storePath });
		store.markPaired("uplink-a", "mobile-1", 100);
		store.markPaired("uplink-a", "mobile-2", 200);
		store.markSeen("uplink-a", "mobile-1", 300);

		const listed = store.listForUplink("uplink-a");
		expect(listed.map((entry) => entry.mobileDeviceId)).toEqual(["mobile-1", "mobile-2"]);
		expect(listed[0]?.lastSeenAt).toBe(300);
		expect(listed[1]?.lastSeenAt).toBe(200);
	});

	it("revokes one device and all devices for an uplink", () => {
		const store = new TrustedPairingsStore({ filePath: storePath });
		store.markPaired("uplink-a", "mobile-1", 100);
		store.markPaired("uplink-a", "mobile-2", 200);
		store.markPaired("uplink-b", "mobile-3", 300);

		expect(store.revoke("uplink-a", "mobile-1")).toBe(true);
		expect(store.isTrusted("uplink-a", "mobile-1")).toBe(false);
		expect(store.isTrusted("uplink-a", "mobile-2")).toBe(true);

		expect(store.revokeAllForUplink("uplink-a")).toBe(1);
		expect(store.listForUplink("uplink-a")).toHaveLength(0);
		expect(store.isTrusted("uplink-b", "mobile-3")).toBe(true);
	});

	it("recovers from corrupt file by creating a new empty store", async () => {
		await writeFile(storePath, "{ definitely-not-json", "utf8");
		const logs: string[] = [];

		const store = new TrustedPairingsStore({
			filePath: storePath,
			log: (message) => logs.push(message),
		});

		expect(store.listForUplink("uplink-a")).toHaveLength(0);
		expect(logs.some((entry) => entry.includes("corrupt"))).toBe(true);

		const files = await readdir(fixtureDir);
		expect(files.some((entry) => entry.startsWith("trusted-pairings.json.corrupt-"))).toBe(true);
		expect(files.includes("trusted-pairings.json")).toBe(true);
	});

	it("writes atomically and enforces 0600 permissions", async () => {
		const store = new TrustedPairingsStore({ filePath: storePath });
		store.markPaired("uplink-a", "mobile-1", 1_000);

		const files = await readdir(fixtureDir);
		expect(files.includes("trusted-pairings.json.tmp")).toBe(false);

		const fileStat = await stat(storePath);
		expect(fileStat.mode & 0o777).toBe(0o600);

		const raw = await readFile(storePath, "utf8");
		expect(raw).toContain('"version": 1');
		expect(raw).toContain('"mobileDeviceId": "mobile-1"');
	});
});
