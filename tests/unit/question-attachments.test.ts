/**
 * collectQuestionAttachments 单测 —— 编辑重问的「原附件恢复」收集逻辑。
 *
 * 覆盖：自身内容里的图片块、紧随其后的 aside 图片卡、上传文件（uploadPath
 * 标记）、工作区路径附件（reference/inline/lines）、多个附件全部收集、以及
 * 非 file 消息打断收集。
 */
import { describe, expect, it } from "vitest";
import { collectQuestionAttachments } from "../../web/src/question-attachments.js";
import type { EditPromptAttachment } from "../../web/src/question-attachments.js";

// 结构化镜像（与 web/src/question-attachments.ts 的输入类型一致）
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
		// 用户移除第一项后剩下的仍可直接作为 edit_message.attachments 发送
		const kept = atts.slice(1);
		expect(kept).toEqual([]);
	});
});
