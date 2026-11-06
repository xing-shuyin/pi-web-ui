// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeI18n } from "./fake-i18n.js";

const OPTIONS_HTML = readFileSync(join(process.cwd(), "plugins", "page-picker", "extension", "options.html"), "utf8");

interface FakeChrome {
	storage: {
		sync: { get: () => Promise<Record<string, unknown>>; set: (v: Record<string, unknown>) => Promise<void> };
		local: {
			get: (keys: string[] | null) => Promise<Record<string, unknown>>;
			set: (v: Record<string, unknown>) => Promise<void>;
		};
	};
	permissions: { contains: () => Promise<boolean>; request: () => Promise<boolean> };
	tabs: { query: () => Promise<{ id: number; url?: string }[]> };
	runtime: { sendMessage: (message: unknown) => Promise<unknown> };
	i18n: ReturnType<typeof createFakeI18n>;
}

let stored: Record<string, unknown> = {};
let granted = true;
let pairNotices: { removedOrigins?: string[] }[] = [];
let openTabs: { id: number; url?: string }[] = [];

function fakeChrome(): FakeChrome {
	const chrome = {
		storage: {
			sync: {
				get: async () => ({ ...stored }),
				set: async (patch: Record<string, unknown>) => {
					Object.assign(stored, patch);
				},
			},
			local: {
				get: async (keys: string[] | null) => {
					const out: Record<string, unknown> = {};
					for (const key of keys ?? Object.keys(stored)) if (key in stored) out[key] = stored[key];
					return out;
				},
				set: async (patch: Record<string, unknown>) => {
					Object.assign(stored, patch);
				},
			},
		},
		permissions: {
			contains: async () => granted,
			request: async () => {
				granted = true;
				return true;
			},
		},
		tabs: { query: async () => openTabs },
		runtime: {
			sendMessage: async (message: unknown) => {
				const msg = message as { type?: string; removedOrigins?: unknown };
				if (msg?.type === "page-picker:bridges-changed" || msg?.type === "page-picker:pairs-changed") {
					pairNotices.push({
						removedOrigins: Array.isArray(msg.removedOrigins) ? (msg.removedOrigins as string[]) : [],
					});
				}
				return { ok: true, installed: 0, uninstalled: 0 };
			},
		},
		i18n: createFakeI18n(),
	};
	(globalThis as Record<string, unknown>).chrome = chrome;
	return chrome;
}

function mountOptionsPage(search: string): void {
	const main = /<main>([\s\S]*?)<\/main>/.exec(OPTIONS_HTML)?.[1] ?? "";
	document.body.innerHTML = main.replace(/<script[\s\S]*?<\/script>/g, "");
	globalThis.history.replaceState({}, "", `/options.html${search}`);
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const text = (id: string): string => document.getElementById(id)?.textContent ?? "";
const hidden = (id: string): boolean => document.getElementById(id)?.classList.contains("hidden") ?? false;

beforeEach(() => {
	vi.resetModules();
	stored = {
		serverUrl: "http://127.0.0.1:8787",
		token: "",
		detail: "standard",
		copyToClipboard: true,
		screenshots: true,
		focusTarget: false,
	};
	granted = true;
	pairNotices = [];
	openTabs = [];
	fakeChrome();
});

describe("options 页的「发送什么」（多选 + 预设）", () => {
	const toggle = (key: string, on: boolean): void => {
		const box = document.getElementById(`sec-${key}`) as HTMLInputElement;
		box.checked = on;
		box.dispatchEvent(new Event("change"));
	};
	const checked = (): string[] =>
		["page", "selector", "locator", "source", "text", "rules", "styles", "skeleton"].filter(
			(k) => (document.getElementById(`sec-${k}`) as HTMLInputElement).checked,
		);

	it("七项开关 + 预设下拉都渲染出来，默认勾的是标准组合", async () => {
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(document.querySelectorAll("#sectionList input[type=checkbox]").length).toBe(8);
		expect(checked()).toEqual(["page", "selector", "source", "text", "rules", "styles", "skeleton"]);
		expect((document.getElementById("preset") as HTMLSelectElement).value).toBe("standard");
		expect(text("sectionSummary")).toContain("预设：标准");
	});

	it("取消勾选真的落盘（sections 不再包含它）—— 这是「信息太多」的解药", async () => {
		stored.sections = ["page", "selector", "source", "text", "rules", "styles", "skeleton"];
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		toggle("skeleton", false);
		toggle("styles", false);
		await settle();

		expect(stored.sections).toEqual(["page", "selector", "source", "text", "rules"]);
		expect((document.getElementById("preset") as HTMLSelectElement).value).toBe("custom");
		expect(text("sectionSummary")).toContain("自定义");
	});

	it("点预设 → 勾选项跟着变（且写成那个预设的组合）", async () => {
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		const preset = document.getElementById("preset") as HTMLSelectElement;
		const lean = Array.from(preset.options).find((o) => o.textContent?.startsWith("精简"));
		preset.value = lean?.value ?? "lean";
		preset.dispatchEvent(new Event("change"));
		await settle();

		expect(checked()).toEqual(["page", "selector", "source", "text"]);
		expect(stored.sections).toEqual(["page", "selector", "source", "text"]);
		expect(stored.detail).toBe("compact");
	});

	it("全部取消 → 提示并回落标准组合（不静默变成「什么都不发」）", async () => {
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		for (const key of checked()) toggle(key, false);
		await settle();

		expect(text("status")).toContain("至少要勾一项");
		expect(JSON.stringify(stored.sections)).toContain("selector");
	});

	it("老设置里只有 detail → 按档位预勾（升级后行为不变）", async () => {
		stored = { serverUrl: "http://127.0.0.1:8787", detail: "full" };
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(checked()).toEqual(["page", "selector", "locator", "source", "text", "rules", "styles", "skeleton"]);
		expect((document.getElementById("preset") as HTMLSelectElement).value).toBe("full");
	});
});

describe("options 页的 ?bind= 面板", () => {
	it("没有 ?bind= → 面板不出现（平常看设置页不该多一块东西）", async () => {
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();
		expect(hidden("bindPanel")).toBe(true);
	});

	it("?bind= 远程地址 → 预填地址 + 文案说清「会绑成什么」，已授权时按钮是「设为服务地址」", async () => {
		mountOptionsPage("?bind=http%3A%2F%2F203.0.113.10%3A8787");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect((document.getElementById("serverUrl") as HTMLInputElement).value).toBe("http://203.0.113.10:8787");
		expect(hidden("bindPanel")).toBe(false);
		expect(text("bindTitle")).toContain("http://203.0.113.10:8787");
		expect(text("bindAccept")).toBe("设为服务地址");
		expect(text("bindBody")).toContain("已授权");
	});

	it("没授权 → 按钮改成「授权并绑定」，文案点名要授权的 origin 模式", async () => {
		granted = false;
		mountOptionsPage("?bind=http%3A%2F%2F203.0.113.10%3A8787");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(text("bindAccept")).toBe("授权并绑定");
		expect(text("bindBody")).toContain("http://203.0.113.10:8787/*");
	});

	it("点「授权并绑定」→ 授权 + **真的写进存储**（这是用户唯一的目标）", async () => {
		granted = false;
		mountOptionsPage("?bind=https%3A%2F%2Fpi.example.com%2Fpi%2F");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		(document.getElementById("bindAccept") as HTMLButtonElement).click();
		await settle();

		expect(stored.serverUrl).toBe("https://pi.example.com/pi");
		expect(text("status")).toContain("已绑定");
		expect(hidden("bindPanel")).toBe(true);
	});

	it("已经就是这个地址 → 不显示绑定按钮（没有可绑的东西）", async () => {
		stored.serverUrl = "http://203.0.113.10:8787";
		mountOptionsPage("?bind=http%3A%2F%2F203.0.113.10%3A8787%2F");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(text("bindTitle")).toContain("已经是当前服务地址");
		expect(hidden("bindAccept")).toBe(true);
	});
});

async function bootOptions(search = ""): Promise<void> {
	mountOptionsPage(search);
	fakeChrome();
	await import("../../plugins/page-picker/extension/src/options.js");
	await settle();
}

async function clickOptions(id: string): Promise<void> {
	document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	await settle();
}

describe("options 页的「页面桥」配对管理", () => {
	const A = "https://a.example";
	const B = "https://b.example";

	const boot = bootOptions;
	const click = clickOptions;
	const fill = (a: string, b: string, note = ""): void => {
		(document.getElementById("pairA") as HTMLInputElement).value = a;
		(document.getElementById("pairB") as HTMLInputElement).value = b;
		(document.getElementById("pairNote") as HTMLInputElement).value = note;
	};
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("#pairList .pair"));

	it("默认是空列表 + 明说「桥默认关闭」（功能存在但不开，用户得先知道这点）", async () => {
		await boot();
		expect(cards()).toHaveLength(0);
		expect(text("pairList")).toContain("桥默认关闭");
	});

	it("加一对：申请两端权限 → 落盘（归一排序）→ 告诉 worker 重新协调", async () => {
		await boot();
		fill("https://b.example", "https://a.example/path", "订单页 ↔ 工具页");
		await click("pairAdd");

		const saved = stored.bridgePairs as { a: string; b: string; note?: string; enabled: boolean }[];
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ a: A, b: B, note: "订单页 ↔ 工具页", enabled: true });
		expect(pairNotices).toHaveLength(1);
		expect(text("pairStatus")).toContain("已配对");
		expect(cards()).toHaveLength(1);
		expect(text("pairList")).toContain(`${A} ↔ ${B}`);
	});

	it("地址不合法 → 报错且**不落盘**（宁可不加，也不能存一条永远调不通的配对）", async () => {
		await boot();
		fill("file:///E:/x.html", B);
		await click("pairAdd");

		expect(stored.bridgePairs).toBeUndefined();
		expect(text("pairStatus")).toContain("http");
	});

	it("不给授权 → 不落盘，并说清是哪一步缺了", async () => {
		granted = false;
		await boot();
		(globalThis as Record<string, unknown>).chrome = {
			...((globalThis as Record<string, unknown>).chrome as object),
			permissions: { contains: async () => false, request: async () => false },
		};
		fill(A, B);
		await click("pairAdd");

		expect(stored.bridgePairs).toBeUndefined();
		expect(text("pairStatus")).toContain("没授权");
	});

	it("删一对 → 通知 worker 把那一对页面上的桥卸下", async () => {
		stored.bridgePairs = [{ a: A, b: B, enabled: true, createdAt: "t" }];
		await boot();
		expect(cards()).toHaveLength(1);

		const drop = cards()[0].querySelector("button");
		drop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await settle();

		expect(stored.bridgePairs).toEqual([]);
		expect(pairNotices.at(-1)?.removedOrigins).toEqual([A, B]);
		expect(cards()).toHaveLength(0);
	});

	it("停用一对 → enabled=false 且同样通知卸桥（停用不该只是 UI 上变灰）", async () => {
		stored.bridgePairs = [{ a: A, b: B, enabled: true, createdAt: "t" }];
		await boot();

		const box = cards()[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
		box.checked = false;
		box.dispatchEvent(new Event("change"));
		await settle();

		expect((stored.bridgePairs as { enabled: boolean }[])[0].enabled).toBe(false);
		expect(pairNotices.at(-1)?.removedOrigins).toEqual([A, B]);
		expect(text("pairStatus")).toContain("已停用");
	});

	it("候选下拉来自「最近点过扩展图标的页面」（带标题）—— 地址不用手打", async () => {
		stored.recentOrigins = [
			{ origin: "http://localhost:5173", title: "我的开发站", at: "2026-01-02T00:00:00.000Z" },
			{ origin: "https://tools.example", title: "工具页", at: "2026-01-01T00:00:00.000Z" },
		];
		await boot();

		const opts = Array.from(document.querySelectorAll<HTMLOptionElement>("#piOrigins option"));
		expect(opts.map((o) => o.value)).toEqual(["http://localhost:5173", "https://tools.example"]);
		expect(opts[0].label).toBe("我的开发站");
	});

	it("已经配过的 origin 也在候选里（它们不一定在「最近点过」列表里）", async () => {
		stored.bridgePairs = [{ a: A, b: B, enabled: true, createdAt: "t" }];
		await boot();

		const values = Array.from(document.querySelectorAll<HTMLOptionElement>("#piOrigins option")).map((o) => o.value);
		expect(values).toContain(A);
		expect(values).toContain(B);
	});

	it("从拾取浮条跳过来（?pair=）：预填本端 + 焦点放到另一端（少掉手打两个地址）", async () => {
		await boot(`?pair=${encodeURIComponent("http://localhost:5173/app/")}`);

		expect((document.getElementById("pairA") as HTMLInputElement).value).toBe("http://localhost:5173");
		expect(document.activeElement?.id).toBe("pairB");
		expect(text("pairStatus")).toContain("已填入本页");
	});
});

describe("options 页的「AI 操作页面」（授权管理）", () => {
	const DEVELOP = "http://localhost:5173";
	const boot = bootOptions;
	const click = clickOptions;
	const aiCards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("#aiList .pair"));

	it("默认没有任何授权页面（模型没得操作），并说明怎么加", async () => {
		await boot();
		expect(aiCards()).toHaveLength(0);
		expect(text("aiList")).toContain("还没有授权");
	});

	it("授权一个页面：申请 host 权限 → 落盘 aiPages（带标题）→ 通知 worker 重装桥", async () => {
		stored.recentOrigins = [{ origin: DEVELOP, title: "我的开发站", at: "2026-01-02T00:00:00.000Z" }];
		await boot();

		(document.getElementById("aiPageInput") as HTMLInputElement).value = `${DEVELOP}/app/`;
		await click("aiGrant");

		expect(stored.aiPages).toEqual([{ origin: DEVELOP, title: "我的开发站", at: expect.any(String) }]);
		expect(pairNotices).toHaveLength(1);
		expect(text("aiStatus")).toContain("已授权");
		expect(aiCards()).toHaveLength(1);
		expect(text("aiList")).toContain("我的开发站");
	});

	it("没给 host 权限 → 不落盘，并说清缺的是授权", async () => {
		await boot();
		(globalThis as Record<string, unknown>).chrome = {
			...((globalThis as Record<string, unknown>).chrome as object),
			permissions: { contains: async () => false, request: async () => false },
		};
		(document.getElementById("aiPageInput") as HTMLInputElement).value = DEVELOP;
		await click("aiGrant");

		expect(stored.aiPages).toBeUndefined();
		expect(text("aiStatus")).toContain("没授权");
	});

	it("地址不合法 → 报错且不落盘", async () => {
		await boot();
		(document.getElementById("aiPageInput") as HTMLInputElement).value = "file:///E:/x.html";
		await click("aiGrant");
		expect(stored.aiPages).toBeUndefined();
		expect(text("aiStatus")).toContain("http");
	});

	it("收回授权 → 从列表里移除 + 通知 worker 把那一页的控制桥卸掉", async () => {
		stored.aiPages = [{ origin: DEVELOP, title: "开发站", at: "2026-01-01T00:00:00.000Z" }];
		await boot();
		expect(aiCards()).toHaveLength(1);

		aiCards()[0]
			.querySelector("button")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await settle();

		expect(stored.aiPages).toEqual([]);
		expect(pairNotices.at(-1)?.removedOrigins).toEqual([DEVELOP]);
		expect(aiCards()).toHaveLength(0);
	});

	it("总开关与 eval 开关真的落盘（模型能不能动手就看这两个）", async () => {
		await boot();
		expect((document.getElementById("aiControl") as HTMLInputElement).checked).toBe(true);
		expect((document.getElementById("allowEval") as HTMLInputElement).checked).toBe(false);

		const control = document.getElementById("aiControl") as HTMLInputElement;
		control.checked = false;
		control.dispatchEvent(new Event("change"));
		await settle();
		expect(stored.aiControl).toBe(false);

		const evalBox = document.getElementById("allowEval") as HTMLInputElement;
		evalBox.checked = true;
		evalBox.dispatchEvent(new Event("change"));
		await settle();
		expect(stored.allowEval).toBe(true);
	});

	it("从拾取浮条跳过来（?grant=）：预填本页 + 焦点在授权按钮", async () => {
		await boot(`?grant=${encodeURIComponent(`${DEVELOP}/deep/link`)}`);

		expect((document.getElementById("aiPageInput") as HTMLInputElement).value).toBe(DEVELOP);
		expect(document.activeElement?.id).toBe("aiGrant");
		expect(text("aiStatus")).toContain("已填入");
	});
});
