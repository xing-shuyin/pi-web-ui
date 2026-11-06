import { describe, expect, it } from "vitest";
import {
	desktopReleasesUrl,
	getDesktopUpdaterBridge,
	INITIAL_DESKTOP_UPDATER_STATUS,
	reduceUpdaterEvent,
} from "../../web/src/desktop-updater.js";

describe("reduceUpdaterEvent", () => {
	it("checking 清掉旧 error", () => {
		const s = reduceUpdaterEvent(
			{ ...INITIAL_DESKTOP_UPDATER_STATUS, state: "error", message: "x" },
			{
				state: "checking",
			},
		);
		expect(s).toEqual({ state: "checking", version: null, percent: 0, message: null });
	});

	it("available 记住远端版本", () => {
		const s = reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "available", version: "0.89.0" });
		expect(s.state).toBe("available");
		expect(s.version).toBe("0.89.0");
	});

	it("downloading 百分比钳制 0-100", () => {
		expect(reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "downloading", percent: 42 }).percent).toBe(42);
		expect(reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "downloading", percent: 137 }).percent).toBe(
			100,
		);
		expect(reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "downloading", percent: NaN }).percent).toBe(0);
	});

	it("downloaded 直接 100%", () => {
		const s = reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "downloaded", version: "0.89.0" });
		expect(s).toEqual({ state: "downloaded", version: "0.89.0", percent: 100, message: null });
	});

	it("error 落信息，未知事件原样返回", () => {
		const s = reduceUpdaterEvent(INITIAL_DESKTOP_UPDATER_STATUS, { state: "error", message: "net fail" });
		expect(s.state).toBe("error");
		expect(s.message).toBe("net fail");
		expect(reduceUpdaterEvent(s, { state: "weird" } as never)).toBe(s);
	});
});

describe("desktopReleasesUrl", () => {
	it("有版本直达 tag，没版本落 latest", () => {
		expect(desktopReleasesUrl("0.89.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.89.0");
		expect(desktopReleasesUrl("v0.89.0")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.89.0");
		expect(desktopReleasesUrl(null)).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/latest");
		expect(desktopReleasesUrl("")).toBe("https://github.com/xing-shuyin/pi-web-ui/releases/latest");
	});
});

describe("getDesktopUpdaterBridge", () => {
	const bridge = {
		check: () => Promise.resolve(true),
		download: () => Promise.resolve(true),
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

	it("UA 兜底 + 三件套齐 → 桥", () => {
		expect(
			getDesktopUpdaterBridge({
				navigator: { userAgent: "Mozilla/5.0 Electron/44.0.0" },
				piDesktop: { updater: bridge },
			}),
		).toBe(bridge);
	});
});
