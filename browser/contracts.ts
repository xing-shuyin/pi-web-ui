import type { ServerMessage } from "../server/protocol.js";

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
	| "navigate"
	| "back"
	| "forward"
	| "reload"
	/** 开发工具开关：网站出问题（验证码不通过、脚本报错）时用户能自己看控制台 */
	| "devtools.toggle"
	| "mode"
	| "splitRatio"
	| "agent.connect"
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
