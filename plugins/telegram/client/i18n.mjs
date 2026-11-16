import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * Telegram 工作台的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		msgCount: "{n} 条",
		unknownError: "未知错误",

		// 顶栏与机器人状态卡
		workbenchTitle: "Telegram 机器人工作台",
		statusChecking: "检测中...",
		configCredentials: "⚙️ 配置凭证",
		botStatusTitle: "🤖 Telegram Bot 双工长轮询状态",
		toggleBotService: "切换机器人服务",
		duplexState: "双工状态",
		notStarted: "⚪ 未启动",
		botAccount: "机器人账号",
		messagesReceived: "已接收消息",
		messagesReplied: "已回复消息",
		botDescription:
			"采用官方 <code>getUpdates</code> 出站长轮询，零公网 IP、免反代、免开放入站端口。支持在 Telegram 私聊或群聊（@机器人）双向对话，自动分配独立 AI 上下文。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠指令。",
		online: "🟢 在线",
		connectedOnline: "🟢 已连接 (在线)",
		connecting: "🟡 连接中",
		connectingDots: "🟡 正在连接...",
		error: "🔴 错误",
		connectError: "🔴 连接出错",

		// 快捷发送消息卡
		sendCardTitle: "📤 快捷向 Telegram 发送消息",
		targetChatLabel: "目标 Chat ID / 频道用户名:",
		targetChatPlaceholder: "如：123456789 或 @mychannel (留空使用默认)",
		messageTextLabel: "消息文本 (支持 Markdown):",
		messageTextPlaceholder: "输入要发送的消息内容...",
		sendMessage: "🚀 发送消息",
		sendTextRequired: "请输入要发送的消息文本",
		sending: "发送中...",
		sendSuccess: "✅ Telegram 消息发送成功！",
		sendFailed: "发送失败: {error}",

		// 凭证配置弹窗
		settingsTitle: "✈️ Telegram 机器人凭证配置",
		botTokenLabel: "Bot Token (来自 @BotFather, 加密存储):",
		botTokenHint: "在 Telegram 中向 @BotFather 发送 /newbot 即可快速申请 Bot Token",
		apiBaseLabel: "Telegram API 端点 (可选反代):",
		apiBasePlaceholder: "https://api.telegram.org (默认官方接口)",
		defaultChatLabel: "默认发送 Chat ID (可选):",
		defaultChatPlaceholder: "如：123456789",
		botAccessTitle: "🤖 机器人双工与白名单控制",
		botEnabledLabel: "启用 Telegram 机器人双向对话服务 (长轮询接收消息并由 AI 回复)",
		whitelistLabel: "允许的用户白名单 (User ID，逗号分隔，留空不限制):",
		whitelistPlaceholder: "12345678, 87654321 (留空允许所有用户)",
		workspaceLabel: "📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):",
		workspacePlaceholder: "如：E:/my-project (留空跟随当前项目)",
		selectProjectPlaceholder: "快速点选已有项目...",
		browse: "📂 浏览...",
		useCurrentProject: "设为当前项目",
		modelLabel: "✨ AI 模型与思考强度 (留空跟随全局默认):",
		modelPlaceholder: "留空 = 跟随全局默认模型（支持手输或点选）",
		selectModel: "✨ 选择模型...",
		thinkingFollowGlobal: "思考强度：跟随全局",
		thinkingOff: "思考：关闭 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMax: "思考：最大 (max)",
		testConnection: "🔌 测试连接",
		cancel: "取消",
		saveConfig: "💾 保存配置",

		// 凭证占位与弹窗内的提示
		secretStoredPlaceholder: "●●●●●● (已加密保存，留空保持)",
		botTokenPlaceholder: "填入 Bot Token",
		pickDirTitle: "选择 Telegram 机器人执行项目根目录",
		testing: "测试中...",
		testPassed: "连接测试通过！",
		testFailed: "测试失败",
		saving: "保存中...",
		saveFailed: "保存失败: {error}",
	},
	"zh-TW": {
		// 通用
		msgCount: "{n} 條",
		unknownError: "未知錯誤",

		// 顶栏与机器人状态卡
		workbenchTitle: "Telegram 機器人工作臺",
		statusChecking: "檢測中...",
		configCredentials: "⚙️ 配置憑證",
		botStatusTitle: "🤖 Telegram Bot 雙工長輪詢狀態",
		toggleBotService: "切換機器人服務",
		duplexState: "雙工狀態",
		notStarted: "⚪ 未啟動",
		botAccount: "機器人賬號",
		messagesReceived: "已接收訊息",
		messagesReplied: "已回覆訊息",
		botDescription:
			"採用官方 <code>getUpdates</code> 出站長輪詢，零公網 IP、免反代、免開放入站埠。支援在 Telegram 私聊或群聊（@機器人）雙向對話，自動分配獨立 AI 上下文。支援 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜槓指令。",
		online: "🟢 線上",
		connectedOnline: "🟢 已連線 (線上)",
		connecting: "🟡 連線中",
		connectingDots: "🟡 正在連線...",
		error: "🔴 錯誤",
		connectError: "🔴 連接出錯",

		// 快捷发送消息卡
		sendCardTitle: "📤 快捷向 Telegram 傳送訊息",
		targetChatLabel: "目標 Chat ID / 頻道使用者名稱:",
		targetChatPlaceholder: "如：123456789 或 @mychannel (留空使用預設)",
		messageTextLabel: "訊息文本 (支援 Markdown):",
		messageTextPlaceholder: "輸入要傳送的訊息內容...",
		sendMessage: "🚀 傳送訊息",
		sendTextRequired: "請輸入要傳送的訊息文本",
		sending: "傳送中...",
		sendSuccess: "✅ Telegram 訊息傳送成功！",
		sendFailed: "傳送失敗: {error}",

		// 凭证配置弹窗
		settingsTitle: "✈️ Telegram 機器人憑證配置",
		botTokenLabel: "Bot Token (來自 @BotFather, 加密儲存):",
		botTokenHint: "在 Telegram 中向 @BotFather 傳送 /newbot 即可快速申請 Bot Token",
		apiBaseLabel: "Telegram API 端點 (可選反代):",
		apiBasePlaceholder: "https://api.telegram.org (預設官方介面)",
		defaultChatLabel: "預設傳送 Chat ID (可選):",
		defaultChatPlaceholder: "如：123456789",
		botAccessTitle: "🤖 機器人雙工與白名單控制",
		botEnabledLabel: "啟用 Telegram 機器人雙向對話服務 (長輪詢接收訊息並由 AI 回覆)",
		whitelistLabel: "允許的使用者白名單 (User ID，逗號分隔，留空不限制):",
		whitelistPlaceholder: "12345678, 87654321 (留空允許所有使用者)",
		workspaceLabel: "📂 專案根目錄 (Workspace Cwd，留空跟隨當前專案，支援聊天發 /cwd 切換):",
		workspacePlaceholder: "如：E:/my-project (留空跟隨當前專案)",
		selectProjectPlaceholder: "快速點選已有專案...",
		browse: "📂 瀏覽...",
		useCurrentProject: "設為當前專案",
		modelLabel: "✨ AI 模型與思考強度 (留空跟隨全域性預設):",
		modelPlaceholder: "留空 = 跟隨全域性預設模型（支援手輸或點選）",
		selectModel: "✨ 選擇模型...",
		thinkingFollowGlobal: "思考強度：跟隨全域性",
		thinkingOff: "思考：關閉 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMax: "思考：最大 (max)",
		testConnection: "🔌 測試連線",
		cancel: "取消",
		saveConfig: "💾 儲存配置",

		// 凭证占位与弹窗内的提示
		secretStoredPlaceholder: "●●●●●● (已加密儲存，留空保持)",
		botTokenPlaceholder: "填入 Bot Token",
		pickDirTitle: "選擇 Telegram 機器人執行專案根目錄",
		testing: "測試中...",
		testPassed: "連線測試通過！",
		testFailed: "測試失敗",
		saving: "儲存中...",
		saveFailed: "儲存失敗: {error}",
	},
	en: {
		// Common
		msgCount: "{n} messages",
		unknownError: "unknown error",

		// Topbar and bot status card
		workbenchTitle: "Telegram bot workbench",
		statusChecking: "Checking...",
		configCredentials: "⚙️ Credentials",
		botStatusTitle: "🤖 Telegram bot long-polling duplex status",
		toggleBotService: "Toggle bot service",
		duplexState: "Duplex state",
		notStarted: "⚪ Not started",
		botAccount: "Bot account",
		messagesReceived: "Messages received",
		messagesReplied: "Messages replied",
		botDescription:
			"Uses the official <code>getUpdates</code> outbound long polling: no public IP, no reverse proxy, no inbound ports. Chat with it in a Telegram direct message or a group (@-mention the bot) and each chat gets its own AI context. Slash commands such as <code>/help</code>, <code>/clear</code> and <code>/status</code> are supported.",
		online: "🟢 Online",
		connectedOnline: "🟢 Connected (online)",
		connecting: "🟡 Connecting",
		connectingDots: "🟡 Connecting...",
		error: "🔴 Error",
		connectError: "🔴 Connection error",

		// Quick send card
		sendCardTitle: "📤 Quick send to Telegram",
		targetChatLabel: "Target Chat ID / channel username:",
		targetChatPlaceholder: "e.g. 123456789 or @mychannel (blank uses the default)",
		messageTextLabel: "Message text (Markdown supported):",
		messageTextPlaceholder: "Enter the message to send...",
		sendMessage: "🚀 Send message",
		sendTextRequired: "Enter the message text first",
		sending: "Sending...",
		sendSuccess: "✅ Telegram message sent!",
		sendFailed: "Send failed: {error}",

		// Credentials modal
		settingsTitle: "✈️ Telegram bot credentials",
		botTokenLabel: "Bot Token (from @BotFather, stored encrypted):",
		botTokenHint: "Send /newbot to @BotFather in Telegram to get a Bot Token quickly",
		apiBaseLabel: "Telegram API endpoint (optional reverse proxy):",
		apiBasePlaceholder: "https://api.telegram.org (default official endpoint)",
		defaultChatLabel: "Default Chat ID for sending (optional):",
		defaultChatPlaceholder: "e.g. 123456789",
		botAccessTitle: "🤖 Bot duplex and access control",
		botEnabledLabel: "Enable the Telegram bot duplex chat service (long polling; the AI replies to incoming messages)",
		whitelistLabel: "Allowed users (User ID, comma-separated; blank means no restriction):",
		whitelistPlaceholder: "12345678, 87654321 (blank allows all users)",
		workspaceLabel: "📂 Project root (workspace cwd; blank follows the current project; send /cwd in chat to switch):",
		workspacePlaceholder: "e.g. E:/my-project (blank follows the current project)",
		selectProjectPlaceholder: "Pick an existing project...",
		browse: "📂 Browse...",
		useCurrentProject: "Use current project",
		modelLabel: "✨ AI model and thinking effort (blank follows the global default):",
		modelPlaceholder: "Blank = follow the global default model (type it or pick one)",
		selectModel: "✨ Choose model...",
		thinkingFollowGlobal: "Thinking effort: follow global",
		thinkingOff: "Thinking: off",
		thinkingLow: "Thinking: low",
		thinkingMedium: "Thinking: medium",
		thinkingHigh: "Thinking: high",
		thinkingMax: "Thinking: max",
		testConnection: "🔌 Test connection",
		cancel: "Cancel",
		saveConfig: "💾 Save config",

		// Credential placeholders and modal notices
		secretStoredPlaceholder: "●●●●●● (stored encrypted; leave blank to keep)",
		botTokenPlaceholder: "Enter the Bot Token",
		pickDirTitle: "Choose the project root for the Telegram bot",
		testing: "Testing...",
		testPassed: "Connection test passed!",
		testFailed: "Test failed",
		saving: "Saving...",
		saveFailed: "Save failed: {error}",
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
