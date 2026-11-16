import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 钉钉工作台的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		msgCount: "{n} 条",
		unknownError: "未知错误",

		// 顶栏与机器人状态卡
		workbenchTitle: "钉钉 (DingTalk) 工作台与机器人",
		statusChecking: "检测中...",
		configCredentials: "⚙️ 配置凭证",
		botStatusTitle: "🤖 钉钉机器人 (Bot) 双工状态",
		toggleBotService: "切换机器人服务",
		duplexState: "双工状态",
		notStarted: "⚪ 未启动",
		messagesReceived: "已接收消息",
		messagesReplied: "已回复消息",
		botDescription:
			"支持群聊 @机器人 或单聊触发，自动接入 pi-web-ui 独立对话会话。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠快捷指令，超长 Markdown 自动结构化分块，代码块完整闭合。",
		online: "🟢 在线",
		connectedOnline: "🟢 已连接 (在线)",
		connecting: "🟡 连接中",
		connectingDots: "🟡 正在连接...",
		error: "🔴 错误",
		connectError: "🔴 连接出错",

		// Webhook 快捷推送
		webhookPushTitle: "📣 群机器人自定义 Webhook 快捷推送",
		cardTitleLabel: "卡片标题:",
		cardTitlePlaceholder: "通知标题 (如：构建完成通报)",
		cardTextLabel: "Markdown 正文内容:",
		cardTextPlaceholder: "支持标准 Markdown 语法，如：### 项目构建完成\n- 状态：成功\n- 分支：main",
		sendToGroup: "🚀 一键发送到钉钉群",
		pushTextRequired: "请输入 Markdown 正文内容",
		sending: "发送中...",
		pushSuccess: "✅ 钉钉消息推送成功！",
		sendFailed: "发送失败: {error}",

		// 参数配置弹窗
		settingsTitle: "📌 钉钉集成参数配置",
		appSectionTitle: "企业自建应用 / 机器人 API (支持双工对话与长连接)",
		appSecretLabel: "AppSecret (加密保存):",
		keepUnchangedPlaceholder: "留空保持不变",
		robotCodeLabel: "RobotCode (机器人标识，可选):",
		robotCodePlaceholder: "可选，默认为 AppKey",
		botAccessTitle: "🤖 机器人双工与安全访问准入",
		botEnabledLabel: "启用钉钉机器人双向会话对话服务",
		whitelistLabel: "安全白名单 (Staff ID，逗号分隔，留空不限制):",
		whitelistPlaceholder: "staff123, staff456 (留空允许所有用户)",
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
		webhookSectionTitle: "群机器人自定义 Webhook (单向卡片推送)",
		webhookUrlLabel: "Webhook 地址:",
		webhookSecretLabel: "签名加签密钥 (SEC... 开头，加密保存):",
		testConnection: "🔌 测试连接",
		cancel: "取消",
		saveConfig: "💾 保存配置",

		// 凭证与弹窗内的提示
		secretStoredPlaceholder: "●●●●●● (已加密保存，留空保持)",
		appSecretPlaceholder: "填入 AppSecret",
		webhookSecretPlaceholder: "填入 Webhook 签名密钥 (可选)",
		pickDirTitle: "选择钉钉机器人执行项目根目录",
		testing: "测试中...",
		testPassed: "测试通过！",
		testFailed: "测试未通过",
		saving: "保存中...",
		saveFailed: "保存失败: {error}",
	},
	en: {
		// Common
		msgCount: "{n} messages",
		unknownError: "unknown error",

		// Topbar and bot status card
		workbenchTitle: "DingTalk workbench & bot",
		statusChecking: "Checking...",
		configCredentials: "⚙️ Credentials",
		botStatusTitle: "🤖 DingTalk bot duplex status",
		toggleBotService: "Toggle bot service",
		duplexState: "Duplex state",
		notStarted: "⚪ Not started",
		messagesReceived: "Messages received",
		messagesReplied: "Messages replied",
		botDescription:
			"Trigger it by @-mentioning the bot in a group chat or in a direct message; every conversation gets its own pi-web-ui session. Slash commands such as <code>/help</code>, <code>/clear</code> and <code>/status</code> are supported, long Markdown is split into structured chunks, and code blocks are always closed.",
		online: "🟢 Online",
		connectedOnline: "🟢 Connected (online)",
		connecting: "🟡 Connecting",
		connectingDots: "🟡 Connecting...",
		error: "🔴 Error",
		connectError: "🔴 Connection error",

		// Webhook quick push
		webhookPushTitle: "📣 Quick push via a custom group-bot Webhook",
		cardTitleLabel: "Card title:",
		cardTitlePlaceholder: "Notification title (e.g. build finished)",
		cardTextLabel: "Markdown body:",
		cardTextPlaceholder: "Standard Markdown, e.g.: ### Build finished\n- Status: success\n- Branch: main",
		sendToGroup: "🚀 Send to the DingTalk group",
		pushTextRequired: "Enter the Markdown body first",
		sending: "Sending...",
		pushSuccess: "✅ DingTalk message pushed!",
		sendFailed: "Send failed: {error}",

		// Settings modal
		settingsTitle: "📌 DingTalk integration settings",
		appSectionTitle: "Enterprise app / bot API (duplex chat over a long connection)",
		appSecretLabel: "AppSecret (stored encrypted):",
		keepUnchangedPlaceholder: "Leave blank to keep the current value",
		robotCodeLabel: "RobotCode (bot identifier, optional):",
		robotCodePlaceholder: "Optional, defaults to AppKey",
		botAccessTitle: "🤖 Bot duplex and access control",
		botEnabledLabel: "Enable the DingTalk bot duplex chat service",
		whitelistLabel: "Allowlist (Staff IDs, comma-separated; blank means no restriction):",
		whitelistPlaceholder: "staff123, staff456 (blank allows all users)",
		workspaceLabel: "📂 Project root (workspace cwd; blank follows the current project; send /cwd in chat to switch):",
		workspacePlaceholder: "e.g. E:/my-project (blank follows the current project)",
		selectProjectPlaceholder: "Pick an existing project...",
		browse: "📂 Browse...",
		useCurrentProject: "Use current project",
		modelLabel: "✨ AI model and thinking effort (blank follows the global default):",
		modelPlaceholder: "Blank = follow the global default model (type it or pick one)",
		selectModel: "✨ Pick a model...",
		thinkingFollowGlobal: "Thinking effort: follow global",
		thinkingOff: "Thinking: off",
		thinkingLow: "Thinking: low",
		thinkingMedium: "Thinking: medium",
		thinkingHigh: "Thinking: high",
		thinkingMax: "Thinking: max",
		webhookSectionTitle: "Custom group-bot Webhook (one-way card push)",
		webhookUrlLabel: "Webhook URL:",
		webhookSecretLabel: "Signing secret (starts with SEC..., stored encrypted):",
		testConnection: "🔌 Test connection",
		cancel: "Cancel",
		saveConfig: "💾 Save settings",

		// Credentials and in-dialog notices
		secretStoredPlaceholder: "●●●●●● (stored encrypted, leave blank to keep)",
		appSecretPlaceholder: "Enter AppSecret",
		webhookSecretPlaceholder: "Enter the Webhook signing secret (optional)",
		pickDirTitle: "Choose the project root for the DingTalk bot",
		testing: "Testing...",
		testPassed: "Test passed!",
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
