import type { ClientMessage, ServerMessage } from "./protocol.js";
import * as login from "./mcp-oauth-login.js";

type Request = Extract<
	ClientMessage,
	{ type: "mcp_oauth_start" | "mcp_oauth_finish" | "mcp_oauth_status" | "mcp_oauth_cancel" }
>;
type Attempt = { cwd: string; id?: string; cancelled: boolean; finishing?: Promise<void>; completed?: boolean };
type Service = typeof login;

export class McpOAuthUi {
	private attempts = new Map<string, Attempt>();
	private closed = false;
	constructor(private service: Service = login) {}

	async handle(
		msg: Request,
		context: {
			cwd: string;
			agentDir: string;
			resolveServer: (name: string, scope: "global" | "project") => string | undefined;
			reload: (cwd: string) => Promise<void>;
			send: (message: ServerMessage) => void;
		},
	): Promise<void> {
		const send = (status: "pending" | "complete" | "error" | "cancelled", extra = {}) => {
			if (!this.closed) context.send({ type: "mcp_oauth_result", reqId: msg.reqId, status, ...extra });
		};
		let ownedAttempt: Attempt | undefined;
		try {
			if (msg.type === "mcp_oauth_start") {
				for (const [key, attempt] of this.attempts) {
					if (attempt.completed) {
						if (attempt.id) this.service.cancelMcpOAuthLogin(attempt.id);
						this.attempts.delete(key);
					}
				}
				if (this.closed || this.attempts.has(msg.reqId) || this.attempts.size >= 8) {
					send("error", { error: "Unable to start MCP authorization. Please try again." });
					return;
				}
				const serverUrl = context.resolveServer(msg.name, msg.scope);
				if (!serverUrl || !["https:", "http:"].includes(new URL(serverUrl).protocol)) throw new Error();
				const attempt: Attempt = { cwd: context.cwd, cancelled: false };
				this.attempts.set(msg.reqId, attempt);
				try {
					const result = await this.service.startMcpOAuthLogin({
						agentDir: context.agentDir,
						name: msg.name,
						serverUrl,
					});
					attempt.id = result.id;
					if (attempt.cancelled || this.closed) {
						this.service.cancelMcpOAuthLogin(result.id);
						return;
					}
					const url = new URL(result.authorizationUrl);
					if (!["https:", "http:"].includes(url.protocol)) throw new Error();
					send("pending", result);
				} catch {
					if (attempt.id) this.service.cancelMcpOAuthLogin(attempt.id);
					this.attempts.delete(msg.reqId);
					if (!attempt.cancelled) send("error", { error: "Unable to start MCP authorization. Please try again." });
				}
				return;
			}
			const attempt = this.attempts.get(msg.reqId);
			if (!attempt || (msg.type !== "mcp_oauth_cancel" && attempt.id !== msg.id)) {
				send("error", { error: "MCP authorization failed. Please start a new login." });
				return;
			}
			ownedAttempt = attempt;
			if (msg.type === "mcp_oauth_cancel") {
				attempt.cancelled = true;
				if (attempt.id) this.service.cancelMcpOAuthLogin(attempt.id);
				this.attempts.delete(msg.reqId);
				send("cancelled");
				return;
			}
			if (!attempt.id || attempt.cancelled) throw new Error();
			if (attempt.completed) {
				send("complete", { id: attempt.id });
				return;
			}
			if (!attempt.finishing) {
				if (msg.type === "mcp_oauth_finish") {
					if (!msg.redirectUrl || msg.redirectUrl.length > 16384) throw new Error();
					attempt.finishing = (async () => {
						await this.service.finishMcpOAuthLogin({ id: attempt.id!, redirectUrl: msg.redirectUrl });
						if (!attempt.cancelled && !this.closed) await context.reload(attempt.cwd);
					})();
				} else {
					const status = this.service.getMcpOAuthLoginStatus(attempt.id);
					if (status.status === "error") throw new Error();
					if (status.status === "pending") {
						send("pending", { id: attempt.id });
						return;
					}
					attempt.finishing = context.reload(attempt.cwd);
				}
			}
			await attempt.finishing;
			if (attempt.cancelled || this.closed) return;
			attempt.completed = true;
			send("complete", { id: attempt.id });
		} catch {
			const attempt = this.attempts.get(msg.reqId);
			if (ownedAttempt?.cancelled || this.closed) return;
			let recoverable = false;
			try {
				recoverable = !!attempt?.id && this.service.getMcpOAuthLoginStatus(attempt.id).status === "pending";
			} catch {}
			if ((msg.type === "mcp_oauth_finish" || msg.type === "mcp_oauth_status") && attempt?.id && recoverable) {
				attempt.finishing = undefined;
				send("pending", { id: attempt.id, error: "Invalid redirect URL. Paste the full callback URL and try again." });
				return;
			}
			if (attempt?.id) this.service.cancelMcpOAuthLogin(attempt.id);
			this.attempts.delete(msg.reqId);
			send("error", { error: "MCP authorization failed. Please start a new login." });
		}
	}

	dispose(): void {
		this.closed = true;
		for (const attempt of this.attempts.values()) {
			attempt.cancelled = true;
			if (attempt.id) this.service.cancelMcpOAuthLogin(attempt.id);
		}
		this.attempts.clear();
	}
}
