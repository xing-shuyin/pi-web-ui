import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildSessionTranscript,
	isVisibleOnBranch,
	parseSessionEntries,
	projectSessionText,
	selectSessionBranch,
} from "../../server/session-projection.js";
import { scanSessionForSearch } from "../../server/session-search.js";
import { blankNonCode } from "../helpers/code-scan.js";
import { codeFiles } from "../helpers/guard-roots.js";

/**
 * 会话投影单源（issue #979）。
 *
 * 转录是真值：叶指针 + `context_edit` 决定「现在还剩什么」。这一组用例既验行为
 * （删除 / 弃用分支 / 压缩前的计划），也验形状（谁都不许再自己解 jsonl）。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { text?: string }).text ?? "").join("");
}

function withSessionDir<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "session-projection-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** assistant 消息必须带齐 api/provider/model/usage/stopReason（SDK 类型要求）。 */
function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "test",
		stopReason: "toolUse" as const,
		timestamp,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("projectSessionText：删除与替换", () => {
	it("context_edit 抹掉的目标不出现在投影里，替换内容仍可见", () => {
		withSessionDir((dir) => {
			const manager = SessionManager.create(dir, dir);
			const keep = manager.appendMessage({ role: "user", content: "保留这句", timestamp: 10 });
			const secret = manager.appendMessage(assistantMessage("删掉的回答", 20));
			const redactTarget = manager.appendMessage({ role: "user", content: "原文", timestamp: 30 });
			const tail = manager.appendMessage({ role: "user", content: "后面还有", timestamp: 40 });
			expect(typeof keep).toBe("string");
			manager.appendContextEdit(secret, null);
			manager.appendContextEdit(redactTarget, { content: "[已脱敏]" });
			expect(typeof tail).toBe("string");

			const text = readFileSync(manager.getSessionFile()!, "utf8");
			const projected = projectSessionText(text);
			const roles = projected.messages.map((m) => m.role);
			expect(roles).toEqual(["user", "user", "user"]);
			const texts = projected.messages.map((m) => messageText(m));
			expect(texts).toContain("保留这句");
			expect(texts).not.toContain("删掉的回答");
			expect(texts).toContain("[已脱敏]");
			expect(texts).not.toContain("原文");
		});
	});

	it("历史读取（同一份 jsonl）不再把已删消息交出去：关闭会话读已删消息返回空", () => {
		withSessionDir((dir) => {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({ role: "user", content: "问题", timestamp: 1 });
			const gone = manager.appendMessage(assistantMessage("这段要被删", 2));
			manager.appendMessage({ role: "user", content: "收尾", timestamp: 3 });
			manager.appendContextEdit(gone, null);

			// 关闭会话后只能按文件路径读：投影必须与运行态一致。
			const text = readFileSync(manager.getSessionFile()!, "utf8");
			const projected = projectSessionText(text);
			expect(projected.messages.map((m) => messageText(m))).toEqual(["问题", "收尾"]);
			// 被删目标仍作为一个来源条目存在，但它不再贡献任何可见消息。
			const omitted = projected.entries.find((entry) => entry.sourceEntry.id === gone);
			expect(omitted?.messages).toEqual([]);
		});
	});

	it("坏行跳过，session 头不进条目（与 getEntries 同口径）", () => {
		const text = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w", timestamp: "2024-01-01T00:00:00Z" }),
			"{broken",
			JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }),
		].join("\n");
		const entries = parseSessionEntries(text);
		expect(entries.map((entry) => entry.id)).toEqual(["m1"]);
		expect(projectSessionText(text).messages).toHaveLength(1);
	});
});

describe("projectSessionText：叶链", () => {
	it("弃用分支的消息不出现（叶 = 用户最后续写的那条）", () => {
		withSessionDir((dir) => {
			const manager = SessionManager.create(dir, dir);
			const root = manager.appendMessage({ role: "user", content: "主线提问", timestamp: 10 });
			const mainAnswer = manager.appendMessage(assistantMessage("主线回答", 20));
			manager.branch(root);
			manager.appendMessage({ role: "user", content: "分叉后被弃用的提问", timestamp: 30 });
			manager.branch(mainAnswer);
			manager.appendMessage(assistantMessage("主线续答", 40));

			const text = readFileSync(manager.getSessionFile()!, "utf8");
			const projected = projectSessionText(text);
			expect(projected.leafId).not.toBeNull();
			const texts = projected.messages.map((m) => messageText(m));
			expect(texts).toEqual(["主线提问", "主线回答", "主线续答"]);
			expect(texts).not.toContain("分叉后被弃用的提问");
		});
	});

	it("压缩点之前的条目仍在叶链上（压缩只裁模型上下文，不改成员判据）", () => {
		const entries = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: { role: "user", content: "早先的提问" },
			},
			{
				type: "custom",
				id: "p1",
				parentId: "m1",
				customType: "plan/update",
				timestamp: "2024-01-01T00:01:00Z",
				data: { plan: { steps: [], activeStepId: null, updatedAt: 1 } },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "p1",
				summary: "s",
				firstKeptEntryId: "c1",
				tokensBefore: 1,
				timestamp: "2024-01-01T00:01:30Z",
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: "2024-01-01T00:02:00Z",
				message: { role: "assistant", content: "压缩后的回答" },
			},
		];
		const branch = selectSessionBranch(entries);
		expect(branch.leafId).toBe("m2");
		// 计划事件在压缩点之前：模型上下文里被摘要盖掉了，但它仍在叶链上。
		expect(branch.branchIds.has("p1")).toBe(true);
		expect(isVisibleOnBranch(branch, "p1")).toBe(true);
		expect(isVisibleOnBranch(branch, "m1")).toBe(true);
		const projected = buildSessionTranscript(entries);
		expect(projected.messages.map((m) => m.role)).toEqual(["compactionSummary", "assistant"]);
	});

	it("没有可用树结构（老文件 / 无 id）时整份文件就是唯一分支", () => {
		const branch = selectSessionBranch([{ type: "message" }, { type: "message" }]);
		expect(branch.leafId).toBeNull();
		expect(isVisibleOnBranch(branch, undefined)).toBe(true);
	});

	it("同一目标被多次 context_edit：叶链上最后一条说了算（与 SDK 投影同口径）", () => {
		const deletedLast = [
			{ type: "message", id: "m1", parentId: null },
			{ type: "context_edit", id: "e1", parentId: "m1", targetId: "m1", replacement: { content: "x" } },
			{ type: "context_edit", id: "e2", parentId: "e1", targetId: "m1", replacement: null },
		];
		expect(isVisibleOnBranch(selectSessionBranch(deletedLast), "m1")).toBe(false);
		const replacedLast = [
			{ type: "message", id: "m1", parentId: null },
			{ type: "context_edit", id: "e1", parentId: "m1", targetId: "m1", replacement: null },
			{ type: "context_edit", id: "e2", parentId: "e1", targetId: "m1", replacement: { content: "x" } },
		];
		expect(isVisibleOnBranch(selectSessionBranch(replacedLast), "m1")).toBe(true);
	});
});

describe("历史检索按投影口径过滤", () => {
	it("已删消息与弃用分支的命中都不返回", async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-projection-search-"));
		try {
			const path = join(dir, "session.jsonl");
			const header = { type: "session", version: 3, id: "s1", cwd: "/w", timestamp: "2024-01-01T00:00:00Z" };
			const entry = (id: string, parentId: string | null, content: string, timestamp: number) => ({
				type: "message",
				id,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content, timestamp },
			});
			const records = [
				header,
				entry("m1", null, "needle 主线", 10),
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: new Date(20).toISOString(),
					message: { role: "assistant", content: "needle 会被删", timestamp: 20 },
				},
				{ type: "context_edit", id: "e1", parentId: "m2", targetId: "m2", replacement: null },
				entry("m3", "e1", "needle 收尾", 60),
			];
			// 弃用分支：从 m1 分叉出去的命中不在叶链上（最后一条消息的时间早于主线）。
			records.push(entry("f1", "m1", "needle 弃用分支", 40));
			records.push(entry("f2", "f1", "needle 弃用分支收尾", 50));
			await writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));

			const scan = await scanSessionForSearch(path, "needle");
			expect(scan.matched).toBe(true);
			expect(scan.anchors.map((anchor) => anchor.timestamp)).toEqual([10, 60]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("会话投影单源守卫", () => {
	/** 按模块基名记账：搬家（server/ → packages/keel/src/）后断言不变。 */
	function guardSources(): { name: string; source: string; code: string }[] {
		return codeFiles().map((file) => {
			const source = readFileSync(file, "utf8");
			return { name: basename(file, ".ts"), source, code: blankNonCode(source) };
		});
	}

	it("解 jsonl 的裸实现只剩投影模块：parseSessionEntries 只出现在它一处", () => {
		const sources = guardSources();
		for (const { source, name } of sources) {
			expect(source, `${name} 又自己解转录了：请用 session-projection 的 projectSessionText()`).not.toContain(
				"parseTranscriptLines",
			);
		}
		// 注释里点名不算第二份实现，只看代码。
		expect(sources.filter(({ code }) => code.includes("parseSessionEntries")).map(({ name }) => name)).toEqual([
			"session-projection",
		]);
		// 叶选择只有一份实现。
		expect(
			sources.filter(({ code }) => code.includes("export function selectBestSessionLeaf")).map(({ name }) => name),
		).toEqual(["session-branch"]);
	});

	it("conversation_read 的 files/status 不再并集 .touches.json", () => {
		const source = readFileSync(join(ROOT, "server/conversation-read-tool.ts"), "utf8");
		expect(source).not.toContain("readTouchSidecar");
		expect(source).not.toContain("unionTouchLists");
	});

	it("状态类读取一律沿叶链：permission-preset 不再 getEntries() 全文件倒序", () => {
		const source = readFileSync(join(ROOT, "server/permission-preset.ts"), "utf8");
		expect(source).not.toContain(".getEntries(");
		// 读实现（`lastBranchEvent`）搬到了 chat-mode-entries.ts（适配器要复用同一份三态写侧）：
		// 叶链判据跟着搬，两个文件都不许退回去倒序遍历整份转录。
		const leaf = readFileSync(join(ROOT, "server/chat-mode-entries.ts"), "utf8");
		expect(leaf).toContain("getBranch");
		// 叶链实现里只允许提到 `getEntries()` 的注释（说明它为什么不能用），不许真的调它。
		expect(leaf).not.toMatch(/\.getEntries\s*\(/);
	});
});
