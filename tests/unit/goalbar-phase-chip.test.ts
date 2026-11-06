// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus } from "../../web/src/types.js";

let root: Root | null = null;

function mount(goal: Partial<GoalStatus>) {
	window.localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const full = {
		conversationId: "c-1",
		goal: "把 README 补全",
		reviewModel: null,
		maxRounds: 0,
		locked: true,
		execModel: null,
		reviewing: true,
		round: 2,
		status: "",
		verdict: "pending",
		wizard: { active: false },
		...goal,
	} as unknown as GoalStatus;
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, {
					goal: full,
					models: [],
					modelsLoading: false,
					activeConversationId: "c-1",
				} as unknown as Parameters<typeof GoalBar>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("目标条活跃芯片跟随 phase", () => {
	it("phase=executing → 显示「执行中… 第 2 轮」", () => {
		const container = mount({ phase: "executing" });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("执行中…");
		expect(chip!.textContent).toContain("第 2 轮");
		expect(chip!.textContent).not.toContain("审查中");
	});

	it("phase=reviewing → 显示「审查中… 第 2 轮」", () => {
		const container = mount({ phase: "reviewing" });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("审查中…");
	});

	it("phase 缺席（旧后端）→ 回落「审查中…」（行为不变）", () => {
		const container = mount({ phase: undefined });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("审查中…");
	});
});

describe("目标条轮次预算 / 执行者动态 / 用量", () => {
	it("有限预算 → 芯片显示 N/M", () => {
		const container = mount({ phase: "executing", maxRounds: 5, locked: true, round: 2 });
		const chip = container.querySelector(".goalbar-chip.reviewing")!;
		expect(chip.textContent).toContain("第 2/5 轮");
	});

	it("不限轮 → 芯片显示 N·不限", () => {
		const container = mount({ phase: "executing", maxRounds: 0, locked: true, round: 2 });
		const chip = container.querySelector(".goalbar-chip.reviewing")!;
		expect(chip.textContent).toContain("第 2 轮");
		expect(chip.textContent).toContain("不限");
	});

	it("执行者动态进 detail 行", () => {
		const container = mount({
			phase: "executing",
			roles: { executor: { convId: "c-exec", spawned: true, streaming: true, activity: "edit 运行中" } },
		});
		const details = [...container.querySelectorAll(".goalbar-detail")].map((e) => e.textContent ?? "");
		expect(details.some((t) => t.includes("edit 运行中"))).toBe(true);
	});

	it("累计用量进 detail 行（k 格式化，title 给精确值）", () => {
		const container = mount({ phase: "reviewing", usage: { inputTokens: 1500, outputTokens: 300 } });
		const el = [...container.querySelectorAll(".goalbar-detail")].find((e) =>
			(e.textContent ?? "").includes("tokens"),
		)!;
		expect(el).toBeTruthy();
		expect(el!.textContent).toContain("1.8k tokens");
		expect(el!.getAttribute("title")).toContain("1500");
	});
});

describe("目标条历史下拉", () => {
	function mountInactive(history: GoalStatus["history"]) {
		window.localStorage.setItem("pi-web-ui:lang", "zh");
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const full = {
			conversationId: "c-1",
			goal: null,
			reviewModel: null,
			maxRounds: 0,
			locked: true,
			execModel: null,
			reviewing: false,
			round: 0,
			status: "",
			verdict: "pending",
			wizard: { active: false },
			history,
		} as unknown as GoalStatus;
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(GoalBar, {
						goal: full,
						models: [],
						modelsLoading: false,
						activeConversationId: "c-1",
					} as unknown as Parameters<typeof GoalBar>[0]),
				),
			);
		});
		const pill = container.querySelector(".goalbar-hint") as HTMLElement | null;
		if (pill) act(() => pill.click());
		return container;
	}

	it("无历史不渲染入口，有历史点条目回填输入框", () => {
		const empty = mountInactive(undefined);
		expect(empty.querySelector(".goalbar-input")).toBeTruthy();
		expect([...empty.querySelectorAll(".goalbar-opt")].some((e) => (e.textContent ?? "").includes("历史"))).toBe(false);

		if (root) act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		const container = mountInactive([
			{ goal: "把 README 补全", verdict: "pass", rounds: 2, feedback: "全过", finishedAt: 1700000000000 },
			{ goal: "修 flaky 单测", verdict: "fail", rounds: 3, feedback: "未过", finishedAt: 1700000001000 },
		]);
		const trigger = [...container.querySelectorAll(".goalbar-opt")].find((e) =>
			(e.textContent ?? "").includes("历史"),
		) as HTMLElement;
		expect(trigger).toBeTruthy();
		expect(trigger.textContent).toContain("2");
		act(() => trigger.click());
		const items = [...container.querySelectorAll(".dd-model-name")].map((e) => e.textContent ?? "");
		expect(items.some((t) => t.includes("把 README 补全"))).toBe(true);
		expect(items.some((t) => t.includes("修 flaky 单测"))).toBe(true);
		const second = [...container.querySelectorAll(".dd-model-cell")][1] as HTMLElement;
		act(() => second.click());
		const input = container.querySelector(".goalbar-input") as HTMLInputElement;
		expect(input.value).toBe("修 flaky 单测");
	});
});
