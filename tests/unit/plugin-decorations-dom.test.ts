// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_TRANSCRIPT_ATTR, mountChatDecorations } from "../../web/src/plugin-decorations.js";
import { compileChatDecorations } from "../../shared/chat-decorations.js";

/** jsdom 没有 CSS Custom Highlight API：给一份最小假体，断言宿主真的把 Range 挂上去了。 */
class FakeHighlight {
	readonly ranges = new Set<Range>();
	add(range: Range) {
		this.ranges.add(range);
	}
	delete(range: Range) {
		this.ranges.delete(range);
	}
	clear() {
		this.ranges.clear();
	}
}

const registry = new Map<string, FakeHighlight>();
const g = globalThis as unknown as Record<string, unknown>;

const rules = compileChatDecorations([
	{
		pluginId: "dc",
		permissions: ["decorate"],
		decorations: [{ id: "quotes", pattern: '"[^"]+"', style: { color: "#ff8800", fontWeight: "700" } }],
	},
]).rules;

function mount() {
	const el = document.createElement("div");
	el.setAttribute(CHAT_TRANSCRIPT_ATTR, "");
	el.innerHTML = `<div class="md"><p>Kanan says: <strong><span>"hi"</span></strong> now</p><pre><code>"hi"</code></pre></div>`;
	document.body.appendChild(el);
	const handle = mountChatDecorations(rules);
	handle.flush();
	return { el, handle };
}

const highlight = () => registry.get("pi-deco-dc-quotes");

beforeEach(() => {
	registry.clear();
	g.Highlight = FakeHighlight;
	g.CSS = {
		highlights: { set: (n: string, h: FakeHighlight) => registry.set(n, h), delete: (n: string) => registry.delete(n) },
	};
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

afterEach(() => {
	delete g.Highlight;
	delete g.CSS;
});

describe("聊天正文装饰的宿主注入 (chatDecorations)", () => {
	it("只装饰正文根里的正文文本，跳过代码块；Range 覆盖整段命中（含行内标签）", () => {
		const { handle } = mount();
		try {
			const found = [...(highlight()?.ranges ?? [])];
			expect(found).toHaveLength(1);
			expect(found[0]!.toString()).toBe('"hi"');
			expect(found[0]!.startContainer.parentElement?.closest("pre")).toBeNull();
		} finally {
			handle.dispose();
		}
	});

	it("样式只写 ::highlight 规则，不新增类名/节点", () => {
		const { el, handle } = mount();
		try {
			const style = document.head.querySelector("style[data-pi-chat-decorations]");
			expect(style?.textContent).toBe("::highlight(pi-deco-dc-quotes){color:#ff8800;font-weight:700;}");
			expect(el.querySelectorAll(".md span[style]").length).toBe(0);
			expect(el.querySelector(".md")?.innerHTML).toBe(
				'<p>Kanan says: <strong><span>"hi"</span></strong> now</p><pre><code>"hi"</code></pre>',
			);
		} finally {
			handle.dispose();
		}
	});

	it("流式新增节点后重扫：范围跟着变，旧范围被回收", () => {
		const { el, handle } = mount();
		try {
			el.querySelector(".md")!.insertAdjacentHTML("beforeend", '<p>再补一句 "再见"</p>');
			handle.flush();
			const texts = [...(highlight()?.ranges ?? [])].map((r) => r.toString());
			expect(texts).toEqual(['"hi"', '"再见"']);
		} finally {
			handle.dispose();
		}
	});

	it("dispose 干净收尾：观察器停、样式删、注册表清，之后 flush 不再挂任何东西", () => {
		const { el, handle } = mount();
		handle.dispose();
		expect(document.head.querySelector("style[data-pi-chat-decorations]")).toBeNull();
		expect(registry.size).toBe(0);
		el.querySelector(".md")!.insertAdjacentHTML("beforeend", '<p>"新"</p>');
		handle.flush();
		expect(registry.size).toBe(0);
	});

	it("浏览器没有 Highlight API 时是 no-op（不注入样式、不抛错）", () => {
		delete g.Highlight;
		const { handle } = mount();
		try {
			expect(document.head.querySelector("style[data-pi-chat-decorations]")).toBeNull();
			expect(registry.size).toBe(0);
		} finally {
			handle.dispose();
		}
	});

	it("作用域契约与 MessageList 的实际属性一致（改名不会静默失效）", () => {
		expect(CHAT_TRANSCRIPT_ATTR).toBe("data-chat-transcript");
		const src = readFileSync(join(process.cwd(), "web/src/components/MessageList.tsx"), "utf8");
		expect(src).toContain(`${CHAT_TRANSCRIPT_ATTR}=""`);
	});
});

describe("生命周期：正文根被整颗移除", () => {
	it("切会话/卸载时回收 Range（不把旧节点钉在内存里）", async () => {
		const { el, handle } = mount();
		try {
			expect(highlight()?.ranges.size).toBe(1);
			el.remove();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(highlight()?.ranges.size).toBe(0);
		} finally {
			handle.dispose();
		}
	});
});

describe("scope：按消息角色分流", () => {
	it("助手规则不碰我的消息，用户规则不碰助手回复", () => {
		document.body.innerHTML = `
			<div data-chat-transcript>
				<div class="msg" data-role="assistant"><div class="md"><p>"hi"</p></div></div>
				<div class="msg" data-role="user"><div class="md"><p>/compact 一下</p></div></div>
			</div>`;
		const scoped = compileChatDecorations([
			{
				pluginId: "dc",
				permissions: ["decorate"],
				decorations: [
					{ id: "a", pattern: '"[^"]+"', scope: "assistant", style: { color: "red" } },
					{ id: "u", pattern: "/[a-z]+", scope: "user", style: { color: "blue" } },
				],
			},
		]).rules;
		const handle = mountChatDecorations(scoped);
		try {
			handle.flush();
			expect([...(registry.get("pi-deco-dc-a")?.ranges ?? [])].map((r) => r.toString())).toEqual(['"hi"']);
			expect([...(registry.get("pi-deco-dc-u")?.ranges ?? [])].map((r) => r.toString())).toEqual(["/compact"]);
		} finally {
			handle.dispose();
		}
	});
});
