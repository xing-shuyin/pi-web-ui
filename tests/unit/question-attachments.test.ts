import { describe, expect, it } from "vitest";
import { collectQuestionAttachments } from "../../web/src/question-attachments.js";
import type { EditPromptAttachment } from "../../web/src/question-attachments.js";

interface TestBlock {
	type: string;
	text?: string;
	dataUrl?: string;
}
interface TestMessage {
	id: string;
	role: string;
	content: TestBlock[];
	customType?: string;
	details?: unknown;
	timestamp?: number;
}
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function user(id: string, text: string): TestMessage {
	return {
		id,
		role: "user",
		timestamp: 1,
		content: [{ type: "text", text }],
	};
}
function assistant(id: string): TestMessage {
	return {
		id,
		role: "assistant",
		timestamp: 2,
		content: [{ type: "text", text: "ok" }],
	};
}
function fileCard(
	id: string,
	content: { type: string; text?: string; dataUrl?: string }[],
	details: Record<string, unknown>,
): TestMessage {
	return {
		id,
		role: "custom",
		customType: "file",
		timestamp: 3,
		content: content as TestMessage["content"],
		details,
	};
}

describe("collectQuestionAttachments", () => {
	it("restores attachment-store images on the first question and its file cards", () => {
		const url = `/api/attachment/${"a".repeat(64)}`;
		const messages = [
			{ ...user("u1", "question"), content: [{ type: "image", dataUrl: url, mimeType: "image/png" }] },
			{
				id: "f1",
				role: "custom",
				customType: "file",
				content: [{ type: "image", dataUrl: url, mimeType: "image/png" }],
				details: { name: "pasted.png" },
			},
		];
		expect(collectQuestionAttachments(messages).get("u1")).toEqual([
			{ path: "", imageUrl: url, mimeType: "image/png", name: "image" },
		]);
		expect(collectQuestionAttachments([...messages.slice(1), user("u2", "question")]).get("u2")).toEqual([
			{ path: "", imageUrl: url, mimeType: "image/png", name: "pasted.png" },
		]);
	});
	it("restores a canvas id and title without downgrading it to a file", () => {
		const map = collectQuestionAttachments([
			user("u1", "inspect"),
			fileCard("c1", [], { mode: "canvas", path: "graph-1", name: "Build" }),
		]);
		expect(map.get("u1")).toEqual([{ mode: "canvas", path: "graph-1", name: "Build" }]);
	});
	it("恢复保存在用户消息中的引用", () => {
		const quote = { text: "引用原文", messageId: "a1", role: "assistant" };
		const map = collectQuestionAttachments([{ ...user("u1", "解释这段"), details: { quotes: [quote] } }]);
		expect(map.get("u1")).toEqual([{ path: "", mode: "quote", quote }]);
	});
	it("编辑重问恢复文字引用原文与来源，无需文件路径", () => {
		const quote = { text: "代码\n第二行", messageId: "a1", role: "assistant", sessionId: "s1" };
		const map = collectQuestionAttachments([
			user("u1", "解释这段"),
			fileCard("q1", [{ type: "text", text: "引用上下文" }], { mode: "quote", quote }),
			assistant("a2"),
		]);
		expect(map.get("u1")).toEqual([{ path: "", mode: "quote", quote }]);
	});
	it("编辑重问恢复提问之前插入的 aside 卡（非流式提问顺序）", () => {
		const quote = { text: "代码\n第二行", messageId: "a1", role: "assistant", sessionId: "s1" };
		const map = collectQuestionAttachments([
			assistant("a0"),
			fileCard("q1", [{ type: "text", text: "引用上下文" }], { mode: "quote", quote }),
			user("u1", "解释这段"),
			assistant("a2"),
		]);
		expect(map.get("u1")).toEqual([{ path: "", mode: "quote", quote }]);
	});
	it("收集用户自身内容里的图片块", () => {
		const u = {
			...user("u1", "看图"),
			content: [
				{ type: "text", text: "看图" },
				{ type: "image", dataUrl: PNG },
			],
		};
		const map = collectQuestionAttachments([u]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].imageData).toContain("iVBORw0KG");
		expect(atts[0].path).toBe("");
	});

	it("收集紧随其后的图片 aside 卡（含视觉桥缩略图）", () => {
		const aside = fileCard("c1", [{ type: "image", dataUrl: PNG }], { name: "图.png", mode: "image" });
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].imageData).toContain("iVBORw0KG");
		expect(atts[0].name).toBe("图.png");
	});

	it("上传文件（upload:true）→ uploadPath 附件", () => {
		const aside = fileCard("c1", [{ type: "text", text: '<file path="C:/data/u/1/2-x.txt" />' }], {
			name: "x.txt",
			path: "C:/data/u/1/2-x.txt",
			mode: "reference",
			upload: true,
		});
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].uploadPath).toBe("C:/data/u/1/2-x.txt");
		expect(atts[0].name).toBe("x.txt");
		expect(atts[0].imageData).toBeUndefined();
	});

	it("工作区路径附件：reference → path+mode", () => {
		const aside = fileCard("c1", [{ type: "text", text: '<file path="src/a.ts" size="10" />' }], {
			name: "a.ts",
			path: "src/a.ts",
			mode: "reference",
			size: 10,
		});
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].path).toBe("src/a.ts");
		expect(atts[0].mode).toBe("reference");
	});

	it("工作区路径附件：lines → path+mode+lines 范围", () => {
		const aside = fileCard("c1", [{ type: "text", text: '<file path="src/a.ts" lines="2-3">```x```</file>' }], {
			name: "a.ts",
			path: "src/a.ts",
			mode: "lines",
			size: 100,
			startLine: 2,
			endLine: 3,
		});
		const map = collectQuestionAttachments([user("u1", "q"), aside]);
		const atts = map.get("u1")!;
		expect(atts).toHaveLength(1);
		expect(atts[0].path).toBe("src/a.ts");
		expect(atts[0].mode).toBe("lines");
		expect(atts[0].lines).toEqual({ start: 2, end: 3 });
	});

	it("多个图片 + 多个文件 + 路径附件全部收集", () => {
		const messages: TestMessage[] = [
			user("u1", "q"),
			fileCard("c1", [{ type: "image", dataUrl: PNG }], { name: "a.png", mode: "image" }),
			fileCard("c2", [{ type: "image", dataUrl: PNG }], { name: "b.png", mode: "image" }),
			fileCard("c3", [{ type: "text", text: '<file path="C:/u/1/2-d.txt" />' }], {
				name: "d.txt",
				path: "C:/u/1/2-d.txt",
				mode: "reference",
				upload: true,
			}),
			fileCard("c4", [{ type: "text", text: '<file path="src/a.ts" />' }], {
				name: "a.ts",
				path: "src/a.ts",
				mode: "reference",
				size: 9,
			}),
		];
		const atts = collectQuestionAttachments(messages).get("u1")!;
		expect(atts).toHaveLength(4);
		const kinds = atts.map((a) => (a.imageData ? "image" : a.uploadPath ? "upload" : "path"));
		expect(kinds).toEqual(["image", "image", "upload", "path"]);
	});

	it("不收集：assistant 消息打断 aside 序列 / 无附件的纯文本问题", () => {
		const interrupted = [
			user("u1", "q"),
			assistant("a1"),
			fileCard("c1", [{ type: "image", dataUrl: PNG }], { name: "x.png", mode: "image" }),
		];
		expect(collectQuestionAttachments(interrupted).has("u1")).toBe(false);

		expect(collectQuestionAttachments([user("u1", "q")]).has("u1")).toBe(false);
	});

	it("返回的附件可移除后重新发送（编辑重问的 attachments 形状）", () => {
		const aside = fileCard("c1", [{ type: "text", text: '<file path="src/a.ts" lines="1-1">```x```</file>' }], {
			name: "a.ts",
			path: "src/a.ts",
			mode: "lines",
			startLine: 1,
			endLine: 1,
		});
		const atts: EditPromptAttachment[] = collectQuestionAttachments([user("u1", "q"), aside]).get("u1") ?? [];
		const kept = atts.slice(1);
		expect(kept).toEqual([]);
	});

	it("网页引用（mode:page）→ 原样恢复 path=origin + name=标题（不被当成工作区 reference）", () => {
		const aside = fileCard("c1", [{ type: "text", text: '<browser-page url="https://a.example" title="A 页" />' }], {
			name: "A 页",
			path: "https://a.example",
			mode: "page",
		});
		const atts = collectQuestionAttachments([user("u1", "q"), aside]).get("u1") ?? [];
		expect(atts).toEqual([{ path: "https://a.example", mode: "page", name: "A 页" }]);
	});

	it("防御性去重：历史会话中残留重复的对话引用/图片/文件附件时自动去重", () => {
		const asideConv1 = fileCard("c1", [{ type: "text", text: "对话引用" }], {
			mode: "conversation",
			conversationId: "conv-1",
			name: "对话A",
		});
		const asideImg1 = fileCard("c2", [{ type: "image", dataUrl: PNG }], { name: "image.png", mode: "image" });
		const asideConvDuplicate = fileCard("c3", [{ type: "text", text: "对话引用" }], {
			mode: "conversation",
			conversationId: "conv-1",
			name: "对话A",
		});
		const asideImgDuplicate = fileCard("c4", [{ type: "image", dataUrl: PNG }], { name: "image.png", mode: "image" });

		const messages = [user("u1", "q"), asideConv1, asideImg1, asideConvDuplicate, asideImgDuplicate];
		const atts = collectQuestionAttachments(messages).get("u1")!;
		expect(atts).toHaveLength(2);
		expect(atts[0].mode).toBe("conversation");
		expect(atts[1].imageData).toBeDefined();
	});
});
