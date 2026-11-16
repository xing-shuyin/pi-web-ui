/**
 * 图标编辑体验守卫：
 *   · 每个条目右上角都有 ×，点一下即隐藏（不必拖到面板最底部的隐藏区）；
 *   · 隐藏区常驻面板底部，不跟中间滚动区一起滚；
 *   · 文案纯中文，分段不再直出 start/center/end。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const EDITOR_SRC = readFileSync(join(ROOT, "web", "src", "components", "IconEditor.tsx"), "utf8");
const SETTINGS_SRC = readFileSync(join(ROOT, "web", "src", "components", "SettingsModal.tsx"), "utf8");
const STYLES_SRC = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
const ZH = JSON.parse(readFileSync(join(ROOT, "web", "src", "i18n", "messages", "core", "zh.json"), "utf8")) as Record<
	string,
	string
>;
const EN = JSON.parse(readFileSync(join(ROOT, "web", "src", "i18n", "messages", "core", "en.json"), "utf8")) as Record<
	string,
	string
>;

describe("图标编辑：一键隐藏", () => {
	it("条目渲染了右上角 ×，点击走 applyIconHide（与拖进隐藏区同一条路径）", () => {
		expect(EDITOR_SRC).toContain('className="icon-editor-chip-hide"');
		expect(EDITOR_SRC).toMatch(/const hideEntry = \(id: string\) => \{[\s\S]*?applyIconHide\(/);
		expect(EDITOR_SRC).toContain("hideEntry(entry.id)");
		// × 压在 chip 上，不能把它当成拖拽起手
		expect(EDITOR_SRC).toContain("onPointerDown={(e) => e.stopPropagation()}");
	});

	it("固定入口（设置 / 历史 / 文件）不给 ×：隐藏写了也不生效，别给假按钮", () => {
		expect(EDITOR_SRC).toMatch(/const hideable = !inTray && !REQUIRED_TOPBAR_ITEM_IDS\.has\(entry\.id\)/);
	});

	it("隐藏区在滚动区外、常驻面板底部（body 只包四个栏）", () => {
		expect(EDITOR_SRC).toContain('className="icon-editor-tray"');
		expect(EDITOR_SRC).not.toContain("icon-editor-zone-tray");
		const bodyOpen = EDITOR_SRC.indexOf('className="icon-editor-body"');
		const bodyClose = EDITOR_SRC.indexOf("</div>", EDITOR_SRC.indexOf("})}", bodyOpen));
		const tray = EDITOR_SRC.indexOf('className="icon-editor-tray"');
		expect(bodyOpen).toBeGreaterThan(-1);
		expect(bodyClose).toBeGreaterThan(-1);
		expect(tray).toBeGreaterThan(bodyClose);
	});

	it("样式：中间区可滚、隐藏区不参与滚动", () => {
		const body = STYLES_SRC.match(/\.icon-editor-body \{[^}]*\}/)?.[0] ?? "";
		expect(body).toMatch(/overflow-y:\s*auto/);
		const tray = STYLES_SRC.match(/\.icon-editor-tray \{[^}]*\}/)?.[0] ?? "";
		expect(tray).toMatch(/flex:\s*none/);
		expect(STYLES_SRC).toMatch(
			/\.icon-editor-chip-hide \{[^}]*position:\s*absolute[^}]*top:\s*-?\d+px[^}]*right:\s*-?\d+px/,
		);
	});
});

describe("图标编辑：文案纯中文", () => {
	const keys = ["uiIconEditHint", "uiIconEditTray", "uiIconEditTrayHint"];

	it("中文文案里不夹英文（分段名一律走 alignLabel）", () => {
		for (const key of keys) {
			expect(ZH[key], key).toBeTruthy();
			expect(ZH[key]!.replace(/[\s，、；：「」（）·]/g, ""), key).not.toMatch(/[A-Za-z]/);
		}
		expect(ZH.uiIconEditHint).toContain("×");
	});

	it("英文文案仍在（语言包 keys 对齐），且不再提 start/center/end", () => {
		for (const key of keys) expect(EN[key], key).toBeTruthy();
		expect(EN.uiIconEditHint).not.toContain("start/center/end");
	});

	it("设置里的对齐下拉 / 分段标题也走中文标签，不再手写 start/center/end", () => {
		expect(SETTINGS_SRC).not.toContain('value="start">start</option>');
		expect(SETTINGS_SRC).toContain("alignLabel(t, al, verticalAlignSlot(slot))");
		expect(SETTINGS_SRC).toContain("alignLabel(t, seg.align as UiAlign, verticalAlignSlot(slot))");
	});
});
