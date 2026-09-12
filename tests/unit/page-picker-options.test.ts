// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 设置页的 `?bind=` 面板（从 pi-web-ui 页面上的浮条跳过来的那一步）。
 *
 * 为什么这条路径不能省：`chrome.permissions.request` 必须在**用户手势**里发出，而浮条的
 * 按钮点在网页上（content script 的 UI），浏览器不认 —— 于是「授权 + 绑定」只能落到这个
 * 页面上。它挂了，远程部署的用户就永远绑不上，所以按真 DOM（options.html 本体）+ 假 chrome
 * 钉住：预填地址 / 文案随授权状态变 / 点一下真的把 serverUrl 写进存储。
 */

// jsdom 环境下 import.meta.url 不是 file: 协议（vitest 会换掉）—— 用仓库根拼路径（vitest 的 cwd 就是仓库根）
const OPTIONS_HTML = readFileSync(join(process.cwd(), "plugins", "page-picker", "extension", "options.html"), "utf8");

interface FakeChrome {
	storage: {
		sync: { get: () => Promise<Record<string, unknown>>; set: (v: Record<string, unknown>) => Promise<void> };
	};
	permissions: { contains: () => Promise<boolean>; request: () => Promise<boolean> };
}

let stored: Record<string, unknown> = {};
let granted = true;

function fakeChrome(): FakeChrome {
	const chrome = {
		storage: {
			sync: {
				get: async () => ({ ...stored }),
				set: async (patch: Record<string, unknown>) => {
					Object.assign(stored, patch);
				},
			},
		},
		permissions: {
			contains: async () => granted,
			// 「用户点了授权」：这次请求成功（真浏览器里就是权限对话框被确认）
			request: async () => {
				granted = true;
				return true;
			},
		},
	};
	(globalThis as Record<string, unknown>).chrome = chrome;
	return chrome;
}

/** 把 options.html 的 <main> 搬进 jsdom（脚本标签不执行：我们 import 的是源码模块）。 */
function mountOptionsPage(search: string): void {
	const main = /<main>([\s\S]*?)<\/main>/.exec(OPTIONS_HTML)?.[1] ?? "";
	document.body.innerHTML = main.replace(/<script[\s\S]*?<\/script>/g, "");
	globalThis.history.replaceState({}, "", `/options.html${search}`);
}

/** 等设置页的异步启动流程（load → refreshGrant → initBindPanel）跑完。 */
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
	fakeChrome();
});

describe("options 页的「发送什么」（多选 + 预设）", () => {
	/** 勾/取消勾某一项（真 DOM 里的 checkbox）。 */
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
		expect(stored.detail).toBe("compact"); // 预设同时决定采集深度
	});

	it("全部取消 → 提示并回落标准组合（不静默变成「什么都不发」）", async () => {
		mountOptionsPage("");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		for (const key of checked()) toggle(key, false);
		await settle();

		expect(text("status")).toContain("至少要勾一项");
		expect(JSON.stringify(stored.sections)).toContain("selector"); // 回落成标准组合
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
		mountOptionsPage("?bind=http%3A%2F%2F39.99.235.208%3A8787");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect((document.getElementById("serverUrl") as HTMLInputElement).value).toBe("http://39.99.235.208:8787");
		expect(hidden("bindPanel")).toBe(false);
		expect(text("bindTitle")).toContain("http://39.99.235.208:8787");
		expect(text("bindAccept")).toBe("设为服务地址");
		expect(text("bindBody")).toContain("已授权");
	});

	it("没授权 → 按钮改成「授权并绑定」，文案点名要授权的 origin 模式", async () => {
		granted = false;
		mountOptionsPage("?bind=http%3A%2F%2F39.99.235.208%3A8787");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(text("bindAccept")).toBe("授权并绑定");
		expect(text("bindBody")).toContain("http://39.99.235.208:8787/*");
	});

	it("点「授权并绑定」→ 授权 + **真的写进存储**（这是用户唯一的目标）", async () => {
		granted = false;
		mountOptionsPage("?bind=https%3A%2F%2Fpi.example.com%2Fpi%2F");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		(document.getElementById("bindAccept") as HTMLButtonElement).click();
		await settle();

		expect(stored.serverUrl).toBe("https://pi.example.com/pi"); // 归一过（去尾斜杠）
		expect(text("status")).toContain("已绑定");
		expect(hidden("bindPanel")).toBe(true); // 绑完就收起，不让用户以为还没完成
	});

	it("已经就是这个地址 → 不显示绑定按钮（没有可绑的东西）", async () => {
		stored.serverUrl = "http://39.99.235.208:8787";
		mountOptionsPage("?bind=http%3A%2F%2F39.99.235.208%3A8787%2F");
		fakeChrome();
		await import("../../plugins/page-picker/extension/src/options.js");
		await settle();

		expect(text("bindTitle")).toContain("已经是当前服务地址");
		expect(hidden("bindAccept")).toBe(true);
	});
});
