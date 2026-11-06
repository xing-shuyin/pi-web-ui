import { describe, expect, it, vi } from "vitest";
import { DshClientSession } from "../../server/dsh/dsh-agent-service";
import type { UiMessage, ServerMessage } from "../../server/protocol";
import {
	firstUserText,
	isDshInternalUserMessage,
	replayEventsToMessages,
	sessionLogPreset,
	sessionLogTitle,
} from "../../server/dsh/dsh-sessions";
import { extractDshAssistantRawText, serializeAssistantBlocks } from "../../server/dsh/dsh-serialize";
import type { SessionLog } from "../../server/dsh/dsh-sessions";

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, seq: 1, time: 1, data });

describe("sessionLogPreset", () => {
	it("无记录 → null", () => {
		expect(sessionLogPreset({ header: null, events: [] })).toBeNull();
		expect(sessionLogPreset({ header: {}, events: [ev("user/message")] })).toBeNull();
	});
	it("header 记录", () => {
		const log: SessionLog = { header: { agentPreset: "standard" }, events: [] };
		expect(sessionLogPreset(log)).toBe("standard");
	});
	it("selected 事件优先于 header，取最后一条", () => {
		const log: SessionLog = {
			header: { agentPreset: "standard" },
			events: [
				ev("agent-preset/selected", { agentPreset: "minimal" }),
				ev("agent-preset/selected", { agentPreset: "ptc" }),
			],
		};
		expect(sessionLogPreset(log)).toBe("ptc");
	});
	it("脏数据宽容（空串/非字符串忽略）", () => {
		const log: SessionLog = {
			header: { agentPreset: "" },
			events: [ev("agent-preset/selected", { agentPreset: 42 }), ev("user/message")],
		};
		expect(sessionLogPreset(log)).toBeNull();
	});
});

describe("isDshInternalUserMessage", () => {
	it("识别各类系统内部 source.kind 消息", () => {
		expect(isDshInternalUserMessage({ source: { kind: "skill-catalog" } })).toBe(true);
		expect(isDshInternalUserMessage({ source: { kind: "agent-instructions" } })).toBe(true);
		expect(isDshInternalUserMessage({ source: { kind: "plugin" } })).toBe(true);
		expect(isDshInternalUserMessage({ source: { kind: "goal" } })).toBe(true);
		expect(isDshInternalUserMessage({ source: { kind: "runtime-context" } })).toBe(true);
	});

	it("识别包含 <system-reminder> 或 <goal_round> 或 Current runtime context 标记的文本内容", () => {
		expect(
			isDshInternalUserMessage({
				content: [{ type: "text", text: "<system-reminder> A skill is a reusable set... </system-reminder>" }],
			}),
		).toBe(true);
		expect(
			isDshInternalUserMessage({
				content: [{ type: "text", text: "<goal_round round=1>" }],
			}),
		).toBe(true);
		expect(
			isDshInternalUserMessage({
				content: [
					{
						type: "text",
						text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write.",
					},
				],
			}),
		).toBe(true);
		expect(
			isDshInternalUserMessage({
				message: { content: [{ type: "text", text: "<system-reminder>some reminder</system-reminder>" }] },
			}),
		).toBe(true);
	});

	it("正常用户消息返回 false", () => {
		expect(
			isDshInternalUserMessage({
				role: "user",
				source: { kind: "user" },
				content: [{ type: "text", text: "你好，请帮我分析代码" }],
			}),
		).toBe(false);
		expect(
			isDshInternalUserMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			}),
		).toBe(false);
	});

	it("空数据或无内容安全返回 false", () => {
		expect(isDshInternalUserMessage(undefined)).toBe(false);
		expect(isDshInternalUserMessage({})).toBe(false);
		expect(isDshInternalUserMessage({ content: [] })).toBe(false);
	});
});

describe("firstUserText 过滤系统内部消息", () => {
	it("跳过先到达的 skill-catalog 与 system-reminder，取真正的首条用户消息", () => {
		const events: SessionLog["events"] = [
			ev("user/message", {
				source: { kind: "skill-catalog" },
				content: [{ type: "text", text: "<system-reminder> available skills... </system-reminder>" }],
			}),
			ev("user/message", {
				source: { kind: "agent-instructions" },
				content: [{ type: "text", text: "system prompt snippet" }],
			}),
			ev("user/message", {
				source: { kind: "user" },
				content: [{ type: "text", text: "你好，这是一条真实的用户消息" }],
			}),
		];
		expect(firstUserText(events, "zh")).toBe("你好，这是一条真实的用户消息");
	});

	it("剥离尾部系统追加的文件引用/附件说明，使会话标题纯净呈现真实提问", () => {
		const events: SessionLog["events"] = [
			ev("user/message", {
				source: { kind: "user" },
				content: [{ type: "text", text: "@Dockerfile 这是啥\n[File reference: Dockerfile]" }],
			}),
		];
		expect(firstUserText(events, "zh")).toBe("@Dockerfile 这是啥");

		const eventsZh: SessionLog["events"] = [
			ev("user/message", {
				source: { kind: "user" },
				content: [{ type: "text", text: "@README.md 总结一下\n[文件引用: README.md]" }],
			}),
		];
		expect(firstUserText(eventsZh, "zh")).toBe("@README.md 总结一下");
	});

	it("仅有内部系统消息时回退到默认标题", () => {
		const events: SessionLog["events"] = [
			ev("user/message", {
				source: { kind: "skill-catalog" },
				content: [{ type: "text", text: "<system-reminder> available skills... </system-reminder>" }],
			}),
		];
		expect(firstUserText(events, "zh")).toBe("新对话");
		expect(firstUserText(events, "en")).toBe("New chat");
	});
});

describe("replayEventsToMessages 过滤系统内部消息", () => {
	it("过滤掉 skill-catalog 和 system-reminder 等内部 user/message，保留正常消息", () => {
		const events: SessionLog["events"] = [
			ev("user/message", {
				id: "u-1",
				source: { kind: "user" },
				content: [{ type: "text", text: "你好" }],
			}),
			ev("user/message", {
				id: "u-sys",
				source: { kind: "skill-catalog" },
				content: [{ type: "text", text: "<system-reminder> available skills... </system-reminder>" }],
			}),
			ev("assistant/message", {
				message: {
					id: "a-1",
					role: "assistant",
					content: [{ type: "text", text: "你好！请问有什么我可以协助的？" }],
				},
			}),
		];
		const messages = replayEventsToMessages(events);
		expect(messages).toHaveLength(2);
		expect(messages[0].id).toBe("u-u-1");
		expect(messages[0].role).toBe("user");
		expect(messages[1].id).toBe("a-a-1");
		expect(messages[1].role).toBe("assistant");
	});
});

describe("DshClientSession 历史会话继承与模型选择持久化", () => {
	it("forkConversation 继承原会话的所有消息历史与 IDs，避免续聊时历史丢失变空白", () => {
		const prevMessages: UiMessage[] = [
			{ id: "u-1", role: "user", content: [{ type: "text", text: "历史提问 1" }], timestamp: 100 },
			{ id: "a-1", role: "assistant", content: [{ type: "text", text: "历史回答 1" }], timestamp: 200 },
		];
		const prevMessageIds = new Set(["u-1", "a-1"]);

		const prevConv: any = {
			id: "c-prev",
			sessionId: "web-prev-123",
			agentPreset: "standard",
			title: "历史对话标题",
			goal: { goal: null, verdict: "pending" },
			messages: prevMessages,
			messageIds: prevMessageIds,
		};

		let addedSessionId = "";
		let addedReplay = false;
		const session = Object.assign(Object.create(DshClientSession.prototype), {
			cwd: "/workspace/test",
			activeId: "c-prev",
			goalPrefs: { reviewModel: null, maxRounds: 2, locked: false },
			resolvePreset: (p?: string) => p ?? "standard",
			nextConversationId: () => "c-fork-999",
			addConversation: (sessionId: string, cwd: string, replay: boolean, preset?: string) => {
				addedSessionId = sessionId;
				addedReplay = replay;
				return {
					id: "c-fork-999",
					sessionId,
					agentPreset: preset ?? "standard",
					title: "",
					cwd,
					messages: [],
					messageIds: new Set<string>(),
					goal: { goal: null, verdict: "pending" },
				};
			},
			emitConversations: vi.fn(),
			emit: vi.fn(),
		});

		const forked = (DshClientSession.prototype as any).forkConversation.call(session, prevConv);

		expect(addedSessionId).toMatch(/^fork-/);
		expect(addedReplay).toBe(false);
		expect(forked.title).toBe("历史对话标题");
		expect(forked.messages).toEqual(prevMessages);
		expect(forked.messageIds.has("u-1")).toBe(true);
		expect(forked.messageIds.has("a-1")).toBe(true);
		expect(session.activeId).toBe("c-fork-999");
	});

	it("setDefaultModel 与 clearDefaultModel 能正确保存并推送默认模型", async () => {
		let savedDefault: string | undefined;
		const emitted: ServerMessage[] = [];

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			stateStore: {
				saveDefaultModel: vi.fn((m: string) => {
					savedDefault = m;
				}),
				clearDefaultModel: vi.fn(() => {
					savedDefault = undefined;
				}),
				getDefaultModel: vi.fn(() => (savedDefault ? savedDefault : undefined)),
			},
			resolveModelMeta: (modelId: string) => ({
				meta: { id: modelId, bareId: modelId, name: modelId, provider: "deepseek" },
				targetProvider: "deepseek",
				bareModelId: modelId,
				known: true,
			}),
			emit: (msg: ServerMessage) => emitted.push(msg),
			flushSnapshot: vi.fn(),
		});

		await DshClientSession.prototype.setDefaultModel.call(session, "deepseek/deepseek-v4-pro");
		expect(savedDefault).toBe("deepseek/deepseek-v4-pro");
		const defaultMsg1 = emitted.find((m) => m.type === "default_model");
		expect(defaultMsg1).toEqual({ type: "default_model", modelId: "deepseek/deepseek-v4-pro" });

		DshClientSession.prototype.clearDefaultModel.call(session);
		expect(!savedDefault).toBe(true);
		const defaultMsg2 = emitted.filter((m) => m.type === "default_model").pop();
		expect(defaultMsg2).toEqual({ type: "default_model", modelId: null });
	});

	it("sessionLogTitle 正确提取显式标题，过滤内部 ID 与默认标题", () => {
		expect(sessionLogTitle([])).toBeUndefined();
		expect(sessionLogTitle([ev("session/title", { title: "chat-6bccc071-6f7" })])).toBeUndefined();
		expect(sessionLogTitle([ev("session/title", { title: "fork-d7e12d0c-1bf" })])).toBeUndefined();
		expect(sessionLogTitle([ev("session/title", { title: "新对话" })])).toBeUndefined();
		expect(sessionLogTitle([ev("session/title", { title: "New chat" })])).toBeUndefined();
		expect(sessionLogTitle([ev("session/title", { title: "Dockerfile 文件解析" })])).toBe("Dockerfile 文件解析");
	});

	it("引用文件时，正式的 user/message 事件原地替换 u-pending 乐观消息，不产生两条用户消息", () => {
		const conv: any = {
			id: "c-1",
			sessionId: "web-test-123",
			title: "未命名",
			messages: [
				{
					id: "u-pending-12345",
					role: "user",
					content: [{ type: "text", text: "@Dockerfile 这是啥" }],
					timestamp: 1000,
				},
			],
			messageIds: new Set(["u-pending-12345"]),
			lastEventAt: 0,
		};

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			activeId: "c-1",
			convs: new Map([["c-1", conv]]),
			findConv: () => conv,
			appendMessage: (c: any, m: any) => {
				c.messageIds.add(m.id);
				c.messages.push(m);
			},
		});

		(session as any).handleSessionEvent({
			sessionId: "web-test-123",
			event: {
				type: "user/message",
				seq: 1,
				time: 1050,
				data: {
					id: "real-user-msg-1",
					content: [
						{ type: "text", text: "@Dockerfile 这是啥" },
						{ type: "text", text: "\n[File reference: Dockerfile]" },
					],
				},
			},
		});

		expect(conv.messages).toHaveLength(1);
		expect(conv.messages[0].id).toBe("u-real-user-msg-1");
		expect(conv.messages[0].role).toBe("user");
		expect(conv.messageIds.has("u-pending-12345")).toBe(false);
		expect(conv.messageIds.has("u-real-user-msg-1")).toBe(true);
	});

	it("extractDshAssistantRawText 包含思考块 (reasoning)，且 serializeAssistantBlocks 剥离思考块中的 marker", () => {
		const assistantData = {
			message: {
				content: [
					{
						type: "reasoning" as const,
						text: "[[conv:rename:vitest.config.ts 介绍]] 正在分析配置文件...",
					},
					{
						type: "text" as const,
						text: "这是 Vitest 的配置文件",
					},
				],
			},
		};

		const rawText = extractDshAssistantRawText(assistantData);
		expect(rawText).toContain("[[conv:rename:vitest.config.ts 介绍]]");
		expect(rawText).toContain("这是 Vitest 的配置文件");

		const blocks = serializeAssistantBlocks(assistantData.message.content as any);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("thinking");
		expect((blocks[0] as any).thinking).toBe("正在分析配置文件...");
		expect((blocks[0] as any).thinking).not.toContain("[[conv:rename");
		expect(blocks[1].type).toBe("text");
		expect((blocks[1] as any).text).toBe("这是 Vitest 的配置文件");
	});
});
