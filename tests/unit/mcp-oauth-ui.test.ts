import { describe, expect, it, vi } from "vitest";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";
import { McpOAuthUi } from "../../server/mcp-oauth-ui.js";
import type * as Login from "../../server/mcp-oauth-login.js";

function fixture() {
	const service = {
		startMcpOAuthLogin: vi.fn(async () => ({
			id: "secret-id",
			authorizationUrl: "https://auth.example/authorize",
			redirectUrl: "http://localhost:123/callback",
		})),
		finishMcpOAuthLogin: vi.fn(async () => {}),
		cancelMcpOAuthLogin: vi.fn(),
		getMcpOAuthLoginStatus: vi.fn(() => ({ status: "pending" as "pending" | "complete" | "error" })),
	};
	const context = {
		cwd: "/project-a",
		agentDir: "/agent",
		resolveServer: vi.fn(() => "https://mcp.example"),
		reload: vi.fn(async (_cwd: string) => {}),
		send: vi.fn(),
	};
	const ui = new McpOAuthUi(service as unknown as typeof Login);
	const start = { type: "mcp_oauth_start" as const, reqId: "request", name: "example", scope: "project" as const };
	return { ui, service, context, start };
}

describe("MCP OAuth requester lifecycle", () => {
	it("routes OAuth requests and reports unsupported sessions", () => {
		const msg = { type: "mcp_oauth_status" as const, reqId: "request", id: "login" };
		const handleMcpOAuth = vi.fn();
		expect(handleSettingsMessage(msg, { handleMcpOAuth } as unknown as DispatchSession)).toBe(true);
		expect(handleMcpOAuth).toHaveBeenCalledWith(msg);
		const send = vi.fn();
		expect(handleSettingsMessage(msg, {} as DispatchSession, send)).toBe(true);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "mcp_oauth_result", reqId: "request", status: "error" }),
		);
	});
	it("resolves exact scope and keeps captured project when a later request uses another cwd", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		expect(context.resolveServer).toHaveBeenCalledWith("example", "project");
		expect(service.startMcpOAuthLogin).toHaveBeenCalledWith({
			agentDir: "/agent",
			name: "example",
			serverUrl: "https://mcp.example",
		});
		await ui.handle(
			{
				type: "mcp_oauth_finish",
				reqId: "request",
				id: "secret-id",
				redirectUrl: "http://localhost:123/callback?code=private",
			},
			{ ...context, cwd: "/project-b" },
		);
		expect(context.reload).toHaveBeenCalledExactlyOnceWith("/project-a");
		expect(context.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: "complete" }));
	});

	it("rejects another requester even with the correct backend ID", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		const stranger = new McpOAuthUi(service as unknown as typeof Login);
		await stranger.handle(
			{ type: "mcp_oauth_finish", reqId: "request", id: "secret-id", redirectUrl: "http://localhost/callback" },
			context,
		);
		expect(service.finishMcpOAuthLogin).not.toHaveBeenCalled();
		expect(service.cancelMcpOAuthLogin).not.toHaveBeenCalled();
	});

	it.each(["cancel", "dispose"])("cancels startup that resolves after %s", async (action) => {
		const { ui, service, context, start } = fixture();
		let release!: (value: Awaited<ReturnType<typeof service.startMcpOAuthLogin>>) => void;
		service.startMcpOAuthLogin.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const running = ui.handle(start, context);
		if (action === "dispose") ui.dispose();
		else await ui.handle({ type: "mcp_oauth_cancel", reqId: "request" }, context);
		release({ id: "late-id", authorizationUrl: "https://auth.example", redirectUrl: "http://localhost/callback" });
		await running;
		expect(service.cancelMcpOAuthLogin).toHaveBeenCalledWith("late-id");
		expect(context.send.mock.calls.some(([m]) => m.status === "pending")).toBe(false);
	});

	it("reloads once for concurrent auto-completion polls and permits more than eight completed logins", async () => {
		const { ui, service, context, start } = fixture();
		service.getMcpOAuthLoginStatus.mockReturnValue({ status: "complete" });
		for (let i = 0; i < 10; i++) {
			const reqId = `request-${i}`;
			await ui.handle({ ...start, reqId }, context);
			const poll = { type: "mcp_oauth_status" as const, reqId, id: "secret-id" };
			await Promise.all([ui.handle(poll, context), ui.handle(poll, context)]);
		}
		expect(context.reload).toHaveBeenCalledTimes(10);
		expect(service.startMcpOAuthLogin).toHaveBeenCalledTimes(10);
	});

	it("does not let a wrong backend ID cancel the valid attempt", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		await ui.handle({ type: "mcp_oauth_status", reqId: "request", id: "wrong" }, context);
		expect(service.cancelMcpOAuthLogin).not.toHaveBeenCalled();
		await ui.handle({ type: "mcp_oauth_status", reqId: "request", id: "secret-id" }, context);
		expect(context.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: "pending" }));
	});

	it("suppresses a failed finish after cancellation", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		let reject!: (error: Error) => void;
		service.finishMcpOAuthLogin.mockImplementation(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		const finish = ui.handle(
			{ type: "mcp_oauth_finish", reqId: "request", id: "secret-id", redirectUrl: "http://localhost/callback" },
			context,
		);
		await ui.handle({ type: "mcp_oauth_cancel", reqId: "request" }, context);
		context.send.mockClear();
		reject(new Error("aborted"));
		await finish;
		expect(context.send).not.toHaveBeenCalled();
		expect(context.reload).not.toHaveBeenCalled();
	});

	it("preserves malformed callbacks for retry, including concurrent polls", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		let reject!: (error: Error) => void;
		service.finishMcpOAuthLogin.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		const request = { type: "mcp_oauth_finish" as const, reqId: "request", id: "secret-id", redirectUrl: "bad-url" };
		const finish = ui.handle(request, context);
		const poll = ui.handle({ type: "mcp_oauth_status", reqId: "request", id: "secret-id" }, context);
		reject(new Error("Invalid callback"));
		await Promise.all([finish, poll]);
		expect(service.cancelMcpOAuthLogin).not.toHaveBeenCalled();
		expect(context.send).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "pending", error: expect.any(String) }),
		);
		await ui.handle({ ...request, redirectUrl: "http://localhost/callback?code=valid" }, context);
		expect(context.reload).toHaveBeenCalledExactlyOnceWith("/project-a");
		expect(context.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: "complete" }));
	});

	it("shares manual finish with status requests until persistence completes", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		let resolve!: () => void;
		service.finishMcpOAuthLogin.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const finish = ui.handle(
			{ type: "mcp_oauth_finish", reqId: "request", id: "secret-id", redirectUrl: "http://localhost/callback" },
			context,
		);
		const poll = ui.handle({ type: "mcp_oauth_status", reqId: "request", id: "secret-id" }, context);
		expect(context.reload).not.toHaveBeenCalled();
		resolve();
		await Promise.all([finish, poll]);
		expect(service.finishMcpOAuthLogin).toHaveBeenCalledTimes(1);
		expect(context.reload).toHaveBeenCalledTimes(1);
	});

	it("handles expiration during the recovery status probe without rejecting", async () => {
		const { ui, service, context, start } = fixture();
		await ui.handle(start, context);
		service.finishMcpOAuthLogin.mockRejectedValue(new Error("expired"));
		service.getMcpOAuthLoginStatus.mockImplementation(() => {
			throw new Error("expired");
		});
		await expect(
			ui.handle(
				{ type: "mcp_oauth_finish", reqId: "request", id: "secret-id", redirectUrl: "http://localhost/callback" },
				context,
			),
		).resolves.toBeUndefined();
		expect(service.cancelMcpOAuthLogin).toHaveBeenCalledWith("secret-id");
		expect(context.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
	});

	it("never sends provider errors to the browser", async () => {
		const { ui, service, context, start } = fixture();
		service.startMcpOAuthLogin.mockRejectedValue(new Error("access_token=DO_NOT_SEND"));
		await ui.handle(start, context);
		expect(JSON.stringify(context.send.mock.calls)).not.toContain("DO_NOT_SEND");
		expect(context.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
	});
});
