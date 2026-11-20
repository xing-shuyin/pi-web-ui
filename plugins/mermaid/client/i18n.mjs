import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * Mermaid 渲染器的插件自有词典（目前仅无障碍标签；渲染体是 SVG 图形本身）。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 */
export const DICT = {
	zh: {
		diagram: "Mermaid 图表",
	},
	"zh-TW": {
		diagram: "Mermaid 圖表",
	},
	en: {
		diagram: "Mermaid diagram",
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
