import { describe, expect, it } from "vitest";
import {
	desktopReleasesUrl,
	getDesktopUpdaterBridge,
	hasPendingUpdate,
	legacyUpdaterPatch,
	parseUpdaterState,
	type DesktopUpdaterState,
} from "../../web/src/desktop-updater.js";

/** 主进程快照（desktop/updater.ts 的 UpdaterState）的最小样本。 */
function snapshot(overrides: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
	return {
		mode: "auto",
		modeReason: "ready",
		phase: "available",
		currentVersion: "0.120.0",
		targetVersion: "0.123.0",
		releasesBehind: 2,
		notes: [{ version: "0.123.0", markdown: "- 新功能" }],
		notesCut: false,
		percent: 0,
		transferred: 0,
		total: 0,
		bytesPerSecond: 0,
		skippedVersion: null,
		errorCode: null,
		error: null,
		checkedAt: 1700000000000,
		releasesUrl: "https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0",
		...overrides,
	};
}

describe("parseUpdaterState", () => {
	it("完整快照原样接受", () => {
		expect(parseUpdaterState(snapshot())).toEqual(snapshot());
	});

	it("钳制百分比、剥掉版本号 v 前缀、坏字段回落默认值", () => {
		const parsed = parseUpdaterState({
			...snapshot(),
			phase: "downloading",
			currentVersion: "v0.120.0",
			targetVersion: "v0.123.0",
			percent: 137.4,
			notes: [{ version: "v0.123.0", markdown: "- x" }, { version: "0.122.0", markdown: "  " }, "junk"],
		});
		expect(parsed?.currentVersion).toBe("0.120.0");
		expect(parsed?.targetVersion).toBe("0.123.0");
		expect(parsed?.percent).toBe(100);
		expect(parsed?.notes).toEqual([{ version: "0.123.0", markdown: "- x" }]);
	});

	it("形状不对一律 null：旧壳的增量事件不会污染状态", () => {
		expect(parseUpdaterState(null)).toBeNull();
		expect(parseUpdaterState({ state: "available", version: "0.123.0" })).toBeNull();
		expect(parseUpdaterState({ ...snapshot(), phase: "weird" })).toBeNull();
		expect(parseUpdaterState({ ...snapshot(), currentVersion: "" })).toBeNull();
	});
});

describe("legacyUpdaterPatch", () => {
	it("旧壳的六个事件都能折成状态片段", () => {
		expect(legacyUpdaterPatch({ state: "checking" })).toEqual({ phase: "checking", error: null, errorCode: null });
		expect(legacyUpdaterPatch({ state: "available", version: "v0.123.0" })).toMatchObject({
			phase: "available",
			targetVersion: "0.123.0",
		});
		expect(legacyUpdaterPatch({ state: "downloading", percent: 42 })).toEqual({
			phase: "downloading",
			percent: 42,
		});
		expect(legacyUpdaterPatch({ state: "downloaded", version: "0.123.0" })).toMatchObject({
			phase: "downloaded",
			percent: 100,
		});
		expect(legacyUpdaterPatch({ state: "up-to-date" })).toMatchObject({ phase: "up-to-date" });
		expect(legacyUpdaterPatch({ state: "error", message: "net fail" })).toMatchObject({
			phase: "error",
			error: "net fail",
		});
		expect(legacyUpdaterPatch({ state: "weird" })).toBeNull();
		expect(legacyUpdaterPatch(null)).toBeNull();
	});
});

describe("hasPendingUpdate", () => {
	it("available / downloading / downloaded 才算有更新", () => {
		expect(hasPendingUpdate(null)).toBe(false);
		expect(hasPendingUpdate(snapshot({ phase: "idle" }))).toBe(false);
		expect(hasPendingUpdate(snapshot({ phase: "up-to-date" }))).toBe(false);
		expect(hasPendingUpdate(snapshot())).toBe(true);
		expect(hasPendingUpdate(snapshot({ phase: "downloaded" }))).toBe(true);
	});

	it("被忽略的版本不再提示", () => {
		expect(hasPendingUpdate(snapshot({ skippedVersion: "0.123.0" }))).toBe(false);
		expect(hasPendingUpdate(snapshot({ skippedVersion: "0.122.0" }))).toBe(true);
	});
});

describe("desktopReleasesUrl", () => {
	it("有版本直达 tag，没版本落 latest", () => {
		expect(desktopReleasesUrl("0.123.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0");
		expect(desktopReleasesUrl("v0.123.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.123.0");
		expect(desktopReleasesUrl(null)).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/latest");
		expect(desktopReleasesUrl("")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/latest");
	});
});

describe("getDesktopUpdaterBridge", () => {
	const bridge = {
		getState: () => Promise.resolve(null),
		check: () => Promise.resolve(true),
		download: () => Promise.resolve(true),
		cancel: () => Promise.resolve(true),
		skip: () => Promise.resolve(true),
		quitAndInstall: () => Promise.resolve(true),
		onEvent: () => () => {},
	};

	it("非桌面壳一律 null", () => {
		expect(getDesktopUpdaterBridge({})).toBeNull();
		expect(getDesktopUpdaterBridge(undefined)).toBeNull();
	});

	it("桌面壳但桥不全（旧壳）→ null", () => {
		expect(getDesktopUpdaterBridge({ piDesktop: { isDesktop: true } })).toBeNull();
		expect(getDesktopUpdaterBridge({ piDesktop: { isDesktop: true, updater: { check: () => {} } } })).toBeNull();
	});

	it("UA 兜底 + 必须件齐 → 桥", () => {
		expect(
			getDesktopUpdaterBridge({
				navigator: { userAgent: "Mozilla/5.0 Electron/44.0.0" },
				piDesktop: { updater: bridge },
			}),
		).toBe(bridge);
	});
});
