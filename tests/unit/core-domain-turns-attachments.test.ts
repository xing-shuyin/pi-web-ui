import { describe, expect, it } from "vitest";
import { appendAttachmentAsides } from "../../packages/keel/src/domains/turns/attachments.js";
import type { AttachmentContext, AttachmentsPort } from "../../packages/keel/src/contracts/attachments.js";
import type { MessageEditSession, TurnCustomMessage } from "../../packages/keel/src/contracts/turns.js";
import type { PromptAttachment } from "../../packages/keel/src/protocol.js";

const CTX: AttachmentContext = {
	clientId: "c1",
	cwd: "/work",
	emit: () => {},
	settings: {} as never,
	getLang: () => "zh",
};

function attachment(path: string): PromptAttachment {
	return { path, mode: "reference" } as PromptAttachment;
}

/** aside 定形：与 legacy `buildAttachmentMessages` 同形（`<file>` 引用 + `customType: "file"`）。 */
function asideFor(path: string): TurnCustomMessage {
	return {
		customType: "file",
		content: [{ type: "text", text: `<file path="${path}" size="7" />` }],
		display: true,
		details: { name: path, path, mode: "reference", size: 7 },
	};
}

function editorStub(sent: { message: TurnCustomMessage; deliverAs?: string }[]): MessageEditSession {
	return {
		sessionToken: () => "s1",
		sendCustomMessage: async (
			message: TurnCustomMessage,
			options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
		) => {
			sent.push({ message, ...(options?.deliverAs ? { deliverAs: options.deliverAs } : {}) });
		},
	} as unknown as MessageEditSession;
}

function portStub(calls: { ctx: AttachmentContext; attachments: readonly PromptAttachment[] }[]): AttachmentsPort {
	return {
		build: async (ctx, attachments) => {
			calls.push({ ctx, attachments });
			return attachments.map((one) => asideFor(one.path));
		},
	};
}

describe("domains/turns · 附件 asides（H）", () => {
	it("有附件：端口按现场构建 → 一条一条落进会话（deliverAs: nextTurn）", async () => {
		const calls: { ctx: AttachmentContext; attachments: readonly PromptAttachment[] }[] = [];
		const sent: { message: TurnCustomMessage; deliverAs?: string }[] = [];
		const count = await appendAttachmentAsides({
			port: portStub(calls),
			editor: editorStub(sent),
			ctx: CTX,
			attachments: [attachment("a.txt"), attachment("b.txt")],
		});
		expect(count).toBe(2);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.ctx.cwd).toBe("/work");
		expect(sent.map((one) => one.deliverAs)).toStrictEqual(["nextTurn", "nextTurn"]);
		expect(sent.map((one) => one.message.customType)).toStrictEqual(["file", "file"]);
		// `<file>` 引用进的是旁注正文（模型看得见），不是用户消息正文。
		expect(sent[0]?.message.content).toStrictEqual([{ type: "text", text: '<file path="a.txt" size="7" />' }]);
		expect(sent[0]?.message.details).toMatchObject({ mode: "reference", name: "a.txt" });
	});

	it("没有附件：不碰端口、不发任何消息", async () => {
		const calls: unknown[] = [];
		const sent: unknown[] = [];
		await expect(
			appendAttachmentAsides({
				port: portStub(calls as never),
				editor: editorStub(sent as never),
				ctx: CTX,
				attachments: [],
			}),
		).resolves.toBe(0);
		expect(calls).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("端口未接线：fail-closed 地说一声（附件不静默消失）", async () => {
		const seen: string[] = [];
		const count = await appendAttachmentAsides({
			editor: editorStub([]),
			ctx: CTX,
			attachments: [attachment("a.txt")],
			notice: (level, text) => void seen.push(`${level}:${text}`),
		});
		expect(count).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("未随这条消息发出");
	});
});
