/**
 * Errors raised by the ACP adapter.
 */

export class AcpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AcpError";
    }
}

export class MissingAcpDependencyError extends AcpError {
    readonly original?: unknown;
    constructor(original?: unknown) {
        let msg =
            "The ACP adapter requires the optional 'agent-client-protocol' " +
            "package. Install it with: npm install @zed-industries/agent-client-protocol";
        if (original !== undefined) {
            msg += ` (original error: ${String(original)})`;
        }
        super(msg);
        this.name = "MissingAcpDependencyError";
        this.original = original;
    }
}
