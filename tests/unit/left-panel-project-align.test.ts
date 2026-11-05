import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

describe("LeftPanel 树状项目头部几何对齐守卫", () => {
	it("无层覆盖区守卫：.lp-project-header-item 激活态内边距与边框复位，绝不偏移", () => {
		// 截取末尾的结构性复位区
		const resetSectionIndex = CSS.lastIndexOf("树形项目头几何结构性复位");
		expect(resetSectionIndex).toBeGreaterThan(0);
		const resetSection = CSS.slice(resetSectionIndex);

		// 必须包含 lp-project-header-item.active 选择器
		expect(resetSection).toContain(".lp-project-header-item.active");

		// 必须锁定左侧内边距为 4px（与默认态 0 8px 0 4px 完全一致），border 必须为 none
		expect(resetSection).toMatch(/padding-left:\s*4px/);
		expect(resetSection).toMatch(/border:\s*none/);
	});

	it("项目头激活态高亮采用纯背景色区分，杜绝实体边框线造成难看视觉与像素位移", () => {
		// 校验 .lp-project-header-item.active 不带实体边框（border 为 none），仅纯背景色区分
		expect(CSS).toMatch(/\.lp-project-header-item\.active[\s\S]*?\{[^}]*border:\s*none/);
	});
});
