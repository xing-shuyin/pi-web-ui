import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 实时预览的插件自有词典（客户端本身只做新标签页跳转，界面文案只有弹窗被拦截时的降级提示）。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不进词典的东西：文件树右键菜单的 label / labelEn（manifest.ui 里的双语对，宿主按全局语言选词）。
 */
export const DICT = {
	zh: {
		openBlocked: "新标签页被浏览器拦截，请手动点击结果中的链接打开。",
	},
	"zh-TW": {
		openBlocked: "新分頁被瀏覽器攔截，請手動點擊結果中的連結開啟。",
	},
	en: {
		openBlocked: "The new tab was blocked by the browser — click the link in the result to open it manually.",
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
