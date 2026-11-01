/**
 * prompt-base-store —— SYSTEM.md / APPEND_SYSTEM.md base 的归属守卫（issue #812）。
 *
 * 要守的语义只有一条：**base 属于 loader（= session），不属于客户端**。
 *  - 没文件的项目没有记录 → 空 base（内置默认），绝不会沿用别的会话的值；
 *  - 有文件 → 每次 reload 覆盖式登记（base 变空也覆盖），所以「删掉 SYSTEM.md
 *    再 reload」「切到无 SYSTEM.md 的项目」都不会留旧值；
 *  - key 是 loader 对象本身：过户把 session 搬给另一个 ClientSession 时，记录跟着
 *    会话走，新宿主读得到（旧实现存在客户端字段里，过户即丢/即串）。
 */
import { describe, expect, it } from "vitest";
import { readPromptBase, recordPromptBaseLoader } from "../../server/prompt-base-store.js";

describe("prompt-base-store — base 归属 loader", () => {
	it("未登记的 loader 读到空记录（= 内置默认提示词，不串账）", () => {
		const loader = {};
		expect(readPromptBase(loader)).toEqual({ system: "", append: [] });
	});

	it("两个 loader 互不可见：A 有 SYSTEM.md 不影响 B", () => {
		const loaderA = {};
		const loaderB = {};
		recordPromptBaseLoader(loaderA, { system: "You are summarization master.", append: ["# append a"] });
		expect(readPromptBase(loaderA).system).toBe("You are summarization master.");
		expect(readPromptBase(loaderB)).toEqual({ system: "", append: [] });
	});

	it("覆盖式登记：base 变空即清空（删掉 SYSTEM.md 后 reload 不残留）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "old prompt", append: ["old append"] });
		recordPromptBaseLoader(loader, { system: "", append: [] });
		expect(readPromptBase(loader)).toEqual({ system: "", append: [] });
	});

	it("undefined / null base 一律归一为空（SDK 无文件时就是 undefined）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "x", append: ["y"] });
		recordPromptBaseLoader(loader, {
			system: undefined as unknown as string,
			append: undefined as unknown as string[],
		});
		expect(readPromptBase(loader)).toEqual({ system: "", append: [] });
	});

	it("纯空白 SYSTEM.md 原样保留（TUI 同语义：空提示词，不是「没文件」）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: " \n", append: [] });
		expect(readPromptBase(loader).system).toBe(" \n");
	});

	it("记录与读出的数组不共享引用（调用方改动不影响已登记值）", () => {
		const loader = {};
		const append = ["one"];
		recordPromptBaseLoader(loader, { system: "", append });
		append.push("two");
		expect(readPromptBase(loader).append).toEqual(["one"]);
	});

	it("loader 缺失 → 空记录（不抛错）", () => {
		expect(readPromptBase(undefined)).toEqual({ system: "", append: [] });
		recordPromptBaseLoader(undefined, { system: "ignored", append: [] });
		expect(readPromptBase(undefined)).toEqual({ system: "", append: [] });
	});

	it("过户语义：同一 loader 换宿主读取，记录仍在（记录跟 session 走）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "project prompt", append: [] });
		// 过户 = session（含 loader）搬到另一个 ClientSession；读取侧只有 loader 句柄，
		// 所以记录必须挂在 loader 上而不是挂在读取方身上。
		const readFromNewHolder = () => readPromptBase(loader);
		expect(readFromNewHolder().system).toBe("project prompt");
	});
});
