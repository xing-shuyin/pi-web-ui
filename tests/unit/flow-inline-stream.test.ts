import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW_BASE = readFileSync(join(ROOT, "themes", "bases", "flow-base.css"), "utf8");
const MESSAGE_LIST = readFileSync(join(ROOT, "web", "src", "components", "MessageList.tsx"), "utf8");
const FLOW_MODE = readFileSync(join(ROOT, "web", "src", "flow-mode.ts"), "utf8");

function ruleBlock(prefix: string): string {
	const i = FLOW_BASE.indexOf(prefix);
	expect(i, `缺少规则 ${prefix}`).toBeGreaterThan(-1);
	return FLOW_BASE.slice(i, FLOW_BASE.indexOf("}", i) + 1);
}

const CHIP_RULE_PREFIX = ".flow-turn .toolcall,";

describe("极简行文字级输入流布局契约", () => {
	it("容器是弹性行流：flex + wrap + 行列统一的 gap（间距单源，不再靠逐元素 margin 互斗）", () => {
		const turn = ruleBlock(".flow-turn {");
		expect(turn).toContain("display: flex;");
		expect(turn).toContain("flex-wrap: wrap;");
		expect(turn).toContain("align-items: center;");
		expect(turn).toMatch(/gap: \d+px;/);
	});

	it("非胶囊内容一律 100% 宽项（正文 / 附件 / 报错独占整行，前后必断行）", () => {
		const items = ruleBlock(".flow-turn .msg-body > * {");
		expect(items).toContain("flex: 0 0 100%;");
	});

	it("胶囊是行内项：定高 22px + 行内居中，工具与思考永远同行同高", () => {
		const chips = ruleBlock(CHIP_RULE_PREFIX);
		expect(chips).toContain("flex: 0 0 auto;");
		expect(chips).toContain("align-self: center;");
		expect(chips).toContain("height: 22px;");
		expect(chips).not.toContain("height: 23px");
		expect(chips).toContain("margin: 0;");
	});

	it("正文与胶囊的间距由容器 gap + 正文项外边距提供，正文项不得被行内化", () => {
		const text = ruleBlock(".flow-turn .msg-text {");
		expect(text).toMatch(/margin: \d+px 0;/);
		expect(text).not.toContain("display: inline");
		expect(text).not.toContain("display: inline-flex");
	});

	it("渲染层与样式表的容器类名一致（防「改了 CSS 忘了 JS」与前端包过期）", () => {
		expect(MESSAGE_LIST).toContain('variant === "flow" ? "flow-turn"');
		expect(FLOW_BASE).toContain(".flow-turn {");
		expect(MESSAGE_LIST).toContain("mergeTurns");
	});

	it("主题用自定义属性声明能力，前端据此切换渲染（不维护主题 id 白名单）", () => {
		expect(FLOW_BASE).toContain("--flow-inline-stream: 1;");
		expect(FLOW_MODE).toContain('"--flow-inline-stream"');
		expect(FLOW_MODE).toContain("THEME_CHANGE_EVENT");
	});

	it("胶囊不带 backdrop-filter：行内重复项每颗各占一个合成表面（issue #858）", () => {
		// 带 backdrop-filter 的元素无法与滚动内容共用光栅层。胶囊是 flex 行流里的重复项，
		// 一个回合几十上百颗 ⇒ 几十上百个合成层（300 颗实测 310 层 vs 去掉后 11 层）。
		// 而 flow 家族 --bg-image: none，模糊的是均匀中性色，本来就买不到任何毛玻璃信息。
		const capsuleAt = FLOW_BASE.indexOf(".toolcall,\n.thinking {");
		expect(capsuleAt, "缺少胶囊基座规则 .toolcall, .thinking").toBeGreaterThan(-1);
		const capsule = FLOW_BASE.slice(capsuleAt, FLOW_BASE.indexOf("}", capsuleAt));
		expect(capsule).toContain("backdrop-filter: none;");

		const offenders: string[] = [];
		for (const [, selector, body] of FLOW_BASE.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			if (!/\.(toolcall|thinking)\b/.test(selector)) continue;
			if (/backdrop-filter:\s*blur/.test(body)) offenders.push(selector.trim());
		}
		expect(offenders, "胶囊（.toolcall / .thinking）不得重新引入 backdrop-filter 模糊").toEqual([]);
	});
});
