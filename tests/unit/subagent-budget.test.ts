import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_SPAWNS_PER_RUN,
	spawnBudgetLimitFromEnv,
	SubagentSpawnBudget,
} from "../../server/subagent-budget.js";

afterEach(() => {
	const env = process.env as Record<string, string | undefined>;
	delete env.PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN;
});

describe("SubagentSpawnBudget", () => {
	it("按运行树累计，超出上限拒绝", () => {
		const budget = new SubagentSpawnBudget(2);
		expect(budget.reserve("root-a")).toEqual({ ok: true, count: 1 });
		expect(budget.reserve("root-a")).toEqual({ ok: true, count: 2 });
		expect(budget.reserve("root-a")).toEqual({ ok: false, count: 2, limit: 2 });
		expect(budget.countOf("root-a")).toBe(2);
	});

	it("不同运行树互不影响", () => {
		const budget = new SubagentSpawnBudget(1);
		expect(budget.reserve("root-a").ok).toBe(true);
		expect(budget.reserve("root-b").ok).toBe(true);
		expect(budget.reserve("root-a").ok).toBe(false);
	});

	it("失败退还名额，forget 清掉整棵树", () => {
		const budget = new SubagentSpawnBudget(2);
		budget.reserve("root-a");
		budget.reserve("root-a");
		budget.refund("root-a");
		expect(budget.countOf("root-a")).toBe(1);
		budget.forget("root-a");
		expect(budget.countOf("root-a")).toBe(0);
		expect(budget.reserve("root-a").ok).toBe(true);
		budget.refund("missing");
		expect(budget.countOf("missing")).toBe(0);
	});

	it("limit=0 表示不限制", () => {
		const budget = new SubagentSpawnBudget(0);
		for (let i = 0; i < 200; i++) expect(budget.reserve("root").ok).toBe(true);
		expect(budget.countOf("root")).toBe(200);
	});

	it("环境变量覆盖默认值，非法值回落到默认", () => {
		expect(DEFAULT_MAX_SPAWNS_PER_RUN).toBe(64);
		expect(spawnBudgetLimitFromEnv({} as NodeJS.ProcessEnv)).toBe(64);
		expect(spawnBudgetLimitFromEnv({ PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN: "5" } as never)).toBe(5);
		expect(spawnBudgetLimitFromEnv({ PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN: "0" } as never)).toBe(0);
		expect(spawnBudgetLimitFromEnv({ PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN: "abc" } as never)).toBe(64);
		expect(spawnBudgetLimitFromEnv({ PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN: "-3" } as never)).toBe(64);
	});
});
