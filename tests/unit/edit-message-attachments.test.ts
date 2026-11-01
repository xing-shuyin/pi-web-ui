import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

describe("editMessage 纯附件提问支持（#443）", () => {
	it("空文本且无附件：发出 warning notice 并提前返回", async () => {
		const emitted: unknown[] = [];
		const session = fakeClientSession() as any;
		session.quiesceBlocked = () => false;
		session.emit = (msg: unknown) => emitted.push(msg);
		session.flushSnapshot = vi.fn();

		await ClientSession.prototype.editMessage.call(session, "msg-1", "   ", []);
		expect(emitted).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "warning",
				text: "编辑内容为空，已取消",
			}),
		]);
	});

	it("空文本但带附件：放行通过空检查并尝试 resolve 消息（不静默拦截）", async () => {
		const emitted: unknown[] = [];
		const session = fakeClientSession() as any;
		session.quiesceBlocked = () => false;
		session.emit = (msg: unknown) => emitted.push(msg);
		session.flushSnapshot = vi.fn();
		session.resolveUserMessageEntryId = vi.fn().mockReturnValue(null);

		const fakeAttachment = {
			type: "image",
			path: "/test/image.png",
			mimeType: "image/png",
		};

		await ClientSession.prototype.editMessage.call(session, "msg-1", "", [fakeAttachment as any]);

		// 证明空检查未拦截，进入了寻找目标消息阶段
		expect(session.resolveUserMessageEntryId).toHaveBeenCalledWith("msg-1");
		expect(emitted).toEqual([
			expect.objectContaining({
				type: "notice",
				level: "error",
				text: "找不到要编辑的消息（可能已被压缩或不在当前分支）",
			}),
		]);
	});
});
