import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 企业微信工作台的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		msgCount: "{n} 条",
		unknownError: "未知错误",

		// 顶栏与机器人状态卡
		workbenchTitle: "企业微信 (WeCom) 工作台与机器人",
		statusChecking: "检测中...",
		configCredentials: "⚙️ 配置凭证",
		botStatusTitle: "🤖 企业微信机器人 (Bot) 状态",
		toggleBotService: "切换机器人服务",
		bridgeState: "回调桥接状态",
		notStarted: "⚪ 未启动",
		messagesReceived: "已接收消息",
		messagesReplied: "已回复消息",
		botDescription:
			"支持群机器人 Webhook 与企业内部自建应用消息。对话回复自动按企微格式结构化分块，支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠快捷指令。",
		bridgeEnabled: "🟡 桥接已启用",
		bridgeWaitingExternal: "🟡 需外部回调接入（Webhook 仅发送）",
		connecting: "🟡 连接中",
		connectingDots: "🟡 正在连接...",
		error: "🔴 错误",
		connectError: "🔴 连接出错",

		// Webhook 快捷卡片推送
		webhookPushTitle: "📣 群机器人 Webhook 快捷卡片推送",
		cardTitleLabel: "卡片标题:",
		cardTitlePlaceholder: "如：系统发布通知 / 告警通报",
		cardTextLabel: "Markdown 正文内容:",
		cardTextPlaceholder: "支持企微 Markdown 格式，例如：\n> **构建状态**：成功\n> **提交信息**：修复已知问题",
		sendToGroup: "🚀 一键推送到企业微信群",
		pushTextRequired: "请输入 Markdown 正文内容",
		sending: "发送中...",
		pushSuccess: "✅ 企业微信消息推送成功！",
		sendFailed: "发送失败: {error}",

		// 参数配置弹窗
		settingsTitle: "💼 企业微信参数配置",
		webhookSectionTitle: "群机器人 Webhook (快速接入群消息推送)",
		webhookKeyLabel: "Webhook Key (或完整地址中的 key 参数, 加密保存):",
		appSectionTitle: "企业自建应用 API (可选，发送应用消息与单聊)",
		corpIdLabel: "CorpID (企业 ID):",
		corpSecretLabel: "CorpSecret (应用凭证密钥):",
		agentIdLabel: "AgentId (应用 AgentId):",
		botAccessTitle: "🤖 回调桥接与白名单控制",
		botEnabledLabel: "启用内部会话桥接（需另接可信回调适配器）",
		whitelistLabel: "安全白名单 (用户账号/UserId，逗号分隔，留空不限制):",
		whitelistPlaceholder: "zhangsan, lisi (留空允许所有用户)",
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
		webhookKeyPlaceholder: "填入 Webhook Key",
		corpSecretPlaceholder: "填入 CorpSecret",
		keepUnchangedPlaceholder: "留空保持不变",
		pickDirTitle: "选择企业微信机器人执行项目根目录",
		testing: "测试中...",
		testPassed: "连接测试通过！",
		testFailed: "测试未通过",
		saving: "保存中...",
		saveFailed: "保存失败: {error}",
	},
	"zh-TW": {
		// 通用
		msgCount: "{n} 條",
		unknownError: "未知錯誤",

		// 顶栏与机器人状态卡
		workbenchTitle: "企業微信 (WeCom) 工作臺與機器人",
		statusChecking: "檢測中...",
		configCredentials: "⚙️ 配置憑證",
		botStatusTitle: "🤖 企業微信機器人 (Bot) 狀態",
		toggleBotService: "切換機器人服務",
		bridgeState: "回撥橋接狀態",
		notStarted: "⚪ 未啟動",
		messagesReceived: "已接收訊息",
		messagesReplied: "已回覆訊息",
		botDescription:
			"支援群機器人 Webhook 與企業內部自建應用訊息。對話回覆自動按企微格式結構化分塊，支援 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜槓快捷指令。",
		bridgeEnabled: "🟡 橋接已啟用",
		bridgeWaitingExternal: "🟡 需外部回撥接入（Webhook 僅傳送）",
		connecting: "🟡 連線中",
		connectingDots: "🟡 正在連線...",
		error: "🔴 錯誤",
		connectError: "🔴 連接出錯",

		// Webhook 快捷卡片推送
		webhookPushTitle: "📣 群機器人 Webhook 快捷卡片推送",
		cardTitleLabel: "卡片標題:",
		cardTitlePlaceholder: "如：系統釋出通知 / 告警通報",
		cardTextLabel: "Markdown 正文內容:",
		cardTextPlaceholder: "支援企微 Markdown 格式，例如：\n> **構建狀態**：成功\n> **提交資訊**：修復已知問題",
		sendToGroup: "🚀 一鍵推送到企業微信群",
		pushTextRequired: "請輸入 Markdown 正文內容",
		sending: "傳送中...",
		pushSuccess: "✅ 企業微信訊息推送成功！",
		sendFailed: "傳送失敗: {error}",

		// 参数配置弹窗
		settingsTitle: "💼 企業微信引數配置",
		webhookSectionTitle: "群機器人 Webhook (快速接入群訊息推送)",
		webhookKeyLabel: "Webhook Key (或完整地址中的 key 引數, 加密儲存):",
		appSectionTitle: "企業自建應用 API (可選，傳送應用訊息與單聊)",
		corpIdLabel: "CorpID (企業 ID):",
		corpSecretLabel: "CorpSecret (應用憑證金鑰):",
		agentIdLabel: "AgentId (應用 AgentId):",
		botAccessTitle: "🤖 回撥橋接與白名單控制",
		botEnabledLabel: "啟用內部會話橋接（需另接可信回調適配器）",
		whitelistLabel: "安全白名單 (使用者賬號/UserId，逗號分隔，留空不限制):",
		whitelistPlaceholder: "zhangsan, lisi (留空允許所有使用者)",
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
		webhookKeyPlaceholder: "填入 Webhook Key",
		corpSecretPlaceholder: "填入 CorpSecret",
		keepUnchangedPlaceholder: "留空保持不變",
		pickDirTitle: "選擇企業微信機器人執行專案根目錄",
		testing: "測試中...",
		testPassed: "連線測試通過！",
		testFailed: "測試未通過",
		saving: "儲存中...",
		saveFailed: "儲存失敗: {error}",
	},
	en: {
		// Common
		msgCount: "{n} messages",
		unknownError: "unknown error",

		// Topbar and bot status card
		workbenchTitle: "WeCom workbench & bot",
		statusChecking: "Checking...",
		configCredentials: "⚙️ Credentials",
		botStatusTitle: "🤖 WeCom bot status",
		toggleBotService: "Toggle bot service",
		bridgeState: "Callback bridge state",
		notStarted: "⚪ Not started",
		messagesReceived: "Messages received",
		messagesReplied: "Messages replied",
		botDescription:
			"Works with group-bot Webhooks and internal enterprise app messages. Replies are split into WeCom-formatted structured chunks, and slash commands such as <code>/help</code>, <code>/clear</code> and <code>/status</code> are supported.",
		bridgeEnabled: "🟡 Bridge enabled",
		bridgeWaitingExternal: "🟡 Needs an external callback receiver (Webhook only sends)",
		connecting: "🟡 Connecting",
		connectingDots: "🟡 Connecting...",
		error: "🔴 Error",
		connectError: "🔴 Connection error",

		// Webhook quick card push
		webhookPushTitle: "📣 Quick card push via a group-bot Webhook",
		cardTitleLabel: "Card title:",
		cardTitlePlaceholder: "e.g. release notice / alert summary",
		cardTextLabel: "Markdown body:",
		cardTextPlaceholder:
			"WeCom Markdown is supported, e.g.:\n> **Build status**: success\n> **Commit message**: fixed known issues",
		sendToGroup: "🚀 Push to the WeCom group",
		pushTextRequired: "Enter the Markdown body first",
		sending: "Sending...",
		pushSuccess: "✅ WeCom message pushed!",
		sendFailed: "Send failed: {error}",

		// Settings modal
		settingsTitle: "💼 WeCom settings",
		webhookSectionTitle: "Group-bot Webhook (quick group-message push)",
		webhookKeyLabel: "Webhook Key (or the key query parameter of the full URL; stored encrypted):",
		appSectionTitle: "Internal enterprise app API (optional; sends app messages and direct messages)",
		corpIdLabel: "CorpID (enterprise ID):",
		corpSecretLabel: "CorpSecret (app credential secret):",
		agentIdLabel: "AgentId (app AgentId):",
		botAccessTitle: "🤖 Callback bridge and allowlist",
		botEnabledLabel: "Enable the internal conversation bridge (needs a separate trusted callback adapter)",
		whitelistLabel: "Allowlist (user account / UserId, comma-separated; blank means no restriction):",
		whitelistPlaceholder: "zhangsan, lisi (blank allows all users)",
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
		webhookKeyPlaceholder: "Enter the Webhook Key",
		corpSecretPlaceholder: "Enter the CorpSecret",
		keepUnchangedPlaceholder: "Leave blank to keep the current value",
		pickDirTitle: "Choose the project root for the WeCom bot",
		testing: "Testing...",
		testPassed: "Connection test passed!",
		testFailed: "Test did not pass",
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
