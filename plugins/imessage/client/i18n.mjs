import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * iMessage 工作台的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		msgCount: "{n} 条",
		unknownError: "未知错误",

		// 顶栏与机器人状态卡
		workbenchTitle: "Apple iMessage 工作台与机器人",
		statusChecking: "检测中...",
		configCredentials: "⚙️ 配置凭证",
		botStatusTitle: "🤖 iMessage 双工服务状态",
		toggleBotService: "切换机器人服务",
		duplexState: "双工状态",
		notStarted: "⚪ 未启动",
		platform: "运行平台",
		messagesReceived: "已接收消息",
		messagesReplied: "已回复消息",
		botDescription:
			"专为 Apple macOS 设计，利用 Messages 原生自动化实现与 iPhone / iPad / Mac 的随身双工对话。零公网 IP、无须申请任何商业凭证。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠指令。",
		online: "🟢 在线",
		connectedOnline: "🟢 已连接 (在线)",
		error: "🔴 错误",
		connectError: "🔴 连接出错",

		// 快捷发送
		sendCardTitle: "📤 快捷向 iMessage 联系人发送消息",
		recipientLabel: "目标 Apple ID 邮箱或手机号:",
		recipientPlaceholder: "如：user@example.com 或 +8613800000000 (留空使用默认)",
		messageTextLabel: "消息文本内容:",
		messageTextPlaceholder: "输入要发送的消息内容...",
		sendMessage: "🚀 发送消息",
		sendTextRequired: "请输入要发送的消息文本",
		sending: "发送中...",
		sendSuccess: "✅ iMessage 发送成功！",
		sendFailed: "发送失败: {error}",

		// 参数配置弹窗
		settingsTitle: "💬 iMessage 参数配置",
		defaultRecipientLabel: "默认接收者 (Apple ID 邮箱或手机号, 可选):",
		defaultRecipientPlaceholder: "如：user@example.com",
		botAccessTitle: "🤖 机器人双工与白名单控制",
		botEnabledLabel: "启用 iMessage 双向对话服务",
		whitelistLabel: "允许的用户白名单 (Apple ID / 手机号，逗号分隔，留空不限制):",
		whitelistPlaceholder: "user1@example.com, +8613800000000 (留空允许所有用户)",
		workspaceLabel: "📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):",
		workspacePlaceholder: "如：/Users/me/project (留空跟随当前项目)",
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
		envCheck: "🔌 环境检测",
		cancel: "取消",
		saveConfig: "💾 保存配置",

		// 环境检测与保存提示
		pickDirTitle: "选择 iMessage 机器人执行项目根目录",
		checking: "检测中...",
		checkPassed: "检测通过！",
		checkFailed: "检测失败",
		saving: "保存中...",
		saveFailed: "保存失败: {error}",
	},
	"zh-TW": {
		// 通用
		msgCount: "{n} 條",
		unknownError: "未知錯誤",

		// 顶栏与机器人状态卡
		workbenchTitle: "Apple iMessage 工作臺與機器人",
		statusChecking: "檢測中...",
		configCredentials: "⚙️ 配置憑證",
		botStatusTitle: "🤖 iMessage 雙工服務狀態",
		toggleBotService: "切換機器人服務",
		duplexState: "雙工狀態",
		notStarted: "⚪ 未啟動",
		platform: "執行平臺",
		messagesReceived: "已接收訊息",
		messagesReplied: "已回覆訊息",
		botDescription:
			"專為 Apple macOS 設計，利用 Messages 原生自動化實現與 iPhone / iPad / Mac 的隨身雙工對話。零公網 IP、無須申請任何商業憑證。支援 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜槓指令。",
		online: "🟢 線上",
		connectedOnline: "🟢 已連線 (線上)",
		error: "🔴 錯誤",
		connectError: "🔴 連接出錯",

		// 快捷发送
		sendCardTitle: "📤 快捷向 iMessage 聯絡人傳送訊息",
		recipientLabel: "目標 Apple ID 郵箱或手機號:",
		recipientPlaceholder: "如：user@example.com 或 +8613800000000 (留空使用預設)",
		messageTextLabel: "訊息文本內容:",
		messageTextPlaceholder: "輸入要傳送的訊息內容...",
		sendMessage: "🚀 傳送訊息",
		sendTextRequired: "請輸入要傳送的訊息文本",
		sending: "傳送中...",
		sendSuccess: "✅ iMessage 傳送成功！",
		sendFailed: "傳送失敗: {error}",

		// 参数配置弹窗
		settingsTitle: "💬 iMessage 引數配置",
		defaultRecipientLabel: "預設接收者 (Apple ID 郵箱或手機號, 可選):",
		defaultRecipientPlaceholder: "如：user@example.com",
		botAccessTitle: "🤖 機器人雙工與白名單控制",
		botEnabledLabel: "啟用 iMessage 雙向對話服務",
		whitelistLabel: "允許的使用者白名單 (Apple ID / 手機號，逗號分隔，留空不限制):",
		whitelistPlaceholder: "user1@example.com, +8613800000000 (留空允許所有使用者)",
		workspaceLabel: "📂 專案根目錄 (Workspace Cwd，留空跟隨當前專案，支援聊天發 /cwd 切換):",
		workspacePlaceholder: "如：/Users/me/project (留空跟隨當前專案)",
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
		envCheck: "🔌 環境檢測",
		cancel: "取消",
		saveConfig: "💾 儲存配置",

		// 环境检测与保存提示
		pickDirTitle: "選擇 iMessage 機器人執行專案根目錄",
		checking: "檢測中...",
		checkPassed: "檢測通過！",
		checkFailed: "檢測失敗",
		saving: "儲存中...",
		saveFailed: "儲存失敗: {error}",
	},
	en: {
		// Common
		msgCount: "{n} messages",
		unknownError: "unknown error",

		// Topbar and bot status card
		workbenchTitle: "Apple iMessage workbench and bot",
		statusChecking: "Checking...",
		configCredentials: "⚙️ Credentials",
		botStatusTitle: "🤖 iMessage duplex service status",
		toggleBotService: "Toggle bot service",
		duplexState: "Duplex state",
		notStarted: "⚪ Not started",
		platform: "Platform",
		messagesReceived: "Messages received",
		messagesReplied: "Messages replied",
		botDescription:
			"Made for Apple macOS: it uses the native Messages automation to hold two-way conversations with iPhone, iPad and Mac. No public IP and no commercial credentials required. Slash commands such as <code>/help</code>, <code>/clear</code> and <code>/status</code> are supported.",
		online: "🟢 Online",
		connectedOnline: "🟢 Connected (online)",
		error: "🔴 Error",
		connectError: "🔴 Connection error",

		// Quick send
		sendCardTitle: "📤 Quick message to an iMessage contact",
		recipientLabel: "Target Apple ID email or phone number:",
		recipientPlaceholder: "e.g. user@example.com or +8613800000000 (blank uses the default)",
		messageTextLabel: "Message text:",
		messageTextPlaceholder: "Enter the message to send...",
		sendMessage: "🚀 Send message",
		sendTextRequired: "Enter the message text first",
		sending: "Sending...",
		sendSuccess: "✅ iMessage sent!",
		sendFailed: "Send failed: {error}",

		// Settings modal
		settingsTitle: "💬 iMessage settings",
		defaultRecipientLabel: "Default recipient (Apple ID email or phone number, optional):",
		defaultRecipientPlaceholder: "e.g. user@example.com",
		botAccessTitle: "🤖 Bot duplex and allowlist control",
		botEnabledLabel: "Enable the iMessage two-way chat service",
		whitelistLabel: "Allowed users (Apple ID / phone numbers, comma-separated; blank means no restriction):",
		whitelistPlaceholder: "user1@example.com, +8613800000000 (blank allows all users)",
		workspaceLabel: "📂 Project root (workspace cwd; blank follows the current project; send /cwd in chat to switch):",
		workspacePlaceholder: "e.g. /Users/me/project (blank follows the current project)",
		selectProjectPlaceholder: "Pick an existing project...",
		browse: "📂 Browse...",
		useCurrentProject: "Use current project",
		modelLabel: "✨ AI model and thinking effort (blank follows the global default):",
		modelPlaceholder: "Blank = follow the global default model (type or pick one)",
		selectModel: "✨ Pick a model...",
		thinkingFollowGlobal: "Thinking effort: follow global",
		thinkingOff: "Thinking: off",
		thinkingLow: "Thinking: low",
		thinkingMedium: "Thinking: medium",
		thinkingHigh: "Thinking: high",
		thinkingMax: "Thinking: max",
		envCheck: "🔌 Environment check",
		cancel: "Cancel",
		saveConfig: "💾 Save config",

		// Environment check and save hints
		pickDirTitle: "Choose the project root for the iMessage bot",
		checking: "Checking...",
		checkPassed: "Check passed!",
		checkFailed: "Check failed",
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
