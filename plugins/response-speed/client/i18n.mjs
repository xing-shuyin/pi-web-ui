import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 响应速度看板自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 评级
		ratingExcellent: "极速",
		ratingGood: "良好",
		ratingFair: "一般",
		ratingSlow: "偏慢",

		// 看板
		modalTitle: "AI 响应速度统计看板（当前对话）",
		closeLabel: "关闭",
		cardLatest: "最新请求响应速度 (最新)",
		cardAvg: "平均响应速度 (均速)",
		cardMin: "最快响应时间",
		cardMax: "最慢响应时间",
		explTitle: "响应速度说明",
		explBody:
			"统计当前对话向 AI 发起请求到收到首包响应（TTFT）的耗时。每个对话独立记录，提问与 AI 自循环中的每一次 turn 请求均独立测速。",
		sectionRecent: "最近响应明细 (当前对话样本总数: {count} 次)",
		thTime: "时间",
		thLatency: "首包响应耗时",
		thRating: "评级",
		emptyHistory: "当前对话暂无历史测速记录",
		btnReset: "清空当前对话统计",
		btnClose: "关闭",
		confirmReset: "确定要清空当前对话的 AI 响应速度统计记录吗？",
	},
	"zh-TW": {
		// 評級
		ratingExcellent: "極速",
		ratingGood: "良好",
		ratingFair: "一般",
		ratingSlow: "偏慢",

		// 看板
		modalTitle: "AI 回應速度統計看板（目前對話）",
		closeLabel: "關閉",
		cardLatest: "最新請求回應速度 (最新)",
		cardAvg: "平均回應速度 (均速)",
		cardMin: "最快回應時間",
		cardMax: "最慢回應時間",
		explTitle: "回應速度說明",
		explBody:
			"統計目前對話向 AI 發起請求到收到首包回應（TTFT）的耗時。每個對話獨立記錄，提問與 AI 自循環中的每一次 turn 請求均獨立測速。",
		sectionRecent: "最近回應明細 (目前對話樣本總數: {count} 次)",
		thTime: "時間",
		thLatency: "首包回應耗時",
		thRating: "評級",
		emptyHistory: "目前對話暫無歷史測速記錄",
		btnReset: "清空目前對話統計",
		btnClose: "關閉",
		confirmReset: "確定要清空目前對話的 AI 回應速度統計記錄嗎？",
	},
	en: {
		// Ratings
		ratingExcellent: "Excellent",
		ratingGood: "Good",
		ratingFair: "Fair",
		ratingSlow: "Slow",

		// Dashboard
		modalTitle: "AI Response Speed (Current Conversation)",
		closeLabel: "Close",
		cardLatest: "Latest request (latest)",
		cardAvg: "Average response speed (avg)",
		cardMin: "Fastest response",
		cardMax: "Slowest response",
		explTitle: "About response speed",
		explBody:
			"Time from sending a request to the AI to receiving the first response packet (TTFT). Tracked independently per conversation and per AI/self-loop turn.",
		sectionRecent: "Recent responses (samples in this conversation: {count})",
		thTime: "Time",
		thLatency: "First-packet latency",
		thRating: "Rating",
		emptyHistory: "No latency records for this conversation yet",
		btnReset: "Clear stats for this conversation",
		btnClose: "Close",
		confirmReset: "Clear the AI response speed records for the current conversation?",
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
