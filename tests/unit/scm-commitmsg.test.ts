import { describe, expect, it } from "vitest";
import {
	buildCommitMsgInput,
	buildCommitMsgPrompt,
	COMMITMSG_SYSTEM_PROMPT,
	MAX_COMMITMSG_LEN,
	sanitizeCommitMessage,
} from "../../server/scm-commitmsg.js";
import type { ScmCommitContext } from "../../server/scm.js";

function ctx(partial: Partial<ScmCommitContext> = {}): ScmCommitContext {
	return {
		subjects: [],
		emptyRepo: true,
		files: [],
		stagedStat: {},
		worktreeStat: {},
		stagedPatch: "",
		worktreePatch: "",
		...partial,
	};
}

describe("buildCommitMsgInput", () => {
	it("空上下文返回 null（工作区干净 → 不调模型）", () => {
		expect(buildCommitMsgInput(ctx(), "zh")).toBeNull();
	});

	it("只有未跟踪文件时也返回输入（commit-all 场景，diff 为空）", () => {
		const input = buildCommitMsgInput(ctx({ files: [{ path: "new.txt", x: "?", y: "?" }] }), "en");
		expect(input).toContain("new.txt");
		expect(input).toContain("Untracked");
	});

	it("近期提交主题进提示词作为风格参考", () => {
		const input = buildCommitMsgInput(
			ctx({
				subjects: ["feat(scm): 增加面板", "fix(ui): 对齐"],
				emptyRepo: false,
				worktreePatch: "diff --git a/x b/x",
			}),
			"en",
		);
		expect(input).toContain("feat(scm): 增加面板");
		expect(input).toContain("fix(ui): 对齐");
		expect(input).not.toContain("no commits yet");
	});

	it("空仓库按 fallbackLang 注入语言指令", () => {
		const zh = buildCommitMsgInput(ctx({ worktreePatch: "diff" }), "zh");
		expect(zh).toContain("请用中文");
		const en = buildCommitMsgInput(ctx({ worktreePatch: "diff" }), "en");
		expect(en).toContain("in English");
	});

	it("暂存与未暂存 patch 都进提示词，numstat 摘要带 +/- 计数", () => {
		const input = buildCommitMsgInput(
			ctx({
				stagedPatch: "diff --git a/a.ts b/a.ts",
				stagedStat: { "a.ts": [12, 3] },
				worktreePatch: "diff --git a/b.ts b/b.ts",
				worktreeStat: { "b.ts": [1, 0] },
			}),
			"en",
		);
		expect(input).toContain("Staged diff");
		expect(input).toContain("+12/-3 a.ts");
		expect(input).toContain("Unstaged diff");
		expect(input).toContain("+1/-0 b.ts");
	});

	it("文件列表超过 200 条时截断并标注剩余数", () => {
		const files = Array.from({ length: 205 }, (_, i) => ({ path: `f${i}.ts`, x: "M", y: " " }));
		const input = buildCommitMsgInput(ctx({ files, worktreePatch: "diff" }), "en");
		expect(input).toContain("f199.ts");
		expect(input).not.toContain("f200.ts");
		expect(input).toContain("+5 more files");
	});
});

describe("buildCommitMsgPrompt", () => {
	it("append + 空自定义 = 纯内置默认", () => {
		expect(buildCommitMsgPrompt("append", "")).toBe(COMMITMSG_SYSTEM_PROMPT);
		expect(buildCommitMsgPrompt("append", "   ")).toBe(COMMITMSG_SYSTEM_PROMPT);
	});

	it("append + 自定义 = 内置默认 + 空行 + 自定义", () => {
		expect(buildCommitMsgPrompt("append", "总是用祈使句")).toBe(`${COMMITMSG_SYSTEM_PROMPT}\n\n总是用祈使句`);
	});

	it("replace + 非空自定义 = 纯自定义（自定义空白回落默认，不发空提示词）", () => {
		expect(buildCommitMsgPrompt("replace", "你只输出 conventional commits")).toBe("你只输出 conventional commits");
		expect(buildCommitMsgPrompt("replace", "   ")).toBe(COMMITMSG_SYSTEM_PROMPT);
	});
});

describe("sanitizeCommitMessage", () => {
	it("普通单行原样保留", () => {
		expect(sanitizeCommitMessage("feat(scm): AI 生成提交信息")).toBe("feat(scm): AI 生成提交信息");
	});

	it("剥离 ``` 围栏与首尾空白", () => {
		expect(sanitizeCommitMessage("```\nfix: bump version\n```")).toBe("fix: bump version");
		expect(sanitizeCommitMessage("```ts\nfix: bump version\n```")).toBe("fix: bump version");
	});

	it("只保留首个非空行", () => {
		expect(sanitizeCommitMessage("fix: one line\n\n详细说明第二行")).toBe("fix: one line");
	});

	it("剥离「Commit message:」等前导标签（中英）", () => {
		expect(sanitizeCommitMessage("Commit message: fix: x")).toBe("fix: x");
		expect(sanitizeCommitMessage("提交信息：修复 x")).toBe("修复 x");
	});

	it("剥离成对包裹引号（不剥不成对的）", () => {
		expect(sanitizeCommitMessage('"fix: quoted"')).toBe("fix: quoted");
		expect(sanitizeCommitMessage("'fix: single'")).toBe("fix: single");
		expect(sanitizeCommitMessage('fix: ends with "')).toBe('fix: ends with "');
	});

	it("内部空白折叠为单空格", () => {
		expect(sanitizeCommitMessage("fix:\ttwo  spaces")).toBe("fix: two spaces");
	});

	it("超长截断到 MAX_COMMITMSG_LEN 并以省略号收尾", () => {
		const long = "x".repeat(MAX_COMMITMSG_LEN + 50);
		const out = sanitizeCommitMessage(long);
		expect(out.length).toBe(MAX_COMMITMSG_LEN);
		expect(out.endsWith("…")).toBe(true);
	});

	it("纯空白输入返回空串（调用方按失败处理）", () => {
		expect(sanitizeCommitMessage("  \n\t ")).toBe("");
	});

	it("系统提示词要求单行、跟随仓库风格、拒绝编造", () => {
		expect(COMMITMSG_SYSTEM_PROMPT).toContain("single subject line");
		expect(COMMITMSG_SYSTEM_PROMPT).toContain("Match the style");
		expect(COMMITMSG_SYSTEM_PROMPT).toContain("Never invent");
	});
});
