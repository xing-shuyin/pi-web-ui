import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 微信通道面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		reading: "读取中…",
		cancel: "取消",

		// 面板头部
		title: "💬 微信通道",
		statusDisconnected: "未连接",
		hint: "扫码登录后，微信里直接指挥 agent（出站长轮询，无需公网）。陌生人先配对，白名单在 ⚙ 设置里。",

		// 工作空间根目录
		wsTitle: "工作空间根目录（项目）",
		wsInputPlaceholder: "留空 = 跟随当前网页项目根目录",
		wsQuickPick: "快速点选已有项目…",
		wsBrowse: "📂 浏览目录…",
		wsSave: "设为根目录",
		wsUseCwd: "设为当前项目",
		wsOpenProject: "把项目改为此根目录",
		wsClear: "清空固定",
		wsOptionRecent: "选择最近项目…",
		wsOptionHostProject: "当前网页项目：{name} ({path})",
		wsOptionPinned: "已固定根目录：{name} ({path})",
		wsPinned: "已固定微信根目录：{path}",
		wsPinnedDiff: "（当前网页项目：{path}）",
		wsUnpinnedWithHost: "未固定（默认跟随当前网页项目：{path}）",
		wsUnpinned: "未固定（默认跟随当前网页项目）",

		// AI 模型与思考强度
		modelTitle: "AI 模型与思考强度",
		modelInputPlaceholder: "留空 = 跟随全局默认模型（支持输入或选择）",
		modelBrowse: "✨ 选择模型…",
		thinkingFollowGlobal: "思考强度：跟随全局",
		thinkingOff: "思考：关闭 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMax: "思考：最大 (max)",
		modelSave: "保存配置",
		modelClear: "恢复默认",
		bindActive: "💻📱 电脑手机消息同步：投递到网页当前打开的对话（大屏实时看流式思考与工具输出）",

		// 登录 / 配对 / 收件箱 / 手动发送
		loginSection: "登录",
		pendingSection: "待配对",
		inboxSection: "收件箱",
		inboxEmpty: "暂无消息",
		sendSection: "手动发送",
		toPlaceholder: "微信用户 ID",
		textPlaceholder: "文本内容",
		mediaPlaceholder: "图片/文件路径或 URL（可选）",
		sendBtn: "发送",

		// 登录状态与扫码
		statusLoggedIn: "已登录",
		statusReceiving: " · 接收中",
		statusPaused: " · 受限暂停",
		lastLogin: "上次登录：{time}",
		logout: "登出",
		pollError: "轮询：{error}",
		qrGenerating: "生成二维码中…",
		qrHint: "微信扫码确认登录（5 分钟有效，过期后重新点“扫码登录”）",
		qrCantScan: "扫不上？",
		qrOpenOfficial: "在新标签页打开官方扫码页",
		loginBtn: "扫码登录",

		// 待配对与收件箱条目
		allow: "允许",
		deny: "拒绝",
		openSession: "在主界面打开对话流",
	},
	"zh-TW": {
		// 通用
		reading: "讀取中…",
		cancel: "取消",

		// 面板头部
		title: "💬 微信通道",
		statusDisconnected: "未連線",
		hint: "掃碼登入後，微信裡直接指揮 agent（出站長輪詢，無需公網）。陌生人先配對，白名單在 ⚙ 設定裡。",

		// 工作空间根目录
		wsTitle: "工作空間根目錄（專案）",
		wsInputPlaceholder: "留空 = 跟隨當前網頁專案根目錄",
		wsQuickPick: "快速點選已有專案…",
		wsBrowse: "📂 瀏覽目錄…",
		wsSave: "設為根目錄",
		wsUseCwd: "設為當前專案",
		wsOpenProject: "把專案改為此根目錄",
		wsClear: "清空固定",
		wsOptionRecent: "選擇最近專案…",
		wsOptionHostProject: "當前網頁專案：{name} ({path})",
		wsOptionPinned: "已固定根目錄：{name} ({path})",
		wsPinned: "已固定微信根目錄：{path}",
		wsPinnedDiff: "（當前網頁專案：{path}）",
		wsUnpinnedWithHost: "未固定（預設跟隨當前網頁專案：{path}）",
		wsUnpinned: "未固定（預設跟隨當前網頁專案）",

		// AI 模型与思考强度
		modelTitle: "AI 模型與思考強度",
		modelInputPlaceholder: "留空 = 跟隨全域性預設模型（支援輸入或選擇）",
		modelBrowse: "✨ 選擇模型…",
		thinkingFollowGlobal: "思考強度：跟隨全域性",
		thinkingOff: "思考：關閉 (off)",
		thinkingLow: "思考：低 (low)",
		thinkingMedium: "思考：中 (medium)",
		thinkingHigh: "思考：高 (high)",
		thinkingMax: "思考：最大 (max)",
		modelSave: "儲存配置",
		modelClear: "恢復預設",
		bindActive: "💻📱 電腦手機訊息同步：投遞到網頁當前開啟的對話（大屏即時看流式思考與工具輸出）",

		// 登录 / 配对 / 收件箱 / 手动发送
		loginSection: "登入",
		pendingSection: "待配對",
		inboxSection: "收件箱",
		inboxEmpty: "暫無訊息",
		sendSection: "手動傳送",
		toPlaceholder: "微信使用者 ID",
		textPlaceholder: "文本內容",
		mediaPlaceholder: "圖片/檔案路徑或 URL（可選）",
		sendBtn: "傳送",

		// 登录状态与扫码
		statusLoggedIn: "已登入",
		statusReceiving: " · 接收中",
		statusPaused: " · 受限暫停",
		lastLogin: "上次登入：{time}",
		logout: "登出",
		pollError: "輪詢：{error}",
		qrGenerating: "生成二維碼中…",
		qrHint: "微信掃碼確認登入（5 分鐘有效，過期後重新點“掃碼登入”）",
		qrCantScan: "掃不上？",
		qrOpenOfficial: "在新標籤頁開啟官方掃碼頁",
		loginBtn: "掃碼登入",

		// 待配对与收件箱条目
		allow: "允許",
		deny: "拒絕",
		openSession: "在主介面開啟對話流",
	},
	en: {
		// Common
		reading: "Loading…",
		cancel: "Cancel",

		// Panel header
		title: "💬 WeChat channel",
		statusDisconnected: "Disconnected",
		hint: "After signing in with a QR scan, command the agent straight from WeChat (outbound long polling, no public IP needed). Strangers must be paired first; the allowlist lives in ⚙ Settings.",

		// Workspace root
		wsTitle: "Workspace root (project)",
		wsInputPlaceholder: "Leave empty to follow the current web project root",
		wsQuickPick: "Quick-pick an existing project…",
		wsBrowse: "📂 Browse…",
		wsSave: "Set as root",
		wsUseCwd: "Use current project",
		wsOpenProject: "Open project at this root",
		wsClear: "Clear pinned root",
		wsOptionRecent: "Choose a recent project…",
		wsOptionHostProject: "Current web project: {name} ({path})",
		wsOptionPinned: "Pinned root: {name} ({path})",
		wsPinned: "WeChat root pinned: {path}",
		wsPinnedDiff: "(current web project: {path})",
		wsUnpinnedWithHost: "Not pinned (follows the current web project: {path})",
		wsUnpinned: "Not pinned (follows the current web project)",

		// AI model and thinking effort
		modelTitle: "AI model and thinking effort",
		modelInputPlaceholder: "Leave empty to follow the global default model (type or pick)",
		modelBrowse: "✨ Choose model…",
		thinkingFollowGlobal: "Thinking effort: follow global",
		thinkingOff: "Thinking: off (off)",
		thinkingLow: "Thinking: low (low)",
		thinkingMedium: "Thinking: medium (medium)",
		thinkingHigh: "Thinking: high (high)",
		thinkingMax: "Thinking: max (max)",
		modelSave: "Save config",
		modelClear: "Reset to default",
		bindActive:
			"💻📱 Desktop and phone message sync: deliver to the conversation currently open in the web UI (watch streaming thinking and tool output live on the big screen)",

		// Sign-in / pairing / inbox / manual send
		loginSection: "Sign in",
		pendingSection: "Pending pairing",
		inboxSection: "Inbox",
		inboxEmpty: "No messages yet",
		sendSection: "Send manually",
		toPlaceholder: "WeChat user ID",
		textPlaceholder: "Message text",
		mediaPlaceholder: "Image/file path or URL (optional)",
		sendBtn: "Send",

		// Sign-in state and QR code
		statusLoggedIn: "Signed in",
		statusReceiving: " · receiving",
		statusPaused: " · paused (rate-limited)",
		lastLogin: "Last sign-in: {time}",
		logout: "Sign out",
		pollError: "Polling: {error}",
		qrGenerating: "Generating QR code…",
		qrHint: "Scan with WeChat to confirm sign-in (valid for 5 minutes; if it expires, click “Scan to sign in” again)",
		qrCantScan: "Can't scan?",
		qrOpenOfficial: "Open the official QR page in a new tab",
		loginBtn: "Scan to sign in",

		// Pending peers and inbox entries
		allow: "Allow",
		deny: "Deny",
		openSession: "Open the conversation in the main UI",
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
