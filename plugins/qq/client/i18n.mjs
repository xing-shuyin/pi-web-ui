import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * QQ 机器人工作台的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 *
 * 刻意留在 entry.mjs 里的「数据」不在这里翻译：
 *   · AppID / AppSecret / ClientSecret / Channel ID / openid / user_openid / group_openid 等字段名；
 *   · 网关与沙箱域名（sandbox.api.sgroup.qq.com）、event 名（ask_user_question、run_end）；
 *   · 指令词表（/help、1/cwd、2/new …）本身 —— 只有方括号里的参数提示随界面语言变化；
 *   · 服务端回传的错误码 / 错误文本、用户与群 openid、会话 ID。
 */
export const DICT = {
	zh: {
		// 通用
		cancel: "取消",
		unknownError: "未知错误",
		saveConfig: "保存配置",
		saveConfigBtn: "💾 保存配置",
		savingConfig: "保存中...",
		saveFailed: "保存失败: {error}",
		testConnection: "🔌 测试连接",
		testing: "测试中...",
		testPassed: "连接测试通过！",
		testFailed: "测试失败: {error}",
		testNoResponse: "测试失败: 未收到有效响应",

		// 工作台头部
		workbenchTitle: "QQ 机器人工作台",
		checking: "检测中...",
		refreshStatus: "⟳ 刷新状态",
		toggleBot: "⚡ 启停服务",
		openConfig: "⚙️ 凭证与高级设置",

		// 运行状态
		statusOnline: "🟢 在线",
		statusConnecting: "🟡 连接中",
		statusError: "🔴 错误",
		notRunning: "⚪ 未启动",
		metricConnected: "🟢 已连接 (在线)",
		metricDeliveryFailed: "🔴 投递失败: {error}",
		metricConnecting: "🟡 正在连接...",
		metricErrored: "🔴 出错: {error}",
		metricConnError: "🔴 连接出错",
		countMessages: "{count} 条",
		connState: "连接状态",
		botAccount: "机器人账号",
		recvCount: "已接收消息",
		sentCount: "已回复消息",
		healthTitle: "📊 机器人连接与运行概况",

		// 项目根目录
		wsTitle: "项目根目录（执行工作空间）",
		loading: "读取中…",
		wsPlaceholder: "留空 = 跟随当前网页项目根目录",
		wsSelectPlaceholder: "快速点选已有项目…",
		wsBrowse: "📂 浏览目录…",
		wsSetRoot: "设为根目录",
		wsUseCwd: "设为当前项目",
		wsClear: "清空固定",
		wsFixed: "当前已固定根目录：{path}",
		wsFollowing: "跟随网页当前项目：{path} (留空默认)",
		wsFollowHost: "跟随宿主启动工作目录 (默认)",
		wsSelectOption: "选择最近项目…",
		wsCurrentOption: "当前网页项目：{name} ({path})",
		wsPinnedOption: "已固定根目录：{name} ({path})",

		// 模型与思考强度
		modelTitle: "AI 模型与双向同步模式",
		modelPlaceholder: "留空 = 跟随全局默认模型（支持手输或点选）",
		modelBrowse: "✨ 选择模型…",
		thinkingDefault: "思考强度：跟随全局",
		thinkingOff: "思考：关闭 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMax: "思考：最大 (max)",
		modelClear: "恢复默认",
		bindActiveLabel: "⚠️ 强行注入电脑端当前打开的会话（遥控器模式，默认关闭）",
		bindActiveHint:
			"建议保持关闭：每个 QQ 用户/群自动拥有独立的专属会话，绝不干扰电脑端正在进行的日常写代码对话。在下方点击「👁️ 打开此对话」即可随时在电脑端点开专属会话并接管！",

		// 最近 QQ 互动对话
		recentTitle: "最近 QQ 互动对话（电脑端直接点开查看）",
		recentSubtitle: "双向消息流转",
		recentEmpty: "暂无 QQ 互动记录。在 QQ 中 @机器人 发送消息，这里即可实时查看并一键跳转到主界面！",
		chatUser: "QQ用户: ",
		chatSession: "会话: ",
		askPrefix: "问：",
		replyPrefix: "答：",
		noMessageText: "(暂无消息文本)",
		openChat: "👁️ 打开此对话",
		openChatTitle: "在电脑端直接打开该会话，查看流式记录并直接回复接管",
		opening: "打开中...",

		// 发送测试消息
		sendTitle: "📤 快捷向 QQ 频道子频道发送测试消息",
		targetChannel: "目标子频道 Channel ID:",
		fetchChannels: "🔍 自动读取我的子频道",
		channelPlaceholder: "如：12345678 (注意：是具体的文字子频道ID，不是大频道号)",
		messageText: "消息文本内容:",
		messagePlaceholder: "输入要发送的消息内容...",
		mediaLabel: "媒体（可选：本地文件路径或 http(s) URL）:",
		mediaPlaceholder: "如 C:\\pic\\a.png 或 https://…/a.png",
		mediaHint: "子频道（Channel ID）只支持公网 URL（官方限制）；发本地文件请填下面的单聊/群聊 openid。",
		openidTypeUser: "单聊 user_openid",
		openidTypeGroup: "群聊 group_openid",
		openidLabel: "单聊 / 群聊 openid（可选，填了就发它而不是频道）:",
		openidPlaceholder: "留空 = 发到上方子频道",
		sendMessage: "🚀 发送消息",
		sending: "发送中...",
		uploading: "上传中...",
		sendOkMedia: "✅ QQ 媒体发送成功！",
		sendOkText: "✅ QQ 消息发送成功！",
		sendFailed: "发送失败: {error}",
		emptyMessage: "请输入消息文本或媒体路径",
		channelPickHint: "-- 点击选择下方读取到的子频道 --",
		channelOption: "【{guild}】#{channel} (ID: {id})",
		fetchOk: "成功读取到 {count} 个子频道！已在下方列出，请直接在下拉框中选择。",
		fetchNoSubs: "已找到频道，但未获取到子频道列表。请检查机器人是否有子频道访问权限。",
		fetchNoGuilds: "未找到机器人加入的频道。请先在 QQ 开放平台将机器人邀请进您的频道！",
		fetchFailed: "读取失败: {error}",
		fetchFailedHint: "读取失败: 请确认机器人是否已加入频道并在线",
		fetching: "读取中...",

		// 快捷指令指南（指令词表本身是数据，只有方括号里的参数提示随语言变化）
		quickCmdTitle: "快捷指令指南：",
		quickCmdBody:
			"在 QQ 频道或群聊中发送 {slash} 或 {help} 可查看编号操作菜单。支持发送 {cwd} 切换项目、{new} 清空或开新任务、{status} 查看状态、{model} 切模型、{thinking} 调思考、{plan} 计划模式、{compact} 压缩会话、{stop} 中止任务。",
		cmdCwd: "1/cwd [路径]",
		cmdNew: "2/new [提示]",
		cmdStatus: "3/status",
		cmdModel: "4/model [ID]",
		cmdThinking: "5/thinking [档位]",
		cmdPlan: "6/plan [on/off]",
		cmdCompact: "7/compact",
		cmdStop: "8/stop",

		// 凭证与高级设置
		modalTitle: "🐧 QQ 机器人凭证与高级设置",
		appIdLabel: "AppID (来自 QQ 开放平台):",
		appIdPlaceholder: "如：102030405",
		secretLabel: "AppSecret / ClientSecret (机器人密钥, 加密存储):",
		secretPlaceholder: "填入 AppSecret (机器人密钥)",
		secretSavedPlaceholder: "●●●●●● (已加密保存，留空保持不变)",
		sandboxLabel: "使用沙箱测试环境 (sandbox.api.sgroup.qq.com)",
		defaultChannelLabel: "默认发送子频道 Channel ID (可选，非 AppSecret，不使用可留空):",
		defaultChannelPlaceholder: "如：12345678 (不用频道请留空)",
		broadcastSection: "📢 频道通知广播",
		broadcastDesc: "借助私人频道接收 AI 状态推送，无需时刻守在电脑前。",
		broadcastChannelLabel: "广播通知子频道 ID (留空默认使用上方默认子频道):",
		broadcastChannelPlaceholder: "留空使用上方默认子频道",
		notifyQuestionLabel: "AI 提问待确认时发送频道通知 (ask_user_question)",
		notifyRunEndLabel: "AI 任务执行完成时发送频道通知 (run_end 摘要)",
		voiceSection: "🔊 自动回复语音",
		replyModeLabel: "回复方式",
		replyModeText: "文字回复",
		replyModeVoice: "语音回复",
		replyModeBoth: "语音和文字",
		voiceEngineLabel: "TTS 引擎",
		voiceSpeakerLabel: "音色",
		voiceRateLabel: "语速",
		defaultVoice: "默认音色",
		voiceNotLoaded: "{engine}（未加载）",
		voiceFallbackNotice: "上次语音回复已回退为文字：{error}",
		voiceLoadFailed: "无法加载音色",
		voiceHint:
			"单聊和群聊支持语音，频道使用文字。长回复朗读开头并附完整文字；语音失败自动发送文字。安装并启用 TTS 插件后，可选择豆包等引擎及其音色。",
		builtinVoice: "系统语音",
		botSection: "🤖 机器人双工与白名单控制",
		botEnabledLabel: "启用 QQ 机器人双向会话对话服务 (WebSocket 出站长连接)",
		allowedUsersLabel: "允许的用户白名单 (用户 ID / OpenID，逗号分隔，留空不限制):",
		allowedUsersPlaceholder: "123456, 789012 (留空允许所有用户)",
		timeoutLabel: "执行超时提醒 (秒):",

		// 操作提示
		hostTimeout: "宿主通信超时",
		hostNotReady: "宿主通信未就绪",
		pickDirTitle: "选择 QQ 机器人执行项目根目录",
		workspaceSet: "✅ 已将项目根目录设为：{path}",
		followGlobal: "(跟随全局)",
		switchFailed: "⚠️ 切换失败: {error}",
		workspaceCleared: "已清空固定根目录，恢复跟随全局",
		modelSaved: "✅ AI 模型与思考强度配置已保存！",
		modelReset: "已恢复跟随全局默认模型与思考强度",
		needAppId: "请先填写 AppID",
		needSecret: "请先填写 AppSecret / ClientSecret (机器人密钥)",
		enableNeedsCreds: "启用机器人对话服务需要先配置 AppID 和 AppSecret",
	},
	en: {
		// Common
		cancel: "Cancel",
		unknownError: "unknown error",
		saveConfig: "Save",
		saveConfigBtn: "💾 Save",
		savingConfig: "Saving...",
		saveFailed: "Save failed: {error}",
		testConnection: "🔌 Test connection",
		testing: "Testing...",
		testPassed: "Connection test passed!",
		testFailed: "Test failed: {error}",
		testNoResponse: "Test failed: no valid response",

		// Workbench header
		workbenchTitle: "QQ bot workbench",
		checking: "Checking...",
		refreshStatus: "⟳ Refresh status",
		toggleBot: "⚡ Start/stop service",
		openConfig: "⚙️ Credentials & advanced",

		// Runtime status
		statusOnline: "🟢 Online",
		statusConnecting: "🟡 Connecting",
		statusError: "🔴 Error",
		notRunning: "⚪ Not running",
		metricConnected: "🟢 Connected (online)",
		metricDeliveryFailed: "🔴 Delivery failed: {error}",
		metricConnecting: "🟡 Connecting...",
		metricErrored: "🔴 Error: {error}",
		metricConnError: "🔴 Connection error",
		countMessages: "{count} messages",
		connState: "Connection",
		botAccount: "Bot account",
		recvCount: "Messages received",
		sentCount: "Messages replied",
		healthTitle: "📊 Bot connection and runtime overview",

		// Project root
		wsTitle: "Project root (execution workspace)",
		loading: "Loading…",
		wsPlaceholder: "Empty = follow the current web project root",
		wsSelectPlaceholder: "Quick-pick an existing project…",
		wsBrowse: "📂 Browse…",
		wsSetRoot: "Set as root",
		wsUseCwd: "Use current project",
		wsClear: "Clear pin",
		wsFixed: "Pinned root: {path}",
		wsFollowing: "Following the current web project: {path} (default when empty)",
		wsFollowHost: "Following the host launch directory (default)",
		wsSelectOption: "Pick a recent project…",
		wsCurrentOption: "Current web project: {name} ({path})",
		wsPinnedOption: "Pinned root: {name} ({path})",

		// Model and thinking level
		modelTitle: "AI model and two-way sync",
		modelPlaceholder: "Empty = follow the global default model (type or pick)",
		modelBrowse: "✨ Pick model…",
		thinkingDefault: "Thinking level: follow global",
		thinkingOff: "Thinking: off",
		thinkingLow: "Thinking: low",
		thinkingMedium: "Thinking: medium",
		thinkingHigh: "Thinking: high",
		thinkingMax: "Thinking: max",
		modelClear: "Restore defaults",
		bindActiveLabel: "⚠️ Force-inject the session currently open on the desktop (remote-control mode, off by default)",
		bindActiveHint:
			"Best left off: every QQ user/group gets its own dedicated session, so the desktop coding conversation is never disturbed. Use “👁️ Open this chat” below to open the dedicated session on the desktop and take over at any time.",

		// Recent QQ chats
		recentTitle: "Recent QQ chats (open them right here on the desktop)",
		recentSubtitle: "Two-way message flow",
		recentEmpty:
			"No QQ chats yet. @-mention the bot in QQ and the conversation shows up here in real time with one-click access.",
		chatUser: "QQ user: ",
		chatSession: "Session: ",
		askPrefix: "Q: ",
		replyPrefix: "A: ",
		noMessageText: "(no message text)",
		openChat: "👁️ Open this chat",
		openChatTitle: "Open this session on the desktop to watch the stream and reply directly",
		opening: "Opening...",

		// Send test message
		sendTitle: "📤 Send a quick test message to a QQ guild sub-channel",
		targetChannel: "Target sub-channel Channel ID:",
		fetchChannels: "🔍 Load my sub-channels",
		channelPlaceholder: "e.g. 12345678 (the text sub-channel ID, not the guild ID)",
		messageText: "Message text:",
		messagePlaceholder: "Type the message to send...",
		mediaLabel: "Media (optional: local file path or http(s) URL):",
		mediaPlaceholder: "e.g. C:\\pic\\a.png or https://…/a.png",
		mediaHint:
			"Sub-channels accept public URLs only (platform limit); to send a local file, fill in the direct/group openid below.",
		openidTypeUser: "Direct user_openid",
		openidTypeGroup: "Group group_openid",
		openidLabel: "Direct/group openid (optional; sends there instead of the channel):",
		openidPlaceholder: "Empty = send to the sub-channel above",
		sendMessage: "🚀 Send message",
		sending: "Sending...",
		uploading: "Uploading...",
		sendOkMedia: "✅ QQ media sent!",
		sendOkText: "✅ QQ message sent!",
		sendFailed: "Send failed: {error}",
		emptyMessage: "Enter message text or a media path",
		channelPickHint: "-- pick one of the sub-channels loaded below --",
		channelOption: "[{guild}] #{channel} (ID: {id})",
		fetchOk: "Loaded {count} sub-channels — pick one from the dropdown below.",
		fetchNoSubs: "Found guilds but no sub-channel list; check that the bot can access sub-channels.",
		fetchNoGuilds: "The bot has not joined any guild yet. Invite it to your guild in the QQ Open Platform first!",
		fetchFailed: "Load failed: {error}",
		fetchFailedHint: "Load failed: check that the bot has joined a guild and is online",
		fetching: "Loading...",

		// Quick command guide (the command vocabulary itself is data; only the bracket hints are localized)
		quickCmdTitle: "Quick command guide: ",
		quickCmdBody:
			"send {slash} or {help} in a QQ channel or group to see the numbered menu. Supported: {cwd} switches project, {new} clears or starts a new task, {status} shows status, {model} switches model, {thinking} sets the thinking level, {plan} toggles plan mode, {compact} compacts the session, {stop} stops the task.",
		cmdCwd: "1/cwd [path]",
		cmdNew: "2/new [prompt]",
		cmdStatus: "3/status",
		cmdModel: "4/model [ID]",
		cmdThinking: "5/thinking [level]",
		cmdPlan: "6/plan [on/off]",
		cmdCompact: "7/compact",
		cmdStop: "8/stop",

		// Credentials and advanced settings
		modalTitle: "🐧 QQ bot credentials & advanced settings",
		appIdLabel: "AppID (from the QQ Open Platform):",
		appIdPlaceholder: "e.g. 102030405",
		secretLabel: "AppSecret / ClientSecret (bot secret, stored encrypted):",
		secretPlaceholder: "Enter AppSecret (bot secret)",
		secretSavedPlaceholder: "●●●●●● (saved encrypted, leave empty to keep)",
		sandboxLabel: "Use the sandbox environment (sandbox.api.sgroup.qq.com)",
		defaultChannelLabel: "Default sub-channel Channel ID (optional; not the AppSecret — leave empty if unused):",
		defaultChannelPlaceholder: "e.g. 12345678 (leave empty to skip)",
		broadcastSection: "📢 Channel broadcast notifications",
		broadcastDesc: "Receive AI status pushes in a private channel instead of staying at the desk.",
		broadcastChannelLabel: "Broadcast sub-channel ID (empty = the default sub-channel above):",
		broadcastChannelPlaceholder: "Empty = use the default sub-channel above",
		notifyQuestionLabel: "Notify the channel when a question waits for confirmation (ask_user_question)",
		notifyRunEndLabel: "Notify the channel when a task finishes (run_end summary)",
		voiceSection: "🔊 Voice replies",
		replyModeLabel: "Reply mode",
		replyModeText: "Text",
		replyModeVoice: "Voice",
		replyModeBoth: "Voice and text",
		voiceEngineLabel: "TTS engine",
		voiceSpeakerLabel: "Voice",
		voiceRateLabel: "Rate",
		defaultVoice: "Default voice",
		voiceNotLoaded: "{engine} (not loaded)",
		voiceFallbackNotice: "The last voice reply fell back to text: {error}",
		voiceLoadFailed: "Could not load voices",
		voiceHint:
			"Direct and group chats support voice; channels use text. Long replies read the opening aloud with the full text attached; when voice fails, text is sent. Install and enable TTS plugins to choose engines such as Doubao and their voices.",
		builtinVoice: "System speech",
		botSection: "🤖 Bot duplex mode and allowlist",
		botEnabledLabel: "Enable QQ bot two-way chat (outbound WebSocket long connection)",
		allowedUsersLabel: "Allowed users (user ID / OpenID, comma separated; empty = everyone):",
		allowedUsersPlaceholder: "123456, 789012 (empty allows every user)",
		timeoutLabel: "Execution timeout reminder (seconds):",

		// Action feedback
		hostTimeout: "Host communication timed out",
		hostNotReady: "Host communication not ready",
		pickDirTitle: "Choose the QQ bot execution project root",
		workspaceSet: "✅ Project root set to: {path}",
		followGlobal: "(follow global)",
		switchFailed: "⚠️ Switch failed: {error}",
		workspaceCleared: "Pinned root cleared; following the global setting again",
		modelSaved: "✅ AI model and thinking level saved!",
		modelReset: "Back to the global default model and thinking level",
		needAppId: "Enter the AppID first",
		needSecret: "Enter the AppSecret / ClientSecret (bot secret) first",
		enableNeedsCreds: "Enabling the bot chat service requires AppID and AppSecret",
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
