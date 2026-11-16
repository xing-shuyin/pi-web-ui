import { describe, expect, it } from "vitest";
import {
	scmFileKind,
	scmInChangesList,
	scmInStagedList,
	scmStatusLetter,
	splitScmFiles,
	sumScmStats,
	type ScmFileLike,
} from "../../web/src/scm-file-kind.js";

/**
 * Git 面板状态分组单源守卫。
 *
 * 分组 / 提交摘要 / 批量按钮的 disabled 都从 `scm-file-kind` 取；一旦这儿判定错了，
 * 用户看到的就是"勾了没勾上""文件数对不上"。所以四个 kind 与 two-list 语义都钉在这儿。
 */

function file(path: string, x: string, y: string): ScmFileLike {
	return { path, x, y };
}

describe("scmFileKind", () => {
	it("四个语义：untracked / staged / unstaged / both", () => {
		expect(scmFileKind(file("a", "?", "?"))).toBe("untracked");
		expect(scmFileKind(file("a", "M", " "))).toBe("staged");
		expect(scmFileKind(file("a", " ", "M"))).toBe("unstaged");
		expect(scmFileKind(file("a", "M", "M"))).toBe("both");
	});

	it("新增 / 删除 / 重命名也算已暂存位", () => {
		expect(scmFileKind(file("a", "A", " "))).toBe("staged");
		expect(scmFileKind(file("a", "D", " "))).toBe("staged");
		expect(scmFileKind(file("a", "R", " "))).toBe("staged");
	});

	it("未跟踪不会因为 y 位是 ? 被当成 unstaged", () => {
		const untracked = file("new.ts", "?", "?");
		expect(scmInStagedList(untracked)).toBe(false);
		expect(scmInChangesList(untracked)).toBe(true);
	});
});

describe("splitScmFiles", () => {
	it("both 同时出现在两组，other 只出现一次", () => {
		const files = [
			file("staged.ts", "M", " "),
			file("both.ts", "M", "M"),
			file("dirty.ts", " ", "M"),
			file("new.ts", "?", "?"),
		];
		const lists = splitScmFiles(files);
		expect(lists.staged.map((f) => f.path)).toEqual(["staged.ts", "both.ts"]);
		expect(lists.unstaged.map((f) => f.path)).toEqual(["both.ts", "dirty.ts", "new.ts"]);
	});

	it("保持入参顺序，不重排也不去重", () => {
		const files = [file("b.ts", " ", "M"), file("a.ts", " ", "M")];
		expect(splitScmFiles(files).unstaged.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
	});

	it("空输入返回两个空数组", () => {
		expect(splitScmFiles([])).toEqual({ staged: [], unstaged: [] });
	});
});

describe("scmStatusLetter", () => {
	it("优先显示暂存位，其次工作区位", () => {
		expect(scmStatusLetter(file("a", "M", "M"))).toBe("M");
		expect(scmStatusLetter(file("a", " ", "D"))).toBe("D");
		expect(scmStatusLetter(file("a", "A", "M"))).toBe("A");
	});

	it("未跟踪显示 U", () => {
		expect(scmStatusLetter(file("a", "?", "?"))).toBe("U");
	});
});

describe("sumScmStats", () => {
	it("只累加传入的那批文件，缺统计的跳过", () => {
		const stats = new Map([
			["a.ts", { add: 3, del: 1 }],
			["b.ts", { add: 10, del: 0 }],
		]);
		const summary = sumScmStats([file("a.ts", "M", " "), file("missing.ts", "M", " ")], stats);
		expect(summary).toEqual({ count: 2, add: 3, del: 1 });
	});

	it("空列表得到全零（提交按钮靠 count 判 disabled）", () => {
		expect(sumScmStats([], new Map())).toEqual({ count: 0, add: 0, del: 0 });
	});
});
