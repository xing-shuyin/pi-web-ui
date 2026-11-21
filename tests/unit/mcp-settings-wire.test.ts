import { describe, expect, it, vi } from "vitest";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { ClientMessage } from "../../server/protocol.js";
import type { DispatchSession } from "../../server/engine-service.js";

describe("MCP 设置消息分发 (handleSettingsMessage)", () => {
	it("分发 save_mcp_server 消息", () => {
		const saveMcpServer = vi.fn();
		const mockSession = {
			saveMcpServer,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "save_mcp_server",
			server: {
				name: "test-fs",
				scope: "global",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
				enabled: true,
			},
			prevName: "old-fs",
			prevScope: "project",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(saveMcpServer).toHaveBeenCalledWith(msg.server, "old-fs", "project");
	});

	it("分发 delete_mcp_server 消息", () => {
		const deleteMcpServer = vi.fn();
		const mockSession = {
			deleteMcpServer,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "delete_mcp_server",
			name: "test-fs",
			scope: "project",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(deleteMcpServer).toHaveBeenCalledWith("test-fs", "project");
	});

	it("分发 toggle_mcp_server 消息", () => {
		const toggleMcpServer = vi.fn();
		const mockSession = {
			toggleMcpServer,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "toggle_mcp_server",
			name: "test-fs",
			scope: "global",
			enabled: false,
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(toggleMcpServer).toHaveBeenCalledWith("test-fs", "global", false);
	});

	it("分发 reload_mcp 消息", () => {
		const reloadMcp = vi.fn();
		const mockSession = {
			reloadMcp,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "reload_mcp",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(reloadMcp).toHaveBeenCalled();
	});
});
