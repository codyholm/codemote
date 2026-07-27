import { ATTENTION_DESCRIPTION_MAX, type RunOptions, type RuntimeType } from "@codemote/common";
import { describe, expect, it } from "vitest";
import { EventBus } from "./events.js";
import { BaseExecutor } from "./executor.js";
import { SessionManager } from "./session.js";
import type { Session, Workspace } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * Exposes the protected emit helpers and lets a test decide whether doSendInput
 * succeeds, which is the only way to exercise the failure path in sendInput.
 */
class ProbeExecutor extends BaseExecutor {
	readonly type: RuntimeType = "opencode";
	sendInputShouldThrow = false;
	sentInputs: string[] = [];

	protected async doStartRun(_session: Session, _options: RunOptions): Promise<void> {}

	protected async doSendInput(_session: Session, input: string): Promise<void> {
		if (this.sendInputShouldThrow) throw new Error("child stdin is closed");
		this.sentInputs.push(input);
	}

	protected async doStop(_session: Session): Promise<void> {}

	raiseAttention(sessionId: string, reason: string, details?: unknown): void {
		this.emitAttention(sessionId, reason, details);
	}
}

function harness(): { executor: ProbeExecutor; sessions: SessionManager; session: Session } {
	const sessions = new SessionManager();
	const executor = new ProbeExecutor(new WorkspaceManager("/tmp"), sessions, new EventBus());
	const workspace: Workspace = { id: "ws-1", workingDir: "/tmp/probe", createdAt: 0 };
	const session = sessions.create("opencode", workspace);
	sessions.updateStatus(session.id, "running");
	return { executor, sessions, session };
}

describe("BaseExecutor attention lifecycle", () => {
	it("clears attention once the input has been delivered", async () => {
		const { executor, sessions, session } = harness();
		executor.raiseAttention(session.id, "approval_required", { description: "Run it?" });
		expect(sessions.get(session.id)?.attention).toBeDefined();

		await executor.sendInput(session.id, "y");

		expect(sessions.get(session.id)?.attention).toBeUndefined();
		expect(executor.sentInputs).toEqual(["y"]);
	});

	it("falls back through description, action and tool before the bare reason", () => {
		const { executor, sessions, session } = harness();

		executor.raiseAttention(session.id, "permission_required", { description: "Write hosts?" });
		expect(sessions.get(session.id)?.attention?.description).toBe("Write hosts?");

		executor.raiseAttention(session.id, "approval_required", { action: "file_write" });
		expect(sessions.get(session.id)?.attention?.description).toBe("file_write");

		// Claude omits description for some tools; the tool name still beats the reason.
		executor.raiseAttention(session.id, "permission_required", { tool: "Bash", args: {} });
		expect(sessions.get(session.id)?.attention?.description).toBe("Bash");

		executor.raiseAttention(session.id, "permission_required", {});
		expect(sessions.get(session.id)?.attention?.description).toBe("permission_required");
	});

	it("bounds a description the runtime made too long", () => {
		const { executor, sessions, session } = harness();

		executor.raiseAttention(session.id, "approval_required", { description: "x".repeat(5000) });

		expect(sessions.get(session.id)?.attention?.description).toHaveLength(
			ATTENTION_DESCRIPTION_MAX,
		);
	});

	it("keeps attention when delivering the input fails", async () => {
		const { executor, sessions, session } = harness();
		executor.raiseAttention(session.id, "approval_required", { description: "Run it?" });
		executor.sendInputShouldThrow = true;

		await expect(executor.sendInput(session.id, "y")).rejects.toThrow("child stdin is closed");

		// The caller propagates and never republishes, so clearing before delivery
		// would erase the approval with nothing left to restore it.
		expect(sessions.get(session.id)?.attention?.reason).toBe("approval_required");
	});
});
