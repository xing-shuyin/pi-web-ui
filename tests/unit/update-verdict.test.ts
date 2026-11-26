import { describe, expect, it } from "vitest";
import { componentActionable, isComponentItem, resolveUpdateCenter } from "../../web/src/update-verdict.js";
import type { DesktopUpdaterState } from "../../web/src/desktop-updater.js";
import type { UpdateAllItem } from "../../web/src/use-chat.js";

/**
 * 更新中心的结论必须**单源**：顶栏 badge、顶栏小黄点、弹窗标题、弹窗主按钮全读这里。
 * 这里锁住三件曾经出过问题的事：
 * 1. 桌面壳里 pi-web-ui 只以「运行时」出现一次（`updatesAll` 的 webui 行不进组件列表）；
 * 2. 「已是最新」和「有 1 个更新」不可能同时成立；
 * 3. 下载中优先于「有 N 项可用」，否则一按下载标题又退回上一屏。
 */

function desktopState(over: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
	return {
		mode: "auto",
		modeReason: "ready",
		phase: "available",
		currentVersion: "0.122.0",
		targetVersion: "0.123.0",
		releasesBehind: 1,
		notes: [],
		notesCut: false,
		percent: 0,
		transferred: 0,
		total: 0,
		bytesPerSecond: 0,
		skippedVersion: null,
		errorCode: null,
		error: null,
		checkedAt: Date.now(),
		releasesUrl: "https://example.invalid",
		runtime: {
			enabled: true,
			phase: "available",
			currentVersion: "0.121.3",
			targetVersion: "0.122.0",
			percent: 0,
			transferred: 0,
			total: 0,
			errorCode: null,
			error: null,
			checkedAt: Date.now(),
		},
		...over,
	};
}

function comp(name: string, kind: UpdateAllItem["kind"], over: Partial<UpdateAllItem> = {}): UpdateAllItem {
	return { name, kind, current: "1.0.0", latest: "1.0.1", upToDate: false, ...over };
}

const WEBUI_ROW = comp("pi-web-ui", "webui", { current: "0.121.3", latest: "0.122.0" });
const PLUGIN_ROW = comp("@xing/qq", "plugin", { current: "v2.4.0", latest: "v2.4.1" });
const CORE_ROW = comp("@earendil-works/pi-coding-agent", "pi-core", { current: "1.6.0", latest: null, upToDate: true });

describe("resolveUpdateCenter", () => {
	it("桌面壳：pi-web-ui 只以运行时出现一次，webui 行不进组件列表", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState(),
			update: { current: "0.121.3", latest: "0.122.0", upToDate: false },
			updatesAll: [WEBUI_ROW, PLUGIN_ROW, CORE_ROW],
			updatesSdk: null,
		});

		expect(center.axes.map((axis) => axis.id)).toEqual(["shell", "runtime", "core"]);
		expect(center.components.map((item) => item.name)).toEqual(["@xing/qq"]);
		expect(center.components.some((item) => item.kind === "webui")).toBe(false);
		// 壳 + 运行时 + 1 个插件 = 3
		expect(center.pendingCount).toBe(3);
		expect(center.titleKey).toBe("updatesVerdictAvailable");
	});

	it("网页 / CLI：pi-web-ui 变成 Web 界面轴，仍然不出现在组件里", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: false,
			desktop: null,
			update: { current: "0.121.3", latest: "0.122.0", upToDate: false },
			updatesAll: [WEBUI_ROW, PLUGIN_ROW],
			updatesSdk: null,
		});

		expect(center.axes.map((axis) => axis.id)).toEqual(["webui"]);
		expect(center.axes[0]).toMatchObject({ current: "0.121.3", target: "0.122.0", action: "npm" });
		expect(center.components.map((item) => item.name)).toEqual(["@xing/qq"]);
		expect(center.titleVars).toEqual({ n: 2 });
	});

	it("已是最新时不再报「有更新」（badge 与结论同源）", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState({
				phase: "up-to-date",
				targetVersion: null,
				runtime: {
					enabled: true,
					phase: "up-to-date",
					currentVersion: "0.122.0",
					targetVersion: null,
					percent: 0,
					transferred: 0,
					total: 0,
					errorCode: null,
					error: null,
					checkedAt: Date.now(),
				},
			}),
			update: { current: "0.122.0", latest: "0.122.0", upToDate: true },
			// 这条 webui 行是旧冲突的源头：壳已最新、内核行仍报可更新
			updatesAll: [WEBUI_ROW, comp("@xing/qq", "plugin", { current: "v2.4.1", latest: "v2.4.1", upToDate: true })],
			updatesSdk: null,
		});

		expect(center.pendingCount).toBe(0);
		expect(center.hasPending).toBe(false);
		expect(center.titleKey).toBe("updatesVerdictLatest");
	});

	it("忽略此版本 → 不计入 badge，但轴仍显示「可更新」以便恢复", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState({
				skippedVersion: "0.123.0",
				runtime: {
					enabled: true,
					phase: "up-to-date",
					currentVersion: "0.122.0",
					targetVersion: null,
					percent: 0,
					transferred: 0,
					total: 0,
					errorCode: null,
					error: null,
					checkedAt: Date.now(),
				},
			}),
			update: null,
			updatesAll: [],
			updatesSdk: null,
		});

		expect(center.axes[0]).toMatchObject({ id: "shell", state: "available", skipped: true });
		expect(center.pendingCount).toBe(0);
		expect(center.hasPending).toBe(false);
	});

	it("下载中优先于「有 N 项可用」，主按钮是取消", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState({ phase: "downloading", percent: 42, transferred: 40, total: 96 }),
			update: null,
			updatesAll: [PLUGIN_ROW],
			updatesSdk: null,
		});

		expect(center.titleKey).toBe("updatesVerdictWorking");
		expect(center.titleVars).toEqual({ percent: 42 });
		expect(center.primary).toMatchObject({ action: "cancel", axisId: "shell" });
	});

	it("手动模式：壳不给假按钮，主按钮落在「只更新组件」", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState({ mode: "manual", modeReason: "portable", phase: "idle", targetVersion: null }),
			update: null,
			updatesAll: [PLUGIN_ROW],
			updatesSdk: null,
		});

		expect(center.tone).toBe("muted");
		expect(center.titleKey).toBe("updatesVerdictManual");
		expect(center.axes[0]).toMatchObject({ id: "shell", state: "manual" });
		expect(center.primary).toMatchObject({ action: "npm", key: "updatesActionUpdateComponents" });
	});

	it("npm-global 模式下 runtime.enabled=false 时，运行时轴直接显示全局包更新状态", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: true,
			desktop: desktopState({
				runtime: {
					enabled: false,
					phase: "disabled",
					currentVersion: null,
					targetVersion: null,
					percent: 0,
					transferred: 0,
					total: 0,
					errorCode: null,
					error: null,
					checkedAt: null,
				},
			}),
			update: { current: "0.122.0", latest: "0.123.0", upToDate: false },
			updatesAll: [comp("keel-agent", "webui", { current: "0.122.0", latest: "0.123.0", upToDate: false })],
			updatesSdk: null,
		});

		const runtime = center.axes.find((a) => a.id === "runtime");
		expect(runtime).toMatchObject({
			id: "runtime",
			state: "available",
			current: "0.122.0",
			target: "0.123.0",
			action: "npm",
		});
	});

	it("主表面检查失败 → 整体报错；组件失败只影响自己那一行", () => {
		const center = resolveUpdateCenter({
			inDesktopShell: false,
			desktop: null,
			update: { current: "0.121.3", latest: null, upToDate: false, error: "boom" },
			updatesAll: [comp("@xing/qq", "plugin", { error: "nope" })],
			updatesSdk: null,
		});

		expect(center.tone).toBe("err");
		expect(center.titleKey).toBe("updatesVerdictError");
		expect(componentActionable(center.components[0]!)).toBe(false);
	});
});

describe("isComponentItem", () => {
	it("webui 与 pi-core 归轴，不算组件", () => {
		expect(isComponentItem(WEBUI_ROW)).toBe(false);
		expect(isComponentItem(CORE_ROW)).toBe(false);
		expect(isComponentItem(PLUGIN_ROW)).toBe(true);
	});
});
