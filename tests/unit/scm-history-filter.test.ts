/**
 * SCM 提交树过滤纯函数：关键字拆分、AND 语义、大小写不敏感、
 * 主题/作者/hash/decorations 多字段匹配、空查询原样返回。
 */
import { describe, expect, it } from "vitest";
import { filterScmCommits, type ScmCommitLike } from "../../web/src/scm-history-filter.js";

function commit(partial: Partial<ScmCommitLike>): ScmCommitLike {
	return {
		hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		shortHash: "aaaaaaa",
		author: "Alice",
		subject: "feat: add thing",
		...partial,
	};
}

const history = [
	commit({ subject: "feat(scm): 增加过滤", author: "张三", shortHash: "abc1234" }),
	commit({
		subject: "fix: crash on quit",
		author: "alice",
		shortHash: "def5678",
		decorations: "origin/main, HEAD -> main",
	}),
	commit({ subject: "docs: readme", author: "Bob", shortHash: "0f0f0f0" }),
];

describe("filterScmCommits", () => {
	it("空查询 / 纯空白原样返回（不复制数组）", () => {
		expect(filterScmCommits(history, "")).toBe(history);
		expect(filterScmCommits(history, "   ")).toBe(history);
	});

	it("大小写不敏感匹配主题", () => {
		expect(filterScmCommits(history, "CRASH")).toHaveLength(1);
		expect(filterScmCommits(history, "crash")[0]?.shortHash).toBe("def5678");
	});

	it("匹配作者与短 hash", () => {
		expect(filterScmCommits(history, "bob")).toHaveLength(1);
		expect(filterScmCommits(history, "abc1234")).toHaveLength(1);
	});

	it("匹配 decorations（分支/标签）", () => {
		expect(filterScmCommits(history, "origin/main")).toHaveLength(1);
	});

	it("空格分隔多关键字 AND 语义", () => {
		// fix + def5678 同条命中；fix + bob 无交集 → 空
		expect(filterScmCommits(history, "fix def5678")).toHaveLength(1);
		expect(filterScmCommits(history, "fix bob")).toHaveLength(0);
	});

	it("中文关键字照常匹配", () => {
		expect(filterScmCommits(history, "张三")).toHaveLength(1);
		expect(filterScmCommits(history, "增加过滤")).toHaveLength(1);
	});

	it("无命中返回空数组", () => {
		expect(filterScmCommits(history, "no-such-keyword")).toEqual([]);
	});
});
