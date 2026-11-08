import { beforeEach, describe, expect, it } from "vitest";
import {
	clearFooterStatus,
	clearFooterStatusesOf,
	getFooterStatus,
	resetFooterStatuses,
	setFooterStatus,
} from "../../web/src/footer-status.js";

describe("底栏内置状态槽（host:quota）", () => {
	beforeEach(() => {
		resetFooterStatuses();
	});

	it("槽内容是「文本 + tooltip + 点击动作」，宿主负责渲染位置", () => {
		setFooterStatus("quota-watch", {
			text: "DS ¥15.82",
			tip: "📊 当前供应商：DeepSeek",
			pluginId: "quota-watch",
			action: "quota-watch:open-board",
		});
		expect(getFooterStatus("quota-watch")).toEqual({
			text: "DS ¥15.82",
			tip: "📊 当前供应商：DeepSeek",
			pluginId: "quota-watch",
			action: "quota-watch:open-board",
		});
	});

	it("写入后可读回，重复写入同样内容不触发变更", () => {
		expect(setFooterStatus("quota-watch", { text: "DS ¥15.82" })).toBe(true);
		expect(getFooterStatus("quota-watch")).toEqual({ text: "DS ¥15.82" });
		expect(setFooterStatus("quota-watch", { text: "DS ¥15.82" })).toBe(false);
		expect(setFooterStatus("quota-watch", { text: "DS ¥15.82", tip: "提示" })).toBe(true);
		expect(getFooterStatus("quota-watch")?.tip).toBe("提示");
	});

	it("空文本 / null 都等于清除（不留下孤零零的斜杠）", () => {
		setFooterStatus("k", { text: "有值" });
		expect(setFooterStatus("k", { text: "   " })).toBe(true);
		expect(getFooterStatus("k")).toBeNull();
		setFooterStatus("k", { text: "有值" });
		clearFooterStatus("k");
		expect(getFooterStatus("k")).toBeNull();
	});

	it("带 content.render 时保留浮层内容（外壳归宿主，位置不归插件）", () => {
		const render = () => () => {};
		expect(setFooterStatus("quota-watch", { text: "DS ¥15.82", pluginId: "quota-watch", content: { render } })).toBe(
			true,
		);
		expect(getFooterStatus("quota-watch")?.content?.render).toBe(render);
		// 同一个 render 引用 + 同样文本 → 不算变更（否则每次轮询都会重挂浮层）
		expect(setFooterStatus("quota-watch", { text: "DS ¥15.82", pluginId: "quota-watch", content: { render } })).toBe(
			false,
		);
		// 换了实现 → 变更，宿主据此重挂内容
		expect(
			setFooterStatus("quota-watch", { text: "DS ¥15.82", pluginId: "quota-watch", content: { render: () => {} } }),
		).toBe(true);
	});

	it("content 缺 render（半成品）当没有浮层处理", () => {
		expect(setFooterStatus("k", { text: "X", content: {} as never })).toBe(true);
		expect(getFooterStatus("k")?.content).toBeUndefined();
	});

	it("只清自己插件的槽（停用某插件不误伤别人）", () => {
		setFooterStatus("a", { text: "A", pluginId: "quota-watch" });
		setFooterStatus("b", { text: "B", pluginId: "other" });
		clearFooterStatusesOf("quota-watch");
		expect(getFooterStatus("a")).toBeNull();
		expect(getFooterStatus("b")).toEqual({ text: "B", pluginId: "other" });
	});

	it("取第一个槽（宿主内置条目不知道 key 时用）与按 key 取两条路都通", () => {
		setFooterStatus("first", { text: "第一个" });
		setFooterStatus("second", { text: "第二个" });
		expect(getFooterStatus()?.text).toBe("第一个");
		expect(getFooterStatus("second")?.text).toBe("第二个");
		expect(getFooterStatus("missing")).toBeNull();
	});
});
