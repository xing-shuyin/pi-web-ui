/**
 * 桌面壳检测与沉浸式装饰单测（`web/src/desktop.ts`）。
 *
 * 传参即判定，不碰全局 window —— 单测里不需要 jsdom。
 */
import { describe, expect, it, vi } from "vitest";
import {
	getDesktopPlatform,
	getDesktopWindowBridge,
	isDesktopShell,
	syncDesktopTitleBarTheme,
} from "../../web/src/desktop.js";

describe("isDesktopShell", () => {
	it("preload 标记在就认（主判定）", () => {
		expect(isDesktopShell({ piDesktop: { isDesktop: true } })).toBe(true);
	});

	it("标记不是 true 不认", () => {
		expect(isDesktopShell({ piDesktop: { isDesktop: false } })).toBe(false);
		expect(isDesktopShell({ piDesktop: {} })).toBe(false);
		expect(isDesktopShell({})).toBe(false);
	});

	it("没 preload 时 UA 带 Electron/ 兜底", () => {
		expect(isDesktopShell({ navigator: { userAgent: "Mozilla/5.0 Electron/44.0.0 Chrome/153 Safari/537.36" } })).toBe(
			true,
		);
		expect(
			isDesktopShell({
				navigator: { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153 Safari/537.36" },
			}),
		).toBe(false);
	});

	it("空输入不抛错", () => {
		expect(isDesktopShell(undefined)).toBe(false);
		expect(isDesktopShell(null)).toBe(false);
	});
});

describe("getDesktopPlatform", () => {
	it("优先从 preload 读 platform", () => {
		expect(getDesktopPlatform({ piDesktop: { isDesktop: true, platform: "darwin" } })).toBe("darwin");
		expect(getDesktopPlatform({ piDesktop: { isDesktop: true, platform: "win32" } })).toBe("win32");
		expect(getDesktopPlatform({ piDesktop: { isDesktop: true, platform: "linux" } })).toBe("linux");
	});

	it("preload 无 platform 时从 UA 兜底", () => {
		expect(
			getDesktopPlatform({
				piDesktop: { isDesktop: true },
				navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/44.0.0" },
			}),
		).toBe("darwin");
		expect(
			getDesktopPlatform({
				piDesktop: { isDesktop: true },
				navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44.0.0" },
			}),
		).toBe("win32");
		expect(
			getDesktopPlatform({
				piDesktop: { isDesktop: true },
				navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Electron/44.0.0" },
			}),
		).toBe("linux");
	});

	it("非桌面环境返回 null", () => {
		expect(
			getDesktopPlatform({
				navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36" },
			}),
		).toBeNull();
		expect(getDesktopPlatform(undefined)).toBeNull();
	});
});

describe("getDesktopWindowBridge", () => {
	it("preload 挂了 window 桥时正确返回", () => {
		const mockBridge = {
			minimize: vi.fn(),
			toggleMaximize: vi.fn(),
			close: vi.fn(),
			isMaximized: vi.fn(),
			onMaximizedChange: vi.fn(),
		};
		expect(getDesktopWindowBridge({ piDesktop: { isDesktop: true, window: mockBridge } })).toBe(mockBridge);
	});

	it("非桌面环境或无 window 桥时返回 null", () => {
		expect(getDesktopWindowBridge(undefined)).toBeNull();
		expect(getDesktopWindowBridge({ piDesktop: { isDesktop: true } })).toBeNull();
		expect(getDesktopWindowBridge({ navigator: { userAgent: "Mozilla/5.0 Electron/44.0.0" } })).toBeNull();
	});
});

describe("syncDesktopTitleBarTheme", () => {
	it("非桌面环境或无 setTitleBarOverlay 时安全不抛错", () => {
		expect(() => syncDesktopTitleBarTheme(undefined)).not.toThrow();
		expect(() => syncDesktopTitleBarTheme({ piDesktop: { isDesktop: true } })).not.toThrow();
	});

	it("调用 setTitleBarOverlay 设置透明背景与对比度按钮颜色", () => {
		const setTitleBarOverlay = vi.fn().mockResolvedValue(true);
		syncDesktopTitleBarTheme({
			piDesktop: {
				isDesktop: true,
				setTitleBarOverlay,
			},
		});
		expect(setTitleBarOverlay).toHaveBeenCalledWith({
			color: "#00000000",
			symbolColor: expect.any(String),
		});
	});
});
