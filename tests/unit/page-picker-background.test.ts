import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickPayload } from "../../plugins/page-picker/extension/src/shared/contract.js";
import {
	attachShots,
	attachmentsOf,
	bindServer,
	composeInPage,
	deliver,
	handleAction,
	handleMessage,
	injectBindBar,
	loadSettings,
	openOptionsFor,
	startPicking,
} from "../../plugins/page-picker/extension/src/background.js";
import { isValidMatchPattern } from "../../plugins/page-picker/extension/src/shared/settings.js";
import { sectionsForDepth } from "../../plugins/page-picker/extension/src/shared/contract.js";
import type { PiProbe } from "../../plugins/page-picker/extension/src/shared/bind.js";
import { MAX_SHOT_EDGE, planCrop } from "../../plugins/page-picker/extension/src/shared/shot-crop.js";

/** 扩展 service worker 的决策逻辑（用假 chrome 驱动，零浏览器）：
 *  - 投递：找到 pi-web-ui 标签页 → MAIN world 注入 → 调宿主的 compose
 *  - 找不到页面 / 宿主不支持 / 输入框没就绪 → **必须把 Markdown 交回给用户**（复制兜底），
 *    绝不出现「点了发送，什么都没发生」
 *  - 注入不了（chrome:// 等）→ 明确报错，不静默 */

const snap = (tag = "section") => ({
	tag,
	classes: ["card"],
	selector: `main > ${tag}.card`,
	tagSummary: `<${tag} class="card">`,
	rect: { x: 0, y: 0, w: 320, h: 180, vwPct: 20, vhPct: 20 },
	text: "内容",
});

const payload = (over: Partial<PickPayload> = {}): PickPayload => ({
	id: "pick-1",
	pickedAt: "2026-01-01T00:00:00.000Z",
	page: { url: "http://localhost:5173/x", title: "X", viewport: { w: 1440, h: 900, dpr: 2 } },
	detail: "standard",
	elements: [{ snapshot: snap() }],
	...over,
});

interface FakeChrome {
	storage: {
		sync: { get: () => Promise<Record<string, unknown>>; set: (v: Record<string, unknown>) => Promise<void> };
	};
	runtime: { getURL: ReturnType<typeof vi.fn> };
	tabs: { query: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
	windows: { update: ReturnType<typeof vi.fn> };
	scripting: { executeScript: ReturnType<typeof vi.fn> };
	action: { setBadgeText: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> };
	permissions: { contains: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
}

function fakeChrome(
	opts: {
		tabs?: { id: number; windowId?: number; url?: string }[];
		injectResult?: unknown;
		injectThrows?: string;
		stored?: Record<string, unknown>;
		/** false = 没授权该地址（远程/局域网部署的第一步就是授权）。 */
		permissionGranted?: boolean;
		/** 探测注入（认页面）的返回值；undefined = 注不进去 → 走原来的拾取流程。 */
		probe?: PiProbe;
		probeThrows?: boolean;
		/** `permissions.request` 的结果：true = 浏览器给了手势。 */
		permissionRequest?: boolean;
	} = {},
): FakeChrome {
	const chrome: FakeChrome = {
		storage: {
			sync: {
				get: async () => opts.stored ?? {},
				set: vi.fn(async () => {}),
			},
		},
		runtime: { getURL: vi.fn((path: string) => `chrome-extension://fake/${path}`) },
		tabs: {
			// 关键：假 chrome 也要像真 Chrome 一样**校验 match pattern**。
			// `http://localhost:8787`（裸 origin，无路径）在真浏览器里会直接抛
			// `Invalid url pattern`，而被 catch 成「没找到页面」—— 0.2.0 的投递失败就是这么来的，
			// 当时假 chrome 不校验，测试全绿。
			query: vi.fn(async (info: { url?: string | string[] } = {}) => {
				const patterns = info.url == null ? [] : Array.isArray(info.url) ? info.url : [info.url];
				for (const p of patterns) {
					if (!isValidMatchPattern(p)) throw new Error(`Invalid url pattern '${p}'`);
				}
				return opts.tabs ?? [];
			}),
			update: vi.fn(async () => ({})),
			create: vi.fn(async () => ({})),
		},
		windows: { update: vi.fn(async () => ({})) },
		scripting: {
			executeScript: vi.fn(async (injection: { files?: string[]; func?: unknown; args?: unknown[] }) => {
				if (opts.injectThrows) throw new Error(opts.injectThrows);
				// files 注入（拾取器 / 绑定浮条）没有返回值；func 注入：带 args 的是投递（compose），
				// 不带的是一次「这个页面是不是 pi-web-ui」的探测
				if (injection.files) return [{}];
				if (injection.args === undefined) {
					if (opts.probeThrows) throw new Error("Cannot access a chrome:// URL");
					return [{ result: opts.probe }];
				}
				return [{ result: opts.injectResult }];
			}),
		},
		action: { setBadgeText: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
		permissions: {
			contains: vi.fn(async () => opts.permissionGranted ?? true),
			request: vi.fn(async () => opts.permissionRequest ?? false),
		},
	};
	(globalThis as Record<string, unknown>).chrome = chrome;
	return chrome;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
	delete (globalThis as Record<string, unknown>).__piWebUiHost;
});

describe("loadSettings", () => {
	it("读不到存储 → 回落默认设置（绝不抛）", async () => {
		fakeChrome();
		const s = await loadSettings();
		expect(s.serverUrl).toBe("http://127.0.0.1:8787");
		expect(s.detail).toBe("standard");
	});

	it("存储里是脏数据 → 逐项归一", async () => {
		fakeChrome({ stored: { serverUrl: "localhost:9999/", detail: "nope", copyToClipboard: "yes" } });
		const s = await loadSettings();
		expect(s.serverUrl).toBe("http://localhost:9999");
		expect(s.detail).toBe("standard");
		expect(s.copyToClipboard).toBe(true);
	});
});

describe("startPicking", () => {
	it("注入拾取器脚本到当前标签页", async () => {
		const chrome = fakeChrome();
		await startPicking({ id: 7 });
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["dist/picker.js"] });
	});

	it("没有 tabId → 什么都不做（不抛）", async () => {
		const chrome = fakeChrome();
		await startPicking(undefined);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("注入不了（chrome:// 等）→ 角标 + 标题写明原因，不静默", async () => {
		const chrome = fakeChrome({ injectThrows: "Cannot access a chrome:// URL" });
		await startPicking({ id: 3 });
		expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "!", tabId: 3 });
		const title = chrome.action.setTitle.mock.calls[0][0] as { title: string };
		expect(title.title).toContain("chrome://");
	});
});

/** 注入过的脚本文件名（拾取器 / 绑定浮条）。 */
function injectedFiles(chrome: FakeChrome): string[] {
	return chrome.scripting.executeScript.mock.calls
		.map(([injection]) => (injection as { files?: string[] }).files?.[0])
		.filter((f): f is string => Boolean(f));
}

describe("handleAction（点图标：先认页面，再决定注入什么）", () => {
	const probe: PiProbe = { isPiWebUi: true, hasHost: true, url: "http://39.99.235.208:8787/" };

	it("当前页就是 pi-web-ui → 注入绑定浮条，**不注入拾取器**", async () => {
		const chrome = fakeChrome({ probe });
		await handleAction({ id: 9 });
		expect(injectedFiles(chrome)).toEqual(["dist/bind.js"]);
	});

	it("普通页面 → 照旧注入拾取器", async () => {
		const chrome = fakeChrome({ probe: { isPiWebUi: false, url: "http://localhost:5173/" } });
		await handleAction({ id: 9 });
		expect(injectedFiles(chrome)).toEqual(["dist/picker.js"]);
	});

	it("detect 注不进去（chrome:// / 页面 CSP）→ **照样注入浮条让它自检**（不得到「点了没反应」）", async () => {
		// 真实动机：MAIN world 注入可能被环境挡住，而文件注入（拾取器/浮条）一直是好用的；
		// 那就把「认页面」这件事下放给浮条（它自己探 /api/health + DOM 兵形）
		const chrome = fakeChrome({ probeThrows: true });
		await handleAction({ id: 9 });
		expect(injectedFiles(chrome)).toEqual(["dist/bind.js"]);
	});

	it("探测明确说「不是 pi-web-ui」→ 才走拾取器", async () => {
		const chrome = fakeChrome({ probe: { isPiWebUi: false, url: "http://localhost:5173/" } });
		await handleAction({ id: 9 });
		expect(injectedFiles(chrome)).toEqual(["dist/picker.js"]);
	});

	it("没有 tabId → 什么都不做（不抛）", async () => {
		const chrome = fakeChrome();
		await handleAction(undefined);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});
});

describe("injectBindBar", () => {
	it("注入浮条并清掉上一次的角标", async () => {
		const chrome = fakeChrome();
		await injectBindBar(4);
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 4 }, files: ["dist/bind.js"] });
		expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 4 });
	});
});

describe("bindServer（把当前 pi-web-ui 页绑成服务地址）", () => {
	it("已授权 → 写入**归一后**的地址（?token= / hash / 尾斜杠都不进设置）", async () => {
		const chrome = fakeChrome({ permissionGranted: true });
		const res = await bindServer("http://39.99.235.208:8787/?token=abc#/chat");
		expect(res.ok).toBe(true);
		expect(res.base).toBe("http://39.99.235.208:8787");
		expect(chrome.storage.sync.set).toHaveBeenCalledWith({ serverUrl: "http://39.99.235.208:8787" });
		expect(chrome.permissions.request).not.toHaveBeenCalled(); // 已授权就不再烦用户
	});

	it("没授权但浏览器给了手势 → 申请该 origin 的权限再存", async () => {
		const chrome = fakeChrome({ permissionGranted: false, permissionRequest: true });
		const res = await bindServer("https://pi.example.com/pi/");
		expect(res.ok).toBe(true);
		expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ["https://pi.example.com/*"] });
		expect(chrome.storage.sync.set).toHaveBeenCalledWith({ serverUrl: "https://pi.example.com/pi" });
	});

	it("授权拿不到（页面上的点击给不了手势）→ **不写设置**，回 needAuth 让用户去选项页", async () => {
		const chrome = fakeChrome({ permissionGranted: false, permissionRequest: false });
		const res = await bindServer("http://39.99.235.208:8787");
		expect(res.ok).toBe(false);
		expect(res.needAuth).toBe(true);
		expect(res.message).toContain("http://39.99.235.208:8787/*");
		expect(chrome.storage.sync.set).not.toHaveBeenCalled();
	});
});

describe("openOptionsFor", () => {
	it("带 ?bind= 打开扩展自己的选项页（那里才有手势能授权）", async () => {
		const chrome = fakeChrome();
		await openOptionsFor("http://39.99.235.208:8787/?token=x");
		expect(chrome.tabs.create).toHaveBeenCalledWith({
			url: "chrome-extension://fake/options.html?bind=http%3A%2F%2F39.99.235.208%3A8787",
		});
	});
});

describe("composeInPage", () => {
	it("没有宿主桥 → no-host", () => {
		expect(composeInPage("x", [])).toEqual({ ok: false, reason: "no-host" });
	});

	it("有桥 → 调用 compose；宿主拒收 → refused", () => {
		const calls: unknown[] = [];
		(globalThis as Record<string, unknown>).__piWebUiHost = {
			compose: (o: unknown) => {
				calls.push(o);
				return true;
			},
		};
		expect(composeInPage("markdown", [])).toEqual({ ok: true });
		expect(calls).toEqual([{ text: "markdown" }]);

		(globalThis as Record<string, unknown>).__piWebUiHost = { compose: () => false };
		expect(composeInPage("m", [])).toEqual({ ok: false, reason: "refused" });
	});

	it("有附件时带上 attachments 字段", () => {
		const calls: { attachments?: unknown[] }[] = [];
		(globalThis as Record<string, unknown>).__piWebUiHost = {
			compose: (o: { attachments?: unknown[] }) => {
				calls.push(o);
				return true;
			},
		};
		const att = [{ path: "", name: "a.png", mode: "inline" as const, imageData: "AAA", key: "k" }];
		expect(composeInPage("m", att)).toEqual({ ok: true });
		expect(calls[0].attachments).toEqual(att);
	});
});

describe("attachmentsOf", () => {
	it("只把有截图的元素变成附件，key 带拾取 id（重试不叠图）", () => {
		const out = attachmentsOf(
			payload({
				elements: [{ snapshot: snap("div") }, { snapshot: snap("span"), shot: "data:image/png;base64,AAA" }],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ path: "", mode: "inline", imageData: "data:image/png;base64,AAA", key: "pick-1-2" });
		expect(out[0].name).toContain("元素2");
	});
});

describe("deliver", () => {
	const settings = {
		serverUrl: "http://127.0.0.1:8787",
		token: "",
		detail: "standard" as const,
		sections: sectionsForDepth("standard"),
		copyToClipboard: true,
		screenshots: true,
		focusTarget: false,
	};

	it("没有打开的 pi-web-ui 页面 → 失败但**复制兜底**（消息里说明）", async () => {
		fakeChrome({ tabs: [] });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(res.copy).toBe("# md");
		expect(res.message).toContain("没找到打开的 pi-web-ui 页面");
	});

	it("注入成功 → ok + 元素数量提示", async () => {
		const chrome = fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectResult: { ok: true } });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(true);
		expect(res.message).toContain("1 个元素");
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
			expect.objectContaining({ target: { tabId: 42 }, world: "MAIN" }),
		);
	});

	it("宿主版本过旧（没有 compose）→ 明确提示升级，而不是含糊失败", async () => {
		fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectResult: { ok: false, reason: "no-host" } });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("版本过旧");
	});

	it("输入框没就绪（compose 返回 false）→ 提示刷新", async () => {
		fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectResult: { ok: false, reason: "refused" } });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("还没就绪");
	});

	it("注入抛错 → 失败 + 复制兜底", async () => {
		fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectThrows: "boom" });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(res.copy).toBe("# md");
		expect(res.message).toContain("boom");
	});

	it("关掉「复制到剪贴板」→ 不回传 copy（不无谓地把 Markdown 塞回页面）", async () => {
		fakeChrome({ tabs: [] });
		const res = await deliver(payload(), "# md", { ...settings, copyToClipboard: false });
		expect(res.copy).toBeUndefined();
	});

	it("focusTarget 打开 → 注入成功后切标签页/窗口", async () => {
		const chrome = fakeChrome({
			tabs: [{ id: 42, windowId: 9, url: "http://127.0.0.1:8787/" }],
			injectResult: { ok: true },
		});
		await deliver(payload(), "# md", { ...settings, focusTarget: true });
		expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
		expect(chrome.windows.update).toHaveBeenCalledWith(9, { focused: true });
	});

	it("query 抛错 → 当成找不到页面，走兜底", async () => {
		const chrome = fakeChrome();
		chrome.tabs.query.mockRejectedValueOnce(new Error("boom"));
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(res.copy).toBe("# md");
	});

	it("**没授权这个地址** → 提示去选项页授权（而不是含糊地说「找不到页面」）", async () => {
		const chrome = fakeChrome({ permissionGranted: false });
		const res = await deliver(payload(), "# md", { ...settings, serverUrl: "https://pi.example.com" });
		expect(res.ok).toBe(false);
		expect(res.message).toContain("还没授权 https://pi.example.com/*");
		expect(res.message).toContain("授权该地址");
		expect(res.copy).toBe("# md"); // 兜底照样给
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("query 返回了无关标签页（权限过滤被静默忽略）→ 按 URL 复核，**绝不乱注入**", async () => {
		const chrome = fakeChrome({ tabs: [{ id: 1, url: "http://localhost:5173/" }] });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(false);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
		expect(res.message).toContain("没找到打开的 pi-web-ui 页面");
	});

	it("远程 + 子路径部署也认得目标页面", async () => {
		const chrome = fakeChrome({
			tabs: [{ id: 5, url: "https://pi.example.com/pi/chat" }],
			injectResult: { ok: true },
		});
		const res = await deliver(payload(), "# md", { ...settings, serverUrl: "https://pi.example.com/pi" });
		expect(res.ok).toBe(true);
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 5 } }));
	});

	// 回归（0.2.0 真实事故）：tabs.query 的 url 过滤只能是合法 match pattern。
	// 之前传的是 [`${base}/*`, base]，那个裸 origin 让真 Chrome/Edge 直接抛
	// `Invalid url pattern` → 被 catch 成「没找到页面」→ 页明明开着却报「没找到」。
	it("tabs.query 只拿到 **合法 match pattern**（裸 origin 会让真浏览器抛异常）", async () => {
		const chrome = fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectResult: { ok: true } });
		const res = await deliver(payload(), "# md", settings);
		expect(res.ok).toBe(true);
		const arg = chrome.tabs.query.mock.calls[0][0] as { url: string[] };
		expect(arg.url).toEqual(["http://127.0.0.1:8787/*"]);
		for (const p of arg.url) expect(isValidMatchPattern(p)).toBe(true);
	});

	it("目标是子路径时，查询用 origin 模式、路径靠 tabMatchesBase 复核（不误认前缀相似的站）", async () => {
		const chrome = fakeChrome({
			tabs: [{ id: 7, url: "https://host/pi-other/" }],
			injectResult: { ok: true },
		});
		const res = await deliver(payload(), "# md", { ...settings, serverUrl: "https://host/pi" });
		expect(res.ok).toBe(false);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
		expect((chrome.tabs.query.mock.calls[0][0] as { url: string[] }).url).toEqual(["https://host/*"]);
	});
});

/** 驱动 handleMessage 并把异步 respond 收成一个 promise。 */
function ask<T>(message: unknown): Promise<T> {
	return new Promise<T>((resolve) => {
		handleMessage(message, {}, (response) => resolve(response as T));
	});
}

describe("handleMessage", () => {
	it("settings 请求 → 回 detail + sections + serverUrl（**token 不下发**给内容脚本）", async () => {
		fakeChrome({ stored: { serverUrl: "http://127.0.0.1:8787", token: "secret", detail: "full" } });
		expect(handleMessage({ type: "page-picker:settings" }, {}, () => {})).toBe(true);
		expect(await ask({ type: "page-picker:settings" })).toEqual({
			detail: "full",
			// 老设置里只有 detail → 按档位推出对应组合（升级后行为不变）
			sections: sectionsForDepth("full"),
			serverUrl: "http://127.0.0.1:8787",
		});
	});

	it("settings 请求 → 用户自己勾的 sections 原样回给拾取器", async () => {
		fakeChrome({
			stored: { serverUrl: "http://127.0.0.1:8787", detail: "standard", sections: ["selector", "source"] },
		});
		expect(await ask({ type: "page-picker:settings" })).toMatchObject({ sections: ["selector", "source"] });
	});

	it("bind → 按页面地址绑定，结果回给浮条", async () => {
		fakeChrome({ permissionGranted: true });
		const res = await ask<{ ok: boolean; base: string }>({
			type: "page-picker:bind",
			url: "http://39.99.235.208:8787/",
		});
		expect(res.ok).toBe(true);
		expect(res.base).toBe("http://39.99.235.208:8787");
	});

	it("pick-anyway → 补注入拾取器（浮条上选「在本页拾取」）", async () => {
		const chrome = fakeChrome();
		const res = await new Promise<{ ok: boolean }>((resolve) => {
			handleMessage({ type: "page-picker:pick-anyway" }, { tab: { id: 7 } }, (r) => resolve(r as { ok: boolean }));
		});
		expect(res.ok).toBe(true);
		expect(injectedFiles(chrome)).toEqual(["dist/picker.js"]);
	});

	it("open-options → 打开带 ?bind= 的选项页", async () => {
		const chrome = fakeChrome();
		await ask({ type: "page-picker:open-options", url: "http://39.99.235.208:8787/" });
		expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
	});

	it("picked → 渲染 + 投递，回传结果", async () => {
		fakeChrome({ tabs: [{ id: 42, url: "http://127.0.0.1:8787/" }], injectResult: { ok: true } });
		const responded = await ask<{ ok: boolean; copy?: string }>({ type: "page-picker:picked", payload: payload() });
		expect(responded.ok).toBe(true);
		expect(responded.copy).toContain("### 网页元素拾取");
	});

	it("picked 但元素为空 → 明确拒收（不注入空消息）", async () => {
		fakeChrome();
		const responded = await ask<{ ok: boolean; message: string }>({
			type: "page-picker:picked",
			payload: payload({ elements: [] }),
		});
		expect(responded.ok).toBe(false);
		expect(responded.message).toContain("没有可发送的元素");
	});

	it("未知消息 → 不接管（返回 undefined，别人还能处理）", () => {
		fakeChrome();
		expect(handleMessage({ type: "whatever" }, {}, () => {})).toBeUndefined();
		expect(handleMessage(null, {}, () => {})).toBeUndefined();
	});
});

describe("planCrop（截图裁剪的坐标系）", () => {
	const rect = { x: 100, y: 50, w: 320, h: 180, vwPct: 20, vhPct: 20 };

	it("dpr=1：直接按 rect 抠，尺寸原样", () => {
		expect(planCrop(rect, { dpr: 1, imageW: 1440, imageH: 900 })).toEqual({
			srcX: 100,
			srcY: 50,
			srcW: 320,
			srcH: 180,
			dstW: 320,
			dstH: 180,
		});
	});

	it("dpr=2：**必须乘 dpr**（漏了就会抠到错位置/半张图）", () => {
		const plan = planCrop(rect, { dpr: 2, imageW: 2880, imageH: 1800 });
		expect(plan).toMatchObject({ srcX: 200, srcY: 100, srcW: 640, srcH: 360 });
	});

	it("长边超上限 → 等比缩小（不裁掉内容）", () => {
		const big = { x: 0, y: 0, w: 3000, h: 1000, vwPct: 100, vhPct: 100 };
		const plan = planCrop(big, { dpr: 1, imageW: 3000, imageH: 1000 });
		expect(plan?.dstW).toBe(MAX_SHOT_EDGE);
		expect(plan?.dstH).toBe(Math.round((1000 * MAX_SHOT_EDGE) / 3000));
		expect(plan?.srcW).toBe(3000);
	});

	it("自定义 maxEdge 生效", () => {
		expect(planCrop(rect, { dpr: 1, imageW: 1440, imageH: 900, maxEdge: 100 })?.dstW).toBe(100);
	});

	it("元素在视口外 → null（不截误导人的碎图）", () => {
		expect(planCrop({ ...rect, y: 2000 }, { dpr: 1, imageW: 1440, imageH: 900 })).toBeNull();
		expect(planCrop({ ...rect, x: -500 }, { dpr: 1, imageW: 1440, imageH: 900 })).toBeNull();
	});

	it("元素只露出一角（可见面积太少）→ null", () => {
		const mostlyBelow = { ...rect, y: 880, h: 200 }; // 只露出 20px
		expect(planCrop(mostlyBelow, { dpr: 1, imageW: 1440, imageH: 900 })).toBeNull();
	});

	it("跨出头部的元素 → 裁到可见部分，且不越界", () => {
		const plan = planCrop({ ...rect, x: -40 }, { dpr: 1, imageW: 1440, imageH: 900 });
		expect(plan).not.toBeNull();
		expect(plan?.srcX).toBe(0);
		expect(plan?.srcW).toBeLessThanOrEqual(320);
	});

	it("宽高为 0 / 图尺寸为 0 / dpr 非法 → null 或按 1 处理，不抛", () => {
		expect(planCrop({ ...rect, w: 0 }, { dpr: 1, imageW: 100, imageH: 100 })).toBeNull();
		expect(planCrop(rect, { dpr: 1, imageW: 0, imageH: 0 })).toBeNull();
		expect(planCrop(rect, { dpr: 0, imageW: 1440, imageH: 900 })?.srcX).toBe(100);
	});

	it("像素对齐：src 是整数（半像素会让截图发虚）", () => {
		const plan = planCrop(
			{ x: 10.4, y: 20.6, w: 100.3, h: 50.7, vwPct: 1, vhPct: 1 },
			{ dpr: 2, imageW: 1000, imageH: 1000 },
		);
		expect(Number.isInteger(plan?.srcX)).toBe(true);
		expect(Number.isInteger(plan?.srcY)).toBe(true);
		expect(Number.isInteger(plan?.srcW)).toBe(true);
		expect(Number.isInteger(plan?.srcH)).toBe(true);
	});
});

describe("attachShots", () => {
	const settings = {
		serverUrl: "http://127.0.0.1:8787",
		token: "",
		detail: "standard" as const,
		sections: sectionsForDepth("standard"),
		copyToClipboard: true,
		screenshots: true,
		focusTarget: false,
	};

	it("设置里关了截图 → 原样返回（连截屏都不做）", async () => {
		const capture = vi.fn();
		const input = payload();
		const out = await attachShots(
			input,
			{ ...settings, screenshots: false },
			{ id: 1 },
			{ tabs: { captureVisibleTab: capture } },
		);
		expect(out).toBe(input); // 同一个引用：完全没动
		expect(capture).not.toHaveBeenCalled();
	});

	it("没有 activeTab 权限 / 截屏失败 → 只是没截图，**不抛**（拾取照常可用）", async () => {
		const chromeApi = {
			tabs: {
				captureVisibleTab: vi.fn(async () => {
					throw new Error("Cannot access contents of the page");
				}),
			},
		};
		const input = payload();
		const out = await attachShots(input, settings, { id: 1 }, chromeApi);
		expect(out.elements[0].shot).toBeUndefined();
		expect(out.elements).toHaveLength(1);
	});

	it("没有 tabId / 关掉 screenshots 时不折腾", async () => {
		const out = await attachShots(payload(), settings, undefined, { tabs: { captureVisibleTab: vi.fn() } });
		expect(out.elements[0].shot).toBeUndefined();
	});
});
