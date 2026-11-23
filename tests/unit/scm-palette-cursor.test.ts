// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScmCommandPalette } from "../../web/src/components/scm/ScmCommandPalette";
import type { ScmPaletteAction } from "../../web/src/scm-palette-actions";

/**
 * Git 操作面板的游标归属：鼠标悬停 / ↑↓ 选中的行必须一直是高亮行。
 *
 * 曾经的 bug：游标只按 "rows 数组换了个引用" 就归零，于是宿主任何一次重渲染
 * （状态轮询、终端输出、动作表重建）都会把用户悬停到的那行弹回第一行。
 * 规则：只有 "查询变了" 或 "当前行已不可执行" 才允许挪游标。
 */

vi.mock("../../web/src/i18n", () => ({
	useI18n: () => ({ locale: "zh" }),
	isZhLocale: () => true,
	useT: () => (key: string) => key,
}));

const labels = {
	title: "Git 操作",
	placeholder: "搜索",
	empty: "没有匹配",
	move: "选择",
	run: "执行",
	close: "关闭",
	count: (n: number) => `${n} 个操作`,
};

function makeActions(disabledIndex = -1): ScmPaletteAction[] {
	return [
		{ id: "pull", group: "同步", label: "拉取", hint: "git pull", run: () => {} },
		{ id: "push", group: "同步", label: "推送", hint: "git push", run: () => {} },
		{
			id: "fetch",
			group: "同步",
			label: "获取全部远端",
			hint: "git fetch --all --prune",
			disabled: disabledIndex === 2,
			run: () => {},
		},
		{ id: "commit", group: "提交", label: "提交", hint: "git commit -m", run: () => {} },
	];
}

let host: HTMLDivElement;
let root: Root;

function render(actions: ScmPaletteAction[]) {
	return createElement(ScmCommandPalette, {
		open: true,
		onClose: () => {},
		labels,
		actions,
	});
}

function hoveredIndex(): number {
	const on = host.querySelector(".scm-pal-row.on");
	expect(on).not.toBeNull();
	return Number(on?.getAttribute("data-idx"));
}

function hover(index: number) {
	const row = host.querySelector<HTMLElement>(`.scm-pal-row[data-idx="${index}"]`);
	expect(row).not.toBeNull();
	act(() => {
		row?.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
	});
}

function type(value: string) {
	const input = host.querySelector<HTMLInputElement>(".scm-pal-head input");
	expect(input).not.toBeNull();
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input?.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

function key(name: string) {
	act(() => {
		host
			.querySelector(".scm-pal-backdrop")
			?.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }));
	});
}

beforeEach(() => {
	// jsdom 没有 scrollIntoView
	Element.prototype.scrollIntoView = () => {};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("ScmCommandPalette 游标", () => {
	it("悬停到某行后高亮跟着鼠标", () => {
		act(() => root.render(render(makeActions())));
		hover(2);
		expect(hoveredIndex()).toBe(2);
	});

	it("宿主重渲染（动作表换引用）不把悬停行弹回第一行", () => {
		act(() => root.render(render(makeActions())));
		hover(2);
		act(() => root.render(render(makeActions())));
		expect(hoveredIndex()).toBe(2);
	});

	it("键盘 ↑↓ 之后宿主重渲染也保持选中行", () => {
		act(() => root.render(render(makeActions())));
		key("ArrowDown");
		key("ArrowDown");
		expect(hoveredIndex()).toBe(2);
		act(() => root.render(render(makeActions())));
		expect(hoveredIndex()).toBe(2);
	});

	it("搜索词变了才回到第一条可执行行", () => {
		act(() => root.render(render(makeActions())));
		hover(3);
		expect(hoveredIndex()).toBe(3);
		type("git pu");
		expect(hoveredIndex()).toBe(0);
	});

	it("当前行变成不可执行时游标让位给第一条可执行行", () => {
		act(() => root.render(render(makeActions())));
		hover(2);
		expect(hoveredIndex()).toBe(2);
		act(() => root.render(render(makeActions(2))));
		expect(hoveredIndex()).toBe(0);
	});
});
