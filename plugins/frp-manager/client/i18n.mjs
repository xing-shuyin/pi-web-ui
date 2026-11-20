import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 内网穿透（frp）面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不进词典的字符串（数据 / 开发者向）：
 * - 穿透名、主机名、账号、路径、端口（用户与服务端产物），以及 `esc()` 包着的接口数据；
 * - frp 协议词汇与 TOML 键（`frpc.toml`、`[common]`、serverAddr / serverPort / token / TLS /
 *   bindPort / httpPort / dashboard* / subdomainHost），它们是配置文件字段名，不是界面文案；
 * - 穿透类型取值（tcp / udp / http / https / stcp / xtcp）、`tlsEnable` 的 `0` / `1`、日志角色
 *   `frpc` / `frps`（持久化取值与 CLI 词汇）；
 * - `(pid N)`、`(未填)` 之外的裸数据占位由服务端状态驱动；`frp` / `frpc` / `frps` 命令名原样保留；
 * - 服务端返回的错误文本（`r.error`）与 `e.message` 原样透传（server-owned / 浏览器原生）。
 */
export const DICT = {
	zh: {
		// 通用
		connectingFailed: "连接失败：{error}",
		unknownError: "未知错误",
		failed: "失败：{error}",
		working: "执行中…",
		done: "已完成",
		notFilled: "(未填)",
		refresh: "刷新",
		renderFailed: "页面渲染失败：{error}",
		retry: "重试",
		apiBadJson: "接口返回非 JSON（HTTP {status}）：{body}",

		// 环境探测
		probing: "正在检测 frp 环境…",

		// 页签
		tabList: "穿透列表",
		tabClient: "客户端 frpc",
		tabFrps: "本地 frps",
		tabRemote: "远端部署",
		tabLogs: "日志",

		// 穿透列表
		runningWithPid: "运行中 (pid {pid})",
		notRunning: "未运行",
		serverSummary: "服务端 {addr}:{port} · {count} 条启用",
		installFrp: "一键安装 frp",
		restart: "重启",
		start: "启动",
		stop: "停止",
		frpcMissing: "未检测到 frpc（{dir}），点一键安装从 GitHub 下载官方版；离线机器可手动放二进制到该目录。",
		newProxy: "+ 新增穿透",
		applyHint: "改完点「启动/重启」生效",
		colName: "名称",
		colType: "类型",
		colMapping: "映射",
		colOps: "操作",
		emptyProxies: "还没有穿透规则，点「新增穿透」把本机服务（如 127.0.0.1:3000）暴露出去。",
		disabled: "已禁用",
		enable: "启用",
		disable: "禁用",
		edit: "编辑",
		remove: "删",

		// 穿透表单
		editProxy: "编辑 {name}",
		addProxy: "新增穿透",
		fName: "名称",
		namePlaceholder: "如 web-admin",
		fType: "类型",
		fLocalIp: "本地 IP",
		fLocalPort: "本地端口",
		localPortPlaceholder: "如 3000",
		fRemotePort: "远程端口",
		remotePortPlaceholder: "tcp/udp 用，如 6000",
		fDomains: "域名",
		domainsPlaceholder: "http/https 用，逗号分隔",
		fSubdomain: "subdomain",
		subdomainPlaceholder: "可选，需服务端 subdomainHost",
		save: "保存",
		cancel: "取消",

		// 客户端 frpc
		clientSection: "服务端连接（frpc.toml [common]）",
		addrPlaceholder: "公网服务器 IP/域名",
		tokenPlaceholder: "与 frps 一致",
		tlsOn: "开启",
		tlsOff: "关闭",
		clientSavedHint: "保存后重启 frpc 生效 · 配置文件 frpc.toml 在数据目录",

		// 本地 frps
		localFrps: "本地 frps",
		frpsSummary: "联调用：本机同时起 frps + frpc 自测",
		fHttpPort: "http 穿透端口",
		httpPortPlaceholder: "如 8080，空=关闭",
		fDashboardPort: "dashboard 端口",
		dashboardPortPlaceholder: "如 7500",
		fDashboardUser: "dashboard 账号",
		fDashboardPwd: "dashboard 密码",
		subdomainHostPlaceholder: "如 frp.example.com",

		// 远端部署
		remoteSection: "远端公网 frps 一键部署",
		remoteDesc:
			"用本机<b>共享 SSH 主机库</b>（与远程工作台/SFTP 同一份：截图里那些已保存连接直接选，不用再填 IP 密码）。主机先去远程工作台加好，回来点刷新。远端需放行 bindPort/tcp（如 7000）+ http/dashboard 端口。",
		remoteHost: "远端主机",
		remoteDeployHint: "直装成功后 frpc 服务端地址自动同步为所选主机 IP，token 与本地 frps 页一致，重启 frpc 即通。",
		hostLibEmpty: "（主机库为空，先去远程工作台添加）",
		hostOption: "{name}（{user}@{host}:{port}）",
		useThisHost: "选用该主机",
		probe: "测试连通",
		copyScript: "复制一键脚本",
		deploy: "SSH 直装远端",
		remoteCurrent: "当前远端配置：bindPort {bindPort} / token ",
		tokenSet: "已设。",
		tokenUnset: "<b>未设（先去本地 frps 页设置）</b>。",
		scriptCopied: "一键脚本已复制，到远端 root 下 bash 粘贴执行即可",
		copyFailed: "复制失败，点 SSH 直装或稍后重试",
		installing: "下载安装中（GitHub release，约 10-20MB）…",
		installed: "安装完成 {version}",
		deleteProxyAsk: "删除穿透 {name}？",

		// 日志
		logsFrpc: "frpc 日志",
		logsFrps: "frps 日志",
		logsEmpty: "(暂无日志)",

		// 头部
		title: "🚇 内网穿透",
		subtitle: "frpc 穿透列表 · 本地 frps 联调 · 远端一键部署",
	},
	"zh-TW": {
		// 通用
		connectingFailed: "連線失敗：{error}",
		unknownError: "未知錯誤",
		failed: "失敗：{error}",
		working: "執行中…",
		done: "已完成",
		notFilled: "(未填)",
		refresh: "重新整理",
		renderFailed: "頁面渲染失敗：{error}",
		retry: "重試",
		apiBadJson: "介面返回非 JSON（HTTP {status}）：{body}",

		// 环境探测
		probing: "正在檢測 frp 環境…",

		// 页签
		tabList: "穿透列表",
		tabClient: "客戶端 frpc",
		tabFrps: "本地 frps",
		tabRemote: "遠端部署",
		tabLogs: "日誌",

		// 穿透列表
		runningWithPid: "執行中 (pid {pid})",
		notRunning: "未執行",
		serverSummary: "服務端 {addr}:{port} · {count} 條啟用",
		installFrp: "一鍵安裝 frp",
		restart: "重啟",
		start: "啟動",
		stop: "停止",
		frpcMissing: "未檢測到 frpc（{dir}），點一鍵安裝從 GitHub 下載官方版；離線機器可手動放二進位制到該目錄。",
		newProxy: "+ 新增穿透",
		applyHint: "改完點「啟動/重啟」生效",
		colName: "名稱",
		colType: "型別",
		colMapping: "對映",
		colOps: "操作",
		emptyProxies: "還沒有穿透規則，點「新增穿透」把本機服務（如 127.0.0.1:3000）暴露出去。",
		disabled: "已停用",
		enable: "啟用",
		disable: "停用",
		edit: "編輯",
		remove: "刪",

		// 穿透表单
		editProxy: "編輯 {name}",
		addProxy: "新增穿透",
		fName: "名稱",
		namePlaceholder: "如 web-admin",
		fType: "型別",
		fLocalIp: "本地 IP",
		fLocalPort: "本地埠",
		localPortPlaceholder: "如 3000",
		fRemotePort: "遠端埠",
		remotePortPlaceholder: "tcp/udp 用，如 6000",
		fDomains: "域名",
		domainsPlaceholder: "http/https 用，逗號分隔",
		fSubdomain: "subdomain",
		subdomainPlaceholder: "可選，需服務端 subdomainHost",
		save: "儲存",
		cancel: "取消",

		// 客户端 frpc
		clientSection: "服務端連線（frpc.toml [common]）",
		addrPlaceholder: "公網伺服器 IP/域名",
		tokenPlaceholder: "與 frps 一致",
		tlsOn: "開啟",
		tlsOff: "關閉",
		clientSavedHint: "儲存後重啟 frpc 生效 · 配置檔案 frpc.toml 在資料目錄",

		// 本地 frps
		localFrps: "本地 frps",
		frpsSummary: "聯呼叫：本機同時起 frps + frpc 自測",
		fHttpPort: "http 穿透埠",
		httpPortPlaceholder: "如 8080，空=關閉",
		fDashboardPort: "dashboard 埠",
		dashboardPortPlaceholder: "如 7500",
		fDashboardUser: "dashboard 賬號",
		fDashboardPwd: "dashboard 密碼",
		subdomainHostPlaceholder: "如 frp.example.com",

		// 远端部署
		remoteSection: "遠端公網 frps 一鍵部署",
		remoteDesc:
			"用本機<b>共享 SSH 主機庫</b>（與遠端工作臺/SFTP 同一份：截圖裡那些已儲存連線直接選，不用再填 IP 密碼）。主機先去遠端工作臺加好，回來點重新整理。遠端需放行 bindPort/tcp（如 7000）+ http/dashboard 埠。",
		remoteHost: "遠端主機",
		remoteDeployHint: "直裝成功後 frpc 服務端地址自動同步為所選主機 IP，token 與本地 frps 頁一致，重啟 frpc 即通。",
		hostLibEmpty: "（主機庫為空，先去遠端工作臺新增）",
		hostOption: "{name}（{user}@{host}:{port}）",
		useThisHost: "選用該主機",
		probe: "測試連通",
		copyScript: "複製一鍵指令碼",
		deploy: "SSH 直裝遠端",
		remoteCurrent: "當前遠端配置：bindPort {bindPort} / token ",
		tokenSet: "已設。",
		tokenUnset: "<b>未設（先去本地 frps 頁設定）</b>。",
		scriptCopied: "一鍵指令碼已複製，到遠端 root 下 bash 貼上執行即可",
		copyFailed: "複製失敗，點 SSH 直裝或稍後重試",
		installing: "下載安裝中（GitHub release，約 10-20MB）…",
		installed: "安裝完成 {version}",
		deleteProxyAsk: "刪除穿透 {name}？",

		// 日志
		logsFrpc: "frpc 日誌",
		logsFrps: "frps 日誌",
		logsEmpty: "(暫無日誌)",

		// 头部
		title: "🚇 內網穿透",
		subtitle: "frpc 穿透列表 · 本地 frps 聯調 · 遠端一鍵部署",
	},
	en: {
		// Common
		connectingFailed: "Connection failed: {error}",
		unknownError: "unknown error",
		failed: "Failed: {error}",
		working: "Working…",
		done: "Done",
		notFilled: "(not set)",
		refresh: "Refresh",
		renderFailed: "Render failed: {error}",
		retry: "Retry",
		apiBadJson: "Non-JSON response (HTTP {status}): {body}",

		// Environment probe
		probing: "Checking the frp environment…",

		// Tabs
		tabList: "Proxies",
		tabClient: "frpc client",
		tabFrps: "Local frps",
		tabRemote: "Remote deploy",
		tabLogs: "Logs",

		// Proxy list
		runningWithPid: "running (pid {pid})",
		notRunning: "not running",
		serverSummary: "Server {addr}:{port} · {count} enabled",
		installFrp: "Install frp",
		restart: "Restart",
		start: "Start",
		stop: "Stop",
		frpcMissing:
			"frpc not found ({dir}); use Install frp to fetch the official build from GitHub, or drop the binary into that directory on an offline machine.",
		newProxy: "+ New proxy",
		applyHint: "Start/restart to apply",
		colName: "Name",
		colType: "Type",
		colMapping: "Mapping",
		colOps: "Actions",
		emptyProxies: "No proxy rules yet; use New proxy to expose a local service (e.g. 127.0.0.1:3000) to the internet.",
		disabled: "disabled",
		enable: "Enable",
		disable: "Disable",
		edit: "Edit",
		remove: "Del",

		// Proxy form
		editProxy: "Edit {name}",
		addProxy: "New proxy",
		fName: "Name",
		namePlaceholder: "e.g. web-admin",
		fType: "Type",
		fLocalIp: "Local IP",
		fLocalPort: "Local port",
		localPortPlaceholder: "e.g. 3000",
		fRemotePort: "Remote port",
		remotePortPlaceholder: "for tcp/udp, e.g. 6000",
		fDomains: "Domains",
		domainsPlaceholder: "for http/https, comma-separated",
		fSubdomain: "subdomain",
		subdomainPlaceholder: "optional, needs subdomainHost on the server",
		save: "Save",
		cancel: "Cancel",

		// frpc client
		clientSection: "Server connection (frpc.toml [common])",
		addrPlaceholder: "public server IP / domain",
		tokenPlaceholder: "same as frps",
		tlsOn: "On",
		tlsOff: "Off",
		clientSavedHint: "Restart frpc to apply · frpc.toml lives in the data directory",

		// Local frps
		localFrps: "Local frps",
		frpsSummary: "For local testing: run frps and frpc on this machine",
		fHttpPort: "HTTP proxy port",
		httpPortPlaceholder: "e.g. 8080, empty = off",
		fDashboardPort: "dashboard port",
		dashboardPortPlaceholder: "e.g. 7500",
		fDashboardUser: "dashboard user",
		fDashboardPwd: "dashboard password",
		subdomainHostPlaceholder: "e.g. frp.example.com",

		// Remote deploy
		remoteSection: "One-click remote frps deploy",
		remoteDesc:
			"Uses this machine's <b>shared SSH host library</b> (the same one as Remote Workbench/SFTP, so saved hosts are selectable without retyping IP and password). Add the host in Remote Workbench first, then refresh here. The remote side must allow bindPort/tcp (e.g. 7000) plus the http/dashboard ports.",
		remoteHost: "Remote host",
		remoteDeployHint:
			"Once installed, frpc's server address follows the selected host's IP automatically and the token matches the Local frps tab; restart frpc to connect.",
		hostLibEmpty: "(host library empty — add a host in Remote Workbench first)",
		hostOption: "{name} ({user}@{host}:{port})",
		useThisHost: "Use this host",
		probe: "Test reachability",
		copyScript: "Copy deploy script",
		deploy: "Install over SSH",
		remoteCurrent: "Current remote config: bindPort {bindPort} / token ",
		tokenSet: "set.",
		tokenUnset: "<b>not set (set it on the Local frps tab first)</b>.",
		scriptCopied: "Deploy script copied — paste it into a root shell on the remote host",
		copyFailed: "Copy failed; use Install over SSH or try again",
		installing: "Downloading and installing (GitHub release, about 10-20MB)…",
		installed: "Installed {version}",
		deleteProxyAsk: "Delete proxy {name}?",

		// Logs
		logsFrpc: "frpc logs",
		logsFrps: "frps logs",
		logsEmpty: "(no logs yet)",

		// Header
		title: "🚇 FRP Tunnel",
		subtitle: "frpc proxy list · local frps testing · one-click remote deploy",
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
