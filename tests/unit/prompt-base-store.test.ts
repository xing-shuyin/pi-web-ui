import { describe, expect, it } from "vitest";
import { createPromptBaseObservers, readPromptBase, recordPromptBaseLoader } from "../../server/prompt-base-store.js";

const EMPTY_RECORD = { system: "", soul: "", append: [] };

describe("prompt-base-store — base 归属 loader", () => {
	it("未登记的 loader 读到空记录（= 内置默认提示词，不串账）", () => {
		const loader = {};
		expect(readPromptBase(loader)).toEqual(EMPTY_RECORD);
	});

	it("两个 loader 互不可见：A 有 SYSTEM.md 不影响 B", () => {
		const loaderA = {};
		const loaderB = {};
		recordPromptBaseLoader(loaderA, { system: "You are summarization master.", soul: "", append: ["# append a"] });
		expect(readPromptBase(loaderA).system).toBe("You are summarization master.");
		expect(readPromptBase(loaderB)).toEqual(EMPTY_RECORD);
	});

	it("覆盖式登记：base 变空即清空（删掉 SYSTEM.md 后 reload 不残留）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "old prompt", soul: "old prompt", append: ["old append"] });
		recordPromptBaseLoader(loader, { system: "", soul: "", append: [] });
		expect(readPromptBase(loader)).toEqual(EMPTY_RECORD);
	});

	it("undefined / null base 一律归一为空（SDK 无文件时就是 undefined）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "x", soul: "x", append: ["y"] });
		recordPromptBaseLoader(loader, {
			system: undefined as unknown as string,
			soul: undefined as unknown as string,
			append: undefined as unknown as string[],
		});
		expect(readPromptBase(loader)).toEqual(EMPTY_RECORD);
	});

	it("纯空白 SYSTEM.md 原样保留（TUI 同语义：空提示词，不是「没文件」）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: " \n", soul: " \n", append: [] });
		expect(readPromptBase(loader).system).toBe(" \n");
	});

	it("记录与读出的数组不共享引用（调用方改动不影响已登记值）", () => {
		const loader = {};
		const append = ["one"];
		recordPromptBaseLoader(loader, { system: "", soul: "", append });
		append.push("two");
		expect(readPromptBase(loader).append).toEqual(["one"]);
	});

	it("loader 缺失 → 空记录（不抛错）", () => {
		expect(readPromptBase(undefined)).toEqual(EMPTY_RECORD);
		recordPromptBaseLoader(undefined, { system: "ignored", soul: "ignored", append: [] });
		expect(readPromptBase(undefined)).toEqual(EMPTY_RECORD);
	});

	it("过户语义：同一 loader 换宿主读取，记录仍在（记录跟 session 走）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "project prompt", soul: "project prompt", append: [] });
		const readFromNewHolder = () => readPromptBase(loader);
		expect(readFromNewHolder().system).toBe("project prompt");
	});

	it("老调用方只登记 system 时 soul 跟随 system（没有覆盖 = 灵魂就是原文）", () => {
		const loader = {};
		recordPromptBaseLoader(loader, { system: "legacy", append: [] } as never);
		expect(readPromptBase(loader)).toEqual({ system: "legacy", soul: "legacy", append: [] });
	});
});

describe("prompt-base-store — 灵魂槽位（子代理模板 replace，issue #999）", () => {
	function observe(soul?: () => string | undefined) {
		const loader = {};
		const observers = createPromptBaseObservers(soul ? { soul } : {});
		observers.bind(loader);
		return { loader, observers };
	}

	it("没有 SYSTEM.md 时模板照样生效（旧实现要求 base 非空才生效）", () => {
		const { loader, observers } = observe(() => "You are a strict reviewer.");
		expect(observers.systemPromptOverride(undefined)).toBe("You are a strict reviewer.");
		expect(readPromptBase(loader)).toEqual({ system: "", soul: "You are a strict reviewer.", append: [] });
	});

	it("有 SYSTEM.md 时 soul 用模板，system 仍记原文（预览/迁移读原文）", () => {
		const { loader, observers } = observe(() => "You are a strict reviewer.");
		expect(observers.systemPromptOverride("You are Pi.")).toBe("You are a strict reviewer.");
		expect(readPromptBase(loader)).toEqual({
			system: "You are Pi.",
			soul: "You are a strict reviewer.",
			append: [],
		});
	});

	it("无覆盖时 soul = system，override 原样返回 base（旧语义逐字不变）", () => {
		const { loader, observers } = observe();
		expect(observers.systemPromptOverride("You are Pi.")).toBe("You are Pi.");
		expect(readPromptBase(loader).soul).toBe("You are Pi.");
		expect(observers.systemPromptOverride(undefined)).toBeUndefined();
		expect(readPromptBase(loader)).toEqual({ system: "", soul: "", append: [] });
	});

	it("空白 soul 覆盖不生效（模板 trim 后为空 = 不改灵魂）", () => {
		const { loader, observers } = observe(() => "  \n");
		expect(observers.systemPromptOverride("You are Pi.")).toBe("You are Pi.");
		expect(readPromptBase(loader).soul).toBe("You are Pi.");
	});

	it("reload 重放：同一 loader 二次观察，soul 跟当前模板（记录无条件覆盖）", () => {
		const loader = {};
		let template = "first";
		const observers = createPromptBaseObservers({ soul: () => template });
		observers.bind(loader);
		observers.systemPromptOverride(undefined);
		expect(readPromptBase(loader).soul).toBe("first");
		template = "second";
		observers.systemPromptOverride(undefined);
		expect(readPromptBase(loader).soul).toBe("second");
	});
});
