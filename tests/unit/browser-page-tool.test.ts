/**
 * browser_page customTool + 页面调用桥单测（零 token / 零端口 / 零浏览器）。
 *
 * 覆盖：工具定义（名字、op 必填、args 只收已提供参数、timeoutMs 归一）、
 * execute 成功/失败、ClientSession.pageCall 的超时与无前端错误、resolvePageCall
 * 对未知 id 静默忽略、cancelPendingPageCalls、tool-manager 目录登记。
 *
 * 取舍说明：ClientSession 的构造函数要真起 SDK/文件监视/PTY，单测里造不出（也不
 * 该造）。这里改用 `fakeClientSession()` 只补上 pageCall 用到的
 * 那几个私有字段（disposed / sinks / pendingPageCalls / pageSeq），跑的是**真实**
 * 的 pageCall / resolvePageCall / cancelPendingPageCalls 实现，不是假替身。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClientSession,
	collectBrowserPageArgs,
	formatBrowserPageError,
	formatPageCallResult,
	makeBrowserPageTool,
	normalizePageCallTimeoutMs,
	type PageCallRequest,
	type PageCallResult,
} from "../../server/agent-service.js";
import { AGENT_TOOL_CATALOG, BROWSER_PAGE_TOOL_NAME, defaultDisabledAgentTools } from "../../server/tool-manager.js";
import { fakeClientSession } from "../helpers/fake-session.js";

/** 页面调用桥的真实实现 + 只补最小私有字段（见文件头取舍说明）。 */
function pageBridge(opts: { sinks?: number; disposed?: boolean } = {}) {
	const cs = fakeClientSession() as unknown as Record<string, unknown>;
	cs.disposed = opts.disposed ?? false;
	cs.sinks = new Set(Array.from({ length: opts.sinks ?? 1 }, () => () => {}));
	cs.pendingPageCalls = new Map();
	cs.pageSeq = 0;
	const calls = {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) =>
			(cs as unknown as ClientSession).pageCall(req, sig, conversationId),
		resolvePageCall: (id: string, ok: boolean, result?: unknown, error?: string) =>
			(cs as unknown as ClientSession).resolvePageCall(id, ok, result, error),
		cancelPendingPageCalls: () => (cs as unknown as ClientSession).cancelPendingPageCalls(),
		pending: () => cs.pendingPageCalls as Map<string, { conversationId?: string }>,
	};
	return calls;
}

/** 构造最小 clientSession mock：记录收到的请求，返回预设结果。 */
function mockSession(behave: (req: PageCallRequest) => Promise<PageCallResult>) {
	const invoked = {
		reqs: [] as PageCallRequest[],
		ownerIds: [] as (string | undefined)[],
		sig: {} as { aborted?: boolean },
	};
	return {
		invoked,
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, ownerId?: string) => {
			invoked.reqs.push(req);
			invoked.ownerIds.push(ownerId);
			invoked.sig = sig;
			return behave(req);
		},
	};
}

const ctx = {} as never;

afterEach(() => {
	vi.useRealTimers();
});

describe("makeBrowserPageTool 工具定义", () => {
	it("名字用 BROWSER_PAGE_TOOL_NAME，op 必填且可选参数齐全", () => {
		const tool = makeBrowserPageTool(mockSession(async () => ({ ok: true })));
		expect(tool.name).toBe(BROWSER_PAGE_TOOL_NAME);
		expect(tool.name).toBe("browser_page");
		const parsed = JSON.parse(JSON.stringify(tool.parameters)) as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(parsed.required).toEqual(["op"]);
		// schema 里的可选字段必须与 collectBrowserPageArgs 的白名单一致。
		const argsKeys = Object.keys(
			collectBrowserPageArgs({ what: 1, selector: 1, text: 1, url: 1, code: 1, all: 1, index: 1, maxEdge: 1 }),
		).sort();
		const schemaKeys = Object.keys(parsed.properties)
			.filter((k) => k !== "op" && k !== "target" && k !== "timeoutMs")
			.sort();
		expect(schemaKeys).toEqual(argsKeys);
	});

	it("description / promptGuidelines 提到 op 与「只读用户授权的页面」", () => {
		const tool = makeBrowserPageTool(mockSession(async () => ({ ok: true })));
		expect(tool.description).toContain("pages");
		expect(tool.description).toContain("eval");
		expect(String(tool.promptSnippet)).toContain("page-picker");
		const guidelines = (tool.promptGuidelines ?? []).join("\n");
		expect(guidelines).toContain("browser_page");
	});

	it("execute 只把已提供的参数收进 args，并带上 op/target/timeoutMs", async () => {
		const session = mockSession(async () => ({ ok: true, result: "hi" }));
		const tool = makeBrowserPageTool(session, "c7");
		await tool.execute("t1", { op: "type", selector: "#q", text: "hello", index: 0 }, undefined, undefined, ctx);
		const req = session.invoked.reqs[0];
		expect(req.op).toBe("type");
		// 提供的：selector/text/index；没提供的（what/url/code/all）不入包。
		expect(req.args).toEqual({ selector: "#q", text: "hello", index: 0 });
		expect(req.target).toBeUndefined();
		expect(req.timeoutMs).toBe(30_000);
		expect(session.invoked.ownerIds[0]).toBe("c7");
	});

	it("execute 把 target 与 timeoutMs 归一后透传", async () => {
		const session = mockSession(async () => ({ ok: true }));
		const tool = makeBrowserPageTool(session);
		await tool.execute(
			"t1",
			{ op: "goto", url: "https://a.test", target: "https://a.test", timeoutMs: 5 },
			undefined,
			undefined,
			ctx,
		);
		expect(session.invoked.reqs[0].target).toBe("https://a.test");
		expect(session.invoked.reqs[0].timeoutMs).toBe(1_000); // 夹到下限
		await tool.execute("t2", { op: "read", timeoutMs: 999_999 }, undefined, undefined, ctx);
		expect(session.invoked.reqs[1].timeoutMs).toBe(120_000); // 夹到上限
	});

	it("op 空缺 / 空白 → 报错且不碰桥", async () => {
		const session = mockSession(async () => ({ ok: true }));
		const tool = makeBrowserPageTool(session);
		await expect(tool.execute("t1", {}, undefined, undefined, ctx)).rejects.toThrow("non-empty");
		await expect(tool.execute("t2", { op: "   " }, undefined, undefined, ctx)).rejects.toThrow("non-empty");
		expect(session.invoked.reqs).toHaveLength(0);
	});

	it("execute 成功：字符串结果原样给模型，对象结果 JSON 缩进", async () => {
		const text = makeBrowserPageTool(mockSession(async () => ({ ok: true, result: "页面正文" })));
		const r1 = (await text.execute("t1", { op: "read" }, undefined, undefined, ctx)) as {
			content: { text: string }[];
			details: { op: string };
		};
		expect(r1.content[0].text).toBe("页面正文");
		expect(r1.details.op).toBe("read");

		const json = makeBrowserPageTool(mockSession(async () => ({ ok: true, result: { pages: ["a", "b"], n: 2 } })));
		const r2 = (await json.execute("t2", { op: "pages" }, undefined, undefined, ctx)) as {
			content: { text: string }[];
		};
		expect(r2.content[0].text).toBe(JSON.stringify({ pages: ["a", "b"], n: 2 }, null, 2));
	});

	it("execute 失败：抛 Error，消息里有原因和下一步建议", async () => {
		const tool = makeBrowserPageTool(mockSession(async () => ({ ok: false, error: "page not allowed（页面未授权）" })));
		await expect(tool.execute("t1", { op: "click", selector: "a" }, undefined, undefined, ctx)).rejects.toThrow(
			/page not allowed（页面未授权）/,
		);
		await expect(tool.execute("t2", { op: "click" }, undefined, undefined, ctx)).rejects.toThrow(/pages/);
	});

	it("execute 把信号的 aborted 快照传给 pageCall", async () => {
		const session = mockSession(async () => ({ ok: true }));
		const tool = makeBrowserPageTool(session);
		const controller = new AbortController();
		controller.abort();
		await tool.execute("t1", { op: "pages" }, controller.signal, undefined, ctx);
		expect(session.invoked.sig).toEqual({ aborted: true });
	});
});

describe("纯格式化/归一（页面桥共用）", () => {
	it("normalizePageCallTimeoutMs：默认 30000，夹在 [1000, 120000]（含脏值）", () => {
		expect(normalizePageCallTimeoutMs(undefined)).toBe(30_000);
		expect(normalizePageCallTimeoutMs(Number.NaN)).toBe(30_000);
		expect(normalizePageCallTimeoutMs("soon")).toBe(30_000);
		expect(normalizePageCallTimeoutMs(0)).toBe(1_000);
		expect(normalizePageCallTimeoutMs(-5)).toBe(1_000);
		expect(normalizePageCallTimeoutMs(9_999)).toBe(9_999);
		expect(normalizePageCallTimeoutMs(1e9)).toBe(120_000);
	});

	it("collectBrowserPageArgs：undefined 不入包（避免覆盖扩展侧默认值）", () => {
		expect(collectBrowserPageArgs({ op: "read", selector: undefined, all: false })).toEqual({ all: false });
		expect(collectBrowserPageArgs({})).toEqual({});
	});

	it("formatPageCallResult：空结果也有话说", () => {
		expect(formatPageCallResult("")).toBe("(empty)");
		expect(formatPageCallResult(null)).toBe("(no result)");
		// 循环引用不炸工具调用。
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(formatPageCallResult(cyc)).toBe("[object Object]");
	});

	it("formatBrowserPageError：中英双份 + 可执行的下一步", () => {
		const msg = formatBrowserPageError("click", "boom");
		expect(msg).toContain('browser_page "click" failed: boom');
		expect(msg).toContain("失败：boom");
		expect(msg).toContain('op:"pages"');
	});
});

describe("ClientSession 页面调用桥", () => {
	it("pageCall 发 page_request（id=timer 前登记），page_response 回来后 resolve 成功", async () => {
		const bridge = pageBridge();
		vi.useFakeTimers();
		const pending = bridge.pageCall({ op: "pages", timeoutMs: 30_000 }, {}, "c1");
		expect(bridge.pending().size).toBe(1);
		const id = [...bridge.pending().keys()][0];
		expect(id).toBe("p-1");
		expect(bridge.pending().get(id)?.conversationId).toBe("c1");
		bridge.resolvePageCall(id, true, { pages: ["x"] });
		await expect(pending).resolves.toEqual({ ok: true, result: { pages: ["x"] } });
		// 清理干净：不留下计时器/登记项。
		expect(bridge.pending().size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("pageCall 超时 → 返回失败并清理（不是无限等）", async () => {
		const bridge = pageBridge();
		vi.useFakeTimers();
		const pending = bridge.pageCall({ op: "read", timeoutMs: 1_000 }, {});
		await vi.advanceTimersByTimeAsync(999);
		expect(bridge.pending().size).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		const res = await pending;
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toContain("timeout");
		expect(bridge.pending().size).toBe(0);
	});

	it("超时后才迟到的 page_response → 静默忽略（不抛错、不再 resolve）", async () => {
		const bridge = pageBridge();
		vi.useFakeTimers();
		const pending = bridge.pageCall({ op: "read", timeoutMs: 1_000 }, {});
		const id = [...bridge.pending().keys()][0];
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toMatchObject({ ok: false });
		// 迟到回包：不抛错（这是正常竞态，不是 bug）。
		expect(() => bridge.resolvePageCall(id, true, "late")).not.toThrow();
		expect(() => bridge.resolvePageCall("p-999", true, "unknown")).not.toThrow();
	});

	it("sig.aborted / 已 dispose → 立即失败，不发请求", async () => {
		vi.useFakeTimers();
		const aborted = pageBridge();
		await expect(aborted.pageCall({ op: "pages", timeoutMs: 30_000 }, { aborted: true })).resolves.toMatchObject({
			ok: false,
		});
		expect(aborted.pending().size).toBe(0);

		const disposed = pageBridge({ disposed: true });
		await expect(disposed.pageCall({ op: "pages", timeoutMs: 30_000 }, {})).resolves.toMatchObject({ ok: false });
	});

	it("没有前端在线 → 可执行的错误（提示打开页面/启用扩展），不空等", async () => {
		vi.useFakeTimers();
		const bridge = pageBridge({ sinks: 0 });
		const res = await bridge.pageCall({ op: "pages", timeoutMs: 30_000 }, {});
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toMatch(/pi-web-ui/);
		expect(res.ok === false && res.error).toContain("page-picker");
		expect(bridge.pending().size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("page_response 失败但没给 error → 回落一句人话", async () => {
		const bridge = pageBridge();
		const pending = bridge.pageCall({ op: "click", timeoutMs: 30_000 }, {});
		bridge.resolvePageCall([...bridge.pending().keys()][0], false);
		await expect(pending).resolves.toMatchObject({ ok: false });
		const res = await pending;
		expect(res.ok === false && res.error.length).toBeGreaterThan(0);
	});

	it("cancelPendingPageCalls（dispose）→ 全部以失败解析，模型不挂死", async () => {
		const bridge = pageBridge();
		vi.useFakeTimers();
		const p1 = bridge.pageCall({ op: "read", timeoutMs: 30_000 }, {});
		const p2 = bridge.pageCall({ op: "click", timeoutMs: 30_000 }, {});
		expect(bridge.pending().size).toBe(2);
		bridge.cancelPendingPageCalls();
		expect(bridge.pending().size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		for (const p of [p1, p2]) {
			const res = await p;
			expect(res.ok).toBe(false);
			expect(res.ok === false && res.error).toContain("页面调用");
		}
	});
});

describe("tool-manager 登记", () => {
	it("AGENT_TOOL_CATALOG 含 browser_page（other 组、默认关）", () => {
		const entry = AGENT_TOOL_CATALOG.find((t) => t.name === BROWSER_PAGE_TOOL_NAME);
		expect(entry).toBeDefined();
		expect(entry?.group).toBe("other");
		expect(entry?.defaultOn).toBe(false);
		// 默认关 = 在默认禁用名单里。
		expect(defaultDisabledAgentTools()).toContain(BROWSER_PAGE_TOOL_NAME);
	});
});

// ------------------------------------------------------------------ 截图（op:"shot"）

/**
 * 截图这条路要回答一个体验问题：**主模型看不到图时谁来"看"**。
 * 规则：能看图就直接给 image block（当轮可见）；看不到就交给视觉桥转写成文字证据
 * （与用户粘贴图片同一套逻辑，设置里开着就自动生效）；连视觉桥也没有就把原因写进文本，
 * 而不是抛错让模型以为工具坏了。
 */
describe('截图（op:"shot"）的结果怎么给模型', () => {
	const shotResult = {
		ok: true as const,
		result: {
			image: { dataUrl: "data:image/jpeg;base64,QUJD", mimeType: "image/jpeg", width: 800, height: 600 },
			selector: "#card",
		},
	};

	it("主模型能看图 → 直接给 image block，且 data 是**纯 base64**（剥掉 data: 前缀）", async () => {
		const session = {
			...mockSession(async () => shotResult),
			canSeeImages: () => true,
		};
		const tool = makeBrowserPageTool(session);
		const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: unknown[] }>)(
			"t1",
			{ op: "shot", target: "http://localhost:5173", selector: "#card" },
			undefined,
		)) as { content: Array<Record<string, unknown>> };
		const image = out.content.find((c) => c.type === "image");
		expect(image).toMatchObject({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
		// 说明文字里带上「截的是哪一页的哪个元素、多大」
		const text = String(out.content[0]?.text ?? "");
		expect(text).toContain("#card");
		expect(text).toContain("800×600");
	});

	it("纯文本模型 + 视觉桥可用 → 只给文字，且带 <vision-bridge> 证据块", async () => {
		const calls: unknown[] = [];
		const session = {
			...mockSession(async () => shotResult),
			canSeeImages: () => false,
			transcribeToolImage: async (image: unknown) => {
				calls.push(image);
				return { text: "页面顶部有一张卡片，标题「卡片标题」。" };
			},
		};
		const tool = makeBrowserPageTool(session);
		const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)(
			"t1",
			{ op: "shot" },
			undefined,
		)) as { content: Array<{ text?: string }> };
		expect(out.content).toHaveLength(1); // 没有 image block
		expect(out.content[0].text).toContain("<vision-bridge>");
		expect(out.content[0].text).toContain("卡片标题");
		expect(calls[0]).toMatchObject({ data: "QUJD", mimeType: "image/jpeg" });
	});

	it("纯文本模型 + 视觉桥不可用 → 说明原因（不抛错、不静默）", async () => {
		const session = {
			...mockSession(async () => shotResult),
			canSeeImages: () => false,
			transcribeToolImage: async () => ({ reason: "没有可用的视觉模型" }),
		};
		const tool = makeBrowserPageTool(session);
		const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)(
			"t1",
			{ op: "shot" },
			undefined,
		)) as { content: Array<{ text?: string }> };
		expect(out.content[0].text).toContain("没有可用的视觉模型");
	});

	it("老替身（没实现 canSeeImages）也能用：退化成「看不到图 + 原因」", async () => {
		const tool = makeBrowserPageTool(mockSession(async () => shotResult));
		const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)(
			"t1",
			{ op: "shot" },
			undefined,
		)) as { content: Array<{ text?: string }> };
		expect(out.content).toHaveLength(1);
		expect(out.content[0].text).toContain("视觉桥");
	});

	it("非截图结果照旧走 JSON 文本（不因为加了截图把别的结果改坏）", async () => {
		const tool = makeBrowserPageTool(mockSession(async () => ({ ok: true, result: { title: "首页" } })));
		const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)(
			"t1",
			{ op: "read", what: "title" },
			undefined,
		)) as { content: Array<{ text?: string }> };
		expect(out.content[0].text).toContain("首页");
	});
});
