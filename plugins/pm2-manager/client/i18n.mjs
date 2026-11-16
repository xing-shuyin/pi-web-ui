import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 进程管家（pm2）面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不进词典的字符串（数据 / 开发者向）：
 * - pm2 的应用名、脚本入口、工作目录、参数（用户与服务端产物）；
 * - pm2 的进程状态取值（`online` / `stopped` / `errored` / `offline` / `launching`），
 *   `statusTag()` 只做样式类映射，标签文本原样展示接口数据；
 * - `uptime()` 拼出的 `12s` / `3h5m` / `2d1h` 单位与 `—` 占位符（数值格式化，不是界面文案）；
 * - CLI 词汇与命令（`pm2 kill`、`npm i -g pm2`、`script` / `cwd` / `args` 等表单字段名）；
 * - 宿主注入的服务端错误文本（`/status`、`/install` 返回的 error）原样透传。
 */
export const DICT = {
	zh: {
		title: "进程管家",
		subtitle: "pm2 统一托管 AI 的后台任务",
		probing: "正在检测 pm2 环境…",
		refresh: "刷新",
		notInstalled: "未检测到 pm2 —— 长期任务无法托管，AI 起的后台实例会脱离管理面。",
		install: "安装 pm2",
		installing: "正在安装…",
		installHint: "等价于在终端执行 npm i -g pm2",
		appsTitle: "pm2 托管的应用",
		empty: "pm2 当前没有托管任何应用。让 AI 用 pm2 起服务后，这里会自动出现。",
		name: "名称",
		status: "状态",
		cpu: "CPU",
		mem: "内存",
		restarts: "重启",
		uptime: "时长",
		ops: "操作",
		stop: "停止",
		restart: "重启",
		del: "删除",
		logs: "日志",
		logsEmpty: "（无输出）",
		platform: "平台",
		busy: "执行中…",
		startToggle: "启动新应用",
		startTitle: "安装到 pm2：一行起一个后台服务",
		appName: "应用名（可选，默认取文件名）",
		script: "启动入口（必填，如 server.js / npm / python）",
		cwd: "工作目录（可选）",
		args: "附加参数（可选，空格分隔，如 run dev）",
		startBtn: "启动并托管",
		starting: "正在启动…",
		startNeedScript: "请先填启动入口（script），如 server.js。",
		startHint: "等价于 pm2 start <入口> --name <应用名>，起好后出现在上表，可停可删可看日志。",
		uninstall: "卸载 pm2",
		uninstalling: "正在卸载…",
		uninstallAsk: "确认卸载 pm2 本体？会先停掉所有托管应用（pm2 kill），再执行 npm uninstall -g pm2。",
		uninstallYes: "确认卸载",
		uninstallCancel: "取消",
		uninstallHint: "不用 pm2 了点这里：删守护进程 + 卸全局包。删单个应用点表里的“删除”。",
	},
	"zh-TW": {
		title: "程序管家",
		subtitle: "pm2 統一託管 AI 的後臺任務",
		probing: "正在檢測 pm2 環境…",
		refresh: "重新整理",
		notInstalled: "未檢測到 pm2 —— 長期任務無法託管，AI 起的後臺例項會脫離管理面。",
		install: "安裝 pm2",
		installing: "正在安裝…",
		installHint: "等價於在終端執行 npm i -g pm2",
		appsTitle: "pm2 託管的應用",
		empty: "pm2 當前沒有託管任何應用。讓 AI 用 pm2 起服務後，這裡會自動出現。",
		name: "名稱",
		status: "狀態",
		cpu: "CPU",
		mem: "記憶體",
		restarts: "重啟",
		uptime: "時長",
		ops: "操作",
		stop: "停止",
		restart: "重啟",
		del: "刪除",
		logs: "日誌",
		logsEmpty: "（無輸出）",
		platform: "平臺",
		busy: "執行中…",
		startToggle: "啟動新應用",
		startTitle: "安裝到 pm2：一行起一個後臺服務",
		appName: "應用名（可選，預設取檔名）",
		script: "啟動入口（必填，如 server.js / npm / python）",
		cwd: "工作目錄（可選）",
		args: "附加引數（可選，空格分隔，如 run dev）",
		startBtn: "啟動並託管",
		starting: "正在啟動…",
		startNeedScript: "請先填啟動入口（script），如 server.js。",
		startHint: "等價於 pm2 start <入口> --name <應用名>，起好後出現在上表，可停可刪可看日誌。",
		uninstall: "解除安裝 pm2",
		uninstalling: "正在解除安裝…",
		uninstallAsk: "確認解除安裝 pm2 本體？會先停掉所有託管應用（pm2 kill），再執行 npm uninstall -g pm2。",
		uninstallYes: "確認解除安裝",
		uninstallCancel: "取消",
		uninstallHint: "不用 pm2 了點這裡：刪守護程序 + 卸全域性包。刪單個應用點表裡的“刪除”。",
	},
	en: {
		title: "Process Manager",
		subtitle: "All AI background tasks supervised by pm2",
		probing: "Checking the pm2 environment…",
		refresh: "Refresh",
		notInstalled: "pm2 not found — long-lived tasks cannot be supervised; AI background instances escape management.",
		install: "Install pm2",
		installing: "Installing…",
		installHint: "Same as running npm i -g pm2 in a terminal",
		appsTitle: "pm2-supervised apps",
		empty: "pm2 supervises no app right now. Apps appear here as soon as the AI starts them through pm2.",
		name: "Name",
		status: "Status",
		cpu: "CPU",
		mem: "Memory",
		restarts: "Restarts",
		uptime: "Uptime",
		ops: "Actions",
		stop: "Stop",
		restart: "Restart",
		del: "Delete",
		logs: "Logs",
		logsEmpty: "(no output)",
		platform: "Platform",
		busy: "working…",
		startToggle: "Start a new app",
		startTitle: "Install into pm2: one line starts one background service",
		appName: "App name (optional, defaults to file name)",
		script: "Entry (required, e.g. server.js / npm / python)",
		cwd: "Working directory (optional)",
		args: "Extra args (optional, space-separated, e.g. run dev)",
		startBtn: "Start & supervise",
		starting: "Starting…",
		startNeedScript: "Please fill in the entry (script) first, e.g. server.js.",
		startHint: "Same as pm2 start <entry> --name <app>; it shows up in the table above once started.",
		uninstall: "Uninstall pm2",
		uninstalling: "Uninstalling…",
		uninstallAsk:
			"Uninstall pm2 itself? This stops every supervised app first (pm2 kill), then runs npm uninstall -g pm2.",
		uninstallYes: "Yes, uninstall",
		uninstallCancel: "Cancel",
		uninstallHint: "Done with pm2? This removes the daemon + global package. To drop one app use Delete in the table.",
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
