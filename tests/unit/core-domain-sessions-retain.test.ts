import { describe, expect, it } from "vitest";
import { Conversation, ConversationRegistry } from "../../packages/keel/src/kernel/conversation/index.js";
import {
	displacePrevious,
	rebindSession,
	type RebindContext,
} from "../../packages/keel/src/domains/sessions/rebind.js";
import {
	createRetainOnDisplace,
	retainFactsOf,
	shouldRetainOnDisplace,
} from "../../packages/keel/src/domains/sessions/retain.js";
import { createWorkspaceSwitcher } from "../../packages/keel/src/domains/sessions/workspace.js";
import { ConversationPinIndex, mergePinState } from "../../packages/keel/src/domains/sessions/pins.js";

interface Harness {
	registry: ConversationRegistry<Conversation>;
	ctx: RebindContext;
	/** 每次 `ensure` 的对话（重绑时就是候选对话）。 */
	ensured: Conversation[];
	closed: string[];
	listed: string[];
	conversationsPushed: number;
	engineRoots: { cwd: string; roots: readonly string[] };
}

/** 重绑的最小假体：只有注册表 / 开会话 / 出帧，够验「保留还是退役」。 */
function harness(startCwd = "/work"): Harness {
	const registry = new ConversationRegistry<Conversation>();
	let seq = 0;
	const state: Harness = {
		registry,
		ensured: [],
		closed: [],
		listed: [],
		conversationsPushed: 0,
		engineRoots: { cwd: startCwd, roots: [] },
		ctx: undefined as unknown as RebindContext,
	};
	state.ctx = {
		registry,
		sessions: {
			ensure: async (conv) => {
				state.ensured.push(conv);
				return {};
			},
			close: (id) => void state.closed.push(id),
		},
		frames: {
			flush: () => {},
			pushSessions: () => {},
			pushConversations: () => void (state.conversationsPushed += 1),
		},
		createConversation: (init) => {
			const conv = new Conversation({
				id: `c-${++seq}`,
				clientId: "c1",
				cwd: init.cwd,
				kind: "user",
				createdAt: seq,
				...(init.sessionFile ? { sessionFile: init.sessionFile } : {}),
			});
			registry.add(conv);
			return conv;
		},
		markListed: (id) => void state.listed.push(id),
	};
	return state;
}

function conversation(
	registry: ConversationRegistry<Conversation>,
	init: { id: string; cwd?: string; title?: string; kind?: "user" | "subagent" | "cli"; parentId?: string },
): Conversation {
	const conv = new Conversation({
		id: init.id,
		clientId: "c1",
		cwd: init.cwd ?? "/work",
		kind: init.kind ?? "user",
		createdAt: 1,
		...(init.title ? { title: init.title } : {}),
		...(init.parentId ? { parentId: init.parentId } : {}),
	});
	registry.add(conv);
	return conv;
}

describe("shouldRetainOnDisplace · 老判据逐条（isRetainedOnDisplace / shouldRetainActive）", () => {
	const retained: [string, Parameters<typeof shouldRetainOnDisplace>[0]][] = [
		["钉住", { pinned: true }],
		["目标评审在跑", { reviewing: true }],
		["问卷向导在跑", { wizardRunning: true }],
		["有消息正在投递", { promptInFlight: true }],
		["正在生成", { streaming: true }],
		["正在压缩", { compacting: true }],
		["还开着会阻塞的终端", { openTerminals: 1 }],
		["有活着的子代理运行", { hasActiveSubagentRun: true }],
		["还有等唤醒的订阅", { hasPendingWake: true }],
		["还有在跑的后台任务", { hasRunningBackgroundTask: true }],
		["列过运行列表并且在里面说过话", { listed: true, promptedSinceActive: true }],
		["子代理对话", { isSubagent: true }],
		["原生 CLI 对话", { nativeCli: true }],
		["还有活着的子对话", { hasLiveChildConversation: true }],
		["「保留已结束的对话」+ 会话真的开始过", { keepsFinished: true, started: true }],
	];
	for (const [name, facts] of retained) {
		it(`保留：${name}`, () => {
			expect(shouldRetainOnDisplace(facts)).toBe(true);
		});
	}

	const retired: [string, Parameters<typeof shouldRetainOnDisplace>[0]][] = [
		["空白对话（什么活都没有）", {}],
		["列过但没说过话", { listed: true }],
		["设了「保留已结束的对话」但会话没开始过", { keepsFinished: true }],
		["会话开始过但没设保留项", { started: true }],
		["终端数显式为 0", { openTerminals: 0 }],
	];
	for (const [name, facts] of retired) {
		it(`退役：${name}`, () => {
			expect(shouldRetainOnDisplace(facts)).toBe(false);
		});
	}
});

describe("retainFactsOf · 内核自己认得的证据", () => {
	it("子代理 / CLI 种类、相位 running、活着的子对话都由内核回答（不问宿主）", () => {
		const registry = new ConversationRegistry<Conversation>();
		const parent = conversation(registry, { id: "p" });
		conversation(registry, { id: "child", kind: "subagent", parentId: "p" });
		parent.beginTurn(2);

		const facts = retainFactsOf(registry, parent);
		expect(facts.streaming).toBe(true);
		expect(facts.hasLiveChildConversation).toBe(true);
		expect(facts.isSubagent).toBe(false);

		const cli = conversation(registry, { id: "cli", kind: "cli" });
		expect(retainFactsOf(registry, cli).nativeCli).toBe(true);
	});

	it("内核拿不到的事实缺省为「不知道」：缺项按 false / 0 计（老口径 hasRunningBackgroundTask ?? false）", () => {
		const registry = new ConversationRegistry<Conversation>();
		const blank = conversation(registry, { id: "blank" });
		const facts = retainFactsOf(registry, blank);
		expect(facts).toMatchObject({
			pinned: false,
			listed: false,
			promptedSinceActive: false,
			compacting: false,
			openTerminals: 0,
			hasActiveSubagentRun: false,
			hasPendingWake: false,
			hasRunningBackgroundTask: false,
		});
		expect(shouldRetainOnDisplace(facts)).toBe(false);
	});

	it("标题已命名 = 会话开始过（老 isConversationStarted 的内核那一条）", () => {
		const registry = new ConversationRegistry<Conversation>();
		const named = conversation(registry, { id: "named", title: "改个名字" });
		expect(retainFactsOf(registry, named, { keepsFinished: () => true }).started).toBe(true);
		expect(shouldRetainOnDisplace(retainFactsOf(registry, named, { keepsFinished: () => true }))).toBe(true);
	});
});

describe("rebindSession · 换活动对话时按判据保留 / 退役", () => {
	it("流式中的旧对话被保留：仍在注册表、会话没释放、仍占运行列表，候选成为活动对话", async () => {
		const h = harness();
		const previous = conversation(h.registry, { id: "c-old", title: "正在跑的那条" });
		h.registry.activate(previous.id);
		previous.beginTurn(2);
		h.ctx.shouldRetainPrevious = createRetainOnDisplace(h.registry);

		const result = await rebindSession(h.ctx, { cwd: "/next" });

		expect(h.registry.get("c-old")).toBe(previous);
		expect(previous.phase).toBe("running");
		expect(h.closed).toStrictEqual([]);
		expect(h.listed).toStrictEqual(["c-old"]);
		expect(h.registry.activeId()).toBe(result.conversation.id);
		expect(result.displaced).toBeUndefined();
		expect(h.ensured).toStrictEqual([result.conversation]);
	});

	it("非流式空白对话退役（现有行为不变）", async () => {
		const h = harness();
		const previous = conversation(h.registry, { id: "c-old" });
		h.registry.activate(previous.id);
		h.ctx.shouldRetainPrevious = createRetainOnDisplace(h.registry);

		const result = await rebindSession(h.ctx, { cwd: "/next" });

		expect(h.registry.get("c-old")).toBeUndefined();
		expect(previous.phase).toBe("retired");
		expect(h.closed).toStrictEqual(["c-old"]);
		expect(h.listed).toStrictEqual([]);
		expect(result.displaced).toBe(previous);
		expect(h.registry.activeId()).toBe(result.conversation.id);
	});

	it("没有注入判据时一律退役（缺省不信「保留」）", async () => {
		const h = harness();
		const previous = conversation(h.registry, { id: "c-old", title: "有标题也一样" });
		h.registry.activate(previous.id);
		previous.beginTurn(2);

		const result = await rebindSession(h.ctx, { cwd: "/next" });

		expect(h.registry.get("c-old")).toBeUndefined();
		expect(result.displaced).toBe(previous);
	});

	it("保留判据抛错不算重绑失败：错误原样上抛之前不留下半个状态（候选先建、旧对话不动）", async () => {
		const h = harness();
		const previous = conversation(h.registry, { id: "c-old" });
		h.registry.activate(previous.id);
		h.ctx.shouldRetainPrevious = () => {
			throw new Error("判据炸了");
		};

		await expect(rebindSession(h.ctx, { cwd: "/next" })).rejects.toThrow("判据炸了");
		// 旧对话还在、会话没释放；候选已经开出来了（等于一次未完成的重绑，不制造第二个退役写者）。
		expect(h.registry.get("c-old")).toBe(previous);
		expect(h.closed).toStrictEqual([]);
	});

	it("displacePrevious：保留走 markListed，退役走退役三件套（老 displaceActive 的两个分支）", () => {
		const h = harness();
		const kept = conversation(h.registry, { id: "kept" });
		const dropped = conversation(h.registry, { id: "dropped" });
		const ctx = { ...h.ctx, shouldRetainPrevious: (conv: Conversation) => conv.id === "kept" };

		expect(displacePrevious(ctx, kept)).toBe(true);
		expect(displacePrevious(ctx, dropped)).toBe(false);

		expect(h.registry.get("kept")).toBe(kept);
		expect(kept.phase).toBe("idle");
		expect(h.listed).toStrictEqual(["kept"]);
		expect(h.registry.get("dropped")).toBeUndefined();
		expect(dropped.phase).toBe("retired");
		expect(h.closed).toStrictEqual(["dropped"]);
	});

	it("displacePrevious：保留的是「消息刚受理」的对话时说明一声（老 displaceActive 的 info notice）", () => {
		const h = harness();
		const kept = conversation(h.registry, { id: "kept", title: "在跑的对话" });
		const notices: { level: string; text: string; textEn: string }[] = [];
		const ctx = {
			...h.ctx,
			notice: (level: string, text: string, textEn: string) => void notices.push({ level, text, textEn }),
			shouldRetainPrevious: () => true,
			inFlight: (conv: Conversation) => conv.id === "kept",
		} as unknown as RebindContext & { inFlight: (conv: Conversation) => boolean };

		expect(displacePrevious(ctx, kept)).toBe(true);
		expect(notices).toStrictEqual([
			{
				level: "info",
				text: "「在跑的对话」的消息正在投递，已为你保留该对话",
				textEn: '"在跑的对话" is still sending your message — kept in the running list',
			},
		]);
		expect(h.listed).toStrictEqual(["kept"]);
	});

	it("displacePrevious：已经开始流式就不再多说一句（老口径：只解释还没开始的窗口）", () => {
		const h = harness();
		const kept = conversation(h.registry, { id: "kept" });
		kept.beginTurn(1);
		const notices: string[] = [];
		const ctx = {
			...h.ctx,
			notice: (_level: string, text: string) => void notices.push(text),
			shouldRetainPrevious: () => true,
			inFlight: () => true,
		} as unknown as RebindContext & { inFlight: (conv: Conversation) => boolean };

		expect(displacePrevious(ctx, kept)).toBe(true);
		expect(notices).toStrictEqual([]);
	});
});

describe("createWorkspaceSwitcher · setCwd 的重绑目标（老 setCwd 的 openRecent）", () => {
	function switcher(options: {
		openRecentSession?: () => boolean;
		mostRecentSession?: (cwd: string) => Promise<string | undefined>;
		sessionOwner?: (file: string) => { connected?: boolean; isStreaming?: boolean } | undefined;
	}) {
		const h = harness();
		const inits: { cwd: string; sessionFile?: string }[] = [];
		const port = createWorkspaceSwitcher({
			registry: h.registry,
			sessions: h.ctx.sessions,
			frames: h.ctx.frames,
			createConversation: (init) => {
				inits.push(init);
				return (h.ctx.createConversation as (i: { cwd: string; sessionFile?: string }) => Conversation)(init);
			},
			cwd: () => h.engineRoots.cwd,
			roots: () => h.engineRoots.roots,
			setWorkspace: (cwd, roots) => {
				h.engineRoots = { cwd, roots };
			},
			host: { resolveTarget: async (input) => ({ cwd: input }) },
			notice: () => {},
			...options,
		});
		return { port, h, inits };
	}

	it("设置项开着且有最近会话：重绑目标带上那份转录（恢复最近会话，不新建空白）", async () => {
		const { port, inits } = switcher({
			openRecentSession: () => true,
			mostRecentSession: async (cwd) => (cwd === "/next" ? "/s/recent.jsonl" : undefined),
		});
		await port.setCwd("/next");
		expect(inits).toStrictEqual([{ cwd: "/next", sessionFile: "/s/recent.jsonl" }]);
	});

	it("最近会话被别的页面占着（connected / isStreaming）：不恢复，仍旧新建（老 resumeSkipped）", async () => {
		for (const owner of [{ connected: true }, { isStreaming: true }]) {
			const { port, inits } = switcher({
				openRecentSession: () => true,
				mostRecentSession: async () => "/s/recent.jsonl",
				sessionOwner: () => owner,
			});
			await port.setCwd("/next");
			expect(inits).toStrictEqual([{ cwd: "/next" }]);
		}
	});

	it("占用者只是开着没在跑（connected 缺省 / isStreaming false）：照常恢复", async () => {
		const { port, inits } = switcher({
			openRecentSession: () => true,
			mostRecentSession: async () => "/s/recent.jsonl",
			sessionOwner: () => ({ isStreaming: false }),
		});
		await port.setCwd("/next");
		expect(inits).toStrictEqual([{ cwd: "/next", sessionFile: "/s/recent.jsonl" }]);
	});

	it("设置项关着 / 宿主没给扫盘口 / 扫盘抛错：都按新建处理（不自拼 SDK 目录布局）", async () => {
		const closed = switcher({ openRecentSession: () => false, mostRecentSession: async () => "/s/recent.jsonl" });
		await closed.port.setCwd("/next");
		expect(closed.inits).toStrictEqual([{ cwd: "/next" }]);

		const noScanner = switcher({ openRecentSession: () => true });
		await noScanner.port.setCwd("/next");
		expect(noScanner.inits).toStrictEqual([{ cwd: "/next" }]);

		const broken = switcher({
			openRecentSession: () => true,
			mostRecentSession: async () => {
				throw new Error("扫盘挂了");
			},
		});
		await broken.port.setCwd("/next");
		expect(broken.inits).toStrictEqual([{ cwd: "/next" }]);
	});

	it("换目录时旧对话按判据保留（流式中）或退役（空白）", async () => {
		const h = harness();
		const previous = conversation(h.registry, { id: "c-old", title: "在跑" });
		h.registry.activate(previous.id);
		previous.beginTurn(2);
		const port = createWorkspaceSwitcher({
			registry: h.registry,
			sessions: h.ctx.sessions,
			frames: h.ctx.frames,
			createConversation: (init) => h.ctx.createConversation(init),
			cwd: () => h.engineRoots.cwd,
			roots: () => h.engineRoots.roots,
			setWorkspace: (cwd, roots) => {
				h.engineRoots = { cwd, roots };
			},
			host: { resolveTarget: async (input) => ({ cwd: input }) },
			notice: () => {},
			shouldRetainPrevious: createRetainOnDisplace(h.registry),
			markListed: (id) => void h.listed.push(id),
		});
		await port.setCwd("/next");
		expect(h.registry.get("c-old")).toBe(previous);
		expect(h.listed).toStrictEqual(["c-old"]);
		expect(h.closed).toStrictEqual([]);
	});
});

describe("保留判据的最后一支：listed && promptedSinceActive（老 `shouldRetainActive`）", () => {
	it("从历史里明确打开过（listed + prompted）的对话，换对话时保留", () => {
		const index = new ConversationPinIndex();
		index.markListed("c1");
		index.markPrompted("c1");
		const state = mergePinState(index.stateOf("c1"), false);
		expect(state.listed).toBe(true);
		expect(state.prompted).toBe(true);
		expect(shouldRetainOnDisplace({ listed: state.listed, promptedSinceActive: state.prompted })).toBe(true);
	});

	it("只列入未用过（listed 但没 prompted）：不保留 —— 退役才能把空壳从运行列表收走", () => {
		const index = new ConversationPinIndex();
		index.markListed("c1");
		const state = mergePinState(index.stateOf("c1"), false);
		expect(state.prompted).toBeUndefined();
		expect(shouldRetainOnDisplace({ listed: state.listed, promptedSinceActive: state.prompted === true })).toBe(false);
	});

	it("prompted 与 listed 一起被钉住位保全（setPinned 不丢位）", () => {
		const index = new ConversationPinIndex();
		index.markPrompted("c1");
		index.setPinned("c1", true);
		expect(index.stateOf("c1")).toMatchObject({ pinned: true, listed: true, prompted: true });
	});
});
