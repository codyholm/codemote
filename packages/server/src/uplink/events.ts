import type { StreamEvent, StreamEventType } from "@codemote/common";

type EventHandler = (event: StreamEvent) => void;

/**
 * Event bus for streaming events from executors
 */
export class EventBus {
	private handlers = new Set<EventHandler>();
	private sessionHandlers = new Map<string, Set<EventHandler>>();
	private typeHandlers = new Map<StreamEventType, Set<EventHandler>>();

	/**
	 * Emit an event to all subscribers
	 */
	emit(event: StreamEvent): void {
		// Global handlers
		for (const handler of this.handlers) {
			handler(event);
		}

		// Session-specific handlers
		const sessionSet = this.sessionHandlers.get(event.sessionId);
		if (sessionSet) {
			for (const handler of sessionSet) {
				handler(event);
			}
		}

		// Type-specific handlers
		const typeSet = this.typeHandlers.get(event.type);
		if (typeSet) {
			for (const handler of typeSet) {
				handler(event);
			}
		}
	}

	/**
	 * Subscribe to all events
	 */
	subscribe(handler: EventHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/**
	 * Subscribe to events for a specific session
	 */
	subscribeSession(sessionId: string, handler: EventHandler): () => void {
		let set = this.sessionHandlers.get(sessionId);
		if (!set) {
			set = new Set();
			this.sessionHandlers.set(sessionId, set);
		}
		set.add(handler);

		return () => {
			set?.delete(handler);
			if (set?.size === 0) {
				this.sessionHandlers.delete(sessionId);
			}
		};
	}

	/**
	 * Subscribe to events of a specific type
	 */
	subscribeType(type: StreamEventType, handler: EventHandler): () => void {
		let set = this.typeHandlers.get(type);
		if (!set) {
			set = new Set();
			this.typeHandlers.set(type, set);
		}
		set.add(handler);

		return () => {
			set?.delete(handler);
			if (set?.size === 0) {
				this.typeHandlers.delete(type);
			}
		};
	}

	/**
	 * Create an async iterator for a session's events
	 */
	async *streamSession(sessionId: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
		const queue: StreamEvent[] = [];
		let resolve: (() => void) | null = null;

		const unsubscribe = this.subscribeSession(sessionId, (event) => {
			queue.push(event);
			resolve?.();
		});

		try {
			while (!signal?.aborted) {
				const event = queue.shift();
				if (event) {
					yield event;
				} else {
					await new Promise<void>((r) => {
						resolve = r;
					});
					resolve = null;
				}
			}
		} finally {
			unsubscribe();
		}
	}
}

/**
 * Helper to create a stream event
 */
export function createEvent(
	type: StreamEventType,
	sessionId: string,
	payload: unknown,
): StreamEvent {
	return {
		type,
		timestamp: Date.now(),
		sessionId,
		payload,
	};
}
