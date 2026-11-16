import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * WhatsApp 工作台面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 顶栏
		workspaceTitle: "WhatsApp 机器人工作台",
		checking: "检测中...",
		configureCredentials: "⚙️ 配置凭证",

		// 双工状态卡
		botStatusTitle: "🤖 WhatsApp Bot 双工服务状态",
		toggleBotService: "切换机器人服务",
		duplexStatus: "双工状态",
		linkedAccount: "关联号码 / 账号",
		messagesReceived: "已接收消息",
		messagesReplied: "已回复消息",
		msgCount: "{count} 条",
		botIntro:
			"基于 Meta 官方 WhatsApp Cloud API，需配置经过鉴权的 webhook 转发。支持多用户独立上下文隔离，自动结构化分块，代码块完整闭合，支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠快捷指令。",
		stateOnline: "🟢 在线",
		stateConnected: "🟢 已连接 (在线)",
		stateConnecting: "🟡 连接中",
		stateConnectingDetail: "🟡 正在连接...",
		stateError: "🔴 错误",
		stateErrorDetail: "🔴 连接出错",
		stateStopped: "⚪ 未启动",

		// 发送消息卡
		sendCardTitle: "📤 快捷向 WhatsApp 用户发送消息",
		targetPhoneLabel: "目标电话号码 (带国家区号，如 8613800000000):",
		targetPhonePlaceholder: "如：8613800000000 (留空使用默认号码)",
		messageTextLabel: "消息文本内容:",
		messageTextPlaceholder: "输入要发送的消息内容...",
		messageKindAria: "消息类型",
		kindText: "文本",
		kindImage: "图片",
		kindAudio: "语音/音频",
		kindDocument: "文件",
		kindVideo: "视频",
		mediaPathPlaceholder: "媒体文件的工作区相对路径（20 MiB 以内）",
		mediaPathAria: "媒体文件路径",
		mimePlaceholder: "MIME 类型，例如 image/png、audio/ogg",
		mimeAria: "媒体 MIME 类型",
		sendMessage: "🚀 发送消息",
		sending: "发送中...",
		sendMissingPath: "请输入媒体文件的工作区路径",
		sendMissingText: "请输入要发送的消息文本",
		sendOk: "✅ WhatsApp 消息发送成功！",
		sendFailed: "发送失败: {error}",

		// 凭证弹窗
		credentialsTitle: "🟢 WhatsApp Cloud API 凭证配置",
		phoneIdLabel: "Phone Number ID (来自 Meta for Developers):",
		phoneIdPlaceholder: "如：105938472910482",
		phoneIdHint: "在 Meta for Developers → WhatsApp → API Setup 中复制 Phone number ID",
		accessTokenLabel: "System Access Token (加密存储):",
		accessTokenPlaceholder: "EAABwz... (永久系统访问令牌)",
		accessTokenSaved: "●●●●●● (已加密保存，留空保持)",
		accessTokenEnter: "填入 Access Token",
		defaultRecipientLabel: "默认发送目标号码 (可选):",
		defaultRecipientPlaceholder: "如：8613800000000",

		// 机器人双工与白名单
		botControlTitle: "🤖 机器人双工与白名单控制",
		botEnabledLabel: "启用 WhatsApp 机器人双向对话回复服务",
		allowlistLabel: "安全白名单 (手机号，逗号分隔，留空不限制):",
		allowlistPlaceholder: "8613800000000, 15551234567 (留空允许所有用户)",

		// 工作区目录
		workspaceLabel: "📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):",
		workspacePlaceholder: "如：E:/my-project (留空跟随当前项目)",
		quickPickProject: "快速点选已有项目...",
		browse: "📂 浏览...",
		useCurrentProject: "设为当前项目",
		pickWorkspaceTitle: "选择 WhatsApp 机器人执行项目根目录",

		// 模型与思考强度
		modelLabel: "✨ AI 模型与思考强度 (留空跟随全局默认):",
		modelPlaceholder: "留空 = 跟随全局默认模型（支持手输或点选）",
		pickModel: "✨ 选择模型...",
		thinkingFollow: "思考强度：跟随全局",
		thinkingOff: "思考：关闭 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMinimal: "思考：最小 (minimal)",
		thinkingXhigh: "思考：极高 (xhigh)",

		// 底部操作
		testConnection: "🔌 测试连接",
		testing: "测试中...",
		testPassed: "连接测试通过！",
		testFailed: "测试失败",
		cancel: "取消",
		saveConfig: "💾 保存配置",
		saving: "保存中...",
		saveFailed: "保存失败: {error}",
		unknownError: "未知错误",
	},
	"zh-TW": {
		// 顶栏
		workspaceTitle: "WhatsApp 機器人工作臺",
		checking: "檢測中...",
		configureCredentials: "⚙️ 配置憑證",

		// 双工状态卡
		botStatusTitle: "🤖 WhatsApp Bot 雙工服務狀態",
		toggleBotService: "切換機器人服務",
		duplexStatus: "雙工狀態",
		linkedAccount: "關聯號碼 / 賬號",
		messagesReceived: "已接收訊息",
		messagesReplied: "已回覆訊息",
		msgCount: "{count} 條",
		botIntro:
			"基於 Meta 官方 WhatsApp Cloud API，需配置經過鑑權的 webhook 轉發。支援多使用者獨立上下文隔離，自動結構化分塊，程式碼塊完整閉合，支援 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜槓快捷指令。",
		stateOnline: "🟢 線上",
		stateConnected: "🟢 已連線 (線上)",
		stateConnecting: "🟡 連線中",
		stateConnectingDetail: "🟡 正在連線...",
		stateError: "🔴 錯誤",
		stateErrorDetail: "🔴 連接出錯",
		stateStopped: "⚪ 未啟動",

		// 发送消息卡
		sendCardTitle: "📤 快捷向 WhatsApp 使用者傳送訊息",
		targetPhoneLabel: "目標電話號碼 (帶國家區號，如 8613800000000):",
		targetPhonePlaceholder: "如：8613800000000 (留空使用預設號碼)",
		messageTextLabel: "訊息文本內容:",
		messageTextPlaceholder: "輸入要傳送的訊息內容...",
		messageKindAria: "訊息型別",
		kindText: "文本",
		kindImage: "圖片",
		kindAudio: "語音/音訊",
		kindDocument: "檔案",
		kindVideo: "影片",
		mediaPathPlaceholder: "媒體檔案的工作區相對路徑（20 MiB 以內）",
		mediaPathAria: "媒體檔案路徑",
		mimePlaceholder: "MIME 型別，例如 image/png、audio/ogg",
		mimeAria: "媒體 MIME 型別",
		sendMessage: "🚀 傳送訊息",
		sending: "傳送中...",
		sendMissingPath: "請輸入媒體檔案的工作區路徑",
		sendMissingText: "請輸入要傳送的訊息文本",
		sendOk: "✅ WhatsApp 訊息傳送成功！",
		sendFailed: "傳送失敗: {error}",

		// 凭证弹窗
		credentialsTitle: "🟢 WhatsApp Cloud API 憑證配置",
		phoneIdLabel: "Phone Number ID (來自 Meta for Developers):",
		phoneIdPlaceholder: "如：105938472910482",
		phoneIdHint: "在 Meta for Developers → WhatsApp → API Setup 中複製 Phone number ID",
		accessTokenLabel: "System Access Token (加密儲存):",
		accessTokenPlaceholder: "EAABwz... (永久系統訪問令牌)",
		accessTokenSaved: "●●●●●● (已加密儲存，留空保持)",
		accessTokenEnter: "填入 Access Token",
		defaultRecipientLabel: "預設傳送目標號碼 (可選):",
		defaultRecipientPlaceholder: "如：8613800000000",

		// 机器人双工与白名单
		botControlTitle: "🤖 機器人雙工與白名單控制",
		botEnabledLabel: "啟用 WhatsApp 機器人雙向對話回覆服務",
		allowlistLabel: "安全白名單 (手機號，逗號分隔，留空不限制):",
		allowlistPlaceholder: "8613800000000, 15551234567 (留空允許所有使用者)",

		// 工作区目录
		workspaceLabel: "📂 專案根目錄 (Workspace Cwd，留空跟隨當前專案，支援聊天發 /cwd 切換):",
		workspacePlaceholder: "如：E:/my-project (留空跟隨當前專案)",
		quickPickProject: "快速點選已有專案...",
		browse: "📂 瀏覽...",
		useCurrentProject: "設為當前專案",
		pickWorkspaceTitle: "選擇 WhatsApp 機器人執行專案根目錄",

		// 模型与思考强度
		modelLabel: "✨ AI 模型與思考強度 (留空跟隨全域性預設):",
		modelPlaceholder: "留空 = 跟隨全域性預設模型（支援手輸或點選）",
		pickModel: "✨ 選擇模型...",
		thinkingFollow: "思考強度：跟隨全域性",
		thinkingOff: "思考：關閉 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMinimal: "思考：最小 (minimal)",
		thinkingXhigh: "思考：極高 (xhigh)",

		// 底部操作
		testConnection: "🔌 測試連線",
		testing: "測試中...",
		testPassed: "連線測試通過！",
		testFailed: "測試失敗",
		cancel: "取消",
		saveConfig: "💾 儲存配置",
		saving: "儲存中...",
		saveFailed: "儲存失敗: {error}",
		unknownError: "未知錯誤",
	},
	en: {
		// Top bar
		workspaceTitle: "WhatsApp bot workspace",
		checking: "Checking...",
		configureCredentials: "⚙️ Configure credentials",

		// Duplex status card
		botStatusTitle: "🤖 WhatsApp bot duplex status",
		toggleBotService: "Toggle bot service",
		duplexStatus: "Duplex status",
		linkedAccount: "Linked number / account",
		messagesReceived: "Messages received",
		messagesReplied: "Messages replied",
		msgCount: "{count} messages",
		botIntro:
			"Built on Meta's official WhatsApp Cloud API; an authenticated webhook forwarder must be configured. Supports isolated per-user context, structured chunking, always-closed code blocks, and slash commands such as <code>/help</code>, <code>/clear</code> and <code>/status</code>.",
		stateOnline: "🟢 Online",
		stateConnected: "🟢 Connected (online)",
		stateConnecting: "🟡 Connecting",
		stateConnectingDetail: "🟡 Connecting...",
		stateError: "🔴 Error",
		stateErrorDetail: "🔴 Connection error",
		stateStopped: "⚪ Not running",

		// Send message card
		sendCardTitle: "📤 Send a message to a WhatsApp user",
		targetPhoneLabel: "Target phone number (with country code, e.g. 8613800000000):",
		targetPhonePlaceholder: "e.g. 8613800000000 (leave empty to use the default number)",
		messageTextLabel: "Message text:",
		messageTextPlaceholder: "Type the message to send...",
		messageKindAria: "Message type",
		kindText: "Text",
		kindImage: "Image",
		kindAudio: "Voice / audio",
		kindDocument: "File",
		kindVideo: "Video",
		mediaPathPlaceholder: "Workspace-relative path of the media file (up to 20 MiB)",
		mediaPathAria: "Media file path",
		mimePlaceholder: "MIME type, e.g. image/png, audio/ogg",
		mimeAria: "Media MIME type",
		sendMessage: "🚀 Send message",
		sending: "Sending...",
		sendMissingPath: "Enter the workspace-relative path of the media file",
		sendMissingText: "Enter the message text to send",
		sendOk: "✅ WhatsApp message sent!",
		sendFailed: "Send failed: {error}",

		// Credentials dialog
		credentialsTitle: "🟢 WhatsApp Cloud API credentials",
		phoneIdLabel: "Phone Number ID (from Meta for Developers):",
		phoneIdPlaceholder: "e.g. 105938472910482",
		phoneIdHint: "Copy the Phone number ID from Meta for Developers → WhatsApp → API Setup",
		accessTokenLabel: "System Access Token (stored encrypted):",
		accessTokenPlaceholder: "EAABwz... (permanent system user token)",
		accessTokenSaved: "●●●●●● (saved encrypted; leave empty to keep)",
		accessTokenEnter: "Enter Access Token",
		defaultRecipientLabel: "Default recipient number (optional):",
		defaultRecipientPlaceholder: "e.g. 8613800000000",

		// Bot duplex and allowlist
		botControlTitle: "🤖 Bot duplex and allowlist",
		botEnabledLabel: "Enable two-way reply service for the WhatsApp bot",
		allowlistLabel: "Allowlist (phone numbers, comma-separated; empty means no restriction):",
		allowlistPlaceholder: "8613800000000, 15551234567 (leave empty to allow every user)",

		// Workspace directory
		workspaceLabel: "📂 Project root (Workspace Cwd; empty follows the current project; /cwd in chat switches it):",
		workspacePlaceholder: "e.g. E:/my-project (leave empty to follow the current project)",
		quickPickProject: "Quick-pick an existing project...",
		browse: "📂 Browse...",
		useCurrentProject: "Use current project",
		pickWorkspaceTitle: "Choose the project root the WhatsApp bot runs in",

		// Model and thinking level
		modelLabel: "✨ AI model and thinking level (empty follows the global default):",
		modelPlaceholder: "Empty = follow the global default model (type or pick)",
		pickModel: "✨ Choose model...",
		thinkingFollow: "Thinking: follow global",
		thinkingOff: "Thinking: off",
		thinkingLow: "Thinking: low",
		thinkingMedium: "Thinking: medium",
		thinkingHigh: "Thinking: high",
		thinkingMinimal: "Thinking: minimal",
		thinkingXhigh: "Thinking: extra high",

		// Footer actions
		testConnection: "🔌 Test connection",
		testing: "Testing...",
		testPassed: "Connection test passed!",
		testFailed: "Test failed",
		cancel: "Cancel",
		saveConfig: "💾 Save config",
		saving: "Saving...",
		saveFailed: "Save failed: {error}",
		unknownError: "unknown error",
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
