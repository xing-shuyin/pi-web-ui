import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { AgentService } from "../../server/agent-service-daemon.js";
import { fakeClientSession, fakeAgentService } from "../helpers/fake-session.js";

describe("MCP runtime consumers", () => {
	it("refreshes management UI for every client viewing the changed project", () => {
		const client = (cwd: string) => ({ cwd, broadcastMcpServers: vi.fn(), pushSettings: vi.fn() });
		const a = client("/project/a"),
			a2 = client("/project/a"),
			b = client("/project/b");
		const service = fakeAgentService() as any;
		service.clients = new Map([
			["a", a],
			["a2", a2],
			["b", b],
		]);
		service.refreshMcpProject("/project/a");
		for (const cs of [a, a2]) {
			expect(cs.broadcastMcpServers).toHaveBeenCalledOnce();
			expect(cs.pushSettings).toHaveBeenCalledOnce();
		}
		expect(b.broadcastMcpServers).not.toHaveBeenCalled();
	});

	it("hot tool refresh reapplies gating to all stable conversation sessions", () => {
		const cs = fakeClientSession() as any;
		const a = { session: {}, cwd: "/project/a", agentPreset: "standard" };
		const b = { session: {}, cwd: "/project/b", agentPreset: "ask" };
		cs.convs = new Map([
			["a", a],
			["b", b],
		]);
		cs.applyToolGating = vi.fn();
		cs.refreshPluginTools();
		expect(cs.applyToolGating).toHaveBeenCalledWith(a.session, "standard");
		expect(cs.applyToolGating).toHaveBeenCalledWith(b.session, "ask");
	});

	it("plugin definitions use the passed conversation cwd rather than the current UI project", () => {
		const cs = fakeClientSession() as any;
		cs.cwd = "/ui/project";
		cs.settingsSvc = { current: {} };
		cs.pluginToolsProvider = vi.fn(() => []);
		cs.enabledPluginToolDefs("standard", "/background/project");
		expect(cs.pluginToolsProvider).toHaveBeenCalledWith("/background/project");
	});
});
