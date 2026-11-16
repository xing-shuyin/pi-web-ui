import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 网页邮箱面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 顶部工具条
		viewTitle: "📬 网页邮箱",
		btnCompose: "✉ 写信",
		btnSettings: "⚙ 设置",
		btnRefresh: "刷新",
		refreshListTitle: "刷新列表",
		composeTitle: "写邮件",
		settingsTitle: "邮箱设置",
		close: "关闭",
		unknownStatus: "未知",

		// 依赖缺失提示
		depsMissing: "缺少运行依赖（imapflow / mailparser / nodemailer），正在后台自动安装；也可手动",
		installNow: "立即安装",
		installing: "安装中…",

		// 列表工具条
		searchPlaceholder: "搜索主题 / 发件人…",
		search: "搜索",
		unreadOnly: "未读",
		emptyList: "没有匹配的邮件",
		linkFallback: "链接",

		// 阅读区
		emptyReader: "👈 从左侧选择一封邮件查看内容",
		truncated: "…（内容过长已截断）",
		attachmentsNote: " · 📎 含附件（正文下方不展示）",
		markUnread: "标为未读",
		markRead: "标为已读",
		reply: "回复",
		delete: "删除",
		quoteToChat: "💬 引用到对话",
		quoteToChatTitle: "将此邮件引用到主对话输入框",
		quoteCopied: "✓ 已复制引用",

		// 翻译相关
		translate: "🌐 翻译",
		translating: "🌐 翻译中…",
		showOriginal: "🌐 显示原文",
		showTranslation: "🌐 显示译文",
		langEnglish: "英文",
		langChinese: "中文",
		transHead: "🌐 译文（已译为{lang}{engine}）",
		transHeadSwitchTitle: "切换模型并重新翻译",
		copyTranslation: "复制译文",
		copied: "已复制！",
		hideOriginal: "收起原文",
		compareOriginal: "对照原文",
		originalLabel: "【原文】",
		engineLlm: " · 🤖 {model}",
		engineQuickNamed: " · ⚡ {model}",
		engineQuick: " · ⚡ 快速引擎",
		aiModelFallback: "AI 大模型",
		transSubjectPrefix: "译：",
		selectModelTitle: "选择翻译使用的 AI 模型或引擎",
		pickModelTitle: "调起统一模型选择器点选模型",
		modelFastOption: "⚡ 快速引擎",
		modelSessionOption: "🤖 当前会话模型",

		// 设置弹窗
		imapLegend: "收信 IMAP",
		smtpLegend: "发信 SMTP",
		behaviorLegend: "行为",
		pluginUpdateLegend: "插件更新",
		server: "服务器",
		port: "端口",
		username: "用户名",
		passwordOrToken: "密码 / 授权码",
		imapTls: "使用 SSL/TLS（端口通常 993；关闭则 143）",
		fromLabel: "显示发件人",
		smtpTls: "使用 SSL/TLS（端口通常 465）",
		pollSec: "轮询间隔(秒)",
		transEngine: "翻译引擎",
		transEngineFast: "⚡ 快速公共引擎（免 Token · 速度快）",
		transEngineSession: "🤖 跟随主会话当前模型",
		notifyEnabled: "新邮件桌面通知条",
		updateHintLabel: "从 GitHub 拉取最新版本覆盖安装（保留配置；依赖会自动重装）",
		updateNow: "更新到最新版",
		updateHint: "更新在可见终端执行，完成后刷新页面加载新版本。",
		credentialsHint:
			"凭据明文保存在本机 &lt;dataDir&gt;/plugins/webmail/config.json，不上传、重装插件不丢失。保存后立即生效。",
		saveAndApply: "保存并应用",
		passSaved: "已保存（输入可覆盖）",
		passPlaceholder: "密码",

		// 写信弹窗
		toPlaceholder: "收件人 to@example.com",
		subjectPlaceholder: "主题",
		bodyPlaceholder: "正文…",
		htmlBody: "HTML 正文（自动生成纯文本降级）",
		cancel: "取消",
		send: "发送",

		// 动态文案
		unseenBadge: "{count} 封未读",
		quoteSubject: "📬 邮件 #{uid}：{subject}",
		quoteFrom: "发件人：{from}{when}",
		quoteTranslatedSubject: "{subject}（译：{translated}）",
		updateTerminalTitle: "webmail 更新",
	},
	"zh-TW": {
		// 顶部工具条
		viewTitle: "📬 網頁郵箱",
		btnCompose: "✉ 寫信",
		btnSettings: "⚙ 設定",
		btnRefresh: "重新整理",
		refreshListTitle: "重新整理列表",
		composeTitle: "寫郵件",
		settingsTitle: "郵箱設定",
		close: "關閉",
		unknownStatus: "未知",

		// 依赖缺失提示
		depsMissing: "缺少執行依賴（imapflow / mailparser / nodemailer），正在後臺自動安裝；也可手動",
		installNow: "立即安裝",
		installing: "安裝中…",

		// 列表工具条
		searchPlaceholder: "搜尋主題 / 發件人…",
		search: "搜尋",
		unreadOnly: "未讀",
		emptyList: "沒有匹配的郵件",
		linkFallback: "連結",

		// 阅读区
		emptyReader: "👈 從左側選擇一封郵件檢視內容",
		truncated: "…（內容過長已截斷）",
		attachmentsNote: " · 📎 含附件（正文下方不展示）",
		markUnread: "標為未讀",
		markRead: "標為已讀",
		reply: "回覆",
		delete: "刪除",
		quoteToChat: "💬 引用到對話",
		quoteToChatTitle: "將此郵件引用到主對話輸入框",
		quoteCopied: "✓ 已複製引用",

		// 翻译相关
		translate: "🌐 翻譯",
		translating: "🌐 翻譯中…",
		showOriginal: "🌐 顯示原文",
		showTranslation: "🌐 顯示譯文",
		langEnglish: "英文",
		langChinese: "中文",
		transHead: "🌐 譯文（已譯為{lang}{engine}）",
		transHeadSwitchTitle: "切換模型並重新翻譯",
		copyTranslation: "複製譯文",
		copied: "已複製！",
		hideOriginal: "收起原文",
		compareOriginal: "對照原文",
		originalLabel: "【原文】",
		engineLlm: " · 🤖 {model}",
		engineQuickNamed: " · ⚡ {model}",
		engineQuick: " · ⚡ 快速引擎",
		aiModelFallback: "AI 大模型",
		transSubjectPrefix: "譯：",
		selectModelTitle: "選擇翻譯使用的 AI 模型或引擎",
		pickModelTitle: "調起統一模型選擇器點選模型",
		modelFastOption: "⚡ 快速引擎",
		modelSessionOption: "🤖 當前會話模型",

		// 设置弹窗
		imapLegend: "收信 IMAP",
		smtpLegend: "發信 SMTP",
		behaviorLegend: "行為",
		pluginUpdateLegend: "外掛更新",
		server: "伺服器",
		port: "埠",
		username: "使用者名稱",
		passwordOrToken: "密碼 / 授權碼",
		imapTls: "使用 SSL/TLS（埠通常 993；關閉則 143）",
		fromLabel: "顯示發件人",
		smtpTls: "使用 SSL/TLS（埠通常 465）",
		pollSec: "輪詢間隔(秒)",
		transEngine: "翻譯引擎",
		transEngineFast: "⚡ 快速公共引擎（免 Token · 速度快）",
		transEngineSession: "🤖 跟隨主會話當前模型",
		notifyEnabled: "新郵件桌面通知條",
		updateHintLabel: "從 GitHub 拉取最新版本覆蓋安裝（保留配置；依賴會自動重灌）",
		updateNow: "更新到最新版",
		updateHint: "更新在可見終端執行，完成後重新整理頁面載入新版本。",
		credentialsHint:
			"憑據明文儲存在本機 &lt;dataDir&gt;/plugins/webmail/config.json，不上傳、重灌外掛不丟失。儲存後立即生效。",
		saveAndApply: "儲存並應用",
		passSaved: "已儲存（輸入可覆蓋）",
		passPlaceholder: "密碼",

		// 写信弹窗
		toPlaceholder: "收件人 to@example.com",
		subjectPlaceholder: "主題",
		bodyPlaceholder: "正文…",
		htmlBody: "HTML 正文（自動生成純文本降級）",
		cancel: "取消",
		send: "傳送",

		// 动态文案
		unseenBadge: "{count} 封未讀",
		quoteSubject: "📬 郵件 #{uid}：{subject}",
		quoteFrom: "發件人：{from}{when}",
		quoteTranslatedSubject: "{subject}（譯：{translated}）",
		updateTerminalTitle: "webmail 更新",
	},
	en: {
		// Top toolbar
		viewTitle: "📬 Webmail",
		btnCompose: "✉ Compose",
		btnSettings: "⚙ Settings",
		btnRefresh: "Refresh",
		refreshListTitle: "Refresh list",
		composeTitle: "Compose",
		settingsTitle: "Mailbox settings",
		close: "Close",
		unknownStatus: "unknown",

		// Missing dependencies notice
		depsMissing:
			"Missing runtime dependencies (imapflow / mailparser / nodemailer); installing in the background — or install manually",
		installNow: "Install now",
		installing: "Installing…",

		// List toolbar
		searchPlaceholder: "Search subject / sender…",
		search: "Search",
		unreadOnly: "Unread",
		emptyList: "No matching messages",
		linkFallback: "link",

		// Reader
		emptyReader: "👈 Pick a message on the left to read it",
		truncated: "… (truncated, content too long)",
		attachmentsNote: " · 📎 has attachments (not shown below)",
		markUnread: "Mark as unread",
		markRead: "Mark as read",
		reply: "Reply",
		delete: "Delete",
		quoteToChat: "💬 Quote to chat",
		quoteToChatTitle: "Quote this message into the main chat composer",
		quoteCopied: "✓ Quote copied",

		// Translation
		translate: "🌐 Translate",
		translating: "🌐 Translating…",
		showOriginal: "🌐 Show original",
		showTranslation: "🌐 Show translation",
		langEnglish: "English",
		langChinese: "Chinese",
		transHead: "🌐 Translation (into {lang}{engine})",
		transHeadSwitchTitle: "Switch model and translate again",
		copyTranslation: "Copy translation",
		copied: "Copied!",
		hideOriginal: "Hide original",
		compareOriginal: "Compare with original",
		originalLabel: "[Original]",
		engineLlm: " · 🤖 {model}",
		engineQuickNamed: " · ⚡ {model}",
		engineQuick: " · ⚡ fast engine",
		aiModelFallback: "AI model",
		transSubjectPrefix: "Translated: ",
		selectModelTitle: "Choose the AI model or engine used for translation",
		pickModelTitle: "Open the unified model picker",
		modelFastOption: "⚡ Fast engine",
		modelSessionOption: "🤖 Session model",

		// Settings dialog
		imapLegend: "Incoming IMAP",
		smtpLegend: "Outgoing SMTP",
		behaviorLegend: "Behaviour",
		pluginUpdateLegend: "Plugin update",
		server: "Server",
		port: "Port",
		username: "Username",
		passwordOrToken: "Password / app password",
		imapTls: "Use SSL/TLS (usually port 993; 143 when off)",
		fromLabel: "Sender display",
		smtpTls: "Use SSL/TLS (usually port 465)",
		pollSec: "Poll interval (seconds)",
		transEngine: "Translation engine",
		transEngineFast: "⚡ Fast public engine (no token · faster)",
		transEngineSession: "🤖 Follow the session's current model",
		notifyEnabled: "Desktop notification banner for new mail",
		updateHintLabel: "Pull the latest version from GitHub and install over it (config kept; dependencies reinstall)",
		updateNow: "Update to latest",
		updateHint: "The update runs in a visible terminal; refresh the page afterwards to load the new version.",
		credentialsHint:
			"Credentials are stored in plain text on this machine at &lt;dataDir&gt;/plugins/webmail/config.json; they are never uploaded and survive reinstalling the plugin. Changes apply as soon as you save.",
		saveAndApply: "Save & apply",
		passSaved: "Saved (type to replace)",
		passPlaceholder: "Password",

		// Compose dialog
		toPlaceholder: "Recipient to@example.com",
		subjectPlaceholder: "Subject",
		bodyPlaceholder: "Message…",
		htmlBody: "HTML body (plain-text fallback generated)",
		cancel: "Cancel",
		send: "Send",

		// Dynamic text
		unseenBadge: "{count} unread",
		quoteSubject: "📬 Mail #{uid}: {subject}",
		quoteFrom: "From: {from}{when}",
		quoteTranslatedSubject: "{subject} (translated: {translated})",
		updateTerminalTitle: "webmail update",
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
