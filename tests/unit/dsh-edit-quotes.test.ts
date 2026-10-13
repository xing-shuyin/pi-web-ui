import { expect, it, vi } from "vitest";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

it("编辑移除引用时，只保留编辑点之前的上下文", async () => {
	const quote = { text: "应当移除的原引用", messageId: "a1", role: "assistant" };
	const previousQuote = { ...quote, text: "更早问题的引用" };
	const prompt = vi.fn();
	const emit = vi.fn();
	const conv = {
		id: "c1",
		messages: [
			{
				id: "u0",
				role: "user",
				content: [{ type: "text", text: "更早的问题" }],
				details: { quotes: [previousQuote] },
			},
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "先前回复" }] },
			{ id: "u1", role: "user", content: [{ type: "text", text: "原问题" }], details: { quotes: [quote] } },
		],
		terminals: { countBlockingLive: () => 0 },
	};
	const session = Object.assign(Object.create(DshClientSession.prototype), {
		activeId: "c1",
		convs: new Map([["c1", conv]]),
		cwd: "/work",
		settings: { retainFinishedConversations: false },
		addConversation: () => ({ id: "fresh" }),
		getLang: () => "zh",
		prompt,
		emit,
		emitConversations: vi.fn(),
		flushSnapshot: vi.fn(),
	});
	await DshClientSession.prototype.editMessage.call(session as never, "u1", "修改后的问题", []);
	expect(emit).not.toHaveBeenCalled();
	expect(prompt).toHaveBeenCalledOnce();
	const [text, attachments] = prompt.mock.calls[0];
	expect(text).toContain("修改后的问题");
	expect(text).toContain("更早问题的引用");
	expect(text).toContain("先前回复");
	expect(text).not.toContain("应当移除的原引用");
	expect(text).not.toContain("原问题");
	expect(attachments).toEqual([]);
});
