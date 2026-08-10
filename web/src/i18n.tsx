import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";

export type Locale = "zh" | "en";

const STORAGE_KEY = "pi-web-ui:lang";

/* ------------------------------------------------------------------ */
/* zh (default)                                                        */
/* ------------------------------------------------------------------ */

const zh = {
	/* common */
	cancel: "取消",
	ok: "确定",
	save: "保存",
	close: "关闭",
	loading: "加载中…",
	connected: "已连接",
	connecting: "连接中…",
	reconnecting: "重连中…",
	language: "语言",
	langZh: "中文",
	langEn: "English",
	githubRepo: "GitHub 仓库（xing-shuyin/pi-web-ui）",
	copy: "复制",

	/* topbar */
	viewSwitch: "视图切换",
	chat: "对话",
	terminal: "终端",
	selectModel: "选择模型",
	availableModels: "可用模型",
	noModels: "暂无可用模型（请先配置 API 密钥）",
	reasoning: "推理",
	vision: "识图",
	refreshModels: "刷新模型列表",
	manageModels: "⚙ 管理模型（新增 / 修改）",
	manageModelsTitle: "管理模型",
	thinkingLevel: "思考强度",
	thinking: "思考",
	thinkingChip: "思考：{level}",
	sound: "声音",
	newChat: "新对话",
	more: "更多",
	newChatTip: "新建对话（每个浏览器独立保存会话）",
	"thinking.off": "关闭",
	"thinking.minimal": "极简",
	"thinking.low": "低",
	"thinking.medium": "中",
	"thinking.high": "高",
	"thinking.xhigh": "极高",
	"thinking.max": "最大",
	thinkingUnsupported: "当前模型不支持该级别，已按模型能力就近生效",

	/* footerbar */
	context: "上下文",
	contextUsage: "上下文用量",
	cumulativeCost: "累计成本",
	sessionMessages: "会话消息数",
	messages: "消息",
	pluginStatus: "插件状态",
	working: "工作中",
	queued: "排队",
	enterPath: "输入路径，Enter 切换",
	cwdTip: "工作目录：{path}（点击切换）",

	/* chat input */
	folderRef: "文件夹引用：{path}",
	refOnly: "仅引用：{path}",
	attachContent: "附加内容：{path}",
	attachLines: "附加选中行：{path}（第 {start}-{end} 行）",
	attachImage: "图片：{name}",
	attachFile: "文件：{name}",
	removeAttachment: "移除附件",
	attachHint: "将随下一条消息发送",
	uploadFile: "添加文件（图片/文本/任意文件，也可直接拖入或粘贴截图）",
	dropHereToAttach: "松开以添加文件",
	imageNotSupported: "当前模型不支持识图，图片可能不会被模型看到",
	imageLoadFailed: "图片读取失败：{name}",
	fileLoadFailed: "文件读取失败：{name}",
	fileTooLarge: "文件过大已跳过（>{size}MB）：{name}",
	foldersNotSupported: "不支持直接拖入文件夹，请展开后选择文件",
	followUpQueued: "⏳ {n} 条跟进消息排队中",
	steeringQueued: "⏳ {n} 条转向消息排队中",
	placeholderStreaming: "智能体正在工作中…（消息可排队发送）",
	placeholderIdle: "给 pi 发送消息 — Enter 发送，Shift+Enter 换行",
	placeholderConnecting: "正在连接服务器…",
	stopAgent: "停止智能体",
	stop: "停止",
	supplement: "补充",
	supplementTip: "当前回复完成后立即发送",
	sendTip: "发送（Enter）",

	/* left panel */
	recentProjects: "最近项目",
	runningConversations: "运行的对话",
	historySessions: "历史对话",
	openHistory: "历史对话",
	openFiles: "文件列表",	streaming: "进行中…",
	noHistory: "还没有历史对话",
	current: "当前",
	messageCount: "{n} 条消息",
	tuiTip: "pi 终端（TUI）中的对话",
	emptyChat: "空对话",

	/* message edit */
	editReask: "编辑重问",
	editReaskTip:
		"修改此问题，并从这里重新提问（会新建一个分支对话，原对话保留）",
	reaskFromHere: "从此处重新提问",
	editPlaceholder: "修改问题内容…",
	editHint: "⌘/Ctrl+Enter 提交 · Esc 取消",

	/* collapsed old messages */
	expandMsg: "展开",
	collapseMsg: "收起",
	toolCalls: "工具调用",
	bashRuns: "终端运行",
	images: "图片",

	/* self-update */
	update: "更新",
	updateTip: "检查并更新 pi-web-ui",
	currentVersion: "当前版本",
	latestVersion: "最新版本",
	checkingUpdate: "检查中…",
	checkUpdate: "检查更新",
	upToDate: "已是最新版本",
	updateAvailable: "发现新版本 v{version}",
	updateJustPublished:
		"v{version} 刚刚发布，npm 缓存可能尚未同步——若未检测到新版本，请稍后重新检查",
	updateNow: "立即更新",
	confirmUpdate: "确认更新（覆盖全局安装）",
	updateSuccess: "✅ 已更新，正在重启…",
	updateFailed: "更新失败：{detail}",
	restartHint: "重启：pi-web-ui server restart",

	/* right panel */
	rootDir: "根目录",
	noFiles: "暂无文件",
	filesTruncated: "目录过大，列表已截断，仅显示前 2000 项",
	linkFolderTip: "链接文件夹路径到对话",
	attachInlineTip: "附加内容到对话",
	referenceTip: "仅引用路径（AI 按需读取）",
	previewFile: "预览",
	downloadFile: "下载文件",
	downloadFailed: "下载失败：{error}",

	/* file preview */
	selectLinesHint: "点击选择行；拖拽或 Shift+点击选择范围",
	selectedRange: "已选 {n} 行（第 {start}-{end} 行）",
	fileLines: "{n} 行",
	selectAll: "全选",
	clearSelection: "清除",
	addToChat: "添加到对话",
	addedToChat: "已添加",
	previewTruncated: "⚠ 文件过大，仅预览前 512KB",
	previewLinesTruncated: "… 文件行数过多，仅显示前 {n} 行",
	binaryFile: "🔣 二进制文件，已显示前 4KB 十六进制",
	binaryHexTruncated: "（文件更大，可下载完整文件）",
	previewNotSupported: "该类型文件不支持预览（仅图片 / 视频 / 文本）",
	emptyFile: "（空文件）",

	/* dialog */
	pluginRequest: "插件请求",
	noOptions: "（无选项）",
	inputPlaceholder: "输入内容",

	/* sound settings */
	soundHeader: "声音提示",
	enableSound: "启用声音",
	preview: "试听",
	volume: "音量",
	"sound.question": "问卷弹出",
	"sound.question.desc": "ask_user_question 出现时",
	"sound.done": "回复结束",
	"sound.done.desc": "智能体完成一轮回答时",
	"sound.start": "回复开始",
	"sound.start.desc": "智能体开始新一轮时",
	"sound.error": "出错",
	"sound.error.desc": "出现错误提示时",

	/* pi setup modal */
	setupTitle: "未检测到 pi agent 配置",
	setupDesc:
		"pi-web-ui 需要 pi 的配置目录（~/.pi/agent）和至少一个 API 密钥才能运行智能体。pi 内置了 openai、anthropic、deepseek 等服务商——选一个填密钥即可，全程无需打开终端。",
	installFailed: "✖ pi agent 安装失败：",
	retryInstall: "重试安装",
	skip: "跳过",
	installDone:
		"✅ pi agent CLI 已安装。选择服务商并填入 API 密钥即可开始对话：",
	provider: "服务商",
	configured: "已配置",
	providerKeyReady: "该服务商已配置密钥，可直接使用或更换新密钥。",
	apiKey: "API 密钥",
	saving: "保存中…",
	saveAndStart: "保存并开始使用",
	recheck: "重新检测",
	installing: "正在安装 pi agent CLI…",
	autoInstall: "自动安装 pi agent",

	/* messages */
	attachment: "附件",
	plugin: "插件",
	unknown: "未知",
	thinkingWait: "正在思考",
	exitCode: "退出码 {code}",
	cancelled: "已取消",
	truncated: "… 内容过长，当前视图已截断",
	outputTruncated: "… 输出过长，当前视图已截断",
	refOnlyShort: "仅引用",
	folderRefShort: "文件夹 · 仅引用",
	inlineLines: "内联 · {n} 行",
	inlineLinesRange: "行 {start}-{end}",
	image: "🖼 图片",
	folderNotExpanded: "文件夹，未展开内容 —— 智能体会按需浏览目录",
	fileNotExpanded: "文件较大（{size}），未展开内容 —— 智能体会按需读取",
	"role.user": "你",
	"role.assistant": "pi",
	"role.tool": "工具",
	"role.bash": "终端",
	"role.branch": "分支摘要",
	"role.compaction": "上下文已压缩",

	/* welcome / message list */
	welcomeTitle: "pi 编码智能体",
	welcomeSub: "检查、编辑、运行 —— 随时待命",
	directory: "目录",
	clickToFill: "点击填入输入框",
	waitingResponse: "正在等待模型响应…",
	backToBottom: "回到底部",
	"ex.understand": "了解这个项目",
	"ex.understand.prompt": "介绍一下这个项目：整体结构、主要模块和如何运行？",
	"ex.debug": "排查一个问题",
	"ex.debug.prompt": "帮我排查一个 bug，请先说明问题现象，我会补充细节。",
	"ex.test": "编写测试",
	"ex.test.prompt": "为项目的核心模块编写单元测试。",
	"ex.review": "代码审查",
	"ex.review.prompt": "审查最近改动的代码，指出潜在问题和改进建议。",

	/* tool call block */
	error: "出错",
	done: "完成",
	running: "执行中…",
	toolQueued: "排队中",
	copyArgs: "复制参数",
	errorOutput: "错误输出",
	output: "输出",
	waitingOutput: "等待输出…",
	toolDoneWaitingModel: "已结束 · 等模型",
	waitingModel: "等待模型响应…",

	/* thinking block */
	thinkingNow: "思考中",
	thinkingPreview: "思考：{preview}",

	/* terminal panel */
	commands: "命令",
	newCommand: "新建命令",
	newTerminal: "新建终端",
	name: "名称",
	command: "命令",
	cwdHint: "（${pwd} = 当前工作目录）",
	noCommands: "还没有命令，点 + 添加一个",
	clickToRun: "点击运行",
	edit: "编辑",
	delete: "删除",
	confirmQ: "确认?",
	builtinTerminal: "内置终端",
	termEmptySub: "点击左侧命令运行，或点右侧 + 新建终端",
	noTerminal: "暂无终端",
	exited: "（已退出{code}）",
	closeTerminal: "关闭终端",
	rerun: "重新读取 .pi/commands.json",
	terminalTitle: "终端 {n}",
	exampleName: "例如：启动开发服务器",
	exampleCommand: "例如：npm run dev",

	/* model config modal */
	editProvider: "编辑服务商",
	builtinProviders: "内置服务商",
	hintKeyOnly: "只需填入 API 密钥",
	configuredBadge: "✓ 已配置",
	keyReady: "密钥已就绪",
	pasteKey: "粘贴 API 密钥…",
	savingKey: "保存中",
	saveKey: "保存密钥",
	customProviders: "自定义服务商",
	customDesc:
		"用于 Ollama / vLLM / 兼容 OpenAI 的代理等，写入 pi 的 models.json，保存后热重载、立即生效。",
	noCustomProviders: "还没有自定义服务商",
	modelsCount: "{n} 个模型",
	addProvider: "新增服务商",
	providerId: "服务商 ID",
	providerIdHint: "（必填，如 ollama / my-proxy）",
	displayName: "显示名",
	displayNamePh: "我的代理",
	apiType: "API 类型",
	baseUrlHint: "（OpenAI 兼容端点）",
	apiKeyHint: "sk-…（可留空，用 auth.json 的密钥）",
	authHeader: "自动添加 Authorization 请求头",
	modelsTitle: "模型",
	modelIdReq: "模型 ID（必填）",
	text: "文本",
	textImage: "文本+图片",
	contextWindow: "上下文",
	maxOutput: "最大输出",
	removeModel: "移除模型",
	addModel: "添加模型",
	deleteProviderConfirm: "删除服务商 {id} 及其 {n} 个模型？",

	/* app */
	loadingSession: "正在加载会话…",
	connectingServer: "正在连接 pi-web-ui 服务器…",
} as const;

/* ------------------------------------------------------------------ */
/* en                                                                  */
/* ------------------------------------------------------------------ */

const en: Record<keyof typeof zh, string> = {
	/* common */
	cancel: "Cancel",
	ok: "OK",
	save: "Save",
	close: "Close",
	loading: "Loading…",
	connected: "Connected",
	connecting: "Connecting…",
	reconnecting: "Reconnecting…",
	language: "Language",
	langZh: "中文",
	langEn: "English",
	githubRepo: "GitHub repository (xing-shuyin/pi-web-ui)",
	copy: "Copy",

	/* topbar */
	viewSwitch: "Switch view",
	chat: "Chat",
	terminal: "Terminal",
	selectModel: "Select model",
	availableModels: "Available models",
	noModels: "No models available (configure an API key first)",
	reasoning: "reasoning",
	vision: "vision",
	refreshModels: "Refresh model list",
	manageModels: "⚙ Manage models (add / edit)",
	manageModelsTitle: "Manage models",
	thinkingLevel: "Thinking level",
	thinking: "Thinking",
	thinkingChip: "Thinking: {level}",
	sound: "Sound",
	newChat: "New chat",
	more: "More",
	newChatTip: "New chat (sessions are saved per browser)",
	"thinking.off": "Off",
	"thinking.minimal": "Minimal",
	"thinking.low": "Low",
	"thinking.medium": "Medium",
	"thinking.high": "High",
	"thinking.xhigh": "Extra high",
	"thinking.max": "Max",
	thinkingUnsupported:
		"Not supported by this model — snapped to the nearest supported level",

	/* footerbar */
	context: "Context",
	contextUsage: "Context usage",
	cumulativeCost: "Cumulative cost",
	sessionMessages: "Session messages",
	messages: "messages",
	pluginStatus: "Plugin status",
	working: "Working",
	queued: "queued",
	enterPath: "Type a path, Enter to switch",
	cwdTip: "Working directory: {path} (click to switch)",

	/* chat input */
	folderRef: "Folder reference: {path}",
	refOnly: "Reference only: {path}",
	attachContent: "Attached content: {path}",
	attachLines: "Attached selected lines: {path} (lines {start}-{end})",
	attachImage: "Image: {name}",
	attachFile: "File: {name}",
	removeAttachment: "Remove attachment",
	attachHint: "Will be sent with the next message",
	uploadFile: "Add files (images / text / any file — or drag in / paste a screenshot)",
	dropHereToAttach: "Release to attach file",
	imageNotSupported: "The current model doesn't support vision — the image may be ignored",
	imageLoadFailed: "Couldn't read image: {name}",
	fileLoadFailed: "Couldn't read file: {name}",
	fileTooLarge: "File too large, skipped (> {size}MB): {name}",
	foldersNotSupported: "Folders can't be dropped directly — expand and pick files instead",
	followUpQueued: "⏳ {n} follow-up message(s) queued",
	steeringQueued: "⏳ {n} steering message(s) queued",
	placeholderStreaming: "The agent is working… (messages will queue)",
	placeholderIdle: "Message pi — Enter to send, Shift+Enter for newline",
	placeholderConnecting: "Connecting to server…",
	stopAgent: "Stop agent",
	stop: "Stop",
	supplement: "Follow-up",
	supplementTip: "Send immediately after the current reply finishes",
	sendTip: "Send (Enter)",

	/* left panel */
	recentProjects: "Recent projects",
	runningConversations: "Running chats",
	historySessions: "History",
	openHistory: "History",
	openFiles: "Files",	streaming: "Streaming…",
	noHistory: "No previous chats",
	current: "Current",
	messageCount: "{n} messages",
	tuiTip: "Chat in the pi terminal (TUI)",
	emptyChat: "Empty chat",

	/* message edit */
	editReask: "Edit & re-ask",
	editReaskTip:
		"Edit this question and re-ask from here (forks a new conversation; the original is kept)",
	reaskFromHere: "Re-ask from here",
	editPlaceholder: "Edit the question…",
	editHint: "⌘/Ctrl+Enter to submit · Esc to cancel",

	/* collapsed old messages */
	expandMsg: "Expand",
	collapseMsg: "Collapse",
	toolCalls: "tool calls",
	bashRuns: "bash runs",
	images: "images",

	/* self-update */
	update: "Update",
	updateTip: "Check & update pi-web-ui",
	currentVersion: "Current version",
	latestVersion: "Latest version",
	checkingUpdate: "Checking…",
	checkUpdate: "Check for updates",
	upToDate: "You're up to date",
	updateAvailable: "New version v{version} available",
	updateJustPublished:
		"v{version} was just published — npm cache may lag; if the new version isn't detected yet, re-check in a moment",
	updateNow: "Update now",
	confirmUpdate: "Confirm (replaces global install)",
	updateSuccess: "✅ Updated — restarting…",
	updateFailed: "Update failed: {detail}",
	restartHint: "Restart: pi-web-ui server restart",

	/* right panel */
	rootDir: "Root",
	noFiles: "No files",
	filesTruncated: "Directory too large — list truncated (first 2000 shown)",
	linkFolderTip: "Link folder path to chat",
	attachInlineTip: "Attach content to chat",
	referenceTip: "Reference path only (AI reads on demand)",
	previewFile: "Preview",
	downloadFile: "Download file",
	downloadFailed: "Download failed: {error}",

	/* file preview */
	selectLinesHint: "Click a line to select; drag or Shift+click for a range",
	selectedRange: "Selected {n} lines (lines {start}-{end})",
	fileLines: "{n} lines",
	selectAll: "Select all",
	clearSelection: "Clear",
	addToChat: "Add to chat",
	addedToChat: "Added",
	previewTruncated: "⚠ File too large — previewing the first 512KB",
	previewLinesTruncated: "… too many lines — showing the first {n}",
	binaryFile: "🔣 Binary file — first 4KB shown as hex",
	binaryHexTruncated: " (file larger — download for the full file)",
	previewNotSupported:
		"This file type can't be previewed (only images / videos / text)",
	emptyFile: "(empty file)",

	/* dialog */
	pluginRequest: "Plugin request",
	noOptions: "(no options)",
	inputPlaceholder: "Enter content",

	/* sound settings */
	soundHeader: "Sound notifications",
	enableSound: "Enable sound",
	preview: "Preview",
	volume: "Volume",
	"sound.question": "Question popup",
	"sound.question.desc": "When ask_user_question appears",
	"sound.done": "Reply finished",
	"sound.done.desc": "When the agent finishes a turn",
	"sound.start": "Reply started",
	"sound.start.desc": "When the agent starts a new turn",
	"sound.error": "Error",
	"sound.error.desc": "When an error notice appears",

	/* pi setup modal */
	setupTitle: "pi agent config not detected",
	setupDesc:
		"pi-web-ui needs pi's config directory (~/.pi/agent) and at least one API key to run the agent. pi has built-in providers such as openai, anthropic, and deepseek — just pick one and enter a key, no terminal needed.",
	installFailed: "✖ pi agent installation failed:",
	retryInstall: "Retry install",
	skip: "Skip",
	installDone:
		"✅ pi agent CLI installed. Pick a provider and enter an API key to start chatting:",
	provider: "Provider",
	configured: "configured",
	providerKeyReady: "This provider already has a key — use it or replace it.",
	apiKey: "API key",
	saving: "Saving…",
	saveAndStart: "Save and start using",
	recheck: "Recheck",
	installing: "Installing pi agent CLI…",
	autoInstall: "Auto-install pi agent",

	/* messages */
	attachment: "Attachment",
	plugin: "plugin",
	unknown: "unknown",
	thinkingWait: "Thinking",
	exitCode: "Exit code {code}",
	cancelled: "Cancelled",
	truncated: "… content too long, truncated in this view",
	outputTruncated: "… output too long, truncated in this view",
	refOnlyShort: "Reference only",
	folderRefShort: "Folder · reference only",
	inlineLines: "Inline · {n} lines",
	inlineLinesRange: "Lines {start}-{end}",
	image: "🖼 Image",
	folderNotExpanded:
		"Folder — content not expanded, the agent will browse it as needed",
	fileNotExpanded:
		"Large file ({size}) — content not expanded, the agent will read it as needed",
	"role.user": "You",
	"role.assistant": "pi",
	"role.tool": "Tool",
	"role.bash": "Terminal",
	"role.branch": "Branch summary",
	"role.compaction": "Context compacted",

	/* welcome / message list */
	welcomeTitle: "pi coding agent",
	welcomeSub: "Inspect, edit, run — always ready",
	directory: "Directory",
	clickToFill: "Click to fill input",
	waitingResponse: "Waiting for model response…",
	backToBottom: "Back to bottom",
	"ex.understand": "Understand this project",
	"ex.understand.prompt":
		"Introduce this project: overall structure, main modules, and how to run it?",
	"ex.debug": "Debug an issue",
	"ex.debug.prompt":
		"Help me debug a bug — describe the symptom first, and I'll add details.",
	"ex.test": "Write tests",
	"ex.test.prompt": "Write unit tests for the core modules.",
	"ex.review": "Code review",
	"ex.review.prompt":
		"Review the recently changed code and point out potential issues and improvements.",

	/* tool call block */
	error: "Error",
	done: "Done",
	running: "Running…",
	toolQueued: "Queued",
	copyArgs: "Copy args",
	errorOutput: "Error output",
	output: "Output",
	waitingOutput: "Waiting for output…",
	toolDoneWaitingModel: "Done · waiting on model",
	waitingModel: "Waiting for model response…",

	/* thinking block */
	thinkingNow: "Thinking",
	thinkingPreview: "Thinking: {preview}",

	/* terminal panel */
	commands: "Commands",
	newCommand: "New command",
	newTerminal: "New terminal",
	name: "Name",
	command: "Command",
	cwdHint: "(${pwd} = current working directory)",
	noCommands: "No commands yet — click + to add one",
	clickToRun: "Click to run",
	edit: "Edit",
	delete: "Delete",
	confirmQ: "Confirm?",
	builtinTerminal: "Built-in terminal",
	termEmptySub:
		"Click a command on the left to run it, or + on the right for a new terminal",
	noTerminal: "No terminals",
	exited: "(exited{code})",
	closeTerminal: "Close terminal",
	rerun: "Reload .pi/commands.json",
	terminalTitle: "Terminal {n}",
	exampleName: "e.g. start dev server",
	exampleCommand: "e.g. npm run dev",

	/* model config modal */
	editProvider: "Edit provider",
	builtinProviders: "Built-in providers",
	hintKeyOnly: "Just enter an API key",
	configuredBadge: "✓ Configured",
	keyReady: "Key ready",
	pasteKey: "Paste API key…",
	savingKey: "Saving",
	saveKey: "Save key",
	customProviders: "Custom providers",
	customDesc:
		"For Ollama / vLLM / OpenAI-compatible proxies, etc. Written to pi's models.json — hot-reloaded immediately.",
	noCustomProviders: "No custom providers yet",
	modelsCount: "{n} models",
	addProvider: "Add provider",
	providerId: "Provider ID",
	providerIdHint: "(required, e.g. ollama / my-proxy)",
	displayName: "Display name",
	displayNamePh: "My proxy",
	apiType: "API type",
	baseUrlHint: "(OpenAI-compatible endpoint)",
	apiKeyHint: "sk-… (optional — uses the auth.json key)",
	authHeader: "Auto-add Authorization header",
	modelsTitle: "Models",
	modelIdReq: "Model ID (required)",
	text: "Text",
	textImage: "Text+image",
	contextWindow: "Context",
	maxOutput: "Max output",
	removeModel: "Remove model",
	addModel: "Add model",
	deleteProviderConfirm: "Delete provider {id} and its {n} models?",

	/* app */
	loadingSession: "Loading session…",
	connectingServer: "Connecting to pi-web-ui server…",
};

/* ------------------------------------------------------------------ */
/* context + hook                                                      */
/* ------------------------------------------------------------------ */

export type Translate = (
	key: keyof typeof zh,
	vars?: Record<string, string | number>,
) => string;

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function loadLocale(): Locale {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "zh" || saved === "en") return saved;
	} catch {
		// localStorage unavailable — fall through to the default.
	}
	return "zh"; // default: Chinese
}

export function LanguageProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(loadLocale);

	const setLocale = useCallback((l: Locale) => {
		setLocaleState(l);
		try {
			localStorage.setItem(STORAGE_KEY, l);
		} catch {
			// ignore storage errors
		}
	}, []);

	const t = useCallback<Translate>(
		(key, vars) => {
			let str: string = en[key];
			if (locale === "zh") str = zh[key];
			if (vars) {
				for (const [k, v] of Object.entries(vars)) {
					str = str.replaceAll(`{${k}}`, String(v));
				}
			}
			return str;
		},
		[locale],
	);

	useEffect(() => {
		document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
	}, [locale]);

	const value = useMemo(
		() => ({ locale, setLocale, t }),
		[locale, setLocale, t],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
	return ctx;
}

/** Convenience: translation function only. */
export function useT(): Translate {
	return useI18n().t;
}
