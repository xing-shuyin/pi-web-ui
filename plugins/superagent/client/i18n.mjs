import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/** 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现。 */
export const DICT = {
	zh: {
		loading: "正在加载外部渠道…",
		mountFailed: "内置渠道界面加载失败，请重新加载页面或重启主程序。",
	},
	"zh-TW": {
		loading: "正在載入外部渠道…",
		mountFailed: "內建渠道介面載入失敗，請重新載入頁面或重啟主程式。",
	},
	en: {
		loading: "Loading external channel…",
		mountFailed: "The built-in channel UI failed to load. Reload the page or restart the app.",
	},
};

export function detectLang() {
	return createPluginI18n(DICT).locale;
}

export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
