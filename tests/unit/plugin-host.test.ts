import { describe, expect, it } from "vitest";
import { resolveNewChatResult } from "../../web/src/new-chat-request";
import {
	createPluginHostApi,
	emitPluginHostModel,
	PLUGIN_HOST_API_VERSION,
	type PluginHostSessionInfo,
} from "../../web/src/plugin-host";
import { registerAttachmentSink, registerDraftSink, resetComposerSinks } from "../../web/src/composer-bridge";
import type { ClientMessage } from "../../web/src/types";

interface Harness {
	api: ReturnType<typeof createPluginHostApi>;
	sent: ClientMessage[];
	setCwd: (cwd: string) => void;
	setRoots: (roots: string[]) => void;
	setConversationId: (id: string | null) => void;
	setBlank: (blank: boolean) => void;
	setReady: (ready: boolean) => void;
	views: string[];
}

function harness(overrides: Partial<Parameters<typeof createPluginHostApi>[0]> = {}): Harness {
	const sent: ClientMessage[] = [];
	const views: string[] = [];
	let cwd = "";
	let conversationId: string | null = "conv-1";
	let blank = false;
	let ready = true;
	let roots: string[] = [];
	const api = createPluginHostApi({
		send: (msg) => {
			sent.push(msg);
			if (msg.type === "new_chat" && msg.requestId && blank)
				resolveNewChatResult({
					type: "new_chat_result",
					requestId: msg.requestId,
					ok: true,
					conversationId: conversationId!,
				});
			return true;
		},
		isReady: () => ready,
		setView: (v) => views.push(v),
		getCwd: () => cwd,
		getWorkspaceRoots: () => roots,
		listSessions: () => [],
		getConversationId: () => conversationId,
		isConversationBlank: () => blank,
		pollMs: overrides.pollMs ?? 2,
		timeoutMs: overrides.timeoutMs ?? 200,
		...overrides,
	});
	return {
		api,
		sent,
		views,
		setCwd: (v) => {
			cwd = v;
		},
		setRoots: (v) => {
			roots = v;
		},
		setConversationId: (v) => {
			conversationId = v;
			const request = sent.findLast((m) => m.type === "new_chat");
			if (request?.type === "new_chat" && request.requestId && v)
				resolveNewChatResult({ type: "new_chat_result", requestId: request.requestId, ok: true, conversationId: v });
		},
		setBlank: (v) => {
			blank = v;
		},
		setReady: (v) => {
			ready = v;
		},
	};
}

const waitFor = async (ok: () => boolean, ms = 1000) => {
	const deadline = Date.now() + ms;
	while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	return ok();
};

function harnessWith(overrides: {
	pollMs?: number;
	timeoutMs?: number;
	cwd?: string;
	conversationId?: string | null;
	workspaceRoots?: string[];
	sessions?: PluginHostSessionInfo[];
	listProjects?: string[];
	grantedPaths?: string[];
	confirm?: (opts: { path: string }) => Promise<boolean>;
}) {
	const sent: ClientMessage[] = [];
	let cwd = overrides.cwd ?? "";
	let conversationId: string | null = overrides.conversationId ?? "conv-1";
	const roots = overrides.workspaceRoots ?? [];
	const granted: string[] = [];
	const api = createPluginHostApi({
		send: (msg) => {
			sent.push(msg);
			if (msg.type === "set_cwd") cwd = msg.path;
			if (msg.type === "switch_conversation") conversationId = msg.id;
			if (msg.type === "switch_session") conversationId = `session:${msg.path}`;
			return true;
		},
		isReady: () => true,
		setView: () => {},
		getCwd: () => cwd,
		getWorkspaceRoots: () => roots,
		listSessions: () => overrides.sessions ?? [],
		getConversationId: () => conversationId,
		isConversationBlank: () => false,
		listProjects: () => overrides.listProjects ?? [],
		grantedPaths: () => [...(overrides.grantedPaths ?? []), ...granted],
		grantPath: (p) => granted.push(p),
		confirm: overrides.confirm ?? (async () => true),
		pollMs: overrides.pollMs ?? 2,
		timeoutMs: overrides.timeoutMs ?? 200,
	});
	return { api, sent, granted };
}

const types = (sent: ClientMessage[]) => sent.map((m) => m.type);

describe("createPluginHostApi", () => {
	it("版本号暴露给插件", () => {
		expect(harness().api.version).toBe(PLUGIN_HOST_API_VERSION);
	});

	it("空 prompt / 连接未就绪 → 拒绝", () => {
		const h = harness();
		expect(h.api.startChat({ prompt: "   " })).toBe(false);
		h.setReady(false);
		expect(h.api.startChat({ prompt: "hi" })).toBe(false);
		expect(h.sent).toHaveLength(0);
	});

	it("startChat：等 cwd 切过去 + 等新对话就绪，再发 prompt", async () => {
		const h = harness();
		expect(h.api.startChat({ prompt: "修一下", cwd: "/plugin/dir" })).toBe(true);
		expect(types(h.sent)).toEqual(["set_cwd"]);
		h.setCwd("/plugin/dir");
		await waitFor(() => types(h.sent).includes("new_chat"));
		expect(types(h.sent)).toEqual(["set_cwd", "new_chat"]);
		expect(types(h.sent)).not.toContain("prompt");
		h.setConversationId("conv-2");
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["set_cwd", "new_chat", "prompt"]);
		const prompt = h.sent.find((m) => m.type === "prompt");
		expect(prompt && "text" in prompt ? prompt.text : "").toBe("修一下");
	});

	it("startChat：当前对话本来就是空白 → new_chat 不换 id 也照样发 prompt", async () => {
		const h = harness();
		h.setBlank(true);
		h.api.startChat({ prompt: "x" });
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["new_chat", "prompt"]);
	});

	it("startChat：cwd 已经是目标目录 → 不重发 set_cwd", async () => {
		const h = harness();
		h.setCwd("/plugin/dir");
		h.setBlank(true);
		h.api.startChat({ prompt: "x", cwd: "/plugin/dir" });
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["new_chat", "prompt"]);
	});

	it("startChat：newChat=false 绑定当前会话；cwd 超时禁止发送", async () => {
		const h = harness();
		h.api.startChat({ prompt: "x", newChat: false });
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["prompt"]);

		const h2 = harness({ timeoutMs: 30, pollMs: 2 });
		h2.api.startChat({ prompt: "y", cwd: "/never" });
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(types(h2.sent)).toEqual(["set_cwd"]);
		expect(h.sent.find((m) => m.type === "prompt")).toMatchObject({ targetConversationId: "conv-1" });
		expect(h.views).toContain("chat");
	});

	it("new_chat timeout or rejection never delivers a prompt to the original conversation", async () => {
		const h = harness({ timeoutMs: 20 });
		h.api.startChat({ prompt: "deploy" });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(types(h.sent)).toEqual(["new_chat"]);
		const failed = harness({ send: () => false });
		failed.api.startChat({ prompt: "deploy" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(failed.sent).toEqual([]);
	});
	it("setView 透传（空串忽略）", () => {
		const h = harness();
		h.api.setView("chat");
		h.api.setView("  ");
		expect(h.views).toEqual(["chat"]);
	});
});

describe("shared conversation identity", () => {
	it("waits for leaving shared owner when opening the local conversation with the same id", async () => {
		let owner: string | null = "bot-a";
		const h = harness({
			getConversationId: () => "c1",
			getConversationOwner: () => owner,
			listSessions: () => [{ id: "c1", title: "Local", cwd: "", kind: "running" }],
		});
		const result = h.api.sessions.open("c1");
		expect(h.sent).toEqual([{ type: "switch_conversation", id: "c1" }]);
		owner = null;
		expect(await result).toEqual({ ok: true, sessionId: "c1" });
	});
	it("opens the selected owner and waits for shared ownership even when local c1 already exists", async () => {
		let owner: string | null = null;
		const h = harness({
			getConversationId: () => "c1",
			getConversationOwner: () => owner,
			listSessions: () => [
				{
					id: JSON.stringify(["bot-b", "c1"]),
					conversationId: "c1",
					owner: "bot-b",
					title: "Bot",
					cwd: "",
					kind: "elsewhere",
					independent: false,
				},
			],
		});
		let completed = false;
		const result = h.api.sessions.open(JSON.stringify(["bot-b", "c1"])).then((value) => {
			completed = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(completed).toBe(false);
		expect(h.sent).toEqual([{ type: "open_shared_conversation", owner: "bot-b", id: "c1" }]);
		owner = "bot-b";
		expect(await result).toEqual({ ok: true, sessionId: "c1" });
	});
});

describe("createPluginHostApi.openSession（多根工作区 + 目录授权，issue #146）", () => {
	it("folders 多个：第一个当 cwd、其余当额外工作区根（根在切完 cwd 之后再写）", async () => {
		const h = harnessWith({ cwd: "/a", listProjects: ["/a"] });
		const r = await h.api.openSession({ folders: ["/a", "/b", "/c"], newChat: false });
		expect(r).toEqual({ ok: true, sessionId: "conv-1" });
		expect(types(h.sent)).toEqual(["set_workspace_roots"]);
		const roots = h.sent.find((m) => m.type === "set_workspace_roots");
		expect(roots && "roots" in roots ? roots.roots : null).toEqual(["/b", "/c"]);
		expect(h.granted).toEqual(["/b", "/c"]);
	});

	it("cwd + roots 混给：cwd 优先，roots/folders 去重后都当额外根", async () => {
		const h = harnessWith({ listProjects: ["/b"] });
		await h.api.openSession({ cwd: "/b", folders: ["/b", "/c"], roots: ["/c", "/d"], newChat: false });
		const roots = h.sent.find((m) => m.type === "set_workspace_roots");
		expect(roots && "roots" in roots ? roots.roots : null).toEqual(["/c", "/d"]);
		expect(types(h.sent)[0]).toBe("set_cwd");
	});

	it("额外根被用户拒绝 → 整个 openSession 失败，且不写根", async () => {
		const h = harnessWith({ listProjects: ["/a"], confirm: async (o) => o.path !== "/b" });
		const r = await h.api.openSession({ folders: ["/a", "/b"], newChat: false });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toContain("/b");
		expect(types(h.sent)).toEqual([]);
	});

	it("没有 cwd / folders / roots → 结构化失败（不静默）", async () => {
		const r = await harnessWith({}).api.openSession({});
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toContain("folders");
	});

	it("唯一一组根时也发 set_workspace_roots（清掉上一个项目留下的根）", async () => {
		const h = harnessWith({ cwd: "/a", workspaceRoots: ["/old"], listProjects: ["/a"] });
		await h.api.openSession({ cwd: "/a", newChat: false });
		expect(types(h.sent)).toEqual(["set_workspace_roots"]);
		const roots = h.sent.find((m) => m.type === "set_workspace_roots");
		expect(roots && "roots" in roots ? roots.roots : null).toEqual([]);
	});
});

describe("createPluginHostApi.sessions（会话 API，宿主 API v6）", () => {
	const sessions: PluginHostSessionInfo[] = [
		{ id: "conv-9", title: "跑着的对话", cwd: "/a", kind: "running", isStreaming: true },
		{ id: "/a/.pi/sessions/s1.jsonl", title: "历史会话", cwd: "/a", kind: "history" },
	];

	it("list 原样透传宿主给的会话（不编造、不排序）", () => {
		const h = harnessWith({ sessions });
		expect(h.api.sessions.list()).toEqual(sessions);
	});

	it("open 运行中的对话 → switch_conversation，并回 sessionId", async () => {
		const h = harnessWith({ cwd: "/a", conversationId: "conv-1", sessions });
		const r = await h.api.sessions.open("conv-9");
		expect(r).toEqual({ ok: true, sessionId: "conv-9" });
		expect(types(h.sent)).toEqual(["switch_conversation"]);
	});

	it("open 历史会话 → switch_session（path = id）", async () => {
		const h = harnessWith({ cwd: "/a", sessions });
		const r = await h.api.sessions.open("/a/.pi/sessions/s1.jsonl");
		expect(r.ok).toBe(true);
		expect(h.sent[0]).toEqual({ type: "switch_session", path: "/a/.pi/sessions/s1.jsonl" });
	});

	it("open 一个不属于本列表的 id → 结构化失败（不发消息）", async () => {
		const h = harnessWith({ cwd: "/a", sessions });
		const r = await h.api.sessions.open("nope");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toContain("找不到会话");
		expect(h.sent).toEqual([]);
	});

	it("跨项目会话：先切 cwd（走授权），再切会话", async () => {
		const h = harnessWith({
			cwd: "/a",
			listProjects: ["/a", "/b"],
			sessions: [{ id: "/b/.pi/sessions/s2.jsonl", title: "别的项目", cwd: "/b", kind: "history" }],
		});
		const r = await h.api.sessions.open("/b/.pi/sessions/s2.jsonl");
		expect(r.ok).toBe(true);
		expect(types(h.sent)).toEqual(["set_cwd", "switch_session"]);
	});
});

describe("createPluginHostApi.compose", () => {
	function mountComposer() {
		const drafts: string[] = [];
		registerDraftSink((t) => drafts.push(t));
		registerAttachmentSink(() => {});
		return drafts;
	}

	it("宿主 API 版本 ≥ 2（compose 是 v2 新增能力）", () => {
		expect(harness().api.version).toBeGreaterThanOrEqual(2);
	});

	it("输入框还没挂载 → 拒收（不静默丢，交给调用方提示）", () => {
		resetComposerSinks();
		expect(harness().api.compose({ text: "x" })).toBe(false);
	});

	it("文本进草稿，且**不要求连接就绪**（草稿是本地状态）", () => {
		const drafts = mountComposer();
		const h = harness();
		h.setReady(false);
		expect(h.api.compose({ text: "### 元素\n看这个" })).toBe(true);
		expect(drafts).toEqual(["### 元素\n看这个"]);
		expect(h.api.startChat({ prompt: "x" })).toBe(false);
		expect(h.sent).toHaveLength(0);
		resetComposerSinks();
	});

	it("附件透传给附件 sink，不带文本也能投", () => {
		resetComposerSinks();
		const got: unknown[] = [];
		registerAttachmentSink((items) => got.push(items));
		const shot = { path: "", name: "s.png", mode: "inline" as const, imageData: "AAA", key: "k" };
		expect(harness().api.compose({ attachments: [shot] })).toBe(true);
		expect(got).toEqual([[shot]]);
		resetComposerSinks();
	});

	it("空内容 → 拒收", () => {
		mountComposer();
		expect(harness().api.compose({})).toBe(false);
		expect(harness().api.compose({ text: "   " })).toBe(false);
		resetComposerSinks();
	});
});

describe("openModal/closeModal（宿主 API v10，modal.dialog 槽位）", () => {
	function modalHarness(
		overrides: {
			openModal?: (id: string) => boolean;
			closeModal?: () => void;
		} = {},
	) {
		const h = harness();
		let closed = 0;
		const api = createPluginHostApi({
			send: (msg) => {
				h.sent.push(msg);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => null,
			isConversationBlank: () => true,
			pollMs: 2,
			timeoutMs: 200,
			...(overrides.openModal ? { openModal: overrides.openModal } : {}),
			...(overrides.closeModal
				? { closeModal: overrides.closeModal }
				: {
						closeModal: () => {
							closed += 1;
						},
					}),
		});
		return { api, closed: () => closed };
	}
	it("未注入 openModal → 打开拒绝（false）；closeModal 缺省无害（true）", () => {
		const { api } = modalHarness();
		expect(api.openModal("plugin:x")).toBe(false);
		expect(api.openModal("")).toBe(false);
		expect(api.closeModal()).toBe(true);
	});
	it("注入后透传 id 与返回值；closeModal 异常不抛错", () => {
		const seen: string[] = [];
		const { api } = modalHarness({ openModal: (id) => (seen.push(id), id === "plugin:ok") });
		expect(api.openModal("plugin:ok")).toBe(true);
		expect(api.openModal("  ")).toBe(false);
		expect(api.openModal("plugin:nope")).toBe(false);
		expect(seen).toEqual(["plugin:ok", "plugin:nope"]);
		const throwing = modalHarness({
			openModal: () => {
				throw new Error("boom");
			},
			closeModal: () => {
				throw new Error("boom");
			},
		});
		expect(throwing.api.openModal("plugin:x")).toBe(false);
		expect(throwing.api.closeModal()).toBe(true);
	});
	it("宿主 API 版本已升到 v18（底栏状态槽自带跟随浮层内容渲染）", () => {
		expect(PLUGIN_HOST_API_VERSION).toBe(18);
	});
	it("pickDirectory 与 pickModel 转发调用到 deps", async () => {
		const h = harness({
			pickDirectory: async (opts) => ({ ok: true, path: opts?.initialPath || "/picked-dir" }),
			pickModel: async (opts) => ({ ok: true, modelId: opts?.currentModelId || "test-model" }),
		});
		const dirRes = await h.api.pickDirectory({ initialPath: "/workspace/proj" });
		expect(dirRes).toEqual({ ok: true, path: "/workspace/proj" });
		const modelRes = await h.api.pickModel({ currentModelId: "gpt-4o" });
		expect(modelRes).toEqual({ ok: true, modelId: "gpt-4o" });
	});
	it("openFileContextMenu 转发调用到 deps.openFileContextMenu", () => {
		let received: any = null;
		const h = harness({
			openFileContextMenu: (opts) => {
				received = opts;
			},
		});
		h.api.openFileContextMenu?.({ x: 100, y: 200, path: "src/index.ts", kind: "file" });
		expect(received).toEqual({ x: 100, y: 200, path: "src/index.ts", kind: "file" });
	});
});

describe("createPluginHostApi.models + startChat/openSession 的 model（issue #188）", () => {
	const catalog = [
		{ id: "anthropic/claude-sonnet-5", provider: "anthropic", name: "Sonnet", vision: true, reasoning: false },
		{ id: "openai/gpt-4o-mini", provider: "openai", name: "Mini", vision: true, reasoning: false },
	];
	function modelHarness() {
		const sent: ClientMessage[] = [];
		let conversationId: string | null = "conv-1";
		let modelId: string | null = "anthropic/claude-sonnet-5";
		const api = createPluginHostApi({
			send: (msg) => {
				sent.push(msg);
				if (msg.type === "new_chat") {
					conversationId = "conv-2";
					if (msg.requestId)
						resolveNewChatResult({ type: "new_chat_result", requestId: msg.requestId, ok: true, conversationId });
				}
				if (msg.type === "set_model") modelId = msg.modelId;
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "/a",
			getWorkspaceRoots: () => [],
			listModels: () => [...catalog],
			getCurrentModelId: () => modelId,
			listSessions: () => [],
			getConversationId: () => conversationId,
			isConversationBlank: () => false,
			listProjects: () => ["/a"],
			pollMs: 2,
			timeoutMs: 300,
		});
		return { api, sent, getModel: () => modelId };
	}
	it("models.list 原样返回已配置目录（不编造）", () => {
		expect(modelHarness().api.models.list()).toEqual(catalog);
	});
	it("无注入时 models.list 回 []（旧 harness 照旧工作）", () => {
		expect(harness().api.models.list()).toEqual([]);
	});
	it("startChat 带合法 model：new_chat → set_model → prompt（旧对话模型不动）", async () => {
		const h = modelHarness();
		expect(h.api.startChat({ prompt: "review", model: "openai/gpt-4o-mini" })).toBe(true);
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["new_chat", "set_model", "prompt"]);
		const setModel = h.sent.find((m) => m.type === "set_model");
		expect(setModel && "modelId" in setModel ? setModel.modelId : "").toBe("openai/gpt-4o-mini");
		expect(h.getModel()).toBe("openai/gpt-4o-mini");
	});
	it("startChat 带非法 model：直接拒绝，不发任何消息", async () => {
		const h = modelHarness();
		expect(h.api.startChat({ prompt: "review", model: "nope/ghost" })).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(h.sent).toEqual([]);
	});
	it("startChat 不带 model：沿用旧行为（new_chat → prompt，无 set_model）", async () => {
		const h = modelHarness();
		expect(h.api.startChat({ prompt: "hi" })).toBe(true);
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["new_chat", "prompt"]);
	});
	it("openSession 带非法 model：回 {ok:false}，不建对话", async () => {
		const h = modelHarness();
		const r = await h.api.openSession({ cwd: "/a", newChat: false, model: "nope/ghost" });
		expect(r.ok).toBe(false);
		expect(types(h.sent)).toEqual([]);
	});
	it("models.active 返回当前激活模型 id", () => {
		const h = modelHarness();
		expect(h.api.models.active()).toBe("anthropic/claude-sonnet-5");
	});
	it("models.onChange 监听模型变更并在触发时执行", () => {
		const h = modelHarness();
		const seen: (string | null)[] = [];
		const unsub = h.api.models.onChange((m) => seen.push(m));
		emitPluginHostModel("openai/gpt-4o-mini");
		expect(seen).toEqual(["openai/gpt-4o-mini"]);
		unsub();
		emitPluginHostModel("anthropic/claude-sonnet-5");
		expect(seen).toEqual(["openai/gpt-4o-mini"]);
	});
});

describe("createPluginHostApi.ttsProviders", () => {
	it("exposes center engine metadata without a second registration channel", () => {
		const { api } = harness();
		expect(api.ttsProviders.list()).toContainEqual(expect.objectContaining({ id: "builtin" }));
		expect(api.ttsProviders).not.toHaveProperty("register");
	});
});
