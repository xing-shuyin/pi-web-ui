// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus } from "../../web/src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

let root: Root | null = null;

const inactiveGoal = {
	status: "idle",
	goal: null,
	conversationId: "c-1",
} as unknown as GoalStatus;

function mount() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, {
					goal: inactiveGoal,
					models: [],
					modelsLoading: false,
					activeConversationId: "c-1",
				} as unknown as Parameters<typeof GoalBar>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function bodyOf(selector: string) {
	const re = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
	return re.exec(CSS)?.[1] ?? "";
}

describe("目标条折叠态", () => {
	it("渲染 .goalbar-collapsed，且不带 .goalbar 面板类", () => {
		const container = mount();
		const bar = container.querySelector(".goalbar-collapsed");
		expect(bar).not.toBeNull();
		expect(bar!.classList.contains("goalbar")).toBe(false);
		expect(container.querySelector(".goalbar-hint")).not.toBeNull();
		expect(container.querySelector(".goalbar-row")).toBeNull();
	});

	it("CSS：.goalbar-collapsed 自己是悬浮一行（无边框/底色/内边距，且不外溢）", () => {
		const body = bodyOf(".goalbar-collapsed");
		expect(body).not.toBe("");
		expect(/border\s*:/.test(body), "折叠态不该有边框（通栏带子的根因）").toBe(false);
		expect(/background\s*:/.test(body), "折叠态不该有底色").toBe(false);
		expect(/padding\s*:/.test(body), "折叠态不该有面板内边距").toBe(false);
		expect(/display\s*:\s*flex/.test(body)).toBe(true);
		expect(/justify-content\s*:\s*center/.test(body), "药丸应整行水平居中（与 0.96.x 一致）").toBe(true);
		expect(/min-width\s*:\s*0/.test(body)).toBe(true);
		expect(/max-width\s*:\s*100%/.test(body)).toBe(true);
	});

	it("CSS：脱离文档流，浮在输入区上沿（不吃高度、不吃事件）", () => {
		const body = bodyOf(".goalbar-collapsed");
		expect(/position:\s*absolute/.test(body)).toBe(true);
		expect(/bottom:\s*100%/.test(body)).toBe(true);
		expect(/left:\s*0/.test(body)).toBe(true);
		expect(/right:\s*0/.test(body)).toBe(true);
		expect(/pointer-events:\s*none/.test(body)).toBe(true);
		expect(/pointer-events:\s*auto/.test(bodyOf(".goalbar-collapsed > *"))).toBe(true);
		expect(bodyOf(".goalbar-slot")).toMatch(/flex:\s*none/);
		expect(bodyOf(".goalbar-slot:has(.goalbar-collapsed)")).toMatch(/position:\s*relative/);
		expect(body).toMatch(/margin:\s*0 var\(--chat-inset\) 4px/);
		expect(CSS, "别再为回到底部上抬药丸（改成浮标自己上抬）").not.toMatch(
			/\.main:has\(\.messages\.anchor-live\) \.goalbar-collapsed/,
		);
		const fallback = bodyOf(".main:has(.dialog-inline) .goalbar-collapsed");
		expect(fallback).toMatch(/position:\s*static/);
	});

	it("CSS：回到底部浮标回到底边正中，抬到目标药丸上方（不叠）", () => {
		const jump = bodyOf(".scroll-bottom");
		expect(jump).toMatch(/left:\s*50%/);
		expect(jump).toMatch(/transform:\s*translateX\(-50%\)/);
		expect(jump).toMatch(/bottom:\s*calc\(4px \+ var\(--composer-strip\)\)/);
		expect(jump).toMatch(/font-size:\s*12px/);
		expect(jump).toMatch(/padding:\s*6px 14px/);
		expect(jump).toMatch(/gap:\s*6px/);
		const lifted = bodyOf(
			".main:has(.goalbar-collapsed):not(:has(.plan-board)):not(:has(.dialog-inline)) .scroll-bottom",
		);
		expect(lifted).toMatch(/bottom:\s*calc\(32px \+ var\(--composer-strip\)\)/);
		expect(lifted).not.toMatch(/right:/);
		const lift = Number(/bottom:\s*calc\((\d+)px/.exec(lifted)?.[1] ?? "0");
		expect(lift).toBe(32);
	});

	it("CSS：收起态药丸尺寸是原件（只收贴边间距，不缩药丸）", () => {
		const hint = bodyOf(".goalbar-hint");
		expect(hint).toMatch(/font-size:\s*12px/);
		expect(hint).toMatch(/padding:\s*4px 10px/);
		expect(hint).toMatch(/gap:\s*7px/);
		expect(bodyOf(".goalbar-collapsed")).toMatch(/margin:\s*0 var\(--chat-inset\) 4px/);
	});

	it("CSS：兜底把 .goalbar 面板皮从折叠态抹掉（老 bundle/插件带回面板类也不画带子）", () => {
		const body = bodyOf(".goalbar.goalbar-collapsed");
		expect(body).not.toBe("");
		expect(/border:\s*0/.test(body)).toBe(true);
		expect(/background:\s*none/.test(body)).toBe(true);
		expect(/box-shadow:\s*none/.test(body)).toBe(true);
		expect(/padding:\s*0/.test(body)).toBe(true);
	});
});
