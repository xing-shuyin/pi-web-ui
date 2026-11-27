import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalAgentService } from "../../server/universal/universal-service.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";
import type { PluginRunEvent } from "../../server/plugins.js";

const roots: string[] = [];
const services: UniversalAgentService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.disposeAll();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Universal 插件运行事件桥", () => {
	it("服务层接通首包事件，工具后的下一次模型请求重新计时", async () => {
		const root = mkdtempSync(join(tmpdir(), "universal-plugin-events-"));
		roots.push(root);
		const driver = new MockAgentDriver(root);
		let sink!: AgentEventSink;
		let release!: () => void;
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_prompt, _attachments, events) => {
			sink = events;
			await done;
		});
		const service = new UniversalAgentService({
			cwd: root,
			dataDir: root,
			agentDir: root,
			engine: "codex",
			driverFactory: () => driver,
		});
		services.push(service);
		const events: PluginRunEvent[] = [];
		service.onRunEvent = (event) => events.push(event);
		const session = await service.attach("plugin-events-client", vi.fn());
		const pending = session.prompt("tool task");
		await vi.waitFor(() => expect(sink).toBeDefined());

		sink.onThinkingDelta("plan");
		sink.onThinkingDelta(" more");
		const first = events.find((event) => event.type === "turn_first_token")!;
		const firstStart = events.find((event) => event.type === "turn_start")!;
		expect(first.durationMs).toBe(Math.max(1, first.at - firstStart.at));
		expect(events.filter((event) => event.type === "turn_first_token")).toHaveLength(1);

		sink.onToolStart("call-1", "bash", { command: "echo ok" });
		sink.onToolStart("call-2", "read", { path: "file.txt" });
		sink.onToolEnd("call-1", { output: "ok" });
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
		sink.onToolEnd("call-2", { output: "ok" });
		const starts = events.filter((event) => event.type === "turn_start");
		expect(starts).toHaveLength(2);
		sink.onTextDelta("answer");
		const samples = events.filter((event) => event.type === "turn_first_token");
		expect(samples).toHaveLength(2);
		expect(samples[1]!.durationMs).toBe(Math.max(1, samples[1]!.at - starts[1]!.at));

		sink.onTurnComplete();
		release();
		await pending;
		expect(events.at(-1)?.type).toBe("run_end");
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);

		const snapshot = service.readConversationForPlugins({ clientId: "plugin-events-client" });
		expect(snapshot?.conversationId).toBe(session.activeConversationId?.());
		expect(snapshot?.messages.some((message) => message.role === "assistant")).toBe(true);
	});
});
