import { describe, expect, it } from "vitest";
import {
	TOOL_PROMPT_DESCRIPTION_CAP,
	TOOL_PROMPT_GUIDELINE_MAX,
	applyToolPromptOverrides,
	effectiveToolPrompt,
	normalizeToolPromptOverride,
	normalizeToolPromptOverrides,
	toolPromptOverrideOf,
	type ToolPromptSessionLike,
} from "../../server/tool-prompt-overrides.js";

it("migrates legacy terminal overrides deterministically before filtering known names", () => {
	expect(
		normalizeToolPromptOverrides(
			{ terminal_read: { description: "read" }, terminal_create: { description: "create" } },
			["terminal"],
		),
	).toEqual({ terminal: { description: "create" } });
	expect(
		normalizeToolPromptOverrides({ terminal: { description: "merged" }, terminal_create: { description: "create" } }, [
			"terminal",
		]),
	).toEqual({ terminal: { description: "merged" } });
});

function fakeSession() {
	const registry = new Map<string, { name?: string; description?: string }>([
		["bash", { name: "bash", description: "default bash" }],
		["read", { name: "read", description: "default read" }],
	]);
	const definitions = new Map<
		string,
		{ definition: { description?: string; promptSnippet?: string; promptGuidelines?: string[] } }
	>([
		["bash", { definition: { description: "default bash", promptSnippet: "run shell", promptGuidelines: ["g1"] } }],
		["read", { definition: { description: "default read", promptSnippet: "read files", promptGuidelines: ["r1"] } }],
	]);
	const snippets = new Map<string, string>([
		["bash", "run shell"],
		["read", "read files"],
	]);
	const guidelines = new Map<string, string[]>([
		["bash", ["g1"]],
		["read", ["r1"]],
	]);
	return {
		session: {
			_toolRegistry: registry,
			_toolDefinitions: definitions,
			_toolPromptSnippets: snippets,
			_toolPromptGuidelines: guidelines,
		} as ToolPromptSessionLike,
		registry,
		snippets,
		guidelines,
	};
}

describe("normalizeToolPromptOverride", () => {
	it("只保留非空字段；全空 → null", () => {
		expect(normalizeToolPromptOverride({ description: "  x  ", promptSnippet: "", promptGuidelines: [] })).toEqual({
			description: "x",
		});
		expect(normalizeToolPromptOverride({ description: "   " })).toBeNull();
		expect(normalizeToolPromptOverride(null)).toBeNull();
		expect(normalizeToolPromptOverride("x")).toBeNull();
	});

	it("guidelines 去空白行、保留顺序", () => {
		expect(normalizeToolPromptOverride({ promptGuidelines: [" a ", "", "b"] })?.promptGuidelines).toEqual(["a", "b"]);
	});

	it("description 超长截断到上限", () => {
		const long = "x".repeat(TOOL_PROMPT_DESCRIPTION_CAP + 100);
		expect(normalizeToolPromptOverride({ description: long })?.description?.length).toBe(TOOL_PROMPT_DESCRIPTION_CAP);
	});

	it("guidelines 条数封顶", () => {
		const many = Array.from({ length: TOOL_PROMPT_GUIDELINE_MAX + 20 }, (_, i) => `g${i}`);
		expect(normalizeToolPromptOverride({ promptGuidelines: many })?.promptGuidelines?.length).toBeLessThanOrEqual(
			TOOL_PROMPT_GUIDELINE_MAX,
		);
	});
});

describe("normalizeToolPromptOverrides", () => {
	it("丢掉空项/空对象/非法键", () => {
		expect(
			normalizeToolPromptOverrides({
				bash: { description: "b" },
				read: {},
				"  ": { description: "x" },
				"": { description: "y" },
				bad: 3,
			}),
		).toEqual({ bash: { description: "b" } });
	});

	it("非对象 → 空表", () => {
		expect(normalizeToolPromptOverrides(null)).toEqual({});
		expect(normalizeToolPromptOverrides(["a"])).toEqual({});
	});
});

describe("toolPromptOverrideOf", () => {
	it("缺省/空对象 → null", () => {
		expect(toolPromptOverrideOf(undefined, "bash")).toBeNull();
		expect(toolPromptOverrideOf({}, "bash")).toBeNull();
		expect(toolPromptOverrideOf({ bash: {} }, "bash")).toBeNull();
		expect(toolPromptOverrideOf({ bash: { description: "x" } }, "bash")).toEqual({ description: "x" });
	});
});

describe("effectiveToolPrompt", () => {
	it("覆盖字段优先，缺省回落默认", () => {
		const base = { description: "d", promptSnippet: "s", promptGuidelines: ["a"] };
		expect(effectiveToolPrompt(base, null)).toEqual(base);
		expect(effectiveToolPrompt(base, { description: "D" })).toEqual({
			description: "D",
			promptSnippet: "s",
			promptGuidelines: ["a"],
		});
	});
});

describe("applyToolPromptOverrides", () => {
	it("打三处补丁：description / snippet / guidelines", () => {
		const { session, registry, snippets, guidelines } = fakeSession();
		const applied = applyToolPromptOverrides(session, {
			bash: { description: "custom bash", promptSnippet: "run it", promptGuidelines: ["gg"] },
		});
		expect(applied).toEqual(["bash"]);
		expect(registry.get("bash")!.description).toBe("custom bash");
		expect(snippets.get("bash")).toBe("run it");
		expect(guidelines.get("bash")).toEqual(["gg"]);
		expect(registry.get("read")!.description).toBe("default read");
		expect(snippets.get("read")).toBe("read files");
	});

	it("幂等且清空覆盖后复原到出厂默认", () => {
		const { session, registry, snippets, guidelines } = fakeSession();
		applyToolPromptOverrides(session, { bash: { description: "custom" } });
		applyToolPromptOverrides(session, { bash: { description: "custom2", promptSnippet: "s2" } });
		expect(registry.get("bash")!.description).toBe("custom2");
		expect(snippets.get("bash")).toBe("s2");
		applyToolPromptOverrides(session, {});
		expect(registry.get("bash")!.description).toBe("default bash");
		expect(snippets.get("bash")).toBe("run shell");
		expect(guidelines.get("bash")).toEqual(["g1"]);
	});

	it("会话结构不符（SDK 改私有字段名）→ null 降级", () => {
		expect(applyToolPromptOverrides({} as ToolPromptSessionLike, { bash: { description: "x" } })).toBeNull();
		expect(applyToolPromptOverrides(undefined, { bash: { description: "x" } })).toBeNull();
		expect(applyToolPromptOverrides({ _toolRegistry: new Map() } as ToolPromptSessionLike, {})).toBeNull();
	});

	it("打完补丁后用当前活跃集重建系统提示词选项", () => {
		const { session } = fakeSession();
		const setCalls: string[][] = [];
		session.getActiveToolNames = () => ["bash", "read"];
		session.setActiveToolsByName = (names) => setCalls.push(names);
		applyToolPromptOverrides(session, { bash: { promptSnippet: "s" } });
		expect(setCalls).toEqual([["bash", "read"]]);
	});
});
