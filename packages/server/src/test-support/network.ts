import { createServer } from "node:net";
import WebSocket, { type RawData } from "ws";

export function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (error) => {
			server.close(() => reject(error));
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Failed to reserve port")));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

export function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			ws.off("open", onOpen);
			ws.off("error", onError);
		};
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("WebSocket open timeout"));
		}, timeoutMs);

		ws.once("open", onOpen);
		ws.once("error", onError);
	});
}

export function waitForMessage(ws: WebSocket, timeoutMs = 5_000): Promise<Record<string, unknown>> {
	return waitForMatchingMessage(ws, () => true, "message", timeoutMs);
}

export function waitForMessageOfType(
	ws: WebSocket,
	type: string,
	timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
	return waitForMatchingMessage(
		ws,
		(message) => message["type"] === type,
		`type ${type}`,
		timeoutMs,
	);
}

function waitForMatchingMessage(
	ws: WebSocket,
	matches: (message: Record<string, unknown>) => boolean,
	description: string,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			ws.off("message", onMessage);
			ws.off("error", onError);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onMessage = (data: RawData) => {
			try {
				const message = JSON.parse(data.toString()) as Record<string, unknown>;
				if (!matches(message)) return;
				cleanup();
				resolve(message);
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`WebSocket message timeout waiting for ${description}`));
		}, timeoutMs);

		ws.on("message", onMessage);
		ws.once("error", onError);
	});
}
