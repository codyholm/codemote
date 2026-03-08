// TODO: Extract shared WebSocket server setup and pairing simulation into test helpers
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startRelayUplinkBridge } from "./bridge.js";
import { decodeBase64, encodeBase64, generateKeyPair } from "./encryption.js";

interface JsonRecord {
	[key: string]: unknown;
}

describe("Bridge key exchange", () => {
	let relayWss: WebSocketServer;
	let uplinkWss: WebSocketServer;
	let relayPort = 0;
	let uplinkPort = 0;
	let tempHomeDir = "";
	let tempRepoDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env["HOME"];
		tempHomeDir = await mkdtemp(join(tmpdir(), "bridge-kex-home-"));
		tempRepoDir = await mkdtemp(join(tmpdir(), "bridge-kex-repo-"));
		process.env["HOME"] = tempHomeDir;

		relayWss = await createWsServer();
		uplinkWss = await createWsServer();

		const relayAddr = relayWss.address();
		const uplinkAddr = uplinkWss.address();
		if (!relayAddr || typeof relayAddr === "string") {
			throw new Error("Failed to bind relay test server");
		}
		if (!uplinkAddr || typeof uplinkAddr === "string") {
			throw new Error("Failed to bind uplink test server");
		}

		relayPort = relayAddr.port;
		uplinkPort = uplinkAddr.port;
	});

	afterEach(async () => {
		await Promise.allSettled([closeWsServer(relayWss), closeWsServer(uplinkWss)]);
		await Promise.allSettled([
			rm(tempHomeDir, { recursive: true, force: true }),
			rm(tempRepoDir, { recursive: true, force: true }),
		]);
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env["HOME"] = originalHome;
		}
	});

	it("sends encryption_offer after paired when mode is opportunistic", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		const messagesFromBridge: JsonRecord[] = [];

		// Minimal uplink that handles list_sessions
		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100001" }));
					return;
				}

				if (type === "pair") {
					// Capture all subsequent messages sent by the bridge
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						messagesFromBridge.push(bridgeMsg);
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-1" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-1" }),
					);
					return;
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-1",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for bridge to send encryption_offer
			await waitForCondition(
				() =>
					messagesFromBridge.some(
						(msg) =>
							msg["type"] === "message" &&
							typeof msg["payload"] === "object" &&
							msg["payload"] !== null &&
							(msg["payload"] as JsonRecord)["type"] === "encryption_offer",
					),
				5000,
			);

			const offerMsg = messagesFromBridge.find(
				(msg) =>
					msg["type"] === "message" &&
					typeof msg["payload"] === "object" &&
					msg["payload"] !== null &&
					(msg["payload"] as JsonRecord)["type"] === "encryption_offer",
			);
			expect(offerMsg).toBeDefined();
			const payload = offerMsg?.["payload"] as JsonRecord;
			expect(payload["type"]).toBe("encryption_offer");
			// Public key must be a valid 32-byte base64 string
			const pubKey = decodeBase64(payload["publicKey"] as string);
			expect(pubKey.length).toBe(32);

			// The bridge handle exposes its public key
			expect(bridge.encryptionPublicKey).toBeDefined();
			expect(bridge.encryptionPublicKey).toBe(payload["publicKey"]);
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 15_000);

	it("does not send encryption_offer when mode is off", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		const messagesFromBridge: JsonRecord[] = [];
		let sessionListSeen = false;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100002" }));
					return;
				}

				if (type === "pair") {
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						messagesFromBridge.push(bridgeMsg);
						const innerPayload = bridgeMsg["payload"] as JsonRecord | undefined;
						if (innerPayload?.["type"] === "session_list") {
							sessionListSeen = true;
						}
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-2" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-2" }),
					);
					return;
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "off",
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-2",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for session_list to arrive (proves bridge finished paired handling)
			await waitForCondition(() => sessionListSeen, 5000);

			// No encryption_offer should have been sent
			const offerMsg = messagesFromBridge.find(
				(msg) =>
					msg["type"] === "message" &&
					typeof msg["payload"] === "object" &&
					msg["payload"] !== null &&
					(msg["payload"] as JsonRecord)["type"] === "encryption_offer",
			);
			expect(offerMsg).toBeUndefined();

			// Handle has no encryption public key
			expect(bridge.encryptionPublicKey).toBeUndefined();
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 15_000);

	it("activates encryption after receiving valid encryption_accept", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		const messagesFromBridge: JsonRecord[] = [];

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
				if (command["type"] === "list_runtimes") {
					socket.send(JSON.stringify({ type: "runtime_list", payload: { runtimes: ["claude"] } }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100003" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						messagesFromBridge.push(bridgeMsg);
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-3" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-3" }),
					);
					return;
				}

				// Forward messages from mobile to bridge
				if (type === "message" && socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-3",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for bridge's encryption_offer
			await waitForCondition(
				() =>
					messagesFromBridge.some(
						(msg) =>
							msg["type"] === "message" &&
							(msg["payload"] as JsonRecord | undefined)?.["type"] === "encryption_offer",
					),
				5000,
			);

			// Generate a mobile keypair and send encryption_accept
			const mobileKeys = generateKeyPair();
			const mobilePublicKeyB64 = encodeBase64(mobileKeys.publicKey);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "encryption_accept",
						publicKey: mobilePublicKeyB64,
					},
				}),
			);

			// Give the bridge time to process the accept
			await new Promise((resolve) => setTimeout(resolve, 50));
			const preListCount = messagesFromBridge.length;

			// Trigger an outbound message from bridge by requesting runtime list
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "list_runtimes" },
				}),
			);

			// Wait for bridge to send a runtime_list response — it should be encrypted
			await waitForCondition(
				() =>
					messagesFromBridge.slice(preListCount).some((msg) => {
						if (msg["type"] !== "message") return false;
						const p = msg["payload"] as JsonRecord | undefined;
						if (!p) return false;
						// EncryptedPayload has senderPublicKey + ciphertext + nonce + timestamp
						return (
							typeof p["senderPublicKey"] === "string" &&
							typeof p["ciphertext"] === "string" &&
							typeof p["nonce"] === "string" &&
							typeof p["timestamp"] === "number"
						);
					}),
				8000,
			);

			const encryptedMsg = messagesFromBridge.slice(preListCount).find((msg) => {
				if (msg["type"] !== "message") return false;
				const p = msg["payload"] as JsonRecord | undefined;
				return (
					p !== undefined &&
					typeof p["senderPublicKey"] === "string" &&
					typeof p["ciphertext"] === "string" &&
					typeof p["nonce"] === "string"
				);
			});
			expect(encryptedMsg).toBeDefined();

			const encPayload = encryptedMsg?.["payload"] as JsonRecord;
			// Verify the sender key matches what the bridge advertised
			expect(encPayload["senderPublicKey"]).toBe(bridge.encryptionPublicKey);
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 20_000);

	it("rejects encryption_accept with invalid key length", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		const messagesFromBridge: JsonRecord[] = [];
		const logLines: string[] = [];

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
				if (command["type"] === "list_runtimes") {
					socket.send(JSON.stringify({ type: "runtime_list", payload: { runtimes: ["claude"] } }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100004" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						messagesFromBridge.push(bridgeMsg);
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-4" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-4" }),
					);
					return;
				}

				if (type === "message" && socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
			log: (msg) => logLines.push(msg),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-4",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for the offer
			await waitForCondition(
				() =>
					messagesFromBridge.some(
						(msg) =>
							msg["type"] === "message" &&
							(msg["payload"] as JsonRecord | undefined)?.["type"] === "encryption_offer",
					),
				5000,
			);

			// Send accept with a 16-byte (invalid) key
			const shortKey = new Uint8Array(16);
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						type: "encryption_accept",
						publicKey: encodeBase64(shortKey),
					},
				}),
			);

			// Wait for the warning log
			await waitForCondition(
				() => logLines.some((line) => line.includes("invalid key length")),
				5000,
			);

			expect(logLines.some((line) => line.includes("invalid key length 16"))).toBe(true);

			// After reject, trigger real outbound traffic and verify it's plaintext
			const preRejectCount = messagesFromBridge.length;
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "list_runtimes" },
				}),
			);
			await waitForCondition(
				() =>
					messagesFromBridge
						.slice(preRejectCount)
						.some(
							(msg) =>
								msg["type"] === "message" &&
								(msg["payload"] as JsonRecord | undefined)?.["type"] === "runtime_list",
						),
				5000,
			);
			const postRejectMsg = messagesFromBridge
				.slice(preRejectCount)
				.find(
					(msg) =>
						msg["type"] === "message" &&
						(msg["payload"] as JsonRecord | undefined)?.["type"] === "runtime_list",
				);
			expect(postRejectMsg).toBeDefined();
			const postRejectPayload = postRejectMsg?.["payload"] as JsonRecord;
			expect(postRejectPayload["ciphertext"]).toBeUndefined();
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 15_000);

	it("messages are encrypted after key exchange completes", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		const bridgeToMobileMessages: JsonRecord[] = [];

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
				if (command["type"] === "list_runtimes") {
					socket.send(JSON.stringify({ type: "runtime_list", payload: { runtimes: ["claude"] } }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100005" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					// Capture messages the bridge sends toward mobile
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						if (bridgeMsg["type"] === "message") {
							bridgeToMobileMessages.push(bridgeMsg);
						}
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-5" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-5" }),
					);
					return;
				}

				// Forward mobile -> bridge
				if (type === "message" && socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-5",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for the offer
			await waitForCondition(
				() =>
					bridgeToMobileMessages.some(
						(msg) => (msg["payload"] as JsonRecord | undefined)?.["type"] === "encryption_offer",
					),
				5000,
			);

			// Before key exchange completes, messages are plaintext
			const preHandshakeMessages = [...bridgeToMobileMessages];
			const plaintextBeforeHandshake = preHandshakeMessages.filter((msg) => {
				const p = msg["payload"] as JsonRecord | undefined;
				// Plaintext messages have a "type" field that's an app message type, not senderPublicKey
				return p !== undefined && typeof p["type"] === "string" && p["type"] !== "encryption_offer";
			});
			// session_list and device_info should have arrived as plaintext
			expect(plaintextBeforeHandshake.length).toBeGreaterThan(0);

			// Complete the handshake
			const mobileKeys = generateKeyPair();
			const mobilePublicKeyB64 = encodeBase64(mobileKeys.publicKey);

			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "encryption_accept", publicKey: mobilePublicKeyB64 },
				}),
			);

			// Give the bridge time to process the accept before triggering a response
			await new Promise((resolve) => setTimeout(resolve, 50));
			const preAcceptCount = bridgeToMobileMessages.length;

			// Trigger an outbound message by requesting runtime list
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "list_runtimes" },
				}),
			);

			// Wait for at least one post-accept message that has EncryptedPayload shape
			await waitForCondition(
				() =>
					bridgeToMobileMessages.slice(preAcceptCount).some((msg) => {
						const p = msg["payload"] as JsonRecord | undefined;
						return (
							p !== undefined &&
							typeof p["senderPublicKey"] === "string" &&
							typeof p["ciphertext"] === "string" &&
							typeof p["nonce"] === "string" &&
							typeof p["timestamp"] === "number"
						);
					}),
				8000,
			);

			// Verify the post-accept message is a valid EncryptedPayload
			const encryptedPostHandshake = bridgeToMobileMessages.slice(preAcceptCount).find((msg) => {
				const p = msg["payload"] as JsonRecord | undefined;
				return (
					p !== undefined &&
					typeof p["senderPublicKey"] === "string" &&
					typeof p["ciphertext"] === "string"
				);
			});
			expect(encryptedPostHandshake).toBeDefined();

			const encPayload = encryptedPostHandshake?.["payload"] as JsonRecord;
			expect(encPayload["senderPublicKey"]).toBe(bridge.encryptionPublicKey);
			// Nonce must decode to 24 bytes (NaCl box nonce length)
			const nonce = decodeBase64(encPayload["nonce"] as string);
			expect(nonce.length).toBe(24);
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 20_000);

	it("continues plaintext when old mobile ignores encryption_offer (opportunistic)", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		const messagesFromBridge: JsonRecord[] = [];
		let offerSeen = false;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
				if (command["type"] === "list_runtimes") {
					socket.send(JSON.stringify({ type: "runtime_list", payload: { runtimes: ["claude"] } }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100006" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						messagesFromBridge.push(bridgeMsg);
						const p = bridgeMsg["payload"] as JsonRecord | undefined;
						if (p?.["type"] === "encryption_offer") offerSeen = true;
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-6" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-6" }),
					);
					return;
				}

				// Forward mobile -> bridge
				if (type === "message" && socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-6",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for offer to arrive (proves paired handling is done)
			await waitForCondition(() => offerSeen, 5000);

			// Old mobile never sends encryption_accept — just requests runtimes
			const preCount = messagesFromBridge.length;
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: { type: "list_runtimes" },
				}),
			);

			// Wait for the runtime_list response
			await waitForCondition(
				() =>
					messagesFromBridge.slice(preCount).some((msg) => {
						const p = msg["payload"] as JsonRecord | undefined;
						return p?.["type"] === "runtime_list" || typeof p?.["ciphertext"] === "string";
					}),
				5000,
			);

			// Response must be plaintext — no EncryptedPayload shape
			const response = messagesFromBridge.slice(preCount).find((msg) => {
				const p = msg["payload"] as JsonRecord | undefined;
				return p?.["type"] === "runtime_list" || typeof p?.["ciphertext"] === "string";
			});
			expect(response).toBeDefined();
			const responsePayload = response?.["payload"] as JsonRecord;
			// Plaintext: has "type" field, no "ciphertext"
			expect(responsePayload["type"]).toBe("runtime_list");
			expect(responsePayload["ciphertext"]).toBeUndefined();
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 15_000);

	it("drops encrypted message received before key exchange completes", async () => {
		let relayUplinkSocket: WebSocket | null = null;
		let relayMobileSocket: WebSocket | null = null;
		const logLines: string[] = [];
		let offerSeen = false;

		uplinkWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const command = JSON.parse(raw.toString()) as JsonRecord;
				if (command["type"] === "list_sessions") {
					socket.send(JSON.stringify({ type: "sessions", payload: [] }));
				}
			});
		});

		relayWss.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as JsonRecord;
				const type = message["type"];

				if (type === "register") {
					relayUplinkSocket = socket;
					socket.send(JSON.stringify({ type: "registered", pairingCode: "100007" }));
					return;
				}

				if (type === "pair") {
					relayMobileSocket = socket;
					relayUplinkSocket?.on("message", (bridgeRaw) => {
						const bridgeMsg = JSON.parse(bridgeRaw.toString()) as JsonRecord;
						const p = bridgeMsg["payload"] as JsonRecord | undefined;
						if (p?.["type"] === "encryption_offer") offerSeen = true;
					});
					socket.send(JSON.stringify({ type: "paired", uplinkDeviceId: "uplink-kex-7" }));
					relayUplinkSocket?.send(
						JSON.stringify({ type: "paired", mobileDeviceId: "mobile-kex-7" }),
					);
					return;
				}

				// Forward mobile -> bridge
				if (type === "message" && socket === relayMobileSocket) {
					relayUplinkSocket?.send(raw.toString());
				}
			});
		});

		const bridge = await startRelayUplinkBridge({
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			uplinkUrl: `ws://127.0.0.1:${uplinkPort}`,
			repoPath: tempRepoDir,
			encryptionMode: "opportunistic",
			log: (msg) => logLines.push(msg),
		});

		let mobileSocket: WebSocket | null = null;
		try {
			mobileSocket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
			await waitForOpen(mobileSocket);

			mobileSocket.send(
				JSON.stringify({
					type: "pair",
					deviceId: "mobile-kex-7",
					pin: bridge.pairingCode,
					deviceType: "mobile",
				}),
			);

			// Wait for the offer so we know pairing is done — but do NOT send accept
			await waitForCondition(() => offerSeen, 5000);

			// Inject an EncryptedPayload-shaped message before handshake is complete
			mobileSocket.send(
				JSON.stringify({
					type: "message",
					payload: {
						senderPublicKey: encodeBase64(new Uint8Array(32)),
						ciphertext: encodeBase64(new Uint8Array(48)),
						nonce: encodeBase64(new Uint8Array(24)),
						timestamp: Date.now(),
					},
				}),
			);

			// Bridge should drop it and log the reason
			await waitForCondition(
				() => logLines.some((line) => line.includes("encrypted_payload_decode_failed")),
				5000,
			);

			expect(logLines.some((line) => line.includes("encrypted_payload_decode_failed"))).toBe(true);
		} finally {
			if (mobileSocket?.readyState === WebSocket.OPEN) mobileSocket.close();
			await bridge.stop();
		}
	}, 15_000);
});

async function createWsServer(): Promise<WebSocketServer> {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
	return wss;
}

async function closeWsServer(wss: WebSocketServer): Promise<void> {
	for (const client of wss.clients) {
		client.terminate();
	}
	await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitForOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("WebSocket open timeout"));
		}, 4000);
		ws.once("open", () => {
			clearTimeout(timeout);
			resolve();
		});
		ws.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

async function waitForCondition(
	predicate: () => boolean,
	timeoutMs: number,
	intervalMs = 20,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("Timed out waiting for condition");
}
