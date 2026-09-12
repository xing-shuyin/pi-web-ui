import { describe, expect, it } from "vitest";
import { createPluginHostApi, PLUGIN_HOST_API_VERSION } from "../../web/src/plugin-host";
import { registerAttachmentSink, registerDraftSink, resetComposerSinks } from "../../web/src/composer-bridge";
import type { ClientMessage } from "../../web/src/types";

/** 宿主 API 的时序纪律：new_chat 是异步的（`void cs.newChat()`），prompt 必须等
 *  对话真的切过去 / 本来就是空白对话，否则会落进旧对话。这些测试锁住这个顺序。 */
interface Harness {
	api: ReturnType<typeof createPluginHostApi>;
	sent: ClientMessage[];
	setCwd: (cwd: string) => void;
	setConversationId: (id: string | null) => void;
	setBlank: (blank: boolean) => void;
	setReady: (ready: boolean) => void;
	views: string[];
}

function harness(overrides: { pollMs?: number; timeoutMs?: number } = {}): Harness {
	const sent: ClientMessage[] = [];
	const views: string[] = [];
	let cwd = "";
	let conversationId: string | null = "conv-1";
	let blank = false;
	let ready = true;
	const api = createPluginHostApi({
		send: (msg) => {
			sent.push(msg);
			return true;
		},
		isReady: () => ready,
		setView: (v) => views.push(v),
		getCwd: () => cwd,
		getConversationId: () => conversationId,
		isConversationBlank: () => blank,
		pollMs: overrides.pollMs ?? 2,
		timeoutMs: overrides.timeoutMs ?? 200,
	});
	return {
		api,
		sent,
		views,
		setCwd: (v) => {
			cwd = v;
		},
		setConversationId: (v) => {
			conversationId = v;
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
		// set_cwd 先发，prompt 还没有
		expect(types(h.sent)).toEqual(["set_cwd"]);
		// 宿主切完目录 → new_chat 发出
		h.setCwd("/plugin/dir");
		await waitFor(() => types(h.sent).includes("new_chat"));
		expect(types(h.sent)).toEqual(["set_cwd", "new_chat"]);
		expect(types(h.sent)).not.toContain("prompt");
		// 新对话就绪（id 变了）→ 这时才发 prompt
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

	it("startChat：newChat=false 直接发 prompt；cwd 切不过去也照发（不静默丢消息）", async () => {
		const h = harness();
		h.api.startChat({ prompt: "x", newChat: false });
		await waitFor(() => types(h.sent).includes("prompt"));
		expect(types(h.sent)).toEqual(["prompt"]);

		const h2 = harness({ timeoutMs: 30, pollMs: 2 });
		h2.api.startChat({ prompt: "y", cwd: "/never" });
		await waitFor(() => types(h2.sent).includes("prompt"), 1500);
		expect(types(h2.sent)).toEqual(["set_cwd", "new_chat", "prompt"]);
	});

	it("setView 透传（空串忽略）", () => {
		const h = harness();
		h.api.setView("chat");
		h.api.setView("  ");
		expect(h.views).toEqual(["chat"]);
	});
});

describe("createPluginHostApi.compose", () => {
	/** 装上双 sink（模拟 App + ChatInput 已挂载）。 */
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
		// 关键差异：startChat 此时拒收，compose 照收
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
