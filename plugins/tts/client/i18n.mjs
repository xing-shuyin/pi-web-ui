import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 语音合成面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不在这里的是：TTS 引擎 id（`doubao-tts` / `deepseek-tts`）、音色 id、音色/引擎展示名（服务端
 * `registerEngine` 的 label/labelEn）与合成失败原因（服务端 err.message）—— 那些是协议与数据。
 */
export const DICT = {
	zh: {
		// 页头
		"app.title": "多源语音合成助手 (TTS)",
		"app.subtitle": "聚合豆包大模型与 DeepSeek 官方语音，支持伴侣扩展一键同步与系统全功能流式朗读",
		refresh: "刷新状态",

		// 封号风控警示
		"risk.title": "已启用防风控伪装模型（专属会话复用 + 浏览器真实标头对齐）",
		"risk.bodyLead": "现已彻底移除脚本自曝特征，并采用",
		"risk.bodySession": "专属持久化会话复用",
		"risk.bodyMiddle":
			"（杜绝频繁秒建秒删会话的高危特征）与人性化防抖排队。但因 DeepSeek 官方未开放独立 TTS 接口，长文本流式伴读仍存在被官方风控限制的可能，日常推荐优先使用",
		"risk.bodyDoubao": "豆包语音",
		"risk.bodyTail": "（正规 API Key 通道，稳定免封）。",

		// 凭据状态
		"creds.title": "凭据就绪状态",
		checking: "检测中...",
		"doubao.name": "豆包语音",
		"doubao.detail": "支持网页 Cookie 或火山引擎 Key",
		"doubao.badgeApiKey": "🟢 官方 Key 就绪",
		"doubao.badgeCookie": "🟢 网页 Cookie 就绪",
		"doubao.detailReady": "凭据有效，可正常合成",
		"deepseek.name": "DeepSeek 语音",
		"deepseek.detail": "支持 chat.deepseek.com 凭证",
		"deepseek.warn": "易触发网页封号风控，建议慎用",
		"deepseek.badgeReady": "🟢 userToken 就绪",
		"deepseek.detailReady": "已获取 DeepSeek 网页登录态",
		badgeMissing: "🟡 暂未配置",
		"doubao.detailMissing": "请通过扩展同步或填入 API Key",
		"deepseek.detailMissing": "请在扩展或设置中填入 userToken",

		// 伴侣扩展
		"extension.title": "伴侣扩展（一键提取双平台凭证）",
		"extension.openDir": "在电脑中定位扩展目录",
		"extension.downloadZip": "下载扩展压缩包 (.zip)",
		"extension.resetSession": "重置 DeepSeek 会话",
		"extension.clearCreds": "清空本地凭证",
		"guide.lead": "极速加载指南：",
		"guide.beforeCode": "打开",
		"guide.afterCode":
			"开启开发者模式，点击上方【在电脑中定位扩展目录】把弹出的文件夹拖入浏览器即可。在豆包或 DeepSeek 网页点一下扩展图标秒级完成同步！",

		// 在线试听
		"test.title": "在线试听测试",
		"test.riskLabel": "提示",
		"test.riskBody":
			"：当前选择 DeepSeek 语音引擎。已启用专属会话长期复用与真实浏览器标头伪装，已避免秒建秒删与机器人特征。高频长文本伴读仍建议优先使用豆包语音。",
		"test.engine": "语音引擎",
		"test.speaker": "发音角色",
		"test.text": "测试文本",
		"test.sample": "煮栗子前可以用刀在背部划一道口，水开后煮二十分钟即可轻松剥壳。",
		"test.speak": "开始试听合成",
		"test.synthRunning": "正在合成…",
		"test.success": "合成成功！",
		"test.failed": "合成失败: {error}",
		unknownError: "未知错误",
		defaultVoice: "默认音色",

		// 引擎下拉（服务端引擎未到达前的占位；id 见 value 属性）
		"engine.doubao": "豆包大模型语音 (Doubao)",
		"engine.deepseek": "DeepSeek 官方语音",

		// 确认与提示
		"alert.sessionReset": "已重置 DeepSeek 专属语音会话，下次发音将自动创建并长期复用新会话。",
		"confirm.clearCreds": "确定清空本地保存的凭据吗？",
	},
	"zh-TW": {
		// 页头
		"app.title": "多源語音合成助手 (TTS)",
		"app.subtitle": "聚合豆包大模型與 DeepSeek 官方語音，支援伴侶擴充套件一鍵同步與系統全功能流式朗讀",
		refresh: "重新整理狀態",

		// 封号风控警示
		"risk.title": "已啟用防風控偽裝模型（專屬會話複用 + 瀏覽器真實標頭對齊）",
		"risk.bodyLead": "現已徹底移除指令碼自曝特徵，並採用",
		"risk.bodySession": "專屬持久化會話複用",
		"risk.bodyMiddle":
			"（杜絕頻繁秒建秒刪會話的高危特徵）與人性化防抖排隊。但因 DeepSeek 官方未開放獨立 TTS 介面，長文本流式伴讀仍存在被官方風控限制的可能，日常推薦優先使用",
		"risk.bodyDoubao": "豆包語音",
		"risk.bodyTail": "（正規 API Key 通道，穩定免封）。",

		// 凭据状态
		"creds.title": "憑據就緒狀態",
		checking: "檢測中...",
		"doubao.name": "豆包語音",
		"doubao.detail": "支援網頁 Cookie 或火山引擎 Key",
		"doubao.badgeApiKey": "🟢 官方 Key 就緒",
		"doubao.badgeCookie": "🟢 網頁 Cookie 就緒",
		"doubao.detailReady": "憑據有效，可正常合成",
		"deepseek.name": "DeepSeek 語音",
		"deepseek.detail": "支援 chat.deepseek.com 憑證",
		"deepseek.warn": "易觸發網頁封號風控，建議慎用",
		"deepseek.badgeReady": "🟢 userToken 就緒",
		"deepseek.detailReady": "已獲取 DeepSeek 網頁登入態",
		badgeMissing: "🟡 暫未配置",
		"doubao.detailMissing": "請通過擴充套件同步或填入 API Key",
		"deepseek.detailMissing": "請在擴充套件或設定中填入 userToken",

		// 伴侣扩展
		"extension.title": "伴侶擴充套件（一鍵提取雙平臺憑證）",
		"extension.openDir": "在電腦中定位擴充套件目錄",
		"extension.downloadZip": "下載擴充套件壓縮包 (.zip)",
		"extension.resetSession": "重置 DeepSeek 會話",
		"extension.clearCreds": "清空本地憑證",
		"guide.lead": "極速載入指南：",
		"guide.beforeCode": "開啟",
		"guide.afterCode":
			"開啟開發者模式，點選上方【在電腦中定位擴充套件目錄】把彈出的資料夾拖入瀏覽器即可。在豆包或 DeepSeek 網頁點一下擴充套件圖示秒級完成同步！",

		// 在线试听
		"test.title": "線上試聽測試",
		"test.riskLabel": "提示",
		"test.riskBody":
			"：當前選擇 DeepSeek 語音引擎。已啟用專屬會話長期複用與真實瀏覽器標頭偽裝，已避免秒建秒刪與機器人特徵。高頻長文本伴讀仍建議優先使用豆包語音。",
		"test.engine": "語音引擎",
		"test.speaker": "發音角色",
		"test.text": "測試文本",
		"test.sample": "煮栗子前可以用刀在背部劃一道口，水開後煮二十分鐘即可輕鬆剝殼。",
		"test.speak": "開始試聽合成",
		"test.synthRunning": "正在合成…",
		"test.success": "合成成功！",
		"test.failed": "合成失敗: {error}",
		unknownError: "未知錯誤",
		defaultVoice: "預設音色",

		// 引擎下拉（服务端引擎未到达前的占位；id 见 value 属性）
		"engine.doubao": "豆包大模型語音 (Doubao)",
		"engine.deepseek": "DeepSeek 官方語音",

		// 确认与提示
		"alert.sessionReset": "已重置 DeepSeek 專屬語音會話，下次發音將自動建立並長期複用新會話。",
		"confirm.clearCreds": "確定清空本地儲存的憑據嗎？",
	},
	en: {
		// Page header
		"app.title": "Multi-source TTS Assistant",
		"app.subtitle":
			"Doubao LLM voices and DeepSeek official speech in one panel, with one-click companion-extension sync and full streaming playback system-wide",
		refresh: "Refresh status",

		// Anti-ban notice
		"risk.title": "Anti-ban camouflage is on (dedicated session reuse + real browser headers)",
		"risk.bodyLead": "Script fingerprints are fully removed; the plugin relies on ",
		"risk.bodySession": "dedicated persistent session reuse",
		"risk.bodyMiddle":
			" (no rapid create/delete cycles) and a humane debounce queue. Because DeepSeek exposes no official TTS API, long streaming narration may still hit official controls — prefer ",
		"risk.bodyDoubao": "Doubao voices",
		"risk.bodyTail": " (official API Key channel, stable and ban-free) for daily use.",

		// Credential status
		"creds.title": "Credential status",
		checking: "Checking...",
		"doubao.name": "Doubao voices",
		"doubao.detail": "Supports a web Cookie or a Volcano Engine Key",
		"doubao.badgeApiKey": "🟢 Official Key ready",
		"doubao.badgeCookie": "🟢 Web Cookie ready",
		"doubao.detailReady": "Credentials valid, synthesis works",
		"deepseek.name": "DeepSeek voices",
		"deepseek.detail": "Supports chat.deepseek.com credentials",
		"deepseek.warn": "May trigger web anti-ban controls; use with care",
		"deepseek.badgeReady": "🟢 userToken ready",
		"deepseek.detailReady": "DeepSeek web session acquired",
		badgeMissing: "🟡 Not configured",
		"doubao.detailMissing": "Sync through the extension or paste an API Key",
		"deepseek.detailMissing": "Enter a userToken in the extension or in settings",

		// Companion extension
		"extension.title": "Companion extension (one-click credentials for both platforms)",
		"extension.openDir": "Show the extension folder",
		"extension.downloadZip": "Download extension (.zip)",
		"extension.resetSession": "Reset DeepSeek session",
		"extension.clearCreds": "Clear local credentials",
		"guide.lead": "Quick-load guide:",
		"guide.beforeCode": "open",
		"guide.afterCode":
			"and enable Developer mode, then click “Show the extension folder” above and drag the folder into the browser. Click the extension icon on a Doubao or DeepSeek page to sync instantly.",

		// Live preview
		"test.title": "Live preview test",
		"test.riskLabel": "Note",
		"test.riskBody":
			": the DeepSeek engine is selected. Dedicated long-lived session reuse and real browser header camouflage are enabled, avoiding rapid create/delete and bot fingerprints. For high-frequency long narration, Doubao voices are still recommended.",
		"test.engine": "Voice engine",
		"test.speaker": "Voice",
		"test.text": "Test text",
		"test.sample":
			"Score a small cut in the back of each chestnut, boil for twenty minutes, and the shells peel off easily.",
		"test.speak": "Start preview",
		"test.synthRunning": "Synthesizing…",
		"test.success": "Synthesis complete!",
		"test.failed": "Synthesis failed: {error}",
		unknownError: "unknown error",
		defaultVoice: "Default voice",

		// Engine select (placeholders until the server engine list arrives; ids live in value)
		"engine.doubao": "Doubao LLM voices (Doubao)",
		"engine.deepseek": "DeepSeek official voices",

		// Confirms and alerts
		"alert.sessionReset":
			"DeepSeek's dedicated voice session was reset; the next utterance creates a new long-lived session.",
		"confirm.clearCreds": "Clear the locally saved credentials?",
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
