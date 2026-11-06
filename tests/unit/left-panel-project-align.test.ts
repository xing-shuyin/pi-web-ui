import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

describe("LeftPanel 树状项目头部几何对齐守卫", () => {
	it("无层覆盖区守卫：.lp-project-header-item 激活态内边距与边框复位，绝不偏移", () => {
		const resetSectionIndex = CSS.lastIndexOf("\n.lp-project-header-item,\n");
		expect(resetSectionIndex).toBeGreaterThan(0);
		const resetSection = CSS.slice(resetSectionIndex);

		expect(resetSection).toContain(".lp-project-header-item.active");

		expect(resetSection).toMatch(/padding-left:\s*4px/);
		expect(resetSection).toMatch(/border:\s*none/);
	});

	it("项目头激活态高亮采用纯背景色区分，杜绝实体边框线造成难看视觉与像素位移", () => {
		expect(CSS).toMatch(/\.lp-project-header-item\.active[\s\S]*?\{[^}]*border:\s*none/);
	});
});
