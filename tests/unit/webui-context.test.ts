import { describe, expect, it } from "vitest";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { mockThemeProxy, WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

function wrapLikeSdk(ui: WebUIContext) {
	return {
		...ui,
		select: ui.select,
	};
}

describe("WebUIContext SDK wrap", () => {
	it("setStatus and notify remain functions after object spread", () => {
		const ui = new WebUIContext(() => {});
		const wrapped = wrapLikeSdk(ui);
		expect(typeof wrapped.setStatus).toBe("function");
		expect(typeof wrapped.notify).toBe("function");
	});

	it("keeps ctx.ui.theme defined through the SDK spread", () => {
		const wrapped = wrapLikeSdk(new WebUIContext(() => {}));
		expect(typeof wrapped.theme).toBe("object");
		expect(typeof (wrapped.theme as { fg?: unknown }).fg).toBe("function");
	});

	it("spread copy keeps a live theme accessor, not a frozen value", () => {
		const ui = new WebUIContext(() => {});
		const source = Object.getOwnPropertyDescriptor(ui, "theme");
		expect(typeof source?.get).toBe("function");
		expect(source?.enumerable).toBe(true);
		const wrapped = wrapLikeSdk(ui);
		expect(wrapped.theme).toBe(
			(globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")],
		);
	});

	it("every extension-facing member survives the spread", () => {
		const wrapped = wrapLikeSdk(new WebUIContext(() => {})) as Record<string, unknown>;
		const members = [
			"select",
			"confirm",
			"input",
			"custom",
			"notify",
			"onTerminalInput",
			"setStatus",
			"setWorkingMessage",
			"setWorkingVisible",
			"setWorkingIndicator",
			"setHiddenThinkingLabel",
			"setWidget",
			"setFooter",
			"setHeader",
			"setTitle",
			"pasteToEditor",
			"setEditorText",
			"getEditorText",
			"editor",
			"addAutocompleteProvider",
			"setEditorComponent",
			"getEditorComponent",
			"getAllThemes",
			"getTheme",
			"setTheme",
			"getToolsExpanded",
			"setToolsExpanded",
		];
		for (const member of members) expect([member, typeof wrapped[member]]).not.toEqual([member, "undefined"]);
		expect(wrapped.theme).toBeDefined();
	});

	it("survives the real SDK wrapper, not just the shape we mimic", () => {
		const proto = ExtensionRunner.prototype as unknown as {
			wrapUIPromptContext?: (ui: unknown) => unknown;
		};
		const wrap = proto.wrapUIPromptContext;
		if (typeof wrap !== "function") return;
		const wrapped = wrap.call(
			{ withUIPrompt: (_k: string, _t: unknown, run: () => unknown) => run() },
			new WebUIContext(() => {}),
		) as {
			theme?: { fg?: unknown };
		};
		expect(typeof wrapped.theme).toBe("object");
		expect(typeof wrapped.theme?.fg).toBe("function");
	});

	it("spread copy still emits statuses and notice", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));
		const wrapped = wrapLikeSdk(ui);

		wrapped.setStatus("0-claude-max", "🧠 5h 19%");
		wrapped.notify("hello", "info");

		expect(msgs).toContainEqual({
			type: "statuses",
			statuses: [{ key: "0-claude-max", text: "🧠 5h 19%" }],
		});
		expect(msgs).toContainEqual({
			type: "notice",
			level: "info",
			text: "hello",
		});
	});
});

describe("WebUIContext.headless (subagent sessions)", () => {
	it("cancels dialogs right away instead of waiting for a browser", async () => {
		const ui = WebUIContext.headless();
		await expect(ui.select("pick", ["a"])).resolves.toBeNull();
		await expect(ui.confirm("sure?", "m")).resolves.toBeNull();
		await expect(ui.input("name")).resolves.toBeNull();
	});

	it("drops every UI message (no cross-talk with the main conversation)", () => {
		const attached: ServerMessage[] = [];
		const live = new WebUIContext((msg) => attached.push(msg));
		const ui = WebUIContext.headless();
		for (const ctx of [live, ui]) {
			ctx.setStatus("probe", "on");
			ctx.notify("hello", "info");
			ctx.setWidget("probe", ["line"]);
		}
		expect(attached.length).toBeGreaterThan(0);
		expect(live.snapshot()).not.toEqual([]);
		expect(ui.snapshot()).toEqual([]);
	});

	it("never builds widget components (nothing would ever dispose them)", () => {
		const ui = WebUIContext.headless();
		let built = 0;
		const factory = (() => {
			built++;
			return { render: () => ["probe"] };
		}) as unknown as Parameters<WebUIContext["setWidget"]>[1];
		ui.setWidget("probe", factory);
		expect(built).toBe(0);
		expect(ui.snapshot()).toEqual([]);
	});
});

describe("WebUIContext.hasWidgets (conditional 2s poll)", () => {
	it("is false when empty, true after mount, false after unmount/dispose", () => {
		const ui = new WebUIContext(() => {});
		expect(ui.hasWidgets()).toBe(false);
		ui.setWidget("a", ["line"]);
		expect(ui.hasWidgets()).toBe(true);
		ui.setWidget("a", undefined);
		expect(ui.hasWidgets()).toBe(false);
		ui.setDynamicWidget("b", () => ["line"]);
		expect(ui.hasWidgets()).toBe(true);
		ui.dispose();
		expect(ui.hasWidgets()).toBe(false);
	});

	it("refresh with no widgets emits nothing", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));
		msgs.length = 0;
		ui.refresh();
		expect(msgs).toEqual([]);
	});
});

describe("mockThemeProxy (TUI theme shim used in the browser)", () => {
	const theme = mockThemeProxy as unknown as Record<string, (...args: unknown[]) => string>;

	it("keeps text through every single-arg decorator", () => {
		for (const name of ["bold", "italic", "underline", "inverse", "strikethrough"]) {
			expect(theme[name]("正文")).toBe("正文");
		}
	});

	it("keeps text through the two-arg color helpers", () => {
		expect(theme.fg("accent", "正文")).toBe("正文");
		expect(theme.bg("panel", "正文")).toBe("正文");
	});

	it("unknown theme methods still fall back to the last string argument", () => {
		expect(theme.someFutureDecorator("正文")).toBe("正文");
		expect(theme.someFutureDecorator("accent", "正文")).toBe("正文");
	});
});

describe("mockThemeProxy 返回装饰函数的方法（0.103 审计，#592 同类遗漏）", () => {
	const theme = mockThemeProxy as unknown as Record<string, (...args: unknown[]) => unknown>;

	it("getThinkingBorderColor / getBashModeBorderColor 返回函数而非字符串", () => {
		const border = (theme.getThinkingBorderColor as (level: string) => (s: string) => string)("medium");
		expect(typeof border).toBe("function");
		expect(border("正文")).toBe("正文");
		const bashBorder = (theme.getBashModeBorderColor as () => (s: string) => string)();
		expect(typeof bashBorder).toBe("function");
		expect(bashBorder("命令")).toBe("命令");
	});
});

describe("跨会话 widget / status 隔离（issue #952：切对话后还挂着上一个会话的清单）", () => {
	function harness() {
		let active = "conv-a";
		const alive = new Set(["conv-a", "conv-b"]);
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg), {
			activeConversationId: () => active,
			isConversationAlive: (id) => alive.has(id),
		});
		const lastWidgets = () => {
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.type === "widgets") return m.widgets;
			}
			return undefined;
		};
		const lastStatuses = () => {
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.type === "statuses") return m.statuses;
			}
			return undefined;
		};
		return {
			ui,
			msgs,
			lastWidgets,
			lastStatuses,
			switchTo: (id: string) => {
				active = id;
				ui.refresh();
			},
			close: (id: string) => alive.delete(id),
		};
	}

	it("会话 A 的 widget 不进会话 B 的快照，切回来又在", () => {
		const h = harness();
		h.ui.forConversation("conv-a").setWidget("todos", ["○ 写代码"]);
		expect(h.lastWidgets()).toEqual([{ key: "todos", lines: ["○ 写代码"] }]);

		h.switchTo("conv-b");
		// 关键：切到没有任何 widget 的会话也必须推一次空数组，否则前端保留上一份
		expect(h.lastWidgets()).toEqual([]);
		expect(h.ui.snapshot()).toEqual([]);

		h.switchTo("conv-a");
		expect(h.lastWidgets()).toEqual([{ key: "todos", lines: ["○ 写代码"] }]);
	});

	it("两个会话各写同名 key，互不覆盖（last-writer-wins 才是串台的根）", () => {
		const h = harness();
		h.ui.forConversation("conv-a").setWidget("todos", ["A 的任务"]);
		h.ui.forConversation("conv-b").setWidget("todos", ["B 的任务"]);
		expect(h.ui.snapshot()).toEqual([{ key: "todos", lines: ["A 的任务"] }]);
		h.switchTo("conv-b");
		expect(h.ui.snapshot()).toEqual([{ key: "todos", lines: ["B 的任务"] }]);
	});

	it("SDK 的 {...uiContext} 复制不会丢归属（必须 own 属性覆盖，Proxy 会被 spread 抹掉）", () => {
		const h = harness();
		const facade = h.ui.forConversation("conv-b");
		const copied = { ...facade } as typeof facade;
		copied.setWidget("todos", ["B 的任务"]);
		expect(h.lastWidgets()).toEqual([]);
		h.switchTo("conv-b");
		expect(h.ui.snapshot()).toEqual([{ key: "todos", lines: ["B 的任务"] }]);
	});

	it("真 SDK 的 wrapUIPromptContext（会再 spread 一次）之后归属仍在", () => {
		const h = harness();
		const proto = ExtensionRunner.prototype as unknown as {
			wrapUIPromptContext?: (ui: unknown) => unknown;
		};
		const wrap = proto.wrapUIPromptContext;
		if (typeof wrap !== "function") return;
		const wrapped = wrap.call(
			{ withUIPrompt: (_k: string, _t: unknown, run: () => unknown) => run() },
			h.ui.forConversation("conv-b"),
		) as { setWidget: (key: string, lines: string[]) => void };
		wrapped.setWidget("todos", ["B 的任务"]);
		// 落在 conv-b，而不是当前会话 conv-a
		expect(h.lastWidgets()).toEqual([]);
		h.switchTo("conv-b");
		expect(h.ui.snapshot()).toEqual([{ key: "todos", lines: ["B 的任务"] }]);
	});

	it("根 context 上的 setWidget 归属当前会话，不是全局条目", () => {
		const h = harness();
		h.ui.setWidget("todos", ["A 的任务"]);
		h.switchTo("conv-b");
		expect(h.ui.snapshot()).toEqual([]);
	});

	it("全局 widget（内置 markers）每个会话都下发", () => {
		const h = harness();
		h.ui.setDynamicWidget("markers", () => ["● 运行中"]);
		expect(h.ui.snapshot()).toEqual([{ key: "markers", lines: ["● 运行中"] }]);
		h.switchTo("conv-b");
		expect(h.ui.snapshot()).toEqual([{ key: "markers", lines: ["● 运行中"] }]);
	});

	it("已关闭会话的 widget 在轮询里被清掉（含 dispose），不留到别的会话", () => {
		const h = harness();
		let disposed = 0;
		h.ui.forConversation("conv-b").setWidget("todos", (() => ({
			render: () => ["B"],
			invalidate: () => {},
			dispose: () => {
				disposed++;
			},
		})) as unknown as Parameters<WebUIContext["setWidget"]>[1]);
		h.switchTo("conv-b");
		h.switchTo("conv-a");
		h.close("conv-b");
		h.ui.refresh();
		expect(disposed).toBe(1);
		expect(h.ui.hasWidgets()).toBe(false);
	});

	it("statuses 同样按会话隔离（footer 上的状态行不能串台）", () => {
		const h = harness();
		h.ui.forConversation("conv-a").setStatus("quota", "5h 19%");
		expect(h.lastStatuses()).toEqual([{ key: "quota", text: "5h 19%" }]);
		h.switchTo("conv-b");
		expect(h.lastStatuses()).toEqual([]);
	});
});
