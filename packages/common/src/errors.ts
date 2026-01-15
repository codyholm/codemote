/**
 * Base error class for Guild Remote
 */
export class GuildRemoteError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GuildRemoteError";
		this.code = code;
	}
}

/**
 * Session-related errors
 */
export class SessionNotFoundError extends GuildRemoteError {
	constructor(sessionId: string) {
		super("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
		this.name = "SessionNotFoundError";
	}
}

export class SessionNotActiveError extends GuildRemoteError {
	constructor(sessionId: string) {
		super("SESSION_NOT_ACTIVE", `Session is not active: ${sessionId}`);
		this.name = "SessionNotActiveError";
	}
}

/**
 * Executor-related errors
 */
export class ExecutorError extends GuildRemoteError {
	constructor(message: string) {
		super("EXECUTOR_ERROR", message);
		this.name = "ExecutorError";
	}
}

export class ExecutorNotFoundError extends GuildRemoteError {
	constructor(runtime: string) {
		super("EXECUTOR_NOT_FOUND", `No executor for runtime: ${runtime}`);
		this.name = "ExecutorNotFoundError";
	}
}

/**
 * Workspace-related errors
 */
export class WorkspaceNotFoundError extends GuildRemoteError {
	constructor(slug: string) {
		super("WORKSPACE_NOT_FOUND", `Workspace not found: ${slug}`);
		this.name = "WorkspaceNotFoundError";
	}
}

/**
 * Relay-related errors
 */
export class PairingCodeInvalidError extends GuildRemoteError {
	constructor() {
		super("PAIRING_CODE_INVALID", "Invalid or expired pairing code");
		this.name = "PairingCodeInvalidError";
	}
}

export class NotConnectedError extends GuildRemoteError {
	constructor() {
		super("NOT_CONNECTED", "Not connected to relay");
		this.name = "NotConnectedError";
	}
}
