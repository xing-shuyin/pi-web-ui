import { describe, expect, it } from "vitest";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

/** Mimic pi SDK wrapUIPromptContext: `{ ...ui, select: wrapped }` copies own
 *  properties only. Class prototype methods would vanish here. */
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
		// 没有浏览器应答：挂 Promise 会让扩展永久 await（PR #128 回归点）。
		const ui = WebUIContext.headless();
		await expect(ui.select("pick", ["a"])).resolves.toBeNull();
		await expect(ui.confirm("sure?", "m")).resolves.toBeNull();
		await expect(ui.input("name")).resolves.toBeNull();
	});

	it("drops every UI message (no cross-talk with the main conversation)", () => {
		// 先盯「挂浏览器的上下文照常发」，再盯「headless 一条都不发」。
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
