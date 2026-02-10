import { describe, expect, it, vi } from "vitest";
import { EventBus, createEvent } from "./events";

describe("EventBus", () => {
	it("emits events to global subscribers", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.subscribe(handler);
		bus.emit(createEvent("session.output", "sess-1", { text: "hello" }));

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "session.output",
				sessionId: "sess-1",
				payload: { text: "hello" },
			}),
		);
	});

	it("emits to multiple global subscribers", () => {
		const bus = new EventBus();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		bus.subscribe(handler1);
		bus.subscribe(handler2);
		bus.emit(createEvent("session.output", "sess-1", { text: "hello" }));

		expect(handler1).toHaveBeenCalledOnce();
		expect(handler2).toHaveBeenCalledOnce();
	});

	it("filters events by session", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.subscribeSession("sess-1", handler);
		bus.emit(createEvent("session.output", "sess-1", { text: "match" }));
		bus.emit(createEvent("session.output", "sess-2", { text: "no match" }));

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "sess-1",
				payload: { text: "match" },
			}),
		);
	});

	it("unsubscribes correctly", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		const unsub = bus.subscribe(handler);
		bus.emit(createEvent("session.output", "sess-1", {}));
		unsub();
		bus.emit(createEvent("session.output", "sess-1", {}));

		expect(handler).toHaveBeenCalledOnce();
	});

	it("unsubscribes session handler correctly", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		const unsub = bus.subscribeSession("sess-1", handler);
		bus.emit(createEvent("session.output", "sess-1", { n: 1 }));
		unsub();
		bus.emit(createEvent("session.output", "sess-1", { n: 2 }));

		expect(handler).toHaveBeenCalledOnce();
	});

	it("filters events by type", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		bus.subscribeType("attention.required", handler);
		bus.emit(createEvent("session.output", "sess-1", {}));
		bus.emit(createEvent("attention.required", "sess-1", { reason: "test" }));

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "attention.required",
			}),
		);
	});

	it("unsubscribes type handler correctly", () => {
		const bus = new EventBus();
		const handler = vi.fn();

		const unsub = bus.subscribeType("session.status", handler);
		bus.emit(createEvent("session.status", "sess-1", { status: "running" }));
		unsub();
		bus.emit(createEvent("session.status", "sess-1", { status: "ended" }));

		expect(handler).toHaveBeenCalledOnce();
	});
});

describe("createEvent", () => {
	it("creates event with correct structure", () => {
		const event = createEvent("session.output", "test-session", {
			text: "hello",
		});

		expect(event.type).toBe("session.output");
		expect(event.sessionId).toBe("test-session");
		expect(event.payload).toEqual({ text: "hello" });
		expect(event.timestamp).toBeDefined();
		expect(typeof event.timestamp).toBe("number");
	});

	it("creates event with current timestamp", () => {
		const before = Date.now();
		const event = createEvent("session.status", "sess", {});
		const after = Date.now();

		expect(event.timestamp).toBeGreaterThanOrEqual(before);
		expect(event.timestamp).toBeLessThanOrEqual(after);
	});
});
