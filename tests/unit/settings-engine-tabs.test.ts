import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");
const APP_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "App.tsx"), "utf8");

describe("设置面板多引擎动态自适应（分区条件隐藏与模型中枢集成）", () => {
	it("SettingsModalProps 声明了 onOpenManageModels 回调且在 App.tsx 中完成接线", () => {
		expect(SETTINGS_SRC).toContain("onOpenManageModels?: () => void;");
		expect(APP_SRC).toContain("onOpenManageModels={() => {");
		expect(APP_SRC).toContain("setManageModelsOpen(true);");
	});

	it("SettingsTab 包含了通用的 models 分区", () => {
		expect(SETTINGS_SRC).toContain('| "models"');
	});

	it("正确声明了 isClaude、isDsh 和 isPi 引擎分支判断", () => {
		expect(SETTINGS_SRC).toContain('const isDsh = engine === "dsh";');
		expect(SETTINGS_SRC).toContain('const isClaude = engine === "claude";');
		expect(SETTINGS_SRC).toContain('const isCodex = engine === "codex";');
		expect(SETTINGS_SRC).toContain("const isPi = !isDsh && !isClaude && !isCodex;");
	});

	it("默认激活分区根据引擎自适应，避免切到不可见分区（Claude/DSH 默认进 models，Pi 默认进 prompt）", () => {
		expect(SETTINGS_SRC).toContain(
			'const defaultTab: SettingsTab = isClaude || isCodex || isDsh ? "models" : "prompt";',
		);
	});

	it("具备导航纠偏机制：当切换引擎导致当前 tab 不在可用列表时，自动纠回首个可用分区", () => {
		expect(SETTINGS_SRC).toContain("if (!tabs.some((t) => t.id === tab)) {");
		expect(SETTINGS_SRC).toContain("setTab(tabs[0].id);");
	});

	it("Claude 引擎下彻底隐藏一切无法生效的 Pi/DSH 独有分区", () => {
		expect(SETTINGS_SRC).toMatch(/\.\.\.\((?:isPi|isPi\s*\|\|\s*isDsh)\s*\?\s*\[\s*\{\s*id:\s*"prompt"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"scheduler"/);

		expect(SETTINGS_SRC).toMatch(/isPi\s*\?\s*\[\s*\{\s*id:\s*"tools"/);
		expect(SETTINGS_SRC).toMatch(/id:\s*"approval-rules"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"skills"/);

		expect(SETTINGS_SRC).toMatch(/isDsh[\s\S]*?isPi\s*\?\s*\[\s*\{\s*id:\s*"extensions"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"mcp"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isClaude\s*\|\|\s*isCodex\s*\?\s*\[\]\s*:\s*\[\s*\{\s*id:\s*"review"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"vision"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"presets"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"subagent-templates"/);

		expect(SETTINGS_SRC).toMatch(/\.\.\.\(isPi\s*\?\s*\[\s*\{\s*id:\s*"device-collab"/);
	});

	it("全引擎通用呈现「模型与服务商」分区并提供引擎切换与管理入口", () => {
		expect(SETTINGS_SRC).toContain('id: "models" as const');
		expect(SETTINGS_SRC).toContain('label: t("settingsModelsAndProviders")');

		expect(SETTINGS_SRC).toContain('{tab === "models" && (');
		expect(SETTINGS_SRC).toContain('t("manageModelsAndProviders")');
		expect(SETTINGS_SRC).toContain("onClick={onOpenManageModels}");
	});

	it("群组协作与执行设置（device-collab）集成到统一设置弹窗", () => {
		expect(SETTINGS_SRC).toContain('import { DeviceExecutionSettings } from "./DeviceExecutionSettings";');
		expect(SETTINGS_SRC).toContain('| "device-collab"');
		expect(SETTINGS_SRC).toContain('"device-collab": "advanced"');
		expect(SETTINGS_SRC).toContain('"device-collab": [');
		expect(SETTINGS_SRC).toMatch(/tab === "device-collab"\s*&&\s*isPi[\s\S]*?<DeviceExecutionSettings/);
		expect(SETTINGS_SRC).toContain("onNotice={() => triggerSyncState()}");
	});

	it("设置面板引擎卡片不渲染冗余的「可更新」文字标签（已有更新按钮，避免挤压重叠）", () => {
		expect(SETTINGS_SRC).not.toContain('t("engineUpdateAvailable")');
	});
});
