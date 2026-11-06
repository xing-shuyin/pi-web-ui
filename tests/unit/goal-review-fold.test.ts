// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { reviewFoldKind } from "../../web/src/goal-review-fold.js";
import { CollapsedMessage } from "../../web/src/components/CollapsedMessage.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiMessage } from "../../web/src/types.js";

const user = (text: string): UiMessage =>
	({ id: "u1", role: "user", content: [{ type: "text", text }] }) as unknown as UiMessage;
const assistant = (text: string): UiMessage =>
	({ id: "a1", role: "assistant", content: [{ type: "text", text }] }) as unknown as UiMessage;

describe("reviewFoldKind 识别", () => {
	it("含标记的 user 消息 → prompt", () => {
		expect(reviewFoldKind(user("你是严格、独立的验收者。…\n[goal-review]"))).toEqual({ kind: "prompt" });
		expect(reviewFoldKind(user("…\n[goal-review]"))).toEqual({ kind: "prompt" });
	});

	it("无标记的普通用户消息 → undefined", () => {
		expect(reviewFoldKind(user("帮我把 README 补全"))).toBeUndefined();
	});

	it("纯 verdict JSON 的 assistant 回复 → verdict", () => {
		expect(reviewFoldKind(assistant('{"verdict":"pass","feedback":"ok"}'))).toEqual({
			kind: "verdict",
			verdict: "pass",
		});
		expect(reviewFoldKind(assistant('```json\n{"verdict":"fail","feedback":"差单测"}\n```'))).toBeUndefined();
	});

	it("前后带闲话的不算（保持展开，服务端照常解析）", () => {
		expect(reviewFoldKind(assistant('示例：{"verdict":"pass"}\n结论：{"verdict":"fail"}'))).toBeUndefined();
		expect(reviewFoldKind(assistant("我觉得差不多了"))).toBeUndefined();
	});

	it("custom 卡片（结论卡/向导卡）不受影响", () => {
		const card = {
			id: "c1",
			role: "custom",
			customType: "goal-review",
			content: [{ type: "text", text: "✅ 通过" }],
		} as unknown as UiMessage;
		expect(reviewFoldKind(card)).toBeUndefined();
	});
});

describe("CollapsedMessage summary", () => {
	let root: Root | null = null;
	afterEach(() => {
		if (root) act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";
	});

	function mount(message: UiMessage, summary?: string) {
		window.localStorage.setItem("pi-web-ui:lang", "zh");
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(CollapsedMessage, { message, summary, onExpand: () => {} }),
				),
			);
		});
		return container;
	}

	it("summary 优先于正文预览（审查结论行不展示裸 JSON）", () => {
		const container = mount(assistant('{"verdict":"fail","feedback":"还差单测"}'), "未通过");
		const body = container.querySelector(".msg-collapsed-body")!.textContent ?? "";
		expect(body).toContain("未通过");
		expect(body).not.toContain("verdict");
	});

	it("无 summary 时旧口径不变（正文预览）", () => {
		const container = mount(user("帮我把 README 补全"));
		expect(container.querySelector(".msg-collapsed-body")!.textContent).toContain("帮我把 README 补全");
	});
});
