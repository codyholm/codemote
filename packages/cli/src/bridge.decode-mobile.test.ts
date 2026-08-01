import { describe, expect, it } from "vitest";
import { decodeMobileInbound } from "./bridge.js";

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

describe("decodeMobileInbound", () => {
	describe("new_session temperature validation", () => {
		const base = { type: "new_session", runtime: "claude", prompt: "test" };

		it("accepts valid temperature values", () => {
			expect(decodeMobileInbound({ ...base, temperature: 0 })).toMatchObject({ temperature: 0 });
			expect(decodeMobileInbound({ ...base, temperature: 1 })).toMatchObject({ temperature: 1 });
			expect(decodeMobileInbound({ ...base, temperature: 2 })).toMatchObject({ temperature: 2 });
			expect(decodeMobileInbound({ ...base, temperature: 0.7 })).toMatchObject({
				temperature: 0.7,
			});
		});

		it("rejects temperature above 2", () => {
			const result = decodeMobileInbound({ ...base, temperature: 2.1 });
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});

		it("rejects negative temperature", () => {
			const result = decodeMobileInbound({ ...base, temperature: -0.1 });
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});

		it("rejects NaN temperature", () => {
			const result = decodeMobileInbound({ ...base, temperature: Number.NaN });
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});

		it("rejects Infinity temperature", () => {
			const result = decodeMobileInbound({ ...base, temperature: Number.POSITIVE_INFINITY });
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});

		it("rejects non-number temperature", () => {
			const result = decodeMobileInbound({ ...base, temperature: "0.5" });
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});

		it("omits temperature when not provided", () => {
			const result = decodeMobileInbound(base);
			expect(result).not.toBeNull();
			expect(asRecord(result)["temperature"]).toBeUndefined();
		});
	});

	describe("new_session maxTokens validation", () => {
		const base = { type: "new_session", runtime: "claude", prompt: "test" };

		it("accepts valid maxTokens values", () => {
			expect(decodeMobileInbound({ ...base, maxTokens: 1 })).toMatchObject({ maxTokens: 1 });
			expect(decodeMobileInbound({ ...base, maxTokens: 4096 })).toMatchObject({
				maxTokens: 4096,
			});
		});

		it("rejects zero maxTokens", () => {
			const result = decodeMobileInbound({ ...base, maxTokens: 0 });
			expect(result).not.toBeNull();
			expect(asRecord(result)["maxTokens"]).toBeUndefined();
		});

		it("rejects negative maxTokens", () => {
			const result = decodeMobileInbound({ ...base, maxTokens: -1 });
			expect(result).not.toBeNull();
			expect(asRecord(result)["maxTokens"]).toBeUndefined();
		});

		it("rejects non-integer maxTokens", () => {
			const result = decodeMobileInbound({ ...base, maxTokens: 1.5 });
			expect(result).not.toBeNull();
			expect(asRecord(result)["maxTokens"]).toBeUndefined();
		});

		it("rejects non-number maxTokens", () => {
			const result = decodeMobileInbound({ ...base, maxTokens: "4096" });
			expect(result).not.toBeNull();
			expect(asRecord(result)["maxTokens"]).toBeUndefined();
		});

		it("omits maxTokens when not provided", () => {
			const result = decodeMobileInbound(base);
			expect(result).not.toBeNull();
			expect(asRecord(result)["maxTokens"]).toBeUndefined();
		});
	});

	describe("project-folder starts", () => {
		const base = {
			type: "new_session",
			runtime: "codex",
			prompt: "test",
			projectStart: {
				operationId: "operation-1",
				originProjectPath: "/tmp/project",
				mode: "project_folder",
				preparation: { type: "none" },
			},
		};

		it("accepts strict no-branch and branch requests", () => {
			expect(decodeMobileInbound(base)).toMatchObject({ projectStart: base.projectStart });
			expect(
				decodeMobileInbound({
					...base,
					projectStart: {
						...base.projectStart,
						preparation: {
							type: "create_branch",
							newBranch: "feature/session",
							expectedHead: "abc123",
							expectedBranch: null,
						},
					},
				}),
			).toMatchObject({
				projectStart: {
					preparation: {
						type: "create_branch",
						newBranch: "feature/session",
						expectedHead: "abc123",
						expectedBranch: null,
					},
				},
			});
		});

		it("keeps project-aware starts fresh even when a legacy resume ID is supplied", () => {
			const decoded = decodeMobileInbound({ ...base, resumeSessionId: "legacy-session" });
			expect(decoded).not.toBeNull();
			expect(asRecord(decoded)["resumeSessionId"]).toBeUndefined();
		});

		it("rejects malformed nested intent instead of downgrading it", () => {
			const malformed: unknown[] = [
				null,
				{},
				{ ...base.projectStart, operationId: "" },
				{ ...base.projectStart, mode: "worktree" },
				{ ...base.projectStart, preparation: { type: "none", newBranch: "feature/oops" } },
				{
					...base.projectStart,
					preparation: {
						type: "create_branch",
						newBranch: "",
						expectedHead: "abc123",
						expectedBranch: "main",
					},
				},
				{
					...base.projectStart,
					preparation: {
						type: "create_branch",
						newBranch: "feature/session",
						expectedBranch: "main",
					},
				},
			];

			for (const projectStart of malformed) {
				expect(decodeMobileInbound({ ...base, projectStart })).toBeNull();
			}
		});

		it("decodes project start capability requests", () => {
			expect(
				decodeMobileInbound({
					type: "get_project_start_state",
					projectPath: "/tmp/project",
				}),
			).toEqual({
				type: "get_project_start_state",
				projectPath: "/tmp/project",
			});
			expect(decodeMobileInbound({ type: "get_project_start_state", projectPath: "" })).toBeNull();
		});

		it("accepts strict detached and attached Worktree requests", () => {
			const worktree = {
				operationId: "worktree-1",
				originProjectPath: "/tmp/project",
				mode: "worktree",
				preparation: {
					type: "create_worktree",
					baseRef: "refs/remotes/origin/main",
					expectedCommit: "a".repeat(40),
					newBranch: null,
				},
			};
			expect(decodeMobileInbound({ ...base, projectStart: worktree })).toMatchObject({
				projectStart: worktree,
			});
			expect(
				decodeMobileInbound({
					...base,
					projectStart: {
						...worktree,
						preparation: { ...worktree.preparation, newBranch: "feature/mobile" },
					},
				}),
			).toMatchObject({
				projectStart: { preparation: { newBranch: "feature/mobile" } },
			});
		});

		it("rejects malformed Worktree fields", () => {
			const preparation = {
				type: "create_worktree",
				baseRef: "refs/heads/main",
				expectedCommit: "b".repeat(40),
				newBranch: null,
			};
			const worktree = {
				operationId: "worktree-1",
				originProjectPath: "/tmp/project",
				mode: "worktree",
				preparation,
			};
			for (const projectStart of [
				{ ...worktree, originProjectPath: "relative" },
				{ ...worktree, preparation: { ...preparation, baseRef: "main" } },
				{ ...worktree, preparation: { ...preparation, baseRef: "refs/remotes/origin/HEAD" } },
				{ ...worktree, preparation: { ...preparation, expectedCommit: "short" } },
				{ ...worktree, preparation: { ...preparation, newBranch: "" } },
				{ ...worktree, preparation: { ...preparation, unexpected: true } },
			]) {
				expect(decodeMobileInbound({ ...base, projectStart })).toBeNull();
			}
		});
	});
});
