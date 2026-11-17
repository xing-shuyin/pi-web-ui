import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

describe("empty prompt backend guard", () => {
	it("ClientSession ignores empty prompt and preserves drafts", async () => {
		const emitted: unknown[] = [];
		const draftsClear = vi.fn();
		const sessionPrompt = vi.fn();
		const flushSnapshot = vi.fn();

		const cs = {
			emit: (msg: unknown) => emitted.push(msg),
			flushSnapshot,
			assertSubagentWorktreeAdmission: vi.fn(),
			// 私聊/设备任务的能力解析：空白 prompt 在解析之前就该返回，取不到能力也无所谓。
			botOf: () => undefined,
			// 投递门：空 prompt 在门判定之前就该返回，这里只需要它能被调用。
			deliveryModeOf: (ClientSession.prototype as any).deliveryModeOf,
			drafts: { clear: draftsClear },
			conv: { session: { sessionId: "sid-1" } },
			session: { prompt: sessionPrompt },
		} as unknown as ClientSession;

		await ClientSession.prototype.prompt.call(cs, "   ", []);
		expect(draftsClear).not.toHaveBeenCalled();
		expect(sessionPrompt).not.toHaveBeenCalled();
		expect(flushSnapshot).toHaveBeenCalledTimes(1);
		expect(emitted).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "warning",
				textEn: "Prompt ignored: text is empty and no attachments were provided.",
			}),
		]);
	});

	it("DshClientSession ignores empty prompt and returns early", async () => {
		const emitted: unknown[] = [];
		const flushSnapshot = vi.fn();

		const dsh = {
			emit: (msg: unknown) => emitted.push(msg),
			flushSnapshot,
			conv: { sessionId: "sid-dsh" },
		} as unknown as DshClientSession;

		await DshClientSession.prototype.prompt.call(dsh, "", undefined);
		expect(flushSnapshot).toHaveBeenCalledTimes(1);
		expect(emitted).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "warning",
				textEn: "Prompt ignored: text is empty and no attachments were provided.",
			}),
		]);
	});
});
