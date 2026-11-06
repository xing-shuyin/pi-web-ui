import { describe, expect, it } from "vitest";
import { resolveBackspaceMention } from "../../web/src/chat-input-backspace.js";

describe("resolveBackspaceMention", () => {
	it("基础文件整块退格删除并匹配附件", () => {
		const atts = [{ path: "README.md", name: "README.md", mode: "reference" }];
		const text = "请查看 @README.md ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).not.toBeNull();
		expect(res?.tokenStart).toBe("请查看 ".length);
		expect(res?.attachment).toBe(atts[0]);
	});

	it("多级相对路径整块退格删除，不留目录前缀残渣", () => {
		const atts = [{ path: "src/components/App.tsx", name: "App.tsx", mode: "reference" }];
		const text = "分析 @src/components/App.tsx ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).not.toBeNull();
		expect(res?.tokenStart).toBe("分析 ".length);
		expect(res?.attachment).toBe(atts[0]);
	});

	it("同名 basename 条目（根目录 报告 vs 方案/报告）退格绝不误删", () => {
		const rootReport = { path: "报告", name: "报告", mode: "reference" };
		const subReport = { path: "方案/报告", name: "报告", mode: "reference" };
		const atts = [rootReport, subReport];

		const textSub = "请审阅 @方案/报告 ";
		const resSub = resolveBackspaceMention(textSub, textSub.length, atts);
		expect(resSub).not.toBeNull();
		expect(resSub?.tokenStart).toBe("请审阅 ".length);
		expect(resSub?.attachment).toBe(subReport);
		expect(resSub?.attachment).not.toBe(rootReport);

		const textRoot = "请审阅 @报告 ";
		const resRoot = resolveBackspaceMention(textRoot, textRoot.length, atts);
		expect(resRoot).not.toBeNull();
		expect(resRoot?.tokenStart).toBe("请审阅 ".length);
		expect(resRoot?.attachment).toBe(rootReport);
	});

	it("带空格的相对路径（docs/my report.md）可整块退格且联动附件", () => {
		const atts = [{ path: "docs/my report.md", name: "my report.md", mode: "reference" }];
		const text = "请看 @docs/my report.md ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).not.toBeNull();
		expect(res?.tokenStart).toBe("请看 ".length);
		expect(res?.attachment).toBe(atts[0]);
	});

	it("网页（page）引用按标题匹配", () => {
		const atts = [{ path: "https://example.com", name: "示例页面", mode: "page" }];
		const text = "引用 @示例页面 ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).not.toBeNull();
		expect(res?.tokenStart).toBe("引用 ".length);
		expect(res?.attachment).toBe(atts[0]);
	});

	it("手打 @引用（fallback 到通用正则）优先按精确 path 查找附件", () => {
		const rootDoc = { path: "doc", name: "doc", mode: "reference" };
		const subDoc = { path: "arch/doc", name: "doc", mode: "reference" };
		const atts = [rootDoc, subDoc];

		const text = "参考 @arch/doc";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).not.toBeNull();
		expect(res?.tokenStart).toBe("参考 ".length);
		expect(res?.attachment).toBe(subDoc);
	});

	it("紧贴字符（如路径中段 /@file）不整块删除，返回 null", () => {
		const atts = [{ path: "file.ts", name: "file.ts", mode: "reference" }];
		const text = "foo/@file.ts ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).toBeNull();
	});

	it("邮箱或非提及不触发整块删除", () => {
		const atts = [{ path: "user", name: "user", mode: "reference" }];
		const text = "mail@user ";
		const res = resolveBackspaceMention(text, text.length, atts);
		expect(res).toBeNull();
	});
});
