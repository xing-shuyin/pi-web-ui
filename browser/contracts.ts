import type { KernelInstallKind, ServerMessage } from "../server/protocol.js";

/** 安装形态是内核报的（`/api/health` 的 `kernel.installKind`），形状单源在 server/protocol.ts。 */
export type { KernelInstallKind };

export type BrowserPageRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "type" | "id">;
export type BrowserPageResult = { ok: true; result?: unknown } | { ok: false; error: string };
export type BrowserMode = "browser" | "agent" | "split";

/**
 * 内置浏览器扩展所在的 session 标识。
 *
 * Electron 的 session 由 `session.fromPath()` 建立，没有 partition 字符串，但
 * `electron-chrome-extensions` 的 `<browser-action-list>` 与 `crx://` 协议都用 partition 名
 * 反查 session。这里给浏览器 session 一个稳定名字，桌面主进程用
 * `setSessionPartitionResolver()` 把它映射回真实 session，shell 页用同一个常量当属性值。
 */
export const BROWSER_EXTENSION_PARTITION = "pi-browser";

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	internal: boolean;
	/** 站点图标（http(s) 或 data:image）；没拿到就不带，渲染层回退地球图标。 */
	favicon?: string;
}

export interface BrowserState {
	mode: BrowserMode;
	splitRatio: number;
	activeTabId: string | null;
	tabs: BrowserTab[];
	agentUrl: string;
	agentReady: boolean;
	agentError?: string;
	/** 内核状态：这个地址上跑的是谁、关掉壳之后还在不在（见 docs/architecture-kernel.md）。 */
	kernel?: BrowserKernelState;
	/**
	 * 本机没有任何可用内核（纯壳包首次启动就是这样）：覆盖层据此弹「安装内核 / 安装 Node / 重试」。
	 * 与 `agentError` 的区别：后者可能是“内核在、但挂了”；这个专门表示“还没有内核可跑”。
	 */
	kernelMissing?: { nodeOk: boolean; nodeVersion: string | null; platform: string };
	/**
	 * 内核在跑、但装包不完整（最常见：缺 `web/dist/index.html`，页面只能回一张 503 诊断页）。
	 * 它是“已连上的内核需要修”而不是“没有内核”，所以不能塞进 `kernelMissing`；
	 * 覆盖层看到它就必须保留并给出修复/重试/退出出口，不能把内核的错误页当成正常界面收起自己。
	 */
	kernelRepair?: { message: string };
}

/**
 * 内核（唯一的 pi-web-ui 服务进程）在壳里的视图。
 * 判定与文案都在 `desktop/kernel-mode.ts`；这里只定义跨层形状。
 */
export interface BrowserKernelState {
	mode: "external" | "local";
	reason: "external-reachable" | "no-external-configured" | "external-unreachable";
	url: string;
	reachable: boolean;
	version?: string;
	installKind?: KernelInstallKind;
	supervisor: string | null;
	/** 托管者注册的服务名（launchd label / systemd unit / Windows 看门狗名）。 */
	serviceName?: string | null;
	uptimeMs?: number;
	/** 内核要求的最低壳能力版本（`SHELL_CAPABILITY_VERSION` 对比用，见 version-gate）。 */
	minShell?: number;
	/** 内核上报的协议版本（`/api/health.kernel.protocol`）。 */
	protocol?: number;
	/**
	 * 内核自己的界面资源是否齐全（`/api/health.web`）：`ok` 才代表页面能打开。
	 * 老内核不上报这个字段 → undefined，一律当作可用（不能因为缺少新字段就报错）。
	 */
	webBuild?: "ok" | "missing";
	/**
	 * 壳 ↔ 内核的兼容结论（`desktop/kernel-compat.ts` 判定，渲染层只展示不重算）。
	 * 纯壳包里这两者本是两个独立安装物，不匹配是常态而不是异常，所以必须能就地说出“该升级哪一边”。
	 */
	compat?: { kind: "ok" | "upgrade-kernel" | "upgrade-shell" | "unknown-kernel"; message: string };
	error?: string;
}

/**
 * 内核环境（面板的“环境检测”区）：node 够不够、全局包能不能升、服务配置装没装。
 * 判定与命令生成都在 `desktop/kernel-env.ts` / `desktop/kernel-upgrade.ts`，这里只定义跨层形状。
 */
export interface KernelEnvironmentView {
	node: { ok: boolean; version: string };
	global: { installed: boolean; version?: string; latest?: string; upgradeCommand: string; canUpgrade: boolean };
	service: { state: "installed" | "absent" | "unknown" };
	/** 缺 node 时给用户的命令（GUI 里不硬跑的平台只给这条）。 */
	nodeInstall: { command: string; url: string; canRun: boolean };
}

/**
 * 外壳面板名单：宿主校验 `panel` 请求、渲染层 `Panel` 类型都取自这里。
 * 每个面板在自己的一块浮层视图里渲染（`panel.html`），页面在它周围照常可见。
 */
export const BROWSER_PANELS = ["bookmarks", "history", "settings", "downloads", "extensions", "vault"] as const;
export type BrowserPanel = (typeof BROWSER_PANELS)[number];

/** 面板要告诉其他视图的改动：面板在自己的视图里，`window` 事件跨不过去，由宿主转发。 */
export const BROWSER_PANEL_EVENTS = [
	"pb-bookmarks-changed",
	"pb-settings-changed",
	"pb-extensions-changed",
	"pb-vault-changed",
] as const;
export type BrowserPanelEvent = (typeof BROWSER_PANEL_EVENTS)[number];

/**
 * 可自定义的浏览器资产：`newtab` 是新标签页 HTML（自包含），`theme` 是覆盖 CSS。
 * 存储只有一份事实源 `browser/runtime/customize.ts`，这里只定形状。
 */
export const BROWSER_DESIGN_KINDS = ["newtab", "theme"] as const;
export type BrowserDesignKind = (typeof BROWSER_DESIGN_KINDS)[number];

export interface BrowserDesignStatus {
	kind: BrowserDesignKind;
	/** 文件名：newtab.html / theme.css */
	file: string;
	/** 绝对路径：想用编辑器手改时照这个找 */
	path: string;
	/** 用户是否已经写了自定义版本（false = 用内置默认） */
	custom: boolean;
	bytes: number;
	updatedAt?: number;
	maxBytes: number;
}

export interface BrowserDesignDocument {
	status: BrowserDesignStatus;
	content: string;
	/** 内容来自内置起步模板（还没写过自定义版本） */
	starter: boolean;
}

export interface BrowserHostBridge {
	version: 1;
	pageCall(request: BrowserPageRequest): Promise<BrowserPageResult>;
}

export type BrowserShellAction =
	| "state"
	/**
	 * 要键盘焦点：内部页（新标签页的搜索框）加载完请宿主把焦点交给自己的视图。
	 * 宿主只接受「发送方就是当前活动标签」的请求，Agent 模式 / 地址浮层开着时不抢。
	 */
	| "focus"
	| "overlay"
	/** 面板浮层：`{ open, panel }` 开/收起，`{ size }` 由面板页回煲自己要多大的矩形 */
	| "panel"
	| "downloads.list"
	/** 自定义新标签页 / 主题：status 列状态，get 取正文，save 写入，reset 回到内置默认 */
	| "design.status"
	| "design.get"
	| "design.save"
	| "design.reset"
	| "extensions.list"
	| "extensions.load"
	| "extensions.installCrx"
	| "extensions.toggle"
	| "extensions.remove"
	| "extensions.reload"
	| "extensions.openPopup"
	| "extensions.openOptions"
	| "extensions.menu"
	| "tabs.create"
	| "tabs.activate"
	| "tabs.close"
	/** 标签页右键菜单（原生）：`{ id, x, y }`，菜单里可选「引用到输入框」等 */
	| "tabs.menu"
	/** 页面级动作：在活动标签页里跑一段固定脚本（翻译开关 / 整页 Markdown） */
	| "page.translate"
	/** 读一次页面翻译状态（进度/完成），外壳拿它给按钮做反馈 */
	| "page.translateState"
	| "page.markdown"
	| "navigate"
	| "back"
	| "forward"
	| "reload"
	/** 开发工具开关：网站出问题（验证码不通过、脚本报错）时用户能自己看控制台 */
	| "devtools.toggle"
	| "mode"
	| "splitRatio"
	| "agent.connect"
	/** 内核（唯一服务进程）：查状态、一键装为系统服务、重启（见 docs/architecture-kernel.md） */
	| "kernel.status"
	| "kernel.install"
	| "kernel.restart"
	/** 内核环境：node 装没装、全局包版本与可升级性、服务配置状态 */
	| "kernel.env"
	| "kernel.upgrade"
	| "kernel.installNode"
	| "bookmarks.list"
	| "bookmarks.save"
	/** 从别的浏览器导出的书签文件导入：宿主自己开原生选文件对话框、读盘、解析再合并，回执只有条数 */
	| "bookmarks.import"
	| "history.list"
	| "settings.get"
	| "settings.save"
	| "files.open"
	| "files.read"
	| "files.save"
	| "files.external"
	/** 密码库：`passwords.list` 只下发投影（无明文密码），明文要按 id 走 `passwords.reveal` */
	| "passwords.list"
	| "passwords.save"
	| "passwords.available"
	| "passwords.fill"
	| "passwords.reveal"
	| "passwords.upsert"
	| "passwords.remove"
	/** 从 CSV 导出文件导入：宿主自己开原生选文件对话框，明文不进渲染层 */
	| "passwords.import"
	/** Passkey 保管库：私钥永不下发渲染层，面板只看得到投影（`PublicPasskey`） */
	| "passkeys.list"
	| "passkeys.remove"
	/** TOTP 保管库：secret 永不出主进程，渲染层只要 6 位码（`totp.code`） */
	| "totp.available"
	| "totp.list"
	| "totp.scan"
	| "totp.importImage"
	| "totp.add"
	| "totp.update"
	| "totp.reorder"
	| "totp.remove"
	| "totp.code"
	| "totp.export"
	| "totp.fill"
	| "data.import"
	| "scripts.list"
	| "scripts.toggle"
	| "scripts.remove"
	| "download.open"
	/** 在系统文件管理器里定位已完成下载（只传 id，路径由主进程解析，不执行文件） */
	| "download.reveal";
