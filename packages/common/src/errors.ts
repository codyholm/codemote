/**
 * Base error class for Codemote
 */
export class CodemoteError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CodemoteError";
		this.code = code;
	}
}

/**
 * Session-related errors
 */
export class SessionNotFoundError extends CodemoteError {
	constructor(sessionId: string) {
		super("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
		this.name = "SessionNotFoundError";
	}
}

export class SessionNotActiveError extends CodemoteError {
	constructor(sessionId: string) {
		super("SESSION_NOT_ACTIVE", `Session is not active: ${sessionId}`);
		this.name = "SessionNotActiveError";
	}
}

/**
 * Workspace-related errors
 */
export class WorkspaceNotFoundError extends CodemoteError {
	constructor(slug: string) {
		super("WORKSPACE_NOT_FOUND", `Workspace not found: ${slug}`);
		this.name = "WorkspaceNotFoundError";
	}
}
