import { describe, expect, it, vi } from "vitest";
import { subscribePluginSessionEvents } from "../../packages/keel/src/app/plugin-engine-hooks.js";
import responseSpeedPlugin from "../../plugins/response-speed/index.mjs";
import type { PluginRunEvent } from "../../packages/keel/src/contracts/plugin.js";

describe("pi 插件运行事件桥", () => {
	it("响应速度插件能消费真实 SDK 桥事件并更新底栏", () => {
		let listener: ((event: unknown) => void) | undefined;
		let runEventHandler: ((event: PluginRunEvent) => void) | undefined;
		const updates = new Map<string, { label?: string }>();
		const cleanupPlugin = responseSpeedPlugin.activate({
			storage: { get: () => undefined, set: vi.fn() },
			ui: { update: (id: string, patch: { label?: string }) => updates.set(id, patch) },
			route: vi.fn(),
			broadcast: vi.fn(),
			onAttach: vi.fn(),
			onConversationChanged: vi.fn(),
			getActiveConversation: () => ({ conversationId: "conv-1" }),
			onRunEvent: (handler: (event: PluginRunEvent) => void) => {
				runEventHandler = handler;
				return () => {};
			},
			onUiAction: vi.fn(),
		} as any);
		const cleanupBridge = subscribePluginSessionEvents({
			session: {
				subscribe: (callback: (event: unknown) => void) => {
					listener = callback;
					return () => {};
				},
			},
			conv: { id: "conv-1" } as any,
			clientId: "client-1",
			onChange: vi.fn(),
			onRunEvent: (event) => runEventHandler?.(event),
		});
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		listener!({ type: "turn_start" });
		now = 1650;
		listener!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
		expect(updates.get("response-speed-badge")?.label).toBe("0.7/0.7");
		cleanupBridge();
		cleanupPlugin?.();
		vi.restoreAllMocks();
	});

	it("从真实 SDK 事件序列产出 turn_first_token，并覆盖自循环每一轮", () => {
		let listener: ((event: unknown) => void) | undefined;
		const unsubscribe = vi.fn();
		const session = {
			subscribe: vi.fn((callback: (event: unknown) => void) => {
				listener = callback;
				return unsubscribe;
			}),
		};
		const events: PluginRunEvent[] = [];
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const cleanup = subscribePluginSessionEvents({
			session,
			conv: { id: "conv-1" } as any,
			clientId: "client-1",
			sessionId: "session-1",
			onChange: vi.fn(),
			onRunEvent: (event) => events.push(event),
		});

		listener!({ type: "turn_start" });
		now = 1400;
		listener!({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
		now = 1500;
		listener!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
		listener!({ type: "turn_end" });

		listener!({ type: "turn_start" });
		now = 1900;
		listener!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } });
		listener!({ type: "turn_end" });

		expect(events.filter((event) => event.type === "turn_first_token")).toEqual([
			expect.objectContaining({ conversationId: "conv-1", at: 1400, durationMs: 400 }),
			expect.objectContaining({ conversationId: "conv-1", at: 1900, durationMs: 400 }),
		]);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);

		cleanup();
		expect(unsubscribe).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
});
