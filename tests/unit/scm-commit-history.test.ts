/**
 * 提交信息历史纯函数：记住（去重置顶 + 上限）、读回（坏 JSON 容错）、
 * ↑/↓ 循环回溯（shell 风格，草稿保存/恢复）。storage 可注入。
 */
import { describe, expect, it } from "vitest";
import {
	COMMIT_RECALL_INITIAL,
	SCM_COMMIT_HISTORY_CAP,
	cycleCommitRecall,
	loadCommitHistory,
	rememberCommitMessage,
	type KvStorage,
} from "../../web/src/scm-commit-history.js";

/** 内存 storage（测试注入用）。 */
function memStorage(initial: Record<string, string> = {}): KvStorage & { data: Record<string, string> } {
	const data: Record<string, string> = { ...initial };
	return {
		data,
		getItem: (k) => data[k] ?? null,
		setItem: (k, v) => {
			data[k] = v;
		},
	};
}

describe("rememberCommitMessage / loadCommitHistory", () => {
	it("空串 / 纯空白忽略", () => {
		const s = memStorage();
		expect(rememberCommitMessage("  ", s)).toEqual([]);
		expect(s.data["scm-commit-history"]).toBeUndefined();
	});

	it("去重置顶：重复提交的旧条目上移", () => {
		const s = memStorage();
		rememberCommitMessage("a", s);
		rememberCommitMessage("b", s);
		expect(rememberCommitMessage("a", s)).toEqual(["a", "b"]);
	});

	it("上限 20 条，最旧的先被挤掉", () => {
		const s = memStorage();
		for (let i = 0; i < SCM_COMMIT_HISTORY_CAP + 5; i++) rememberCommitMessage(`m${i}`, s);
		const list = loadCommitHistory(s);
		expect(list).toHaveLength(SCM_COMMIT_HISTORY_CAP);
		expect(list[0]).toBe(`m${SCM_COMMIT_HISTORY_CAP + 4}`);
		expect(list).not.toContain("m0");
	});

	it("坏 JSON / 非字符串数组容错为空列表", () => {
		expect(loadCommitHistory(memStorage({ "scm-commit-history": "{oops" }))).toEqual([]);
		expect(loadCommitHistory(memStorage({ "scm-commit-history": JSON.stringify([1, "a", null]) }))).toEqual(["a"]);
	});
});

describe("cycleCommitRecall", () => {
	const entries = ["first", "second", "third"];

	it("空历史不动", () => {
		expect(cycleCommitRecall([], COMMIT_RECALL_INITIAL, "draft", "up")).toBeNull();
	});

	it("↑ 从 live 进入第一条，并把当前输入存为草稿", () => {
		const hit = cycleCommitRecall(entries, COMMIT_RECALL_INITIAL, "my draft", "up");
		expect(hit).toEqual({ state: { idx: 0, draft: "my draft" }, text: "first" });
	});

	it("↑ 连续翻到最旧一条后停住（不再动）", () => {
		const st = { idx: 2, draft: "d" };
		expect(cycleCommitRecall(entries, st, "", "up")).toBeNull();
	});

	it("↓ 从第一条退回 live 并恢复草稿", () => {
		const hit = cycleCommitRecall(entries, { idx: 0, draft: "my draft" }, "", "down");
		expect(hit).toEqual({ state: COMMIT_RECALL_INITIAL, text: "my draft" });
	});

	it("↓ 在 live 态不动", () => {
		expect(cycleCommitRecall(entries, COMMIT_RECALL_INITIAL, "", "down")).toBeNull();
	});

	it("↑/↓ 中途来回取值正确", () => {
		const up1 = cycleCommitRecall(entries, COMMIT_RECALL_INITIAL, "x", "up");
		const up2 = cycleCommitRecall(entries, up1!.state, "", "up");
		expect(up2!.text).toBe("second");
		const down1 = cycleCommitRecall(entries, up2!.state, "", "down");
		expect(down1!.text).toBe("first");
	});
});
