import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 阅读插件客户端的自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 注意：给 AI 的修源/建源正文（ai-fix.mjs）不在这里，它是提示词契约，必须逐字保持中文。
 */
export const DICT = {
	zh: {
		// 宿主能力提示
		hostUnsupportedCopied:
			"当前宿主不支持自动开对话（pi-web-ui 版本较旧）。\n给 AI 的正文已复制到剪贴板，粘贴到对话框即可。",
		hostUnsupported: "当前宿主不支持自动开对话（pi-web-ui 版本较旧）。",
		hostNotConnected: "还没连上 pi-web-ui 服务（或连接未就绪），稍后重试。",
	},
	"zh-TW": {
		// 宿主能力提示
		hostUnsupportedCopied:
			"當前宿主不支援自動開對話（pi-web-ui 版本較舊）。\n給 AI 的正文已複製到剪貼簿，貼上到對話方塊即可。",
		hostUnsupported: "當前宿主不支援自動開對話（pi-web-ui 版本較舊）。",
		hostNotConnected: "還沒連上 pi-web-ui 服務（或連線未就緒），稍後重試。",
	},
	en: {
		// Host capability notices
		hostUnsupportedCopied:
			"This host cannot start a chat automatically (pi-web-ui is too old).\nThe prompt for the AI has been copied to the clipboard — paste it into the chat box.",
		hostUnsupported: "This host cannot start a chat automatically (pi-web-ui is too old).",
		hostNotConnected: "Not connected to the pi-web-ui service yet (or the connection is not ready). Try again shortly.",
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
