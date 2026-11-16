import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 拍板中心的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		title: "拍板",
		pendingCount: "待拍板 {n}",
		done: "全部处理完毕",
		doneHint: "定时任务有新拍板请求时会自动出现在这里。",
		jump: "点击跳转会话拍板",
		noConv: "无关联会话（登记时未提供 conversationId）",
		dismiss: "忽略",
		onlyPending: "只看待拍板",
		resolved: "已拍板",
		dismissed: "已忽略",
		emptyFiltered: "没有待拍板项",

		// 相对时间
		timeNow: "刚刚",
		timeMinutes: "{n} 分钟前",
		timeHours: "{n} 小时前",
		timeYesterday: "昨天",
		timeDays: "{n} 天前",
	},
	"zh-TW": {
		title: "拍板",
		pendingCount: "待拍板 {n}",
		done: "全部處理完畢",
		doneHint: "定時任務有新拍板請求時會自動出現在這裡。",
		jump: "點選跳轉會話拍板",
		noConv: "無關聯會話（登記時未提供 conversationId）",
		dismiss: "忽略",
		onlyPending: "只看待拍板",
		resolved: "已拍板",
		dismissed: "已忽略",
		emptyFiltered: "沒有待拍板項",

		// 相对时间
		timeNow: "剛剛",
		timeMinutes: "{n} 分鐘前",
		timeHours: "{n} 小時前",
		timeYesterday: "昨天",
		timeDays: "{n} 天前",
	},
	en: {
		title: "Approvals",
		pendingCount: "{n} pending",
		done: "All clear",
		doneHint: "New approval requests from scheduled tasks will appear here automatically.",
		jump: "Click to open the conversation",
		noConv: "No linked conversation (registered without conversationId)",
		dismiss: "Dismiss",
		onlyPending: "Pending only",
		resolved: "Resolved",
		dismissed: "Dismissed",
		emptyFiltered: "No pending items",

		// Relative time
		timeNow: "just now",
		timeMinutes: "{n}m ago",
		timeHours: "{n}h ago",
		timeYesterday: "yesterday",
		timeDays: "{n}d ago",
	},
};

/** 当前界面语言（词典里存在的那一个）；解析与回退由 SDK 统一实现。 */
export function detectLang() {
	return createPluginI18n(DICT).locale;
}

/** 取文案函数；语言可以是字符串、undefined（跟随界面）或惰性 getter，每次调用时按当前语言解析。 */
export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
