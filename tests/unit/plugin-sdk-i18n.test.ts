import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginI18n } from "../../plugin-sdk/client-utils.mjs";

/**
 * `createPluginI18n` 守卫（issues/939）。
 *
 * 事故形态：插件界面语言自己抄一遍 host.locale 读取，抄漏一处就变成「切语言后不重画」；
 * 更糟的是插件比宿主新时整页 SyntaxError。这里锁住三件事：语言归一（zh-* → zh、其余 → en）、
 * 缺词回落、宿主切语言的订阅与解除。
 */

type Listener = (event: { detail?: string }) => void;

/** 最小 window 桩：只需要 `localStorage` 与 locale 事件（插件视图在宿主同页）。 */
function stubWindow(bridge?: unknown) {
	const listeners = new Set<Listener>();
	const win = {
		addEventListener: (type: string, fn: Listener) => {
			if (type === "pi-web-ui:locale") listeners.add(fn);
		},
		removeEventListener: (type: string, fn: Listener) => {
			if (type === "pi-web-ui:locale") listeners.delete(fn);
		},
		dispatchLocale: (detail: string) => {
			for (const fn of [...listeners]) fn({ detail });
		},
		listenerCount: () => listeners.size,
		__piWebUiHost: bridge,
	};
	(globalThis as any).window = win;
	return win;
}

function bridgeWith(locale: string) {
	const handlers = new Set<(locale: string) => void>();
	return {
		locale: {
			current: () => locale,
			onChange: (fn: (locale: string) => void) => {
				handlers.add(fn);
				return () => handlers.delete(fn);
			},
		},
		emit: (next: string) => {
			locale = next;
			for (const fn of [...handlers]) fn(next);
		},
		count: () => handlers.size,
	};
}

afterEach(() => {
	delete (globalThis as any).window;
});

describe("createPluginI18n", () => {
	it("跟着宿主 locale 选词：zh-* 一律取 zh，其余语言回落 en", () => {
		const bridge = bridgeWith("zh-CN");
		stubWindow(bridge);
		const i18n = createPluginI18n({ zh: { title: "笔记" }, en: { title: "Notes" } });
		expect(i18n.t("title")).toBe("笔记");
		expect(i18n.lang).toBe("zh");
		expect(i18n.locale).toBe("zh-CN");

		bridge.emit("zh-TW");
		expect(i18n.t("title")).toBe("笔记");

		bridge.emit("ja-JP");
		expect(i18n.t("title")).toBe("Notes");
		expect(i18n.lang).toBe("en");
	});

	it("也认 locale tag 形式的键名", () => {
		stubWindow(bridgeWith("en-US"));
		const i18n = createPluginI18n({ "zh-CN": { title: "笔记" }, "en-US": { title: "Notes" } });
		expect(i18n.t("title")).toBe("Notes");
	});

	it("缺词先回落另一种语言，再回落 key 本身", () => {
		stubWindow(bridgeWith("en-US"));
		const i18n = createPluginI18n({ zh: { onlyZh: "只有中文", shared: "共用" }, en: { shared: "shared" } });
		expect(i18n.t("shared")).toBe("shared");
		expect(i18n.t("onlyZh")).toBe("只有中文");
		expect(i18n.t("neverDefined")).toBe("neverDefined");
	});

	it("插值支持 {x} / {{x}} / ${x}，未提供的占位符原样保留", () => {
		stubWindow(bridgeWith("en-US"));
		const i18n = createPluginI18n({
			en: { a: "{count} left", b: "{{count}} left", c: "${count} left", d: "{count} of {total}" },
		});
		expect(i18n.t("a", { count: 3 })).toBe("3 left");
		expect(i18n.t("b", { count: 3 })).toBe("3 left");
		expect(i18n.t("c", { count: 3 })).toBe("3 left");
		expect(i18n.t("d", { count: 1 })).toBe("1 of {total}");
	});

	it("宿主切语言时通知订阅者，destroy 后不再通知、也不留监听", () => {
		const bridge = bridgeWith("zh-CN");
		const win = stubWindow(bridge);
		const i18n = createPluginI18n({ zh: { title: "笔记" }, en: { title: "Notes" } });
		const seen = vi.fn();
		const off = i18n.onChange(seen);
		expect(bridge.count()).toBe(1);

		bridge.emit("en-US");
		expect(seen).toHaveBeenCalledWith("en-US", "en");
		expect(i18n.t("title")).toBe("Notes");

		off();
		bridge.emit("zh-CN");
		expect(seen).toHaveBeenCalledTimes(1);

		// 视图卸载：解除宿主订阅与 window 监听，别留在页面上。
		i18n.onChange(seen);
		i18n.destroy();
		expect(bridge.count()).toBe(0);
		expect(win.listenerCount()).toBe(0);
	});

	it("宿主桥缺失时退浏览器语言；同页 locale 事件也算", () => {
		const win = stubWindow(undefined);
		Object.defineProperty(globalThis, "navigator", {
			value: { languages: ["zh-Hant"], language: "zh-Hant" },
			configurable: true,
		});
		try {
			const i18n = createPluginI18n({ zh: { title: "笔记" }, en: { title: "Notes" } });
			expect(i18n.t("title")).toBe("笔记");
			const seen = vi.fn();
			i18n.onChange(seen);
			win.dispatchLocale("en-GB");
			expect(seen).toHaveBeenCalledWith("en-GB", "en");
			expect(i18n.t("title")).toBe("Notes");
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
		}
	});

	it("兼容位置参数写法 createPluginI18n(zhDict, enDict)", () => {
		stubWindow(bridgeWith("en-US"));
		const i18n = createPluginI18n({ title: "笔记" }, { title: "Notes" });
		expect(i18n.t("title")).toBe("Notes");
	});

	it("认不出形状就报错，不静默变成空白界面", () => {
		stubWindow(bridgeWith("en-US"));
		// 类型系统已经挡住错误用法；这里锁的是 JS 调用方（插件不经过 tsc）的运行时行为。
		expect(() => createPluginI18n("nope" as any)).toThrow(/createPluginI18n/);
		expect(() => createPluginI18n({} as any)).toThrow(/createPluginI18n/);
	});
});
