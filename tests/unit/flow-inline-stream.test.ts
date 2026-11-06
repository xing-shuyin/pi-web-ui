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
});
