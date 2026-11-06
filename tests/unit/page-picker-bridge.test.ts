import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeI18n } from "./fake-i18n.js";
import {
	BRIDGE_VERSION,
	BUILTIN_OPS,
	MAX_ARGS_CHARS,
	MAX_RECENT,
	clampTimeout,
	decideAiRoute,
	decideRoute,
	isBuiltinOp,
	normalizeOrigin,
	normalizePairs,
	normalizeRecent,
	pairId,
	parseBridgeCall,
	peersOf,
	removePair,
	rememberRecent,
	upsertPair,
	type BridgePair,
} from "../../plugins/page-picker/extension/src/shared/bridge.js";
import { AI_PAGES_KEY, PAIRS_KEY } from "../../plugins/page-picker/extension/src/shared/bridge-store.js";
import {
	installBridgePage,
	invokeBridgeHandler,
	uninstallBridgePage,
} from "../../plugins/page-picker/extension/src/content/bridge-page.js";
import {
	handleAction,
	handleBridgeCall,
	handleMessage,
	roleOf,
	syncBridges,
} from "../../plugins/page-picker/extension/src/background.js";
import { requestGrantHere, requestPairHere } from "../../plugins/page-picker/extension/src/content/pair-here.js";
import { isValidMatchPattern, normalizeSettings } from "../../plugins/page-picker/extension/src/shared/settings.js";

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";

const pair = (a = A, b = B, over: Partial<BridgePair> = {}): BridgePair => ({
	id: pairId(a, b),
	a,
	b,
	enabled: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	...over,
});

describe("normalizeOrigin", () => {
	it("取 origin：路径/查询串/hash 都不进配对", () => {
		expect(normalizeOrigin("https://a.example/x/y?z=1#h")).toBe(A);
		expect(normalizeOrigin("http://localhost:5173/app/")).toBe("http://localhost:5173");
	});

	it("缺协议时补 http://（用户习惯只打 host:port）", () => {
		expect(normalizeOrigin("localhost:5173")).toBe("http://localhost:5173");
	});

	it("注入不了的地方一律不认（file:// / chrome:// / 扩展页 / 空值）", () => {
		for (const bad of ["file:///E:/x.html", "chrome://extensions", "", "   ", 42, null, undefined, {}]) {
			expect(normalizeOrigin(bad)).toBeUndefined();
		}
	});
});

describe("normalizePairs", () => {
	it("脏数据逐条丢弃，不因为一格坏数据整表失效", () => {
		const out = normalizePairs([{ a: A, b: B }, { a: A, b: A }, { a: "file:///x", b: B }, null, "nonsense", { b: B }]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ a: A, b: B, enabled: true });
	});

	it("同一对换个顺序是同一对（存两遍也只留一条）", () => {
		const out = normalizePairs([
			{ a: A, b: B },
			{ a: B, b: A, note: "后写的赢？不，先到的保留" },
		]);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe(pairId(A, B));
	});

	it("enabled 缺省是 true（旧版本没这个字段，升级后桥不能变哑）", () => {
		expect(normalizePairs([{ a: A, b: B }])[0].enabled).toBe(true);
		expect(normalizePairs([{ a: A, b: B, enabled: false }])[0].enabled).toBe(false);
	});
});

describe("decideRoute（准入判定）", () => {
	it("没配对的 origin → 拒绝并指向选项页", () => {
		const res = decideRoute([], A);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("no-pair");
			expect(res.message).toContain("页面桥");
		}
	});

	it("唯一对端可以省略 to", () => {
		const res = decideRoute([pair()], A);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.peer).toBe(B);
	});

	it("多个对端必须显式指定 to（猜一个调错页面比报错难查得多）", () => {
		const res = decideRoute([pair(A, B), pair(A, C)], A);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("ambiguous");
			expect(res.message).toContain(B);
			expect(res.message).toContain(C);
		}
		expect(decideRoute([pair(A, B), pair(A, C)], A, C)).toMatchObject({ ok: true, peer: C });
	});

	it("指定了没配对的 to → 拒绝并列出实际配对的（别让人自己去猜）", () => {
		const res = decideRoute([pair(A, B)], A, C);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("no-pair");
			expect(res.message).toContain(B);
		}
	});

	it("停用的配对 → disabled（与「没配对」区分：一个是去启用，一个是去添加）", () => {
		const res = decideRoute([pair(A, B, { enabled: false })], A);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("disabled");
	});

	it("调用方地址不合法 / 对端就是自己 → 直接拒", () => {
		expect(decideRoute([pair()], "chrome://extensions")).toMatchObject({ ok: false, code: "bad-origin" });
		expect(decideRoute([pair()], A, A)).toMatchObject({ ok: false, code: "bad-origin" });
		expect(decideRoute([pair()], A, "file:///x")).toMatchObject({ ok: false, code: "bad-origin" });
	});

	it("对称：两端都能发起", () => {
		expect(decideRoute([pair()], B)).toMatchObject({ ok: true, peer: A });
	});

	it("peersOf 只列启用的对端", () => {
		expect(peersOf([pair(), pair(A, C, { enabled: false })], A)).toEqual([B]);
	});
});

describe("parseBridgeCall（content script 转上来的东西不可信，必须再查一遍）", () => {
	it("缺 op / op 带控制字符 / op 过长 → 拒绝", () => {
		expect(parseBridgeCall({})).toMatchObject({ ok: false });
		expect(parseBridgeCall({ op: "  " })).toMatchObject({ ok: false });
		expect(parseBridgeCall({ op: "a\nb" })).toMatchObject({ ok: false });
		expect(parseBridgeCall({ op: "x".repeat(100) })).toMatchObject({ ok: false });
	});

	it("正常请求：to 去空白、timeoutMs 夹进区间、args 原样保留", () => {
		const res = parseBridgeCall({ op: " read ", to: " https://b.example ", args: { id: 1 }, timeoutMs: 999999 });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.call).toEqual({ op: "read", to: B, args: { id: 1 }, timeoutMs: 30000 });
		}
	});

	it("参数过大 / 循环引用 → 拒绝（在本地就拦住，别等 postMessage 抛 DataCloneError）", () => {
		expect(parseBridgeCall({ op: "x", args: "y".repeat(MAX_ARGS_CHARS + 1) })).toMatchObject({ ok: false });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(parseBridgeCall({ op: "x", args: cyclic })).toMatchObject({ ok: false });
	});

	it("clampTimeout：拿不到/离谱的值都不让页面把 Promise 悬着", () => {
		expect(clampTimeout(undefined)).toBe(5000);
		expect(clampTimeout(-1)).toBe(1);
		expect(clampTimeout(1e9)).toBe(30000);
	});
});

describe("upsertPair / removePair", () => {
	it("新增、改备注、换序都不产生重复项", () => {
		const first = upsertPair([], A, B, { now: "t1" });
		expect(first.pairs).toHaveLength(1);
		const again = upsertPair(first.pairs, B, A, { note: "订单页 ↔ 工具页" });
		expect(again.pairs).toHaveLength(1);
		expect(again.pairs[0].note).toBe("订单页 ↔ 工具页");
		expect(again.pairs[0].createdAt).toBe("t1");
	});

	it("非法输入给一句人话的错，而不是默默存进去", () => {
		expect(upsertPair([], "file:///x", B).error).toContain("http");
		expect(upsertPair([], A, A).error).toContain("同一个");
	});

	it("删除按 id", () => {
		expect(removePair([pair()], pairId(A, B))).toHaveLength(0);
	});
});

interface FakePage {
	sent: Record<string, unknown>[];
	deliver(data: unknown): void;
}

function fakePageWindow(token = "tok-1", origin = A): FakePage {
	const g = globalThis as unknown as Record<string, unknown>;
	const sent: Record<string, unknown>[] = [];
	const listeners: ((e: { data?: unknown }) => void)[] = [];
	g.document = {
		documentElement: {
			getAttribute: (name: string) => (name === "data-pi-bridge" ? token : null),
			removeAttribute: () => {},
		},
	};
	g.location = { origin };
	g.postMessage = (msg: unknown) => {
		sent.push(msg as Record<string, unknown>);
	};
	g.addEventListener = (type: string, cb: (e: { data?: unknown }) => void) => {
		if (type === "message") listeners.push(cb);
	};
	g.removeEventListener = () => {};
	return {
		sent,
		deliver: (data: unknown) => {
			for (const cb of listeners) cb({ data });
		},
	};
}

function cleanPageWindow(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	delete g.document;
	delete g.location;
	delete g.postMessage;
	delete g.addEventListener;
	delete g.removeEventListener;
	delete g.__piBridge;
}

describe("installBridgePage（页面侧 API）", () => {
	afterEach(cleanPageWindow);

	it("content script 还没 arm（DOM 上没有 token）→ 拒绝，而不是装一个哑桥", () => {
		cleanPageWindow();
		const g = globalThis as unknown as Record<string, unknown>;
		g.document = { documentElement: { getAttribute: () => null, removeAttribute: () => {} } };
		expect(installBridgePage()).toMatchObject({ ok: false, reason: "no-token" });
	});

	it("装上后 version 与 shared/bridge.ts 一致（字面量必须同步，这条测试就是那个「必须」）", () => {
		fakePageWindow();
		const res = installBridgePage({ peers: [B], self: A });
		expect(res.ok).toBe(true);
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		expect(api.version).toBe(BRIDGE_VERSION);
		expect(api.self).toBe(A);
		expect(api.peers).toEqual([B]);
	});

	it("call：把请求 postMessage 出去，等 result 回来才 resolve", async () => {
		const page = fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		const promise = api.call({ op: "read", args: { id: 3 }, to: B }) as Promise<unknown>;
		expect(page.sent[0]).toMatchObject({ kind: "call", op: "read", args: { id: 3 }, to: B });
		const id = page.sent[0].id;
		page.deliver({ __piBridge: "tok-1", kind: "result", id, ok: true, value: [1, 2] });
		await expect(promise).resolves.toEqual([1, 2]);
	});

	it("token 不匹配的 result 一律忽略（别的世界/别的扩展发的消息不该能决定我们的 Promise）", async () => {
		const page = fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		const promise = api.call({ op: "read", timeoutMs: 30 }) as Promise<unknown>;
		page.deliver({ __piBridge: "别人家的-token", kind: "result", id: page.sent[0].id, ok: true, value: "假数据" });
		await expect(promise).rejects.toThrow(/没回/);
	});

	it("对端报错 → reject 带对端那句话（页面上能看懂为什么失败）", async () => {
		const page = fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		const promise = api.call({ op: "read" }) as Promise<unknown>;
		page.deliver({ __piBridge: "tok-1", kind: "result", id: page.sent[0].id, ok: false, error: "对端没注册 read" });
		await expect(promise).rejects.toThrow("对端没注册 read");
	});

	it("超时自己兜底（对端永远不回时不能把页面的 Promise 悬着）", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		await expect(api.call({ op: "read", timeoutMs: 20 })).rejects.toThrow(/20ms 内没回/);
	});

	it("重复注入只刷新 peers/token，**保住页面注册的 handler**", () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		const seen: unknown[] = [];
		api.on("read", (args: unknown) => {
			seen.push(args);
			return "ok";
		});
		installBridgePage({ peers: [C], self: A });
		const next = (globalThis as unknown as Record<string, any>).__piBridge;
		expect(next).toBe(api);
		expect(next.peers).toEqual([C]);
		return next.__invoke("read", 42, B).then((res: Record<string, unknown>) => {
			expect(res).toEqual({ ok: true, value: "ok" });
			expect(seen).toEqual([42]);
		});
	});

	it("卸载：拆监听器、清 pending（挂着的调用要 reject，不能永远悬着）", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		const promise = api.call({ op: "read" });
		uninstallBridgePage();
		await expect(promise).rejects.toThrow(/卸载/);
		expect((globalThis as unknown as Record<string, unknown>).__piBridge).toBeUndefined();
	});
});

describe("invokeBridgeHandler（worker 注入进对端页面的那一端）", () => {
	afterEach(cleanPageWindow);

	it("桥没装上 → 明确说「还没装上」并给机器可读的 no-bridge（worker 靠它补装重试）", async () => {
		cleanPageWindow();
		await expect(invokeBridgeHandler({ op: "x" })).resolves.toMatchObject({ ok: false, code: "no-bridge" });
	});

	it("没注册那个 op → 报错里列出对端注册了什么", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		(globalThis as unknown as Record<string, any>).__piBridge.on("alpha", () => 1);
		const res = await invokeBridgeHandler({ op: "beta" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("beta");
		expect(res.error).toContain("alpha");
	});

	it("handler 收到 args 与 from（对端知道是谁在调）", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		const api = (globalThis as unknown as Record<string, any>).__piBridge;
		api.on("read", (args: unknown, ctx: { from: string }) => ({ args, from: ctx.from }));
		await expect(invokeBridgeHandler({ op: "read", args: { id: 7 }, from: B })).resolves.toEqual({
			ok: true,
			value: { args: { id: 7 }, from: B },
		});
	});

	it("handler 抛错 → 变成一句带原因的失败（不是把异常漏给 worker）", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		(globalThis as unknown as Record<string, any>).__piBridge.on("boom", () => {
			throw new Error("炸了");
		});
		const res = await invokeBridgeHandler({ op: "boom" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("炸了");
	});

	it("返回值不可传输（循环引用）→ 提前报错，别让 executeScript 回程抛 DataCloneError", async () => {
		fakePageWindow();
		installBridgePage({ peers: [B], self: A });
		(globalThis as unknown as Record<string, any>).__piBridge.on("loop", () => {
			const o: Record<string, unknown> = {};
			o.self = o;
			return o;
		});
		const res = await invokeBridgeHandler({ op: "loop" });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("传不回来");
	});
});

it("页面侧的函数是自包含的（executeScript 只搬函数本身，引用模块作用域 = 页面里 ReferenceError）", () => {
	for (const fn of [installBridgePage, invokeBridgeHandler, uninstallBridgePage]) {
		expect(() => new Function(`return (${fn.toString()})`)()).not.toThrow();
	}
});

interface FakeChrome {
	storage: {
		sync: { get: () => Promise<Record<string, unknown>>; set: (v: Record<string, unknown>) => Promise<void> };
		local: {
			get: (keys: string[] | null) => Promise<Record<string, unknown>>;
			set: (v: Record<string, unknown>) => Promise<void>;
		};
	};
	tabs: {
		query: ReturnType<typeof vi.fn>;
		sendMessage: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		captureVisibleTab: ReturnType<typeof vi.fn>;
	};
	scripting: { executeScript: ReturnType<typeof vi.fn> };
	windows: { update: ReturnType<typeof vi.fn> };
	action: { setBadgeText: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> };
	permissions: { contains: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
	runtime: { getURL: (path: string) => string; sendMessage: ReturnType<typeof vi.fn> };
	i18n: ReturnType<typeof createFakeI18n>;
	store: Record<string, unknown>;
}

function matchesPattern(pattern: string, url: string): boolean {
	const prefix = pattern.replace(/\*$/, "");
	return url.startsWith(prefix);
}

function fakeChrome(
	opts: {
		tabs?: { id: number; url: string; windowId?: number; active?: boolean }[];
		pairs?: unknown;
		aiPages?: unknown;
		settings?: Record<string, unknown>;
		permissionGranted?: boolean;
		peerResult?: unknown;
		firstPeerResult?: unknown;
		peerByOp?: Record<string, unknown>;
		visibleShot?: string;
		shotPermission?: boolean;
		injectThrows?: string;
	} = {},
): FakeChrome {
	const store: Record<string, unknown> = {};
	if (opts.pairs !== undefined) store[PAIRS_KEY] = opts.pairs;
	if (opts.aiPages !== undefined) store[AI_PAGES_KEY] = opts.aiPages;
	const calls = { peer: 0 };
	const chrome: FakeChrome = {
		storage: {
			sync: { get: async () => ({ ...(opts.settings ?? {}) }), set: vi.fn(async () => {}) },
			local: {
				get: async (keys) => {
					const out: Record<string, unknown> = {};
					for (const key of keys ?? Object.keys(store)) if (key in store) out[key] = store[key];
					return out;
				},
				set: vi.fn(async (items: Record<string, unknown>) => {
					Object.assign(store, items);
				}),
			},
		},
		tabs: {
			query: vi.fn(async (info: { url?: string | string[]; active?: boolean } = {}) => {
				const patterns = info.url == null ? [] : Array.isArray(info.url) ? info.url : [info.url];
				for (const p of patterns) {
					if (!isValidMatchPattern(p)) throw new Error(`Invalid url pattern '${p}'`);
				}
				let list = opts.tabs ?? [];
				if (info.active === true) list = list.filter((t) => t.active === true);
				if (patterns.length === 0) return list;
				return list.filter((t) => patterns.some((p) => matchesPattern(p, t.url)));
			}),
			captureVisibleTab: vi.fn(async () => opts.visibleShot ?? "data:image/jpeg;base64,SHOT"),
			sendMessage: vi.fn(async (tabId: number, message: { type?: string }) => {
				if (message?.type === "page-picker:bridge-arm") return { ok: true, token: `tok-${tabId}` };
				return undefined;
			}),
			update: vi.fn(async () => ({})),
			create: vi.fn(async () => ({})),
		},
		scripting: {
			executeScript: vi.fn(async (injection: { files?: string[]; func?: { name?: string }; args?: unknown[] }) => {
				if (opts.injectThrows) throw new Error(opts.injectThrows);
				if (injection.files) return [{}];
				if (injection.func?.name === "invokeBridgeHandler") {
					const req = (injection.args?.[0] ?? {}) as { op?: string };
					if (opts.peerByOp && req.op && req.op in opts.peerByOp) return [{ result: opts.peerByOp[req.op] }];
					calls.peer += 1;
					if (calls.peer === 1 && opts.firstPeerResult !== undefined) return [{ result: opts.firstPeerResult }];
					return [{ result: opts.peerResult ?? { ok: true, value: "对端的数据" } }];
				}
				return [{ result: { ok: true, version: BRIDGE_VERSION } }];
			}),
		},
		windows: { update: vi.fn(async () => ({})) },
		action: { setBadgeText: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
		permissions: {
			contains: vi.fn(async (p: { origins?: string[] } = {}) => {
				const wantsShot = (p.origins ?? []).some((o) => /^https?:\/\/\*\//.test(o));
				if (wantsShot) return opts.shotPermission ?? true;
				return opts.permissionGranted ?? true;
			}),
			request: vi.fn(async () => true),
		},
		runtime: {
			getURL: (path: string) => `chrome-extension://fake/${path}`,
			sendMessage: vi.fn(
				async (message: unknown) =>
					await new Promise((resolve) => {
						handleMessage(message, { tab: { id: 1, url: `${A}/x` } }, (r) => resolve(r ?? null));
					}),
			),
		},
		i18n: createFakeI18n(),
		store,
	};
	(globalThis as Record<string, unknown>).chrome = chrome;
	return chrome;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

describe("handleBridgeCall（sender 是唯一可信的「你是谁」）", () => {
	it("不是网页发来的（没有 sender.tab）→ 拒绝", async () => {
		fakeChrome({ pairs: [pair()] });
		await expect(handleBridgeCall({ op: "read" }, {})).resolves.toMatchObject({ ok: false });
	});

	it("sender 的 origin 不在配对表 → 拒绝（哪怕消息体里自称是对端）", async () => {
		fakeChrome({ pairs: [pair()], tabs: [{ id: 1, url: `${B}/x` }] });
		const res = await handleBridgeCall({ op: "read", to: B }, { tab: { id: 9, url: `${C}/evil` } });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("配对");
	});

	it("配对在、对端页面没打开 → 一句「先把它开在标签页里」", async () => {
		fakeChrome({ pairs: [pair()], tabs: [{ id: 1, url: `${A}/x` }] });
		const res = await handleBridgeCall({ op: "read" }, { tab: { id: 1, url: `${A}/x` } });
		expect(res.ok).toBe(false);
		expect(res.error).toContain(B);
		expect(res.error).toContain("没打开");
	});

	it("happy path：查到对端标签页 → 注入 MAIN world 调 handler → 结果原样带回", async () => {
		const chrome = fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
			],
			peerResult: { ok: true, value: [{ id: 3 }] },
		});
		const res = await handleBridgeCall({ op: "orders", args: { day: 1 } }, { tab: { id: 1, url: `${A}/x` } });
		expect(res).toEqual({ ok: true, value: [{ id: 3 }] });
		const injection = chrome.scripting.executeScript.mock.calls.at(-1)?.[0] as {
			target: { tabId: number };
			world: string;
			args: unknown[];
		};
		expect(injection.target).toEqual({ tabId: 2 });
		expect(injection.world).toBe("MAIN");
		expect(injection.args[0]).toMatchObject({ op: "orders", args: { day: 1 }, from: A });
	});

	it("对端还没装上桥 → 补装一次再重试（用户看到的是「自己好了」而不是失败）", async () => {
		const chrome = fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
			],
			firstPeerResult: { ok: false, code: "no-bridge", error: "对端页面还没装上页面桥" },
			peerResult: { ok: true, value: "补装成功" },
		});
		const res = await handleBridgeCall({ op: "orders" }, { tab: { id: 1, url: `${A}/x` } });
		expect(res).toEqual({ ok: true, value: "补装成功" });
		const files = chrome.scripting.executeScript.mock.calls
			.map(([injection]) => (injection as { files?: string[] }).files?.[0])
			.filter(Boolean);
		expect(files).toContain("dist/bridge.js");
	});

	it("对端没注册那个 op → 原样把原因带回来（不重试、不吞掉）", async () => {
		fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
			],
			peerResult: { ok: false, code: "no-handler", error: '对端页面没注册 "read"' },
		});
		const res = await handleBridgeCall({ op: "read" }, { tab: { id: 1, url: `${A}/x` } });
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-handler");
		expect(res.error).toContain("没注册");
	});

	it("回程结果过大 → 挡住（SW 被一个超大对象拖死比报错糟糕得多）", async () => {
		fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
			],
			peerResult: { ok: true, value: "x".repeat(600 * 1024) },
		});
		const res = await handleBridgeCall({ op: "big" }, { tab: { id: 1, url: `${A}/x` } });
		expect(res.ok).toBe(false);
		expect(res.code).toBe("too-large");
	});

	it("没授权对端地址 → 说清是「授权」这一步缺了", async () => {
		fakeChrome({ pairs: [pair()], tabs: [{ id: 1, url: `${A}/x` }], permissionGranted: false });
		const res = await handleBridgeCall({ op: "read", to: B }, { tab: { id: 1, url: `${A}/x` } });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("授权");
	});
});

describe("handleMessage 接线", () => {
	it("page-picker:bridge-call → 异步 respond（通道要保持住）", async () => {
		fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
			],
		});
		const responded = await new Promise<unknown>((resolve) => {
			const keep = handleMessage(
				{ type: "page-picker:bridge-call", op: "read" },
				{ tab: { id: 1, url: `${A}/x` } },
				(res) => resolve(res),
			);
			expect(keep).toBe(true);
		});
		expect(responded).toMatchObject({ ok: true, value: "对端的数据" });
	});

	it("page-picker:pairs-changed → 装上该装的、卸下被删的那一对", async () => {
		const chrome = fakeChrome({
			pairs: [pair()],
			tabs: [
				{ id: 1, url: `${A}/x` },
				{ id: 2, url: `${B}/y` },
				{ id: 3, url: `${C}/z` },
			],
		});
		const res = await new Promise<unknown>((resolve) => {
			handleMessage({ type: "page-picker:pairs-changed", removedOrigins: [C] }, {}, (r) => resolve(r));
		});
		expect(res).toMatchObject({ ok: true, installed: 2, uninstalled: 1 });
		const files = chrome.scripting.executeScript.mock.calls
			.map(([injection]) => (injection as { files?: string[] }).files?.[0])
			.filter(Boolean);
		expect(files.filter((f) => f === "dist/bridge.js")).toHaveLength(2);
	});

	it("未知消息照旧忽略（返回 undefined，不占着通道）", () => {
		fakeChrome();
		expect(handleMessage({ type: "page-picker:nonsense" }, {}, () => {})).toBeUndefined();
	});
});

describe("syncBridges（注入时机）", () => {
	it("没配对的页面一个字节都不注入", async () => {
		const chrome = fakeChrome({ pairs: [], tabs: [{ id: 1, url: `${A}/x` }] });
		expect(await syncBridges()).toBe(0);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("配对的页面：content script + arm + MAIN 桥，三步齐（MAIN 桥的 token 依赖 arm 先跑）", async () => {
		const chrome = fakeChrome({ pairs: [pair()], tabs: [{ id: 1, url: `${A}/x` }] });
		expect(await syncBridges()).toBe(1);
		const order = chrome.scripting.executeScript.mock.calls.map(
			([injection]) =>
				(injection as { files?: string[]; world?: string }).files?.[0] ??
				((injection as { world?: string }).world === "MAIN" ? "main" : "?"),
		);
		expect(order).toEqual(["dist/bridge.js", "main"]);
		expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: "page-picker:bridge-arm" });
	});

	it("没授权那个 origin → 不查也不注入（tabs.query 的过滤在没权限时会被静默忽略）", async () => {
		const chrome = fakeChrome({ pairs: [pair()], tabs: [{ id: 1, url: `${A}/x` }], permissionGranted: false });
		expect(await syncBridges()).toBe(0);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("停用的配对不装", async () => {
		const chrome = fakeChrome({ pairs: [pair(A, B, { enabled: false })], tabs: [{ id: 1, url: `${A}/x` }] });
		expect(await syncBridges()).toBe(0);
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});
});

describe("配对候选（最近点过扩展图标的页面）", () => {
	it("normalizeRecent：去重、非 http(s) 丢弃、按最近在前", () => {
		const list = normalizeRecent([
			{ origin: "http://a.example/x", title: " A ", at: "2026-01-01T00:00:00.000Z" },
			{ origin: "http://a.example/other", title: "重复的", at: "2026-01-03T00:00:00.000Z" },
			{ origin: "chrome://extensions", at: "2026-01-04T00:00:00.000Z" },
			{ origin: "https://b.example", at: "2026-01-02T00:00:00.000Z" },
			null,
			"nope",
		]);
		expect(list.map((r) => r.origin)).toEqual(["http://a.example", "https://b.example"]);
		expect(list[0].title).toBe("重复的");
		expect(normalizeRecent([{ origin: "http://x.example", title: "  空白标题  ", at: "t" }])[0].title).toBe("空白标题");
	});

	it("超过上限只留最近的 MAX_RECENT 条（下拉不该变成一个要滚动的列表）", () => {
		const many = Array.from({ length: MAX_RECENT + 5 }, (_, i) => ({
			origin: `https://s${i}.example`,
			at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
		}));
		const list = normalizeRecent(many);
		expect(list).toHaveLength(MAX_RECENT);
		expect(list[0].origin).toBe(`https://s${MAX_RECENT + 4}.example`);
	});

	it("同一个 origin 再点一次只提到最前，不产生重复项", () => {
		let list = rememberRecent([], "http://localhost:5173", { title: "开发站", now: "t1" });
		list = rememberRecent(list, "https://tools.example", { title: "工具页", now: "t2" });
		list = rememberRecent(list, "http://localhost:5173/app", { title: "开发站（改过）", now: "t3" });
		expect(list.map((r) => r.origin)).toEqual(["http://localhost:5173", "https://tools.example"]);
		expect(list[0].title).toBe("开发站（改过）");
	});

	it("注入不了的地址不进候选（配了也调不通）", () => {
		expect(rememberRecent([], "file:///x")).toEqual([]);
		expect(rememberRecent([], undefined)).toEqual([]);
	});

	it("点扩展图标 → 本页进候选（此刻 activeTab 让 url/标题可读）", async () => {
		const chrome = fakeChrome({ tabs: [{ id: 3, url: "http://localhost:5173/app" }] });
		await handleAction({ id: 3, url: "http://localhost:5173/app?x=1#h", title: "我的开发站" });
		expect(chrome.store.recentOrigins).toEqual([
			{ origin: "http://localhost:5173", title: "我的开发站", at: expect.any(String) },
		]);
	});

	it("chrome:// 页面点图标 → 不进候选（但拾取流程照旧不报错）", async () => {
		const chrome = fakeChrome({});
		await handleAction({ id: 4, url: "chrome://extensions", title: "扩展" });
		expect(chrome.store.recentOrigins).toEqual([]);
	});

	it("拾取浮条的「与另一页配对…」→ 打开设置页并预填本端（网页上给不了授权手势）", async () => {
		const chrome = fakeChrome({});
		const res = await new Promise<unknown>((resolve) => {
			handleMessage({ type: "page-picker:pair-here", url: "http://localhost:5173/x?y=1" }, {}, (r) => resolve(r));
		});
		expect(res).toEqual({ ok: true });
		const created = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
		expect(created.url).toContain("options.html?pair=");
		expect(decodeURIComponent(created.url)).toContain("http://localhost:5173");
		expect(chrome.store.recentOrigins).toEqual([
			{ origin: "http://localhost:5173", title: "http://localhost:5173", at: expect.any(String) },
		]);
	});

	it("页面地址给不出来（拿不到 sender）→ 不打开设置页，报 ok:false", async () => {
		const chrome = fakeChrome({});
		const res = await new Promise<unknown>((resolve) => {
			handleMessage({ type: "page-picker:pair-here" }, {}, (r) => resolve(r));
		});
		expect(res).toEqual({ ok: false });
		expect(chrome.tabs.create).not.toHaveBeenCalled();
	});

	it("浮条一侧的 requestPairHere：成功 true、失败 false（调用方据此决定提示什么）", async () => {
		const chrome = fakeChrome({});
		expect(await requestPairHere("http://localhost:5173/x")).toBe(true);

		(chrome.runtime as unknown as Record<string, unknown>).sendMessage = async () => {
			throw new Error("Extension context invalidated");
		};
		expect(await requestPairHere("http://localhost:5173/x")).toBe(false);
	});

	it("浮条一侧的 requestGrantHere：同样只负责把用户送到设置页", async () => {
		const chrome = fakeChrome({});
		expect(await requestGrantHere("http://localhost:5173/x")).toBe(true);
		const created = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
		expect(decodeURIComponent(created.url)).toContain("options.html?grant=http://localhost:5173");
	});
});

const HOST = "http://127.0.0.1:8787/";
const TARGET = "http://localhost:5173";

const aiPage = (origin = TARGET, title = "开发站") => ({ origin, title, at: "2026-01-01T00:00:00.000Z" });
const hostSender = { tab: { id: 9, url: HOST } };

function lastInjection(chrome: FakeChrome): { target: { tabId: number }; args: unknown[]; world?: string } {
	return chrome.scripting.executeScript.mock.calls.at(-1)?.[0] as {
		target: { tabId: number };
		args: unknown[];
	};
}

describe("decideAiRoute（目标页面必须在授权列表里）", () => {
	it("没授权任何页面 → 指路去选项页", () => {
		const res = decideAiRoute([], undefined);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("授权");
	});

	it("唯一页面可以省略 target；多个页面必须显式指定", () => {
		expect(decideAiRoute([aiPage()], undefined)).toMatchObject({ ok: true, peer: TARGET });
		const many = decideAiRoute([aiPage(TARGET), aiPage("https://b.example")], undefined);
		expect(many.ok).toBe(false);
		if (!many.ok) expect(many.code).toBe("ambiguous");
		expect(decideAiRoute([aiPage(TARGET), aiPage("https://b.example")], "https://b.example")).toMatchObject({
			ok: true,
			peer: "https://b.example",
		});
	});

	it("指定了没授权的页面 → 拒绝并列出现有授权", () => {
		const res = decideAiRoute([aiPage()], "https://evil.example");
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("no-page");
			expect(res.message).toContain(TARGET);
		}
	});

	it("非法地址 → bad-origin", () => {
		expect(decideAiRoute([aiPage()], "file:///x")).toMatchObject({ ok: false, code: "bad-origin" });
	});
});

describe("roleOf（页面桥里的三个角色）", () => {
	const ctx = (over: Partial<{ pairs: BridgePair[]; aiPages: ReturnType<typeof aiPage>[] }> = {}) => ({
		pairs: over.pairs ?? [],
		aiPages: over.aiPages ?? [],
		settings: normalizeSettings(null),
	});

	it("pi-web-ui 页面是 host（即使它也在配对表里）", () => {
		expect(roleOf(HOST, ctx({ pairs: [pair(HOST, TARGET)] }))).toBe("host");
	});

	it("授权给 AI 的页面是 target", () => {
		expect(roleOf(TARGET, ctx({ aiPages: [aiPage()] }))).toBe("target");
	});

	it("配对过的普通页面是 peer；都不是就是 none（一个字节都不注入）", () => {
		expect(roleOf(TARGET, ctx({ pairs: [pair(TARGET, "https://b.example")] }))).toBe("peer");
		expect(roleOf("https://random.example", ctx({ pairs: [pair()] }))).toBe("none");
		expect(roleOf("chrome://extensions", ctx())).toBe("none");
	});
});

describe("handleBridgeCall 的 AI 分支（模型在操作页面）", () => {
	it("总开关关闭 → 一切页面动作都拒（这是总闸门）", async () => {
		fakeChrome({ aiPages: [aiPage()], settings: { aiControl: false } });
		const res = await handleBridgeCall({ op: "read" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("关闭");
	});

	it("不在白名单的动作 → 拒绝（页面里一段脚本不能指使扩展干别的）", async () => {
		fakeChrome({ aiPages: [aiPage()] });
		const res = await handleBridgeCall({ op: "internal:anything" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("不支持的动作");
		expect(BUILTIN_OPS).toContain("read");
		expect(isBuiltinOp("click")).toBe(true);
		expect(isBuiltinOp("rm -rf")).toBe(false);
	});

	it("eval 默认关：即使总开关开着也拒；设置里打开后才放行", async () => {
		fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		const denied = await handleBridgeCall({ op: "eval", args: { code: "1+1" } }, hostSender);
		expect(denied.ok).toBe(false);
		expect(denied.error).toContain("eval");

		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [{ id: 1, url: `${TARGET}/x` }],
			settings: { allowEval: true },
			peerResult: { ok: true, value: { value: 2 } },
		});
		const allowed = await handleBridgeCall({ op: "eval", args: { code: "1+1" } }, hostSender);
		expect(allowed).toEqual({ ok: true, value: { value: 2 } });
		expect(lastInjection(chrome).args[0]).toMatchObject({ op: "eval", builtin: true });
	});

	it("happy path：唯一授权页面开着 → 在**那个页面**上跑内置动作", async () => {
		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [
				{ id: 1, url: `${TARGET}/any/path` },
				{ id: 2, url: HOST },
			],
			peerResult: { ok: true, value: { text: "页面正文" } },
		});
		const res = await handleBridgeCall({ op: "read", args: { what: "text" } }, hostSender);
		expect(res).toEqual({ ok: true, value: { text: "页面正文" } });
		const injection = lastInjection(chrome);
		expect(injection.target).toEqual({ tabId: 1 });
		expect(injection.args[0]).toMatchObject({ op: "read", builtin: true, from: "http://127.0.0.1:8787" });
	});

	it("pages 动作由 worker 直接答（带标题与“开着没”），不去打扰页面", async () => {
		const chrome = fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		const res = await handleBridgeCall({ op: "pages" }, hostSender);
		expect(res).toEqual({ ok: true, value: { pages: [{ origin: TARGET, title: "开发站", open: true }] } });
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("status：报告扩展状态（开关、授权页、设置页地址）—— pi-web-ui 的入口靠它", async () => {
		const chrome = fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		const res = await handleBridgeCall({ op: "status" }, hostSender);
		const value = res.value as Record<string, unknown>;
		expect(res.ok).toBe(true);
		expect(value).toMatchObject({ installed: true, aiControl: true, allowEval: false });
		expect(value.pages).toEqual([{ origin: TARGET, title: "开发站", open: true }]);
		expect(String(value.optionsUrl)).toContain("options.html");
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});

	it("status 在总开关关着时也要能答（否则用户不知道去哪里打开）", async () => {
		fakeChrome({ aiPages: [], settings: { aiControl: false, allowEval: false } });
		const res = await handleBridgeCall({ op: "status" }, hostSender);
		expect(res.ok).toBe(true);
		expect(res.value).toMatchObject({ installed: true, aiControl: false, pages: [] });
	});

	it("目标页面没打开 → 明确说「先把它开在一个标签页里」", async () => {
		fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 2, url: HOST }] });
		const res = await handleBridgeCall({ op: "read" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("没打开");
	});

	it("目标页面没授权（哪怕开着）→ 拒绝（授权表才是凭据）", async () => {
		fakeChrome({ aiPages: [aiPage("https://other.example")], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		const res = await handleBridgeCall({ op: "read", to: TARGET }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("授权");
	});

	it("宿主页面的调用**不走配对表**：AI 授权表是它唯一的凭据", async () => {
		fakeChrome({ pairs: [pair(HOST, TARGET)], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		const res = await handleBridgeCall({ op: "read" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("授权");
	});

	it("普通页面的调用仍然走配对表：AI 授权表不参与", async () => {
		fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 2, url: `${TARGET}/x` }] });
		const res = await handleBridgeCall({ op: "read" }, { tab: { id: 2, url: `${TARGET}/x` } });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("配对");
	});
});

describe("shot（截图：切页 → 截 → 裁 → 切回）", () => {
	function fakeImageEnv(): void {
		const g = globalThis as unknown as Record<string, unknown>;
		g.createImageBitmap = async () => ({ width: 2400, height: 1600, close: () => {} });
		g.OffscreenCanvas = class {
			width: number;
			height: number;
			constructor(w: number, h: number) {
				this.width = w;
				this.height = h;
			}
			getContext(): { drawImage: () => void } {
				return { drawImage: () => {} };
			}
			async convertToBlob(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
				return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
			}
		};
	}
	afterEach(() => {
		const g = globalThis as unknown as Record<string, unknown>;
		delete g.createImageBitmap;
		delete g.OffscreenCanvas;
	});

	it("开关关着 → 拒绝并说清去哪开（截图是能关的）", async () => {
		fakeChrome({ aiPages: [aiPage()], settings: { allowShot: false } });
		const res = await handleBridgeCall({ op: "shot" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.code).toBe("shot-disabled");
		expect(res.error).toContain("截图");
	});

	it("默认路径：切到目标页 → 截 → **切回原来的活动页**", async () => {
		fakeImageEnv();
		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [
				{ id: 1, url: `${TARGET}/x`, windowId: 7 },
				{ id: 2, url: HOST, windowId: 7, active: true },
			],
			peerByOp: { metrics: { ok: true, value: { dpr: 2, vw: 1200, vh: 800 } } },
		});
		const res = await handleBridgeCall({ op: "shot" }, hostSender);
		expect(res.ok).toBe(true);
		const image = (res.value as { image: { dataUrl: string; mimeType: string } }).image;
		expect(image.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
		expect(image.mimeType).toBe("image/jpeg");
		const updates = chrome.tabs.update.mock.calls.map((c) => c as [number, { active: boolean }]);
		expect(updates).toEqual([
			[1, { active: true }],
			[2, { active: true }],
		]);
		expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "jpeg", quality: expect.any(Number) });
	});

	it("指定 selector：按元素的 rect 裁剪（rect 是 CSS 像素，截图是物理像素）", async () => {
		fakeImageEnv();
		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [{ id: 1, url: `${TARGET}/x`, windowId: 7, active: true }],
			peerByOp: {
				metrics: { ok: true, value: { dpr: 2, vw: 1200, vh: 800 } },
				read: { ok: true, value: { items: [{ rect: { x: 10, y: 20, w: 100, h: 50 } }] } },
			},
		});
		const res = await handleBridgeCall({ op: "shot", args: { selector: "#card" } }, hostSender);
		expect(res.ok).toBe(true);
		const image = (res.value as { image: { width: number; height: number } }).image;
		expect(image.width).toBeLessThanOrEqual(200);
		expect(chrome.tabs.update).not.toHaveBeenCalled();
	});

	it("selector 没匹上 → 失败（不静默给一张整屏图）", async () => {
		fakeImageEnv();
		fakeChrome({
			aiPages: [aiPage()],
			tabs: [{ id: 1, url: `${TARGET}/x`, active: true }],
			peerByOp: {
				metrics: { ok: true, value: { dpr: 1 } },
				read: { ok: true, value: { items: [] } },
			},
		});
		const res = await handleBridgeCall({ op: "shot", args: { selector: "#没有" } }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("没匹上");
	});

	it("截不到（无 activeTab / 页面不可截）→ 也要切回去", async () => {
		fakeImageEnv();
		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [
				{ id: 1, url: `${TARGET}/x`, windowId: 7 },
				{ id: 2, url: HOST, windowId: 7, active: true },
			],
			peerByOp: { metrics: { ok: true, value: { dpr: 1 } } },
		});
		chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error("Cannot access contents of the page"));
		const res = await handleBridgeCall({ op: "shot" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("截不到");
		const updates = chrome.tabs.update.mock.calls.map((c) => c as [number, { active: boolean }]);
		expect(updates.at(-1)).toEqual([2, { active: true }]);
	});

	it("没给截图权限（<all_urls>）→ 直接说清去哪授权，不去撞底层报错", async () => {
		fakeImageEnv();
		fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 1, url: `${TARGET}/x`, active: true }], shotPermission: false });
		const res = await handleBridgeCall({ op: "shot" }, hostSender);
		expect(res.ok).toBe(false);
		expect(res.code).toBe("shot-permission");
		expect(res.error).toContain("权限");
	});

	it("status 报出截图开关与权限状态（pi-web-ui 面板能显示）", async () => {
		fakeChrome({ aiPages: [aiPage()], settings: { allowShot: false } });
		const res = await handleBridgeCall({ op: "status" }, hostSender);
		expect(res.value).toMatchObject({ allowShot: false, shotPermission: true });
	});
});

describe("syncBridges 的 AI 角色", () => {
	it("授权页面装的是**带内置动作**的桥（control: true）", async () => {
		const chrome = fakeChrome({ aiPages: [aiPage()], tabs: [{ id: 1, url: `${TARGET}/x` }] });
		expect(await syncBridges()).toBe(1);
		const main = chrome.scripting.executeScript.mock.calls
			.map(([injection]) => injection as { world?: string; args?: unknown[] })
			.find((injection) => injection.world === "MAIN");
		expect(main?.args?.[0]).toMatchObject({ control: true, self: TARGET });
	});

	it("宿主页面也装上桥（模型的动作从这里发起），peers = 已授权页面", async () => {
		const chrome = fakeChrome({
			aiPages: [aiPage()],
			tabs: [
				{ id: 1, url: `${TARGET}/x` },
				{ id: 2, url: HOST },
			],
		});
		expect(await syncBridges()).toBe(2);
		const mainArgs = chrome.scripting.executeScript.mock.calls
			.map(([injection]) => injection as { world?: string; args?: unknown[] })
			.filter((injection) => injection.world === "MAIN")
			.map((injection) => injection.args?.[0] as { self?: string; peers?: string[]; control?: boolean });
		const host = mainArgs.find((args) => args.self === "http://127.0.0.1:8787");
		expect(host).toMatchObject({ peers: [TARGET], control: false });
	});
});
