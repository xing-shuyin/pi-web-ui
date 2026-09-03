import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../../web/src/skill-block.js";

const BODY = `---
name: demo
---
技能正文第一行
第二行`;

describe("parseSkillBlock", () => {
	it("解析标准 <skill> 块（镜像 SDK 正则，勿单独改动）", () => {
		const text = `<skill name="demo" location="/tmp/demo/SKILL.md">\n${BODY}\n</skill>\n\n帮我做 X`;
		const b = parseSkillBlock(text);
		expect(b).not.toBeNull();
		expect(b!.name).toBe("demo");
		expect(b!.location).toBe("/tmp/demo/SKILL.md");
		expect(b!.content).toBe(BODY);
		expect(b!.userMessage).toBe("帮我做 X");
	});

	it("无 userMessage 时为 undefined", () => {
		const text = `<skill name="a" location="/l">\nbody\n</skill>`;
		const b = parseSkillBlock(text);
		expect(b!.userMessage).toBeUndefined();
	});

	it("非 skill 文本返回 null", () => {
		expect(parseSkillBlock("普通消息")).toBeNull();
	});
});
