import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 额度看板浮层的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 底栏那格文本（徽标 + tooltip）不在这里：它由服务端 `badge.mjs` 算好后随 `/summary` 下发，
 * 客户端只负责画；供应商名 / 窗口名 / hint 也都是服务端数据（带 labelEn / hintEn），不翻译。
 */
export const DICT = {
	zh: {
		// 卡片外壳
		title: "额度看板",
		refresh: "刷新",
		never: "尚未加载",
		loading: "读取中…",
		failed: "读取失败",
		unknown: "未知",
		resetDone: "已重置",
		balance: "余额",
		noWindows: "没有额度窗口",
		noSource: "当前模型没有对应的额度来源",
		signedOut: "未登录 / 未配置",
		empty: "该账号没有返回额度",
		stale: "数值来自上次成功读取",
		lowBalance: "余额偏低，建议充值后再跑长任务",

		// 自动刷新节奏
		"auto.everySeconds": "每 {seconds} 秒自动刷新",
		"auto.everyMinute": "每分钟自动刷新",
		"auto.everyMinutes": "每 {minutes} 分钟自动刷新",

		// 新鲜度
		justNow: "刚刚",
		secondsAgo: "{n} 秒前",
		minutesAgo: "{n} 分钟前",
		hoursAgo: "{n} 小时前",
		aging: "陈旧",

		// 窗口重置倒计时
		"countdown.days": "{days} 天后重置",
		"countdown.daysHours": "{days} 天 {hours} 小时后重置",
		"countdown.hours": "{hours} 小时后重置",
		"countdown.hoursMins": "{hours} 小时 {mins} 分后重置",
		"countdown.minutes": "{mins} 分钟后重置",
	},
	"zh-TW": {
		// 卡片外壳
		title: "額度看板",
		refresh: "重新整理",
		never: "尚未載入",
		loading: "讀取中…",
		failed: "讀取失敗",
		unknown: "未知",
		resetDone: "已重置",
		balance: "餘額",
		noWindows: "沒有額度視窗",
		noSource: "當前模型沒有對應的額度來源",
		signedOut: "未登入 / 未配置",
		empty: "該賬號沒有返回額度",
		stale: "數值來自上次成功讀取",
		lowBalance: "餘額偏低，建議充值後再跑長任務",

		// 自动刷新节奏
		"auto.everySeconds": "每 {seconds} 秒自動重新整理",
		"auto.everyMinute": "每分鐘自動重新整理",
		"auto.everyMinutes": "每 {minutes} 分鐘自動重新整理",

		// 新鲜度
		justNow: "剛剛",
		secondsAgo: "{n} 秒前",
		minutesAgo: "{n} 分鐘前",
		hoursAgo: "{n} 小時前",
		aging: "陳舊",

		// 窗口重置倒计时
		"countdown.days": "{days} 天后重置",
		"countdown.daysHours": "{days} 天 {hours} 小時後重置",
		"countdown.hours": "{hours} 小時後重置",
		"countdown.hoursMins": "{hours} 小時 {mins} 分後重置",
		"countdown.minutes": "{mins} 分鐘後重置",
	},
	en: {
		// Card shell
		title: "Quota Watch",
		refresh: "Refresh",
		never: "not loaded yet",
		loading: "Loading…",
		failed: "Failed to load",
		unknown: "unknown",
		resetDone: "reset",
		balance: "Balance",
		noWindows: "no quota window",
		noSource: "No quota source for the active model",
		signedOut: "signed out / not configured",
		empty: "this account returned no quota",
		stale: "showing the last successful read",
		lowBalance: "Balance is low — top up before long runs",

		// Auto-refresh cadence
		"auto.everySeconds": "refreshes every {seconds}s",
		"auto.everyMinute": "refreshes every minute",
		"auto.everyMinutes": "refreshes every {minutes} min",

		// Freshness
		justNow: "just now",
		secondsAgo: "{n}s ago",
		minutesAgo: "{n}m ago",
		hoursAgo: "{n}h ago",
		aging: "stale",

		// Window reset countdown
		"countdown.days": "resets in {days}d",
		"countdown.daysHours": "resets in {days}d {hours}h",
		"countdown.hours": "resets in {hours}h",
		"countdown.hoursMins": "resets in {hours}h {mins}m",
		"countdown.minutes": "resets in {mins}m",
	},
};

/** 当前界面语言（词典里存在的那一个）；解析与回退由 SDK 统一实现。 */
export function detectLang() {
	return createPluginI18n(DICT).locale;
}

/** 取文案函数；语言可以是字符串或惰性 getter，每次调用时按当前语言解析。 */
export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
