import { describe, expect, it, vi } from "vitest";
import { loadSoundSettings } from "../../web/src/sounds.js";
import {
	idleSinceLastActivityMs,
	isNotifyEventEnabled,
	loadNotifySettings,
	notify,
	NOTIFY_EVENTS,
	isCollapsedWindow,
	isWindowsPlatform,
	markActivity,
	notifyBlockReason,
	notificationsSupported,
	NOTIFY_IDLE_GRACE_MS,
	shouldSuppressNotify,
	type PresenceSignals,
} from "../../web/src/notify.js";

const presence = (patch: Partial<PresenceSignals> = {}): PresenceSignals => ({
	hasFocus: true,
	visibility: "visible",
	minimized: false,
	idleMs: 0,
	windows: false,
	...patch,
});

describe("notification event preferences", () => {
	it("existing settings follow every sound event independently of sound master and volume", () => {
		const sound = { ...loadSoundSettings(), enabled: false, volume: 0 };
		for (const kind of NOTIFY_EVENTS) {
			expect(isNotifyEventEnabled(kind, { enabled: true }, { ...sound, [kind]: false })).toBe(false);
			expect(isNotifyEventEnabled(kind, { enabled: true }, { ...sound, [kind]: true })).toBe(true);
		}
	});

	it("per-event overrides work in both directions and never bypass desktop master", () => {
		const sound = loadSoundSettings();
		for (const kind of NOTIFY_EVENTS) {
			expect(isNotifyEventEnabled(kind, { enabled: true, events: { [kind]: "on" } }, { ...sound, [kind]: false })).toBe(
				true,
			);
			expect(isNotifyEventEnabled(kind, { enabled: true, events: { [kind]: "off" } }, { ...sound, [kind]: true })).toBe(
				false,
			);
			expect(isNotifyEventEnabled(kind, { enabled: false, events: { [kind]: "on" } }, sound)).toBe(false);
		}
	});

	it("drops invalid stored event overrides", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => JSON.stringify({ enabled: true, events: { done: "off", subagentDone: "invalid", unknown: "on" } }),
		});
		try {
			expect(loadNotifySettings()).toEqual({ enabled: true, events: { done: "off" } });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("blocks a disabled subagent event before desktop delivery and permits an explicit override", async () => {
		let override = false;
		const delivered = vi.fn();
		class MockNotification {
			static permission = "granted";
			constructor(title: string) {
				delivered(title);
			}
		}
		vi.stubGlobal("window", { Notification: MockNotification, addEventListener: vi.fn() });
		vi.stubGlobal("document", { hasFocus: () => false, visibilityState: "hidden", addEventListener: vi.fn() });
		vi.stubGlobal("navigator", {});
		vi.stubGlobal("Notification", MockNotification);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				JSON.stringify(
					key === "pi-web-notify"
						? { enabled: true, events: override ? { subagentDone: "on" } : {} }
						: { subagentDone: false },
				),
		});
		try {
			await notify("child", "finished", "subagentDone");
			expect(delivered).not.toHaveBeenCalled();
			override = true;
			await notify("child", "finished", "subagentDone");
			expect(delivered).toHaveBeenCalledWith("child");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("isCollapsedWindow", () => {
	it("Windows 实测的最小化矩形 → 判定为最小化", () => {
		expect(isCollapsedWindow({ screenX: -21334, screenY: -21333, outerWidth: 108, outerHeight: 20 })).toBe(true);
		expect(isCollapsedWindow({ screenX: -32000, screenY: -32000, outerWidth: 160, outerHeight: 28 })).toBe(true);
	});

	it("普通窗口（包括屏幕左侧的多显示器布局）不算最小化", () => {
		expect(isCollapsedWindow({ screenX: 10, screenY: 10, outerWidth: 1296, outerHeight: 808 })).toBe(false);
		expect(isCollapsedWindow({ screenX: -5760, screenY: 0, outerWidth: 1296, outerHeight: 808 })).toBe(false);
		expect(isCollapsedWindow({ screenX: 0, screenY: -2160, outerWidth: 1296, outerHeight: 808 })).toBe(false);
	});

	it("只有高度塌陷、坐标缺失时也不得抛错（按未最小化处理）", () => {
		expect(isCollapsedWindow({ screenX: NaN, screenY: NaN, outerWidth: 600, outerHeight: 400 })).toBe(false);
	});

	it("量不到窗口的环境（headless 报 0×0）不算最小化", () => {
		expect(isCollapsedWindow({ screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0 })).toBe(false);
	});
});

describe("shouldSuppressNotify", () => {
	it("最小化（Windows 上焦点/可见性都在骗人）→ 必须通知", () => {
		expect(shouldSuppressNotify(presence({ minimized: true, windows: true }))).toBe(false);
	});

	it("页面不可见（后台标签 / 遮挡）→ 通知", () => {
		expect(shouldSuppressNotify(presence({ visibility: "hidden" }))).toBe(false);
	});

	it("失去焦点（切到别的应用）→ 通知", () => {
		expect(shouldSuppressNotify(presence({ hasFocus: false }))).toBe(false);
	});

	it("有焦点 + 可见 + 刚操作过 = 用户正在看，吞掉通知（改由提示音负责）", () => {
		expect(shouldSuppressNotify(presence({ windows: true, idleMs: 3000 }))).toBe(true);
	});

	it("Windows：长时间没操作页面 → 不再相信「有焦点」，照常通知", () => {
		expect(shouldSuppressNotify(presence({ windows: true, idleMs: NOTIFY_IDLE_GRACE_MS + 1 }))).toBe(false);
	});

	it("非 Windows：焦点/可见性可信，空闲多久都按「在看」处理（不改变原有行为）", () => {
		expect(shouldSuppressNotify(presence({ windows: false, idleMs: 60 * 60 * 1000 }))).toBe(true);
	});

	it("未知/缺失的可见性状态按「不可见」处理（宁可多提醒也不静默）", () => {
		expect(shouldSuppressNotify(presence({ visibility: "prerender" }))).toBe(false);
		expect(shouldSuppressNotify(presence({ visibility: "" }))).toBe(false);
	});
});

describe("用户活动计时", () => {
	it("markActivity 会把空闲计时清零（feed 给 Windows 的兜底判据）", () => {
		markActivity();
		expect(idleSinceLastActivityMs()).toBeLessThan(200);
	});
});

describe("notifyBlockReason", () => {
	it("非浏览器环境（无 window）→ 判为不支持，而不是安全上下文问题", () => {
		expect(notificationsSupported()).toBe(false);
		expect(notifyBlockReason()).toBe("unsupported");
	});
});

describe("isWindowsPlatform", () => {
	it("node 环境无 navigator → false（不误报平台提示）", () => {
		expect(isWindowsPlatform()).toBe(false);
	});
});
