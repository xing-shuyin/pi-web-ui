import { describe, expect, it } from "vitest";
import {
	buildDelegationPrompt,
	makeDelegateTaskTool,
	normalizeDelegation,
	validateDelegation,
	type DelegationInput,
} from "../../server/delegate-task.js";

import { readFileSync } from "node:fs";
import { registerServerStrings, unregisterServerStrings } from "../../server/i18n.js";

const USABLE = ["oracle", "explore", "sisyphus-junior"];

it("Russian delegation keeps tool restrictions, security mode and follow-up instructions", async () => {
	const pack = JSON.parse(readFileSync(new URL("../../locales/ru.json", import.meta.url), "utf8"));
	registerServerStrings("ru", pack.serverStrings);
	try {
		const host = {
			listTemplates: () => [{ name: "oracle", securityMode: "readonly" }],
			spawnSubagent: async () => "c-russian-delegate",
		} as any;
		const tool = makeDelegateTaskTool(host, () => "ru");
		const result = await tool.execute("test", good(), undefined, undefined, { cwd: "/test" } as any);
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("c-russian-delegate");
		expect(text).toContain("read, grep");
		expect(text).toContain("readonly");
		expect(text).toContain('subagent(action="wait_all")');
		expect(text).toContain('subagent(action="steer")');
		expect(text).not.toMatch(/\{[\w.]+\}/);
	} finally {
		unregisterServerStrings("ru");
	}
});

function good(over: Partial<DelegationInput> = {}): DelegationInput {
	return {
		agent: "oracle",
		task: "Evaluate the caching strategy for the new API layer in detail.",
		expected_outcome: "A ranked list of options with trade-offs and a recommendation.",
		required_tools: "read, grep",
		must_do: "Read the API layer code first; cite file paths.",
		must_not_do: "Do not edit files; analysis only.",
		context: "Repo uses layered architecture; see AGENTS.md.",
		...over,
	};
}

describe("normalizeDelegation — 脏参数不抛错", () => {
	it("null / 非对象 / 缺字段 → 空输入（交给校验报错）", () => {
		for (const v of [null, undefined, 42, "x", []]) {
			const n = normalizeDelegation(v);
			expect(n.agent).toBe("");
			expect(n.task).toBe("");
		}
	});

	it("非字符串字段按缺失处理；model 空白归一为 undefined", () => {
		const n = normalizeDelegation({ agent: 42, task: "x".repeat(30), model: "  " });
		expect(n.agent).toBe("");
		expect(n.model).toBeUndefined();
		const m = normalizeDelegation({ agent: " oracle ", model: "a/b" });
		expect(m.agent).toBe("oracle");
		expect(m.model).toBe("a/b");
	});
});

describe("validateDelegation — 糊弄被打回", () => {
	it("完整输入通过（中英）", () => {
		expect(validateDelegation(good(), USABLE, "zh")).toBeNull();
		expect(validateDelegation(good(), USABLE, "en")).toBeNull();
	});

	it("未知/停用模板 → 报错并列出可用模板", () => {
		const zh = validateDelegation(good({ agent: "nope" }), USABLE, "zh")!;
		expect(zh).toContain("nope");
		expect(zh).toContain("oracle");
		const en = validateDelegation(good({ agent: "" }), USABLE, "en")!;
		expect(en).toContain("Available templates");
	});

	it("TASK 太短 → 点名 TASK 段", () => {
		const e = validateDelegation(good({ task: "修一下" }), USABLE, "zh")!;
		expect(e).toContain("TASK");
		expect(e).toContain("20");
	});

	it("EXPECTED OUTCOME 太短 → 点名该段（英文）", () => {
		const e = validateDelegation(good({ expected_outcome: "done" }), USABLE, "en")!;
		expect(e).toContain("EXPECTED OUTCOME");
	});

	it.each(["required_tools", "must_do", "must_not_do", "context"] as const)("空段 %s → 报错", (field) => {
		const e = validateDelegation(good({ [field]: "  " }), USABLE, "zh")!;
		expect(e).not.toBeNull();
	});
});

describe("buildDelegationPrompt — 标准六段", () => {
	it("六段齐全 + 首行是 agent 与任务摘要", () => {
		const p = buildDelegationPrompt(good(), "en");
		for (const h of [
			"## TASK",
			"## EXPECTED OUTCOME",
			"## REQUIRED TOOLS",
			"## MUST DO",
			"## MUST NOT DO",
			"## CONTEXT",
		]) {
			expect(p).toContain(h);
		}
		expect(p.split("\n")[0]).toContain("oracle");
		expect(p).toContain("Evaluate the caching strategy");
	});

	it("收尾汇报纪律按语言切换", () => {
		expect(buildDelegationPrompt(good(), "zh")).toContain("汇报要简洁");
		expect(buildDelegationPrompt(good(), "en")).toContain("Report back concisely");
	});
});
