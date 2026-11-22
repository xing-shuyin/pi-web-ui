import { describe, expect, it } from "vitest";
import {
	attachmentKey,
	goalMaterialsOf,
	hasSendableContent,
	type SendableAttachment,
	sendBlockedReason,
} from "../../web/src/composer-gate.js";

const att = (over: Partial<SendableAttachment> = {}): SendableAttachment => ({ path: "a.png", ...over });

describe("hasSendableContent", () => {
	it("有文本即可发", () => {
		expect(hasSendableContent("hi", [])).toBe(true);
	});

	it("只有附件也可发（图片/文件单独发送是既有能力）", () => {
		expect(hasSendableContent("   ", [att()])).toBe(true);
	});

	it("空文本 + 无附件：不发", () => {
		expect(hasSendableContent("  \n\t ", [])).toBe(false);
		expect(hasSendableContent("", undefined)).toBe(false);
	});
});

describe("attachmentKey", () => {
	it("key 优先（动画后的图片会换 key）", () => {
		expect(attachmentKey(att({ key: "k1" }))).toBe("k1");
	});

	it("对话引用按 conversationId/sessionPath 区分，不会和其它对话引用撞键", () => {
		const a = attachmentKey(att({ mode: "conversation", conversationId: "c1", sessionPath: "s1" }));
		const b = attachmentKey(att({ mode: "conversation", conversationId: "c2", sessionPath: "s2" }));
		expect(a).toBe("conv|c1|s1");
		expect(b).not.toBe(a);
	});

	it("普通附件回落到 path", () => {
		expect(attachmentKey(att({ path: "src/x.ts" }))).toBe("src/x.ts");
	});
});

describe("sendBlockedReason", () => {
	it("带附件不再被拦（目标态已无 goalAttachBlocked 分支，材料走 materials 指针）", () => {
		expect(sendBlockedReason({ attachments: [att()], conversationRefSupported: true })).toBeNull();
		expect(sendBlockedReason({ attachments: [], conversationRefSupported: true })).toBeNull();
	});

	it("引擎不支持对话引用 + 带对话引用附件：拦住并指名原因", () => {
		expect(
			sendBlockedReason({
				attachments: [att({ mode: "conversation" })],
				conversationRefSupported: false,
			}),
		).toEqual({ level: "warning", key: "chatInputConversationRefUnsupported" });
	});

	it("支持对话引用时放行", () => {
		expect(
			sendBlockedReason({
				attachments: [att({ mode: "conversation" })],
				conversationRefSupported: true,
			}),
		).toBeNull();
	});
});

describe("goalMaterialsOf（目标态附件 → 材料指针）", () => {
	it("有路径的附件按路径进规格，去重后保持原顺序", () => {
		const out = goalMaterialsOf([{ path: "docs/spec.md" }, { path: "src/a.ts" }, { path: "docs/spec.md" }]);
		expect(out.materials).toEqual(["docs/spec.md", "src/a.ts"]);
		expect(out.unusable).toEqual([]);
	});

	it("只有 base64 没有路径的图片走瞬态 blob（落盘后再进规格，R1 的唯一出口）", () => {
		const out = goalMaterialsOf([
			{ path: "", imageData: "AAA", name: "shot.png", mimeType: "image/png" },
			{ path: "docs/spec.md" },
		]);
		expect(out.materials).toEqual(["docs/spec.md"]);
		expect(out.blobs).toEqual([{ name: "shot.png", mimeType: "image/png", data: "AAA" }]);
		expect(out.unusable).toEqual([]);
	});

	it("既无路径也无数据的附件才记 unusable", () => {
		const out = goalMaterialsOf([{ path: "", name: "ghost" }]);
		expect(out.materials).toEqual([]);
		expect(out.blobs).toEqual([]);
		expect(out.unusable).toEqual(["ghost"]);
	});

	it("无路径的文件数据也走 blob；两者都没有的才记账", () => {
		const out = goalMaterialsOf([{ path: "", fileData: "AAA", name: "report.pdf" }, { path: "" }]);
		expect(out.materials).toEqual([]);
		expect(out.blobs).toEqual([{ name: "report.pdf", data: "AAA" }]);
		expect(out.unusable).toEqual(["(unnamed)"]);
	});

	it("绝对路径与 URI 原样保留（解释权归服务端 normalizeMaterials）", () => {
		const out = goalMaterialsOf([{ path: "/abs/x.png" }, { path: "https://example.com/a.md" }]);
		expect(out.materials).toEqual(["/abs/x.png", "https://example.com/a.md"]);
	});
});
