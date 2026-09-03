import { describe, expect, it } from "vitest";
import { quotePath } from "../../web/src/scm-quote.js";

describe("quotePath", () => {
	it("普通路径包单引号且闭合（issue #51 回归）", () => {
		expect(quotePath("src/foo.ts")).toBe("'src/foo.ts'");
	});

	it("引号首尾闭合，拼接后是完整的 git add 命令", () => {
		const cmd = `git add -- ${quotePath("a b/c'd.ts")}`;
		expect(cmd).toBe("git add -- 'a b/c'\\''d.ts'");
	});

	it("含单引号的路径按 POSIX 规则转义", () => {
		const q = quotePath("it's/h'ello.txt");
		expect(q.startsWith("'")).toBe(true);
		expect(q.endsWith("'")).toBe(true);
		expect(q).toBe("'it'\\''s/h'\\''ello.txt'");
	});

	it("空路径也保持闭合", () => {
		expect(quotePath("")).toBe("''");
	});
});
