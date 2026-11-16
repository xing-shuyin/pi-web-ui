import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 网络隧道面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		reading: "读取中…",
		loading: "加载中…",
		close: "关闭",
		copied: "已复制",
		none: "无",
		unknownError: "未知错误",

		// 隧道状态卡
		stopService: "停止服务",
		startService: "启动服务",
		conns: "连接数",
		ports: "端口",
		tunnelOnline: "隧道在线 · 出口 {name}",
		serviceWaiting: "服务运行 · 等待设备连入",
		serviceStopped: "服务已停止",
		connsSummary: "活跃 {active} · 累计 {total}",
		tokenRedactedSuffix: " (脱敏)",
		tokenRedactedHint: "宿主未设 PI_WEB_TOKEN，公网下已脱敏保护；设置口令后解锁",
		statusReadFailed: "状态读取失败",
		statusReadFailedInactive: "状态读取失败（插件未激活？）",

		// 模型通道
		modelChannel: "模型通道",
		modelChannelDesc: "指挥设备 pi agent 用的模型；手动指定优先于自动挑选",
		meBasePlaceholder: "baseUrl（http://…/v1）",
		meModelPlaceholder: "model（provider/模型ID）",
		meSave: "保存手动指定",
		meClear: "恢复自动",
		meSourceManual: "手动指定",
		meSourceOverride: "请求指定",
		meSourceAuto: "自动挑选",
		meResolved: "生效：{source} · {model} · key…{tail}",
		meUnresolved: "未解析——请手动指定",
		meUnresolvedWithReason: "未解析：{reason}——请手动指定",
		meCandidates: "自动候选：{list}",
		meCandidateItem: "{provider}（{model}）",
		meCandidatesNone: "自动候选：无（需 models.json provider 为 openai-completions 型且 provider-keys 有 key）",
		saveFailed: "保存失败：{error}",
		saveFailedNetwork: "保存失败：网络错误",

		// Mesh 桥
		meshBridge: "Mesh 桥",
		meshDesc: "把设备 pi agent 接入 pi_messenger，任意会话可 send 直达",
		meshEnable: "开启 Mesh 桥",
		meshDisable: "关闭 Mesh 桥",
		meshSession: "会话",
		meshReset: "重置会话",
		meshOn: "已开启 · {agent}{note}",
		meshOnDevice: "已开启 · {agent}（{device}）{note}",
		meshNotRunning: " · 桥未运行（服务未启动？）",
		meshOff: "已关闭——开启后设备 pi agent 加入 pi_messenger",
		meshQueue: "队列 {queue} · 待回 {pending}",
		meshToggleFailed: "切换失败：网络错误",
		meshSessionInfo: "设备 mesh 会话：\n{detail}",
		meshSessionDetail: "会话 ID：{id}\n最近活跃：{updated}\n文件大小：{size} KB",
		meshSessionNone: "无会话（尚未进行过 mesh 对话）",
		readFailed: "读取失败：{error}",
		readFailedNetwork: "读取失败：网络错误",
		meshResetConfirm: "确定重置设备端 mesh 会话？\n\n重置后设备将遗忘之前的对话记忆，下条消息开启新会话。",
		meshResetDone: "已重置（原会话 {id}）",
		meshResetFailed: "重置失败：{error}",
		meshResetFailedNetwork: "重置失败：网络错误",

		// 出口设备
		devices: "出口设备",
		devicesDesc: "SOCKS 流量走选中的设备；出口掉线自动切换",
		devicesEmpty: "暂无设备连入 —— 在主人设备上运行 CLI 后出现在这里",
		devCurrent: "当前出口",
		devSetCurrent: "设为出口",
		devReconnecting: "重连中",
		devCliOutdated: "CLI 需更新",
		devFsRead: "文件读",
		devFsWrite: "文件写",
		devWhitelist: "白名单目录（逗号分隔）",
		devTask: "任务",
		devHw: "硬件",
		devBrowse: "浏览…",
		devSave: "保存配置",
		devUninstall: "卸载",
		uninstallConfirm: "确定卸载该设备上的隧道 CLI？\n将停止常驻服务并删除 CLI 文件，设备将从列表消失。",
		devWriteOff: "设备未开启写权限（可在能力设置中开启）",

		// 操作审计
		audit: "操作审计（最近 100 条）",
		auditDesc: "设备侧文件/目录枚举操作记录",
		auditEmpty: "暂无操作记录",

		// 接入令牌与设备常驻化
		tokenSection: "接入令牌",
		rotate: "重置令牌",
		rotateHint: "重置后所有已分发 CLI 将无法重连，需重新下载",
		rotateConfirm: "重置令牌后，所有已分发 CLI 将无法重连（需重新下载）。确定重置？",
		persistSection: "设备常驻化",
		persistDesc: "一次性安装，装完不开终端；按设备系统选页签",
		copyTab: "复制当前页签命令",
		copyFailed: "复制失败：请手动选中命令块复制",
		downloadCli: "下载 CLI（已注入令牌）",
		aiProbe: "AI 侧探测： curl --socks5-hostname 127.0.0.1:1080 &lt;url&gt;",
		fallbackHost: "<mini内网IP>",
		fallbackToken: "<tunnel令牌>",
		echoWindows: "常驻已装：登录自启，CLI 内置 5s 掉线重连；pi agent 已就绪（首次用需 pi auth 配模型）",
		echoUnix: "常驻已装：开机自启+掉线自愈",

		// 白名单目录选择器
		bmTitle: "选择白名单目录",
		bmEmpty: "无子目录",
		browseFailed: "浏览失败",
		bmPick: "选择此目录",

		// 硬件概览
		hwTitle: "硬件概览",
		hwFailed: "查询失败",
		hwModel: "型号",
		hwOs: "系统",
		hwCpu: "CPU",
		hwMem: "内存",
		hwDisk: "根分区",
		hwUptime: "运行时长",
		hwLoad: "负载",
		hwHours: "{n} 小时",

		// 指挥设备 pi agent
		tkTitle: "指挥设备 pi agent",
		tkPlaceholder: "任务描述（如：列出 Downloads 下大于 100MB 的文件）",
		tkAllowWrite: "允许写入/执行（bash/edit/write，默认只读）",
		tkRun: "执行任务",
		tkNoPrompt: "请先填写任务描述",
		tkRunning: "任务执行中（设备端 pi agent，最长 5 分钟）…",
		tkDone: "✓ 完成",
		tkMeta: "设备端 pi agent · 耗时 {secs}s",
		tkNoOutput: "（无输出）",
		tkRequestFailed: "✗ 请求失败",
		tkResultPlaceholder: "（结果将显示在这里）",
	},
	"zh-TW": {
		// 通用
		reading: "讀取中…",
		loading: "載入中…",
		close: "關閉",
		copied: "已複製",
		none: "無",
		unknownError: "未知錯誤",

		// 隧道状态卡
		stopService: "停止服務",
		startService: "啟動服務",
		conns: "連線數",
		ports: "埠",
		tunnelOnline: "隧道線上 · 出口 {name}",
		serviceWaiting: "服務執行 · 等待裝置連入",
		serviceStopped: "服務已停止",
		connsSummary: "活躍 {active} · 累計 {total}",
		tokenRedactedSuffix: " (脫敏)",
		tokenRedactedHint: "宿主未設 PI_WEB_TOKEN，公網下已脫敏保護；設定口令後解鎖",
		statusReadFailed: "狀態讀取失敗",
		statusReadFailedInactive: "狀態讀取失敗（外掛未啟用？）",

		// 模型通道
		modelChannel: "模型通道",
		modelChannelDesc: "指揮裝置 pi agent 用的模型；手動指定優先於自動挑選",
		meBasePlaceholder: "baseUrl（http://…/v1）",
		meModelPlaceholder: "model（provider/模型ID）",
		meSave: "儲存手動指定",
		meClear: "恢復自動",
		meSourceManual: "手動指定",
		meSourceOverride: "請求指定",
		meSourceAuto: "自動挑選",
		meResolved: "生效：{source} · {model} · key…{tail}",
		meUnresolved: "未解析——請手動指定",
		meUnresolvedWithReason: "未解析：{reason}——請手動指定",
		meCandidates: "自動候選：{list}",
		meCandidateItem: "{provider}（{model}）",
		meCandidatesNone: "自動候選：無（需 models.json provider 為 openai-completions 型且 provider-keys 有 key）",
		saveFailed: "儲存失敗：{error}",
		saveFailedNetwork: "儲存失敗：網路錯誤",

		// Mesh 桥
		meshBridge: "Mesh 橋",
		meshDesc: "把裝置 pi agent 接入 pi_messenger，任意會話可 send 直達",
		meshEnable: "開啟 Mesh 橋",
		meshDisable: "關閉 Mesh 橋",
		meshSession: "會話",
		meshReset: "重置會話",
		meshOn: "已開啟 · {agent}{note}",
		meshOnDevice: "已開啟 · {agent}（{device}）{note}",
		meshNotRunning: " · 橋未執行（服務未啟動？）",
		meshOff: "已關閉——開啟後設備 pi agent 加入 pi_messenger",
		meshQueue: "佇列 {queue} · 待回 {pending}",
		meshToggleFailed: "切換失敗：網路錯誤",
		meshSessionInfo: "裝置 mesh 會話：\n{detail}",
		meshSessionDetail: "會話 ID：{id}\n最近活躍：{updated}\n檔案大小：{size} KB",
		meshSessionNone: "無會話（尚未進行過 mesh 對話）",
		readFailed: "讀取失敗：{error}",
		readFailedNetwork: "讀取失敗：網路錯誤",
		meshResetConfirm: "確定重置裝置端 mesh 會話？\n\n重置後設備將遺忘之前的對話記憶，下條訊息開啟新會話。",
		meshResetDone: "已重置（原會話 {id}）",
		meshResetFailed: "重置失敗：{error}",
		meshResetFailedNetwork: "重置失敗：網路錯誤",

		// 出口设备
		devices: "出口裝置",
		devicesDesc: "SOCKS 流量走選中的裝置；出口掉線自動切換",
		devicesEmpty: "暫無裝置連入 —— 在主人裝置上執行 CLI 後出現在這裡",
		devCurrent: "當前出口",
		devSetCurrent: "設為出口",
		devReconnecting: "重連中",
		devCliOutdated: "CLI 需更新",
		devFsRead: "檔案讀",
		devFsWrite: "檔案寫",
		devWhitelist: "白名單目錄（逗號分隔）",
		devTask: "任務",
		devHw: "硬體",
		devBrowse: "瀏覽…",
		devSave: "儲存配置",
		devUninstall: "解除安裝",
		uninstallConfirm: "確定解除安裝該裝置上的隧道 CLI？\n將停止常駐服務並刪除 CLI 檔案，裝置將從列表消失。",
		devWriteOff: "裝置未開啟寫許可權（可在能力設定中開啟）",

		// 操作审计
		audit: "操作審計（最近 100 條）",
		auditDesc: "裝置側檔案/目錄列舉操作記錄",
		auditEmpty: "暫無操作記錄",

		// 接入令牌与设备常驻化
		tokenSection: "接入令牌",
		rotate: "重置令牌",
		rotateHint: "重置後所有已分發 CLI 將無法重連，需重新下載",
		rotateConfirm: "重置令牌後，所有已分發 CLI 將無法重連（需重新下載）。確定重置？",
		persistSection: "裝置常駐化",
		persistDesc: "一次性安裝，裝完不開終端；按裝置系統選頁籤",
		copyTab: "複製當前頁籤命令",
		copyFailed: "複製失敗：請手動選中命令塊複製",
		downloadCli: "下載 CLI（已注入令牌）",
		aiProbe: "AI 側探測： curl --socks5-hostname 127.0.0.1:1080 &lt;url&gt;",
		fallbackHost: "<mini內網IP>",
		fallbackToken: "<tunnel令牌>",
		echoWindows: "常駐已裝：登入自啟，CLI 內建 5s 掉線重連；pi agent 已就緒（首次用需 pi auth 配模型）",
		echoUnix: "常駐已裝：開機自啟+掉線自愈",

		// 白名单目录选择器
		bmTitle: "選擇白名單目錄",
		bmEmpty: "無子目錄",
		browseFailed: "瀏覽失敗",
		bmPick: "選擇此目錄",

		// 硬件概览
		hwTitle: "硬體概覽",
		hwFailed: "查詢失敗",
		hwModel: "型號",
		hwOs: "系統",
		hwCpu: "CPU",
		hwMem: "記憶體",
		hwDisk: "根分割槽",
		hwUptime: "執行時長",
		hwLoad: "負載",
		hwHours: "{n} 小時",

		// 指挥设备 pi agent
		tkTitle: "指揮裝置 pi agent",
		tkPlaceholder: "任務描述（如：列出 Downloads 下大於 100MB 的檔案）",
		tkAllowWrite: "允許寫入/執行（bash/edit/write，預設只讀）",
		tkRun: "執行任務",
		tkNoPrompt: "請先填寫任務描述",
		tkRunning: "任務執行中（裝置端 pi agent，最長 5 分鐘）…",
		tkDone: "✓ 完成",
		tkMeta: "裝置端 pi agent · 耗時 {secs}s",
		tkNoOutput: "（無輸出）",
		tkRequestFailed: "✗ 請求失敗",
		tkResultPlaceholder: "（結果將顯示在這裡）",
	},
	en: {
		// Common
		reading: "Loading…",
		loading: "Loading…",
		close: "Close",
		copied: "Copied",
		none: "none",
		unknownError: "unknown error",

		// Tunnel status card
		stopService: "Stop service",
		startService: "Start service",
		conns: "Connections",
		ports: "Port",
		tunnelOnline: "Tunnel online · exit {name}",
		serviceWaiting: "Service running · waiting for a device to connect",
		serviceStopped: "Service stopped",
		connsSummary: "Active {active} · total {total}",
		tokenRedactedSuffix: " (redacted)",
		tokenRedactedHint:
			"The host does not set PI_WEB_TOKEN, so the token is redacted on public networks; set a passphrase to unlock it",
		statusReadFailed: "Failed to read status",
		statusReadFailedInactive: "Failed to read status (plugin not activated?)",

		// Model channel
		modelChannel: "Model channel",
		modelChannelDesc: "Model used to command the device pi agent; a manual pick wins over auto-selection",
		meBasePlaceholder: "baseUrl (http://…/v1)",
		meModelPlaceholder: "model (provider/model ID)",
		meSave: "Save manual pick",
		meClear: "Back to auto",
		meSourceManual: "manual",
		meSourceOverride: "request override",
		meSourceAuto: "auto-selected",
		meResolved: "Active: {source} · {model} · key…{tail}",
		meUnresolved: "Unresolved — set it manually",
		meUnresolvedWithReason: "Unresolved: {reason} — set it manually",
		meCandidates: "Auto candidates: {list}",
		meCandidateItem: "{provider} ({model})",
		meCandidatesNone:
			"Auto candidates: none (needs an openai-completions provider in models.json with a key in provider-keys)",
		saveFailed: "Save failed: {error}",
		saveFailedNetwork: "Save failed: network error",

		// Mesh bridge
		meshBridge: "Mesh bridge",
		meshDesc: "Joins the device pi agent to pi_messenger so any conversation can send straight to it",
		meshEnable: "Enable Mesh bridge",
		meshDisable: "Disable Mesh bridge",
		meshSession: "Session",
		meshReset: "Reset session",
		meshOn: "Enabled · {agent}{note}",
		meshOnDevice: "Enabled · {agent} ({device}){note}",
		meshNotRunning: " · bridge not running (service not started?)",
		meshOff: "Disabled — once enabled, the device pi agent joins pi_messenger",
		meshQueue: "Queue {queue} · pending {pending}",
		meshToggleFailed: "Toggle failed: network error",
		meshSessionInfo: "Device mesh session:\n{detail}",
		meshSessionDetail: "Session ID: {id}\nLast active: {updated}\nFile size: {size} KB",
		meshSessionNone: "No session (no mesh conversation yet)",
		readFailed: "Read failed: {error}",
		readFailedNetwork: "Read failed: network error",
		meshResetConfirm:
			"Reset the device-side mesh session?\n\nThe device will forget the previous conversation memory; the next message starts a new session.",
		meshResetDone: "Reset (previous session {id})",
		meshResetFailed: "Reset failed: {error}",
		meshResetFailedNetwork: "Reset failed: network error",

		// Egress devices
		devices: "Egress devices",
		devicesDesc: "SOCKS traffic goes through the selected device; it switches automatically when the exit drops",
		devicesEmpty: "No device connected yet — run the CLI on the owner's device and it appears here",
		devCurrent: "Current exit",
		devSetCurrent: "Use as exit",
		devReconnecting: "Reconnecting",
		devCliOutdated: "CLI update needed",
		devFsRead: "File read",
		devFsWrite: "File write",
		devWhitelist: "Whitelisted directories (comma-separated)",
		devTask: "Task",
		devHw: "Hardware",
		devBrowse: "Browse…",
		devSave: "Save config",
		devUninstall: "Uninstall",
		uninstallConfirm:
			"Uninstall the tunnel CLI from this device?\nThis stops the persistent service and deletes the CLI file; the device then disappears from the list.",
		devWriteOff: "Write permission is off for this device (enable it in the capability settings)",

		// Audit
		audit: "Audit log (last 100)",
		auditDesc: "Device-side file and directory enumeration records",
		auditEmpty: "No operations recorded yet",

		// Access token and persistent install
		tokenSection: "Access token",
		rotate: "Rotate token",
		rotateHint: "After rotating, every distributed CLI can no longer reconnect and must be downloaded again",
		rotateConfirm: "Rotating the token disconnects every distributed CLI (they must be downloaded again). Rotate now?",
		persistSection: "Persistent install",
		persistDesc: "One-time install that keeps running without a terminal; pick the tab for the device OS",
		copyTab: "Copy the current tab's command",
		copyFailed: "Copy failed: select the command block and copy it manually",
		downloadCli: "Download CLI (token injected)",
		aiProbe: "AI-side probe: curl --socks5-hostname 127.0.0.1:1080 &lt;url&gt;",
		fallbackHost: "<mini LAN IP>",
		fallbackToken: "<tunnel token>",
		echoWindows:
			"Persistent install done: starts at login and the CLI reconnects within 5s of a drop; the pi agent is ready (run pi auth to configure a model the first time)",
		echoUnix: "Persistent install done: starts on boot and self-heals on disconnect",

		// Whitelist directory picker
		bmTitle: "Choose a whitelisted directory",
		bmEmpty: "No subdirectories",
		browseFailed: "Browse failed",
		bmPick: "Choose this directory",

		// Hardware overview
		hwTitle: "Hardware overview",
		hwFailed: "Query failed",
		hwModel: "Model",
		hwOs: "OS",
		hwCpu: "CPU",
		hwMem: "Memory",
		hwDisk: "Root disk",
		hwUptime: "Uptime",
		hwLoad: "Load",
		hwHours: "{n} hours",

		// Command the device pi agent
		tkTitle: "Command the device pi agent",
		tkPlaceholder: "Task description (e.g. list files over 100 MB under Downloads)",
		tkAllowWrite: "Allow writes/commands (bash/edit/write; read-only by default)",
		tkRun: "Run task",
		tkNoPrompt: "Enter a task description first",
		tkRunning: "Running (device-side pi agent, up to 5 minutes)…",
		tkDone: "✓ Done",
		tkMeta: "Device-side pi agent · {secs}s",
		tkNoOutput: "(no output)",
		tkRequestFailed: "✗ Request failed",
		tkResultPlaceholder: "(results appear here)",
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
