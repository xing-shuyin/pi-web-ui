// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots";
import { zh, en } from "../../web/src/i18n";
import { HOST_ICON_NAMES } from "../../web/src/host-icon";
import { DEFAULT_QUIET_MODE_SETTINGS, saveQuietModeSettings } from "../../web/src/quiet-mode";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORAGE_KEY = "pi-web-ui:quiet-mode";

afterEach(() => {
	try {
		localStorage.clear();
	} catch {}
});

describe("安静模式快捷开关 (issue #956 · flip-flop)", () => {
	it("在 BUILTIN_UI_ITEMS 中登记了 host:quiet-mode 顶栏条目", () => {
		const entry = BUILTIN_UI_ITEMS.find((item) => item.id === "host:quiet-mode");
		expect(entry).toBeDefined();
		expect(entry?.slot).toBe("topbar.primary");
		expect(entry?.labelKey).toBe("quietMode");
		expect(entry?.icon).toBe("eye");
		expect(entry?.kind).toBe("action");
		expect(entry?.group).toBe("tools");
	});

	it("i18n 与图标名可解析（不新增 key 之外的隐式依赖）", () => {
		for (const key of ["quietMode", "quietModeDesc"] as const) {
			expect(zh[key], `zh.${key}`).toBeTruthy();
			expect(en[key], `en.${key}`).toBeTruthy();
		}
		expect(HOST_ICON_NAMES).toContain("eye");
	});

	it("顶栏与四栏通用 BarItem 都接了这个条目（登记了却没渲染是静默失效）", () => {
		const barItem = read("../../web/src/components/BarItem.tsx");
		const topBar = read("../../web/src/components/TopBar.tsx");
		expect(barItem).toContain('case "host:quiet-mode":');
		// 顶栏三处：溢出兜底清单、菜单分发、chip 渲染
		expect(topBar.match(/"host:quiet-mode"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("点击语义 = 翻转 enabled 并落盘（与 zen mode 同形的 flip-flop）", () => {
		const on = { ...DEFAULT_QUIET_MODE_SETTINGS, enabled: true, style: "zero" as const };
		saveQuietModeSettings(on);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(on);
		saveQuietModeSettings({ ...on, enabled: !on.enabled });
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").enabled).toBe(false);
	});
});
