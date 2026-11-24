import { describe, expect, it } from "vitest";
import type { BotChatPort } from "../../packages/keel/src/contracts/bots.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import {
	createBotChatHandlers,
	pickBotChatConversation,
	sameWorkspace,
	type BotChatHandlers,
} from "../../packages/keel/src/domains/bots/index.js";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";

type Call = [name: string, ...args: unknown[]];
type Notice = { level: string; text: string; textEn: string };

const CLIENT = "client-1";
const BOT_CWD = "/work/bot-1";
const TRANSCRIPT = "/data/bot-sessions/bot-1/2026.jsonl";

interface Harness {
	handlers: BotChatHandlers;
	registry: ConversationRegistry<Conversation>;
	calls: Call[];
	notices(): Notice[];
	/** 新建一条对话并切过去（模拟「用户去了别的对话」）。 */
	open(cwd?: string): Conversation;
	/** 设备中心把 Bot 的工作目录改到别处（旧私聊的 cwd 就对不上了）。 */
	moveBot(cwd: string): void;
	named(name: string): Call[];
}

interface HarnessOptions {
	/** 客户端当前工作区（默认就是 Bot 的目录）。 */
	cwd?: string;
	setCwdThrows?: boolean;
	newChatThrows?: string;
	port?: Partial<BotChatPort>;
	bindPort?: boolean;
}

/**
 * 假 dispatch：只记录调用，并把「会话身份的变化」写回注册表——
 * 真实编排（newChat / switchSession / switchConversation）在 runtime 里，这里复现它的**可观察结果**。
 */
function harness(options: HarnessOptions = {}): Harness {
	const registry = new ConversationRegistry<Conversation>();
	const calls: Call[] = [];
	let currentCwd = options.cwd ?? BOT_CWD;
	let targetCwd = BOT_CWD;
	let seq = 0;

	const open = (cwd = currentCwd): Conversation => {
		seq += 1;
		const conv = new Conversation({ id: `conv-${seq}`, clientId: CLIENT, cwd, kind: "user", createdAt: seq });
		registry.add(conv);
		registry.activate(conv.id);
		return conv;
	};

	const dispatch = {
		emitNotice: (level: "info" | "warning" | "error", text: string, textEn?: string) => {
			calls.push(["emitNotice", level, text, textEn ?? ""]);
		},
		setCwd: async (path: string) => {
			calls.push(["setCwd", path]);
			if (options.setCwdThrows) throw new Error("目录不存在");
			currentCwd = path;
		},
		switchConversation: async (id: string) => {
			calls.push(["switchConversation", id]);
			registry.activate(id);
		},
		switchSession: async (path: string) => {
			calls.push(["switchSession", path]);
			seq += 1;
			const conv = new Conversation({
				id: `conv-${seq}`,
				clientId: CLIENT,
				cwd: BOT_CWD,
				kind: "bot",
				createdAt: seq,
				sessionFile: path,
			});
			registry.add(conv);
			registry.activate(conv.id);
		},
		newChat: async (
			_preset?: string,
			_ephemeral?: boolean,
			_onReady?: (id: string) => void,
			_independent?: boolean,
			botId?: string,
		) => {
			calls.push(["newChat", botId]);
			if (options.newChatThrows) throw new Error(options.newChatThrows);
			open(currentCwd);
			return true;
		},
		flushSnapshot: () => {
			calls.push(["flushSnapshot"]);
		},
		pushSettings: () => {
			calls.push(["pushSettings"]);
		},
	};

	const port: BotChatPort = {
		resolve: () => ({ id: "bot-1", cwd: targetCwd, revision: 1 }),
		latestTranscript: () => undefined,
		...options.port,
	};

	const handlers = createBotChatHandlers({
		registry,
		dispatch: () => dispatch,
		cwd: () => currentCwd,
		...(options.bindPort === false ? {} : { bots: () => port }),
	});

	return {
		handlers,
		registry,
		calls,
		notices: () =>
			calls
				.filter((call) => call[0] === "emitNotice")
				.map((call) => ({ level: String(call[1]), text: String(call[2]), textEn: String(call[3]) })),
		open,
		moveBot: (cwd: string) => {
			targetCwd = cwd;
			currentCwd = cwd;
		},
		named: (name: string) => calls.filter((call) => call[0] === name),
	};
}

describe("openBotChat · 默认回到同一个私聊", () => {
	it("第一次点：走 newChat(botId) 建一条，并认领成这个 Bot 的私聊", async () => {
		const h = harness();
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("newChat")).toEqual([["newChat", "bot-1"]]);
		expect(h.handlers.botIdOf(h.registry.activeId())).toBe("bot-1");
	});

	it("第二次点（当前在别的对话）：切回那条私聊，不新建", async () => {
		const h = harness();
		await h.handlers.openBotChat("bot-1");
		const botConversationId = h.registry.activeId();
		const other = h.open();
		h.calls.length = 0;

		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.registry.activeId()).toBe(botConversationId);
		expect(h.named("switchConversation")).toEqual([["switchConversation", botConversationId]]);
		expect(h.named("newChat")).toEqual([]);
		expect(other.id).not.toBe(botConversationId);
	});

	it("已经在这条私聊上：只重发设置帧 + 快照（不重建会话、不再切）", async () => {
		const h = harness();
		await h.handlers.openBotChat("bot-1");
		h.calls.length = 0;

		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("newChat")).toEqual([]);
		expect(h.named("switchConversation")).toEqual([]);
		expect(h.named("pushSettings")).toHaveLength(1);
		expect(h.named("flushSnapshot")).toHaveLength(1);
	});

	it("内存里没有但磁盘上有转录：重开最近一份，并按新的对话 id 重新认领", async () => {
		const h = harness({ port: { latestTranscript: () => TRANSCRIPT } });
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("switchSession")).toEqual([["switchSession", TRANSCRIPT]]);
		expect(h.named("newChat")).toEqual([]);
		expect(h.handlers.botIdOf(h.registry.activeId())).toBe("bot-1");

		// 再点一次就是「回到同一个私聊」：认领已成立，不会再开一份转录。
		h.calls.length = 0;
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("switchSession")).toEqual([]);
		expect(h.named("newChat")).toEqual([]);
	});

	it("Bot 改过工作目录后的旧私聊不算：cwd 对不上就另开（不走 switch_conversation）", async () => {
		const h = harness();
		await h.handlers.openBotChat("bot-1");
		const stale = h.registry.activeId();
		h.moveBot("/work/bot-1-new");
		h.calls.length = 0;

		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("switchConversation")).toEqual([]);
		expect(h.named("newChat")).toEqual([["newChat", "bot-1"]]);
		expect(h.registry.activeId()).not.toBe(stale);
	});
});

describe("openBotChat · fresh 才新开", () => {
	it("fresh 跳过内存与转录，直接新建一条；旧对话留在注册表里不动", async () => {
		const h = harness({ port: { latestTranscript: () => TRANSCRIPT } });
		await h.handlers.openBotChat("bot-1");
		const first = h.registry.activeId();
		h.calls.length = 0;

		await expect(h.handlers.openBotChat("bot-1", { fresh: true })).resolves.toBe(true);
		expect(h.named("newChat")).toEqual([["newChat", "bot-1"]]);
		expect(h.named("switchConversation")).toEqual([]);
		expect(h.named("switchSession")).toEqual([]);
		expect(h.registry.activeId()).not.toBe(first);
		expect(h.registry.has(first)).toBe(true);
		expect(h.handlers.botIdOf(h.registry.activeId())).toBe("bot-1");
		expect(h.handlers.botIdOf(first)).toBe("bot-1");
	});
});

describe("openBotChat · 失败路径都说清原因", () => {
	it("Bot 不存在 / 已停用：error notice 明确是「智能体不可用」，且绝不新建对话", async () => {
		const h = harness({ port: { resolve: () => undefined } });
		await expect(h.handlers.openBotChat("bot-deleted")).resolves.toBe(false);
		expect(h.named("newChat")).toEqual([]);
		const [notice] = h.notices();
		expect(notice.level).toBe("error");
		expect(notice.text).toContain("已不可用");
		expect(notice.textEn).toContain("unavailable");
		// 空 id 走同一条「不可用」，不静默成功。
		await expect(h.handlers.openBotChat("   ")).resolves.toBe(false);
		expect(h.named("newChat")).toEqual([]);
	});

	it("读注册表就炸：转成可读 notice + false（不冒成 unhandled rejection）", async () => {
		const h = harness({
			port: {
				resolve: () => {
					throw new Error("registry unreadable");
				},
			},
		});
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(false);
		expect(h.notices()[0].text).toContain("registry unreadable");
		expect(h.named("newChat")).toEqual([]);
	});

	it("Bot 的工作目录切不过去：说明是工作目录问题并返回 false", async () => {
		const h = harness({ cwd: "/work/other", setCwdThrows: true });
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(false);
		expect(h.named("setCwd")).toEqual([["setCwd", BOT_CWD]]);
		expect(h.notices()[0].text).toContain("无法切换到智能体的工作目录");
		expect(h.named("newChat")).toEqual([]);
	});

	it("工作目录不同就先切（切成功才继续建会话）", async () => {
		const h = harness({ cwd: "/work/other" });
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(true);
		expect(h.named("setCwd")).toEqual([["setCwd", BOT_CWD]]);
		expect(h.named("newChat")).toEqual([["newChat", "bot-1"]]);
	});

	it("新建私聊抛错：notice 带原因 + false", async () => {
		const h = harness({ newChatThrows: "Bot execution cwd mismatch" });
		await expect(h.handlers.openBotChat("bot-1")).resolves.toBe(false);
		expect(h.notices()[0].text).toContain("Bot execution cwd mismatch");
	});

	it("端口未注入：同步抛 CoreEngineNotReadyError（wire 层是 void 调用，不能变成 rejected promise）", () => {
		const h = harness({ bindPort: false });
		expect(() => h.handlers.openBotChat("bot-1")).toThrow(CoreEngineNotReadyError);
		try {
			h.handlers.openBotChat("bot-1");
		} catch (error) {
			expect((error as Error).message).toContain("openBotChat");
		}
	});
});

describe("pickBotChatConversation · 行判定单源", () => {
	const refs = [
		{ id: "a", botId: "bot-1", lastActiveAt: 1 },
		{ id: "b", botId: "bot-1", lastActiveAt: 9 },
		{ id: "sub", botId: "bot-1", isSubagent: true, lastActiveAt: 99 },
		{ id: "cli", botId: "bot-1", nativeCli: { preset: "claude" }, lastActiveAt: 98 },
		{ id: "retiring", botId: "bot-1", transferring: true, lastActiveAt: 97 },
		{ id: "ephemeral", botId: "bot-1", isEphemeral: true, lastActiveAt: 96 },
		{ id: "other", botId: "bot-2", lastActiveAt: 100 },
	];

	it("优先当前活跃的那条，其次最近用过的；子代理 / CLI / 临时 / 过户中的不算", () => {
		expect(pickBotChatConversation(refs, "bot-1")?.id).toBe("b");
		expect(pickBotChatConversation(refs, "bot-1", "a")?.id).toBe("a");
		expect(pickBotChatConversation(refs, "bot-2")?.id).toBe("other");
		expect(pickBotChatConversation(refs, "bot-3")).toBeUndefined();
	});

	it("sameWorkspace 归一绝对路径；空值一律不同", () => {
		expect(sameWorkspace("/work/a", "/work/a/")).toBe(true);
		expect(sameWorkspace("/work/a", "/work/b")).toBe(false);
		expect(sameWorkspace("", "/work/a")).toBe(false);
		expect(sameWorkspace(undefined, undefined)).toBe(false);
	});
});
