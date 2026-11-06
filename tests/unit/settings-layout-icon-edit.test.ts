import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");
const STYLES_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "styles.css"), "utf8");
const APP_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "App.tsx"), "utf8");

describe("设置面板「界面布局」编辑图标入口", () => {
	it("SettingsModalProps 声明了 onOpenIconEdit 可选回调", () => {
		expect(SETTINGS_SRC).toContain("onOpenIconEdit?: () => void;");
	});

	it("SettingsModal 组件解构并使用了 onOpenIconEdit", () => {
		expect(SETTINGS_SRC).toMatch(/export function SettingsModal\(\s*\{[\s\S]*?\bonOpenIconEdit\b/);
	});

	it("界面布局 tab 包含编辑图标按钮，配置了图标、文案与点击事件", () => {
		expect(SETTINGS_SRC).toContain("onOpenIconEdit &&");
		expect(SETTINGS_SRC).toContain("<FiEdit2 />");
		expect(SETTINGS_SRC).toContain('t("uiIconEdit")');
		expect(SETTINGS_SRC).toContain('title={t("uiIconEditHint")}');
		expect(SETTINGS_SRC).toContain("onClick={onOpenIconEdit}");
	});

	it("App.tsx 将 setIconEditOpen 传递给 SettingsModal", () => {
		expect(APP_SRC).toContain("onOpenIconEdit={() => setIconEditOpen(true)}");
	});

	it("styles.css 中 IconEditor 的 z-index 高于模态遮罩（300），确保从设置弹窗打开时处于顶层", () => {
		const backdropMatch = STYLES_SRC.match(/\.icon-editor-backdrop\s*\{[^}]*z-index:\s*(\d+)/);
		expect(backdropMatch).not.toBeNull();
		const backdropZ = Number(backdropMatch![1]);
		expect(backdropZ).toBeGreaterThan(300);

		const editorMatch = STYLES_SRC.match(/\.icon-editor\s*\{[^}]*z-index:\s*(\d+)/);
		expect(editorMatch).not.toBeNull();
		const editorZ = Number(editorMatch![1]);
		expect(editorZ).toBeGreaterThan(backdropZ);
	});
});
