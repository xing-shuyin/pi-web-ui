import { describe, expect, it } from "vitest";
import {
	DEFAULT_DSH_CAPABILITIES,
	DEFAULT_PI_CAPABILITIES,
	resolveEngineCapabilities,
} from "../../server/engine-capabilities.js";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink } from "../../server/universal/driver-base.js";

class DummyDriver extends BaseAgentDriver {
	readonly id = "dummy";
	readonly name = "Dummy Driver";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: true,
		supportsHistoryEdit: false,
	};

	async sendPrompt(_prompt: string, _attachments: any, _sink: AgentEventSink): Promise<void> {}
	async abort(): Promise<void> {}
	async createSession(): Promise<string> {
		return "dummy-session";
	}
	async resumeSession(_id: string): Promise<void> {}
	dispose(): void {}
}

describe("engine-capabilities", () => {
	it("Pi 引擎默认声明全量能力", () => {
		expect(DEFAULT_PI_CAPABILITIES.remoteSsh).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.conversationRef).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.planMode).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.sandboxes).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.subagents).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.lazyTools).toBe(true);
		expect(DEFAULT_PI_CAPABILITIES.softCap).toBe(true);
	});

	it("DSH 引擎明确禁用不支持的特性", () => {
		expect(DEFAULT_DSH_CAPABILITIES.remoteSsh).toBe(false);
		expect(DEFAULT_DSH_CAPABILITIES.conversationRef).toBe(false);
		expect(DEFAULT_DSH_CAPABILITIES.pageRef).toBe(false);
		expect(DEFAULT_DSH_CAPABILITIES.planMode).toBe(false);
		expect(DEFAULT_DSH_CAPABILITIES.subagents).toBe(false);
		expect(DEFAULT_DSH_CAPABILITIES.lazyTools).toBe(false);
	});

	it("resolveEngineCapabilities 能够正确合并 patch", () => {
		const custom = resolveEngineCapabilities({ remoteSsh: true, planMode: true });
		expect(custom.remoteSsh).toBe(true);
		expect(custom.planMode).toBe(true);
		expect(custom.conversationRef).toBe(false);
	});

	it("BaseAgentDriver 能够映射自身 capabilities 到标准 AgentEngineCapabilities", () => {
		const driver = new DummyDriver("/tmp");
		const caps = driver.getEngineCapabilities();
		expect(caps.treeFork).toBe(true);
		expect(caps.messageEdit).toBe(false);
		expect(caps.remoteSsh).toBe(false);
		expect(caps.conversationRef).toBe(false);
	});
});
