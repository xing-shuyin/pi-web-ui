/**
 * 宿主 UI 扩展点（issue #146）的**前端纯函数引擎**——把「宿主默认 + 插件声明 +
 * 插件整理意图 + 用户偏好」四层合并成每个挂载点（slot）最终要渲染的条目列表。
 *
 * 为什么要有这么一层：
 *   - 插件只**声明**（`UiPluginInfo.ui.items`）与**整理**（`ui.arrange`），宿主负责渲染、
 *     排序、溢出与可访问性；插件永远不碰 DOM，也不关心自己排在第几个。
 *   - 合并结果被两处消费：真正的渲染层（TopBar / 底栏 / 右键菜单 …）与设置面板的
 *     「界面布局」页。两边跑同一个纯函数 → 「设置里看到的顺序/分组/文案 == 界面上看到的」，
 *     这是 issue #146 的核心不变量（与 plugin-topbar.ts 同口径）。
 *   - 纯函数 + 无副作用：同输入必同输出，便于单测穷举优先级与审计字段。
 *
 * 合并优先级（**从低到高**，高层覆盖低层；单测逐层覆盖）：
 *   1. 宿主默认（BUILTIN_UI_ITEMS 的可见性/顺序/分组/文案）
 *   2. 插件贡献（同 id 后出现的插件覆盖前面的；报错 / 被整体禁用的插件整份丢弃）
 *   3. 插件 arrange（按 plugins 数组顺序逐个应用；只能改**已存在**的条目；改的是别人的
 *      条目时记进该条目的 arrangedBy —— 那是布局页向用户解释「这东西为什么被挪走了」的依据）
 *   4. 用户偏好（最高：用户手动点过什么，就永远是最后说话的那个）
 *   5. 同 order / 无排序信息时保持声明顺序（稳定排序：用声明序号 seq 兜底）
 *
 * 只依赖类型（`./types` 是 server/protocol.ts 的 type-only shim），不 import React /
 * 组件 / 任何运行时代码 —— 因此它既能在浏览器里跑，也能被 vitest 直接单测。
 */
import type {
	UiAlign,
	UiArrangeOp,
	UiContribution,
	UiItemKind,
	UiLayoutPrefs,
	UiPluginInfo,
	UiSelectOption,
	UiSlotId,
} from "./types";

/** 宿主内置条目（宿主的既有入口；插件可经 arrange 整理，用户可经偏好覆盖）。 */
export interface BuiltinUiItem {
	/** 全局 id，形如 `host:settings`（用户偏好与 arrange 的 key 就是它）。 */
	id: string;
	slot: UiSlotId;
	/**
	 * i18n key（必须存在于 web/src/i18n.tsx 的 zh 表里；有单测锁住这一点）。
	 * 注意：带 `{n}` 这类占位符的 key，渲染层要用 labelKey 自己再 t() 一次补参
	 * （本模块收到的 `t` 只做无参翻译，塞不进参数，例如 dismissFinishedSubagents）。
	 */
	labelKey: string;
	/** 宿主图标名（渲染层映射到 react-icons，取值见文件末尾的图标词表）。 */
	icon?: string;
	kind: UiItemKind;
	/** 排序权重（缺省 100，小的靠前）。 */
	order?: number;
	/** 分组标签（同组连续排布并加分隔线）。 */
	group?: string;
	/** 缺省 false：内置入口默认都可见。 */
	hidden?: boolean;
	/** 对齐组（缺省 start；bottombar 用它分左右区，见 FooterBar）。 */
	align?: UiAlign;
	/** kind="view" 时的目标视图（"chat" | "terminal" | "git" | `plugin:<id>`）。 */
	view?: string;
	/**
	 * contextmenu.* 槽位用：这条操作作用在什么上下文对象上（消息/会话/文件/顶栏条目）。
	 * 渲染层其实按槽位就知道上下文了 —— 这里留着是为了让「内置条目表」自身可读，
	 * 也方便布局页把四处右键菜单的条目按 context 分组展示。
	 */
	context?: "message" | "session" | "file" | "topbar";
}

/** 全部挂载点（顺序 = 结果对象的 key 顺序，渲染层/布局页可以按固定次序遍历）。
 *  顺序严格按实际界面的 DOM/视觉顺序（与设置面板「界面布局」页的分区顺序同一张表）：
 *  顶栏 → 通知 → 左栏 → 主列（头部/空态/消息/目标条/输入框） → 右栏 → 终端/Git 视图 →
 *  底栏 → 悬浮层（文件预览）→ 右键菜单（按触发位置：顶栏/消息/会话/文件）→ 设置页 → 对话框。
 */
const SLOT_IDS: UiSlotId[] = [
	"topbar.primary",
	"topbar.overflow",
	"notice.actions",
	"leftpanel.sessions",
	"chat.header",
	"chat.empty",
	"message.actions",
	"goalbar.actions",
	"composer.leading",
	"composer.actions",
	"rightpanel.tabs",
	"terminal.toolbar",
	"scm.toolbar",
	"bottombar",
	"file.preview.toolbar",
	"contextmenu.topbar",
	"contextmenu.message",
	"contextmenu.session",
	"contextmenu.file",
	"settings.pages",
	"modal.dialog",
];

/**
 * 宿主内置条目 —— **逐项对应代码里真实存在的入口**（不臆造）：
 *
 *   topbar.primary   web/src/components/TopBar.tsx：品牌（π 标识＋名称合一） /
 *                    ☰ openHistory / 📁 openFiles / ＋ newChat /
 *                    视图开关三连（chat·terminal·git，缺省 align=end）/ 搜索 / 浏览器操作 /
 *                    后台任务 / 设置 / 声音 / 语言 / 主题 / 版本（更新）/ GitHub。
 *                    **完全扁平**：所有条目是 `.topbar-flow` 的直接子节点，同级、无任何
 *                    按种类包裹的容器（不再有 .brand / .view-switch / .topbar-desktop 三件套，
 *                    也不再有两端贴边的例外）：宿主条目查节点工厂、插件条目通用渲染，
 *                    align 只决定它落在**两个 spacer 划出的三段**（start/center/end）里的哪一段
 *                    （见 TopBar 的 renderFlow + styles.css 的 .tb-spacer）。
 *                    可见性/顺序/对齐/文案对**每一个**条目都生效（布局页勾选框、↑↓、align），
 *                    插件视图 tab 由 withPluginViewItems 合成 kind="view" 条目后同流渲染。
 *                    桌面与手机渲染同一份 slot 数据：宽度放不下的条目按视觉顺序从尾部退到
 *                    「⋯」溢出菜单（web/src/topbar-fit.ts 的纯函数，ResizeObserver 实测宽度），
 *                    被隐藏的条目也落进同一个菜单（菜单型条目整块搬过去），点回仍可用。
 *                    本实例没有独立的「MCP 入口」（MCP 是设置面板里的一页），故不编造。
 *   bottombar        web/src/components/FooterBar.tsx：连接状态、引擎徽标、上下文、成本、
 *                    缓存、消息数、插件状态、工作中、工作目录。**全部按本表顺序从
 *                    `bottombarItems` 渲染**（隐藏 / ↑↓ 调序都真的生效）；引擎徽标 / 插件状态 /
 *                    工作中这几条另带运行时条件，条件不满足时连分隔符一起不画。
 *   message.actions  web/src/components/Message.tsx 的 `.msg-actions`（编辑重问）与
 *                    卡片内复制按钮（复制消息）。
 *   rightpanel.tabs  web/src/components/RightPanel.tsx：今天只有文件树一个 tab
 *                    （tab 列表按本表顺序渲染：隐藏 / 调序都生效）。
 *   contextmenu.session  LeftPanel.tsx 的 `.ctx-menu`：关闭已结束子代理 / 强行关闭对话。
 *   contextmenu.file     RightPanel.tsx 的 `.ctx-menu`：上传到文件夹 / 以项目打开 /
 *                    添加为工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。
 *   contextmenu.message 与 contextmenu.topbar：右键菜单（Message.tsx 整条消息右键 /
 *                    TopBar.tsx 顶栏条目右键，经 ContextMenu.tsx 渲染；无插件贡献时只画宿主项）。
 *   composer.actions 输入框动作区（ChatInput.tsx 的 .composer-tools）：上传 / 模板库 /
 *                    模型 / 思考强度 / DSH 权限 / DSH 预设 / 发送簇，全部是宿主内置条目
 *                    （align=start，发送簇 align=end），与插件贡献的动作按同一顺序统一渲染。
 *                    隐藏只藏按钮（回车仍可发送）；发送簇藏掉后运行中的停止键一起消失，
 *                    需要停止时从布局页恢复。composer.leading 仍是纯插件位（无内置条目），
 *                    渲染在上传按钮左侧。
 *   settings.pages   不列内置（按契约：这一槽位是插件专属）。
 *   v8 新增槽位：file.preview.toolbar / leftpanel.sessions / terminal.toolbar /
 *                    scm.toolbar / goalbar.actions 均已登记宿主条目（见下表），与插件贡献
 *                    按同一顺序统一渲染；chat.header / chat.empty / notice.actions 仍是
 *                    纯插件新增位（宁缺勿造），无插件贡献时渲染层返回 null、不渲染，
 *                    DOM 与旧版一字不差。渲染位置：chat.header 在 App 主列顶部、
 *                    chat.empty 在 MessageList 空态区（EmptyTemplateCards 之后）、
 *                    file.preview.toolbar 在 FilePreview 的 .fp-head-actions 尾部。
 */
export const BUILTIN_UI_ITEMS: BuiltinUiItem[] = [
	// ---- 品牌（左上角 π 标识与名称合一） ----
	// kind=badge：纯展示，无动作。单一条目承载整个品牌块（渲染层见 TopBar 的 host:brand），
	// 对齐/隐藏/改名/调序全部直通 —— 不再有「名称的 align 存而不用」的双 id 包袱。
	// TABS 白名单不管品牌（渲染层不用 tabOn 判断它）。
	{
		id: "host:brand",
		slot: "topbar.primary",
		labelKey: "brand",
		kind: "badge",
		order: 1,
		group: "brand",
	},
	// 「打开项目」：品牌之后的第一个动作按钮（缺省落顶栏左区，手机端在 ☰ / π 之后）。
	// 点开的是与左栏 📁+ 同一个项目选择器（浏览磁盘目录 / 选当前目录 / ＋新建项目后切过去）——
	// 宿主实现留在拥有它的组件内（TopBar 的 hostNodes，`host:*` 的惯例）。
	{
		id: "host:open-project",
		slot: "topbar.primary",
		labelKey: "openProject",
		icon: "folder",
		kind: "action",
		order: 3,
		group: "primary",
	},
	// ---- 顶栏主栏 ----
	// 「面板开关 / 主操作」组在前：它们是随时可点的动作，不参与视图切换的高亮语义。
	// 顺序号即默认视觉顺序（渲染层按 slot 顺序直排）：history 在最前（手机端 ☰ 落在最左）、
	// files 在最后（手机端 📁 落在最右），两者都只是**缺省**位置 —— align/顺序全部可改。
	// 注意：手机端（≤768px）☰/📁 才有宽度（桌面端由 CSS 藏起，靠面板折叠按钮顶替），
	// 宽度为 0 的条目不参与溢出计算（既不会被丢进「⋯」，也不占位）。
	{
		id: "host:history",
		slot: "topbar.primary",
		labelKey: "openHistory",
		icon: "menu",
		kind: "action",
		order: 0,
		group: "panels",
		// 缺省落左区之首要位置（start）：手机端 ☰ 就是顶栏最左一个按钮。
	},

	{
		id: "host:files",
		slot: "topbar.primary",
		labelKey: "openFiles",
		icon: "folder",
		kind: "action",
		order: 97,
		group: "panels",
		// 缺省落右区之尾（end）：手机端 📁 是顶栏最右一个按钮（⋯ 之前）。
		align: "end",
	},
	{
		id: "host:new-chat",
		slot: "topbar.primary",
		labelKey: "newChat",
		icon: "plus",
		kind: "action",
		order: 96,
		group: "primary",
		// 缺省落右区工具组之尾；位置完全由 slot 顺序定（旧版 pin-tail 语义的数据化），用户 ↑↓ 可调。
		align: "end",
	},
	// 视图切换三连：同组 + 连号权重 → 顺序就是 TopBar 里 tab 的顺序（chat/terminal/git）。
	{
		id: "host:chat",
		slot: "topbar.primary",
		labelKey: "chat",
		icon: "chat",
		kind: "view",
		view: "chat",
		order: 20,
		group: "views",
		align: "end",
	},
	{
		id: "host:terminal",
		slot: "topbar.primary",
		labelKey: "terminal",
		icon: "terminal",
		kind: "view",
		view: "terminal",
		order: 21,
		group: "views",
		align: "end",
	},
	{
		id: "host:git",
		slot: "topbar.primary",
		labelKey: "scmTab",
		icon: "git",
		kind: "view",
		view: "git",
		order: 22,
		group: "views",
		align: "end",
	},
	// 插件面板（Chrome 扩展图标那个位置）：一个 🧩 入口列出全部已装插件，每行带「钉到顶栏」
	// 开关。插件视图 tab 默认不钉（合成条目 hidden，见 withPluginViewItems），钉住的才回到
	// 这里当 tab（order 23，紧跟本条目之前）。图标用 emoji 而不是词表名：词表名会被布局页
	// 原样当文字画出来（见 ui-slots 末尾的图标词表注释）。
	{
		id: "host:plugins",
		slot: "topbar.primary",
		labelKey: "pluginMenuTitle",
		icon: "🧩",
		kind: "action",
		order: 24,
		group: "views",
		align: "end",
	},
	// 工具组：全局搜索 / 浏览器操作 / 后台任务（后台任务的角标数由运行时给 badge）。
	{
		id: "host:search",
		slot: "topbar.primary",
		labelKey: "searchGlobal",
		icon: "search",
		kind: "action",
		order: 40,
		group: "tools",
		align: "end",
	},
	{
		id: "host:browser",
		slot: "topbar.primary",
		labelKey: "browserControl",
		icon: "browser",
		kind: "action",
		order: 41,
		group: "tools",
		align: "end",
		// 缺省收进「⋯」：只有装了 page-picker 扩展、真要用模型看页面的人才需要它
		hidden: true,
	},
	{
		id: "host:tasks",
		slot: "topbar.primary",
		labelKey: "bgTasks",
		icon: "layers",
		kind: "action",
		order: 42,
		group: "tools",
		align: "end",
	},
	// 系统组：设置 → 声音/通知 → 语言 → 主题 → 版本（更新）→ GitHub。
	//
	// 缺省收起口径（hidden: true）：低频 / 有替代入口的条目缺省落进顶栏「⋯」溢出菜单。
	// 这不是「消失」—— App.tsx 的 uiOverflow 会把 hidden 的 topbar.primary 条目当成常驻溢出项
	// 塞进那个菜单，且声音/语言/主题/版本/浏览器操作在菜单里是**整块搬组件**
	// （TopBar 的 OVERFLOW_AS_NODE_IDS），下拉/面板/更新红点一个不少；用户随时能在
	// 设置 → 界面布局里勾回来。对比之下 CSS display:none 才是真删（宽度 0 不参与实测溢出，
	// 也不进菜单，见 topbar-fit.ts），所以别用 CSS 做这件事。
	// 常驻只留「切视图 / 起新活 / 看运行态 / 进设置」四类：实测溢出丢的是**尾部**，
	// 常驻项越多，核心动作越容易被挤进 ⋯。
	{
		id: "host:settings",
		slot: "topbar.primary",
		labelKey: "settingsTitle",
		icon: "settings",
		kind: "action",
		order: 60,
		group: "system",
		align: "end",
	},
	{
		id: "host:sound",
		slot: "topbar.primary",
		labelKey: "sound",
		icon: "sound",
		kind: "action",
		order: 70,
		group: "system",
		// 低频（设一次就不动），且菜单里是完整的声音/通知面板
		hidden: true,
		align: "end",
	},
	{
		id: "host:language",
		slot: "topbar.primary",
		labelKey: "language",
		icon: "globe",
		kind: "action",
		order: 80,
		group: "system",
		// 设一次语言就不再动的条目；菜单里是完整的下拉（含「获取更多语言」）
		hidden: true,
		align: "end",
	},
	{
		id: "host:theme",
		slot: "topbar.primary",
		labelKey: "theme",
		icon: "sun",
		kind: "action",
		order: 82,
		group: "system",
		// 同上：低频；菜单里是完整的主题下拉
		hidden: true,
		align: "end",
	},
	{
		id: "host:update",
		slot: "topbar.primary",
		labelKey: "update",
		icon: "download",
		kind: "action",
		order: 90,
		group: "system",
		align: "end",
		// 展示型（版本号 + 更新红点）：缺省收进「⋯」，菜单里仍是完整下拉（红点也一起过去）
		hidden: true,
	},
	// GitHub 外链：缺省收起 + 排在**尾部**（order 取最大）。两件事配合起来才对：
	//   · hidden: true  —— 缺省落在「⋯」里；
	//   · order: 200    —— 万一用户把它勾回顶栏常驻，它是被实测溢出**最先**收走的那个
	//                     （web/src/topbar-fit.ts 按视觉顺序从尾部丢），而不是反过来。
	// 别把它调回 95：那时尾部实际是「新对话(96)」，窄屏会先把核心动作「新对话」收进 ⋯
	//（顺序即丢弃顺序，这是设计上刻意的单一口径）。理由：纯外链、零上下文价值。
	{
		id: "host:github",
		slot: "topbar.primary",
		labelKey: "githubRepo",
		icon: "github",
		kind: "action",
		order: 200,
		group: "system",
		align: "end",
		hidden: true,
	},

	// ---- 底栏（基本都是「展示型」条目 kind="badge"；只有工作目录可点） ----
	{ id: "host:conn", slot: "bottombar", labelKey: "connected", icon: "dot", kind: "badge", order: 5, group: "status" },
	{
		id: "host:engine",
		slot: "bottombar",
		labelKey: "engineBadge",
		icon: "cpu",
		kind: "badge",
		order: 6,
		group: "status",
	},
	{ id: "host:ctx", slot: "bottombar", labelKey: "context", icon: "gauge", kind: "badge", order: 10, group: "usage" },
	{
		id: "host:cost",
		slot: "bottombar",
		labelKey: "cumulativeCost",
		icon: "coins",
		kind: "badge",
		order: 11,
		group: "usage",
	},
	{
		id: "host:cache",
		slot: "bottombar",
		labelKey: "cacheHit",
		icon: "database",
		kind: "badge",
		order: 12,
		group: "usage",
	},
	{
		id: "host:msg-count",
		slot: "bottombar",
		labelKey: "messages",
		icon: "message",
		kind: "badge",
		order: 13,
		group: "usage",
	},
	{
		id: "host:plugin-status",
		slot: "bottombar",
		labelKey: "pluginStatus",
		icon: "activity",
		kind: "badge",
		order: 14,
		group: "status",
	},
	{
		id: "host:working",
		slot: "bottombar",
		labelKey: "working",
		icon: "activity",
		kind: "badge",
		order: 15,
		group: "status",
	},
	{
		id: "host:host-metrics",
		slot: "bottombar",
		labelKey: "hostResources",
		icon: "cpu",
		kind: "badge",
		order: 19,
		group: "host",
		// 右区：与 host:cwd 一起落右栏（FooterBar 按 align 分区，不再按 id 硬编码）。
		align: "end",
	},
	{
		id: "host:cwd",
		slot: "bottombar",
		labelKey: "cwdTip",
		icon: "folder",
		kind: "action",
		order: 20,
		group: "context",
		// 右区：与 host:host-metrics 一起落右栏（FooterBar 按 align 分区，不再按 id 硬编码）。
		align: "end",
	},

	// ---- 消息 hover 工具条（Message.tsx 的 .msg-actions / 卡片复制按钮） ----
	{
		id: "host:msg-edit-reask",
		slot: "message.actions",
		labelKey: "editReask",
		icon: "edit",
		kind: "action",
		order: 10,
	},
	{ id: "host:msg-copy", slot: "message.actions", labelKey: "copyMessage", icon: "copy", kind: "action", order: 20 },
	// 整条消息一键复制三件套（issue #228）：纯文本 / Markdown 原文 / 长图 PNG。
	// 落点在消息 hover 工具条（Message.tsx 内置处理），与按块复制的 host:msg-copy 并存。
	{ id: "host:msg-copy-text", slot: "message.actions", labelKey: "copyText", icon: "text", kind: "action", order: 21 },
	{
		id: "host:msg-copy-markdown",
		slot: "message.actions",
		labelKey: "copyMarkdown",
		icon: "markdown",
		kind: "action",
		order: 22,
	},
	{
		id: "host:msg-copy-image",
		slot: "message.actions",
		labelKey: "copyImage",
		icon: "image",
		kind: "action",
		order: 23,
	},

	// ---- 输入框动作区（ChatInput.tsx 的 .composer-tools；顺序与可见性全部数据驱动） ----
	// 权重给插件默认位（100）让路：无 order 的插件动作按 100 落在上传(10)之后、
	// 模板(110)之前 —— 与旧硬编码顺序（上传 → 插件start → 模板 → 模型 → 思考）一致，
	// 老插件按钮位置不动。发送簇 align=end 落右侧，权重 200 保证它在插件 end 动作之后。
	{
		id: "host:composer-upload",
		slot: "composer.actions",
		labelKey: "uploadFile",
		icon: "upload",
		kind: "action",
		order: 10,
		align: "start",
	},
	{
		id: "host:composer-templates",
		slot: "composer.actions",
		labelKey: "tpl.openPicker",
		icon: "grid",
		kind: "action",
		order: 110,
		align: "start",
	},
	{
		id: "host:composer-model",
		slot: "composer.actions",
		labelKey: "selectModel",
		icon: "cpu",
		kind: "action",
		order: 120,
		align: "start",
	},
	{
		id: "host:composer-thinking",
		slot: "composer.actions",
		labelKey: "thinkingLevel",
		icon: "zap",
		kind: "action",
		order: 130,
		align: "start",
	},
	{
		id: "host:composer-dsh-perm",
		slot: "composer.actions",
		labelKey: "dshPerm",
		icon: "lock",
		kind: "action",
		order: 140,
		align: "start",
	},
	{
		id: "host:composer-dsh-preset",
		slot: "composer.actions",
		labelKey: "dshPreset",
		icon: "layers",
		kind: "action",
		order: 150,
		align: "start",
	},
	{
		id: "host:composer-send",
		slot: "composer.actions",
		labelKey: "sendTip",
		icon: "send",
		kind: "action",
		order: 200,
		align: "end",
	},

	// ---- 文件预览头栏（FilePreview.tsx 的 .fp-head-actions；单个容器，顺序全生效） ----
	// 权重 10-90，插件默认位（100）落在关闭之后 —— 与旧硬编码顺序一致。
	{
		id: "host:fp-md",
		slot: "file.preview.toolbar",
		labelKey: "showMarkdownPreview",
		icon: "eye",
		kind: "action",
		order: 10,
	},
	{
		id: "host:fp-html",
		slot: "file.preview.toolbar",
		labelKey: "showHtmlPreview",
		icon: "code",
		kind: "action",
		order: 20,
	},
	{ id: "host:fp-edit", slot: "file.preview.toolbar", labelKey: "editFile", icon: "edit", kind: "action", order: 30 },
	{ id: "host:fp-wrap", slot: "file.preview.toolbar", labelKey: "enableWrap", icon: "wrap", kind: "action", order: 40 },
	{ id: "host:fp-zoom", slot: "file.preview.toolbar", labelKey: "zoomIn", icon: "zoom", kind: "action", order: 50 },
	{
		id: "host:fp-inline",
		slot: "file.preview.toolbar",
		labelKey: "attachInlineTip",
		icon: "plus",
		kind: "action",
		order: 60,
	},
	{
		id: "host:fp-ref",
		slot: "file.preview.toolbar",
		labelKey: "referenceTip",
		icon: "link",
		kind: "action",
		order: 70,
	},
	{
		id: "host:fp-full",
		slot: "file.preview.toolbar",
		labelKey: "fullscreen",
		icon: "maximize",
		kind: "action",
		order: 80,
	},
	{ id: "host:fp-close", slot: "file.preview.toolbar", labelKey: "close", icon: "x", kind: "action", order: 90 },

	// ---- 目标条（GoalBar.tsx：编辑行 / 选项行 / 活跃行 / 收起 pill 四处按簇分别排序） ----
	{ id: "host:goal-pill", slot: "goalbar.actions", labelKey: "goalBarTitle", icon: "target", kind: "action", order: 5 },
	{ id: "host:goal-set", slot: "goalbar.actions", labelKey: "goalBarSet", icon: "check", kind: "action", order: 10 },
	{
		id: "host:goal-wizard",
		slot: "goalbar.actions",
		labelKey: "goalWizardBtn",
		icon: "search",
		kind: "action",
		order: 20,
	},
	{ id: "host:goal-lock", slot: "goalbar.actions", labelKey: "goalBarLocked", icon: "lock", kind: "action", order: 30 },
	{
		id: "host:goal-collapse",
		slot: "goalbar.actions",
		labelKey: "collapsePanel",
		icon: "chevron-up",
		kind: "action",
		order: 40,
	},
	{
		id: "host:goal-model",
		slot: "goalbar.actions",
		labelKey: "goalBarReviewModel",
		icon: "cpu",
		kind: "action",
		order: 50,
	},
	{
		id: "host:goal-rounds",
		slot: "goalbar.actions",
		labelKey: "goalBarMaxRounds",
		icon: "hash",
		kind: "action",
		order: 60,
	},
	{ id: "host:goal-clear", slot: "goalbar.actions", labelKey: "goalBarClear", icon: "x", kind: "action", order: 70 },

	// ---- SCM（SCMPanel.tsx：头栏簇 + 分支行簇分别排序，插件条目落头栏） ----
	{ id: "host:scm-changes", slot: "scm.toolbar", labelKey: "scmChanges", icon: "file", kind: "action", order: 10 },
	{ id: "host:scm-history", slot: "scm.toolbar", labelKey: "scmHistory", icon: "clock", kind: "action", order: 20 },
	{
		id: "host:scm-refresh",
		slot: "scm.toolbar",
		labelKey: "scmRefreshTip",
		icon: "refresh",
		kind: "action",
		order: 30,
	},
	{ id: "host:scm-branch", slot: "scm.toolbar", labelKey: "scmSwitchBranch", icon: "git", kind: "action", order: 40 },
	{ id: "host:scm-switch", slot: "scm.toolbar", labelKey: "scmSwitch", icon: "git", kind: "action", order: 50 },
	{ id: "host:scm-push", slot: "scm.toolbar", labelKey: "scmPush", icon: "upload", kind: "action", order: 60 },
	{ id: "host:scm-pull", slot: "scm.toolbar", labelKey: "scmPull", icon: "download", kind: "action", order: 70 },
	{
		id: "host:scm-input",
		slot: "scm.toolbar",
		labelKey: "scmCommitPlaceholder",
		icon: "edit",
		kind: "action",
		order: 80,
	},
	{ id: "host:scm-genmsg", slot: "scm.toolbar", labelKey: "scmGenMsg", icon: "cpu", kind: "action", order: 85 },
	{ id: "host:scm-commit", slot: "scm.toolbar", labelKey: "scmCommit", icon: "check", kind: "action", order: 90 },
	{
		id: "host:scm-commit-all",
		slot: "scm.toolbar",
		labelKey: "scmCommitAll",
		icon: "check",
		kind: "action",
		order: 100,
	},
	{ id: "host:scm-term", slot: "scm.toolbar", labelKey: "terminal", icon: "terminal", kind: "action", order: 110 },

	// ---- 终端面板头（TerminalPanel.tsx：命令列表头 + 终端 tab 头，插件条目落 tab 头） ----
	{
		id: "host:term-cmd-refresh",
		slot: "terminal.toolbar",
		labelKey: "rerun",
		icon: "refresh",
		kind: "action",
		order: 10,
	},
	{
		id: "host:term-cmd-new",
		slot: "terminal.toolbar",
		labelKey: "newCommand",
		icon: "plus",
		kind: "action",
		order: 20,
	},
	{
		id: "host:term-tab-new",
		slot: "terminal.toolbar",
		labelKey: "newTerminal",
		icon: "plus",
		kind: "action",
		order: 30,
	},

	// ---- 左栏分区（LeftPanel.tsx：三个分区的显隐 + 纵向顺序；会话行内不渲染这三条） ----
	{
		id: "host:lp-projects",
		slot: "leftpanel.sessions",
		labelKey: "recentProjects",
		icon: "folder",
		kind: "action",
		order: 10,
	},
	{
		id: "host:lp-running",
		slot: "leftpanel.sessions",
		labelKey: "runningConversations",
		icon: "activity",
		kind: "action",
		order: 20,
	},
	{
		id: "host:lp-history",
		slot: "leftpanel.sessions",
		labelKey: "historySessions",
		icon: "clock",
		kind: "action",
		order: 30,
	},

	// ---- 右栏 tab（今天只有文件树） ----
	{
		id: "host:right-files",
		slot: "rightpanel.tabs",
		labelKey: "openFiles",
		icon: "folder",
		kind: "view",
		view: "files",
		order: 10,
	},

	// ---- 左栏会话右键菜单 ----
	// 过户：只在“另一处”行出现（owner/convId 标识目标），点后整段对话（含等答复问卷）搬到本页。
	{
		id: "host:conv-takeover",
		slot: "contextmenu.session",
		labelKey: "takeoverConversation",
		icon: "chat",
		kind: "action",
		context: "session",
		order: 5,
	},
	{
		id: "host:conv-dismiss-subagents",
		slot: "contextmenu.session",
		labelKey: "dismissFinishedSubagents",
		icon: "x",
		kind: "action",
		context: "session",
		order: 10,
	},
	{
		id: "host:conv-force-dismiss",
		slot: "contextmenu.session",
		labelKey: "forceDismissConversation",
		icon: "x",
		kind: "action",
		context: "session",
		order: 20,
	},
	// ---- 对话引用（issue：让 AI 看别的对话）----
	// 复制对话 id：运行中对话行才有（历史行是文件 path，没有 conversation id）。
	{
		id: "host:conv-copy-id",
		slot: "contextmenu.session",
		labelKey: "copyConversationId",
		icon: "copy",
		kind: "action",
		context: "session",
		order: 30,
	},
	// 复制会话文件路径：历史行恒有；运行中对话仅落盘的有（inMemory 子代理没有文件）。
	{
		id: "host:conv-copy-path",
		slot: "contextmenu.session",
		labelKey: "copyConversationPath",
		icon: "copy",
		kind: "action",
		context: "session",
		order: 40,
	},
	// 引用到输入框：把该对话加进待发附件（💬 chip），发送后 AI 经 conversation_read 按需读取。
	{
		id: "host:conv-quote",
		slot: "contextmenu.session",
		labelKey: "quoteConversation",
		icon: "chat",
		kind: "action",
		context: "session",
		order: 50,
	},

	// ---- 文件树右键菜单（contextmenu.file，渲染与分派见 RightPanel.tsx）----
	// 按 group 分段：open（打开类）/ new（新建类，目录行与空白处）/ chat（发对话）/
	// edit（改名/副本/剪切）/ clipboard（复制路径等文本类）/ danger（删除）。
	// 哪些 kind（file/dir/list）可见由 RightPanel 按 target.kind 置 hidden ——
	// 这里只管声明，免得「布局页看到的」和「右键弹出来的」跑两套逻辑。
	{
		id: "host:file-open",
		slot: "contextmenu.file",
		labelKey: "fileOpenPreview",
		icon: "open",
		kind: "action",
		context: "file",
		order: 11,
		group: "open",
	},
	{
		id: "host:file-enter",
		slot: "contextmenu.file",
		labelKey: "fileEnterDir",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 12,
		group: "open",
	},
	{
		id: "host:file-download",
		slot: "contextmenu.file",
		labelKey: "downloadFile",
		icon: "download",
		kind: "action",
		context: "file",
		order: 13,
		group: "open",
	},
	{
		id: "host:file-compress",
		slot: "contextmenu.file",
		labelKey: "fileCompress",
		icon: "file",
		kind: "action",
		context: "file",
		order: 16,
		group: "archive",
	},
	{
		id: "host:file-extract",
		slot: "contextmenu.file",
		labelKey: "fileExtract",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 17,
		group: "archive",
	},
	{
		id: "host:file-compress-download",
		slot: "contextmenu.file",
		labelKey: "fileCompressDownload",
		icon: "download",
		kind: "action",
		context: "file",
		order: 18,
		group: "archive",
	},
	{
		id: "host:file-upload-folder",
		slot: "contextmenu.file",
		labelKey: "fileUploadFolder",
		icon: "upload",
		kind: "action",
		context: "file",
		order: 25,
		group: "new",
	},
	{
		id: "host:file-open-project",
		slot: "contextmenu.file",
		labelKey: "openAsProject",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 14,
		group: "open",
	},
	// 多根（宿主侧多根，见 protocol 的 set_workspace_roots）：把某个目录加成
	// 「工作区根」—— 只对目录行可见（渲染层按 target.kind 置灰），已是根/就是主根时不显。
	{
		id: "host:file-add-root",
		slot: "contextmenu.file",
		labelKey: "addWorkspaceRoot",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 15,
		group: "open",
	},
	{
		id: "host:file-reveal",
		slot: "contextmenu.file",
		labelKey: "fileReveal",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 16,
		group: "open",
	},
	{
		id: "host:file-open-default",
		slot: "contextmenu.file",
		labelKey: "fileOpenDefault",
		icon: "open",
		kind: "action",
		context: "file",
		order: 17,
		group: "open",
	},
	{
		id: "host:file-new-file",
		slot: "contextmenu.file",
		labelKey: "fileNewFile",
		icon: "file",
		kind: "action",
		context: "file",
		order: 21,
		group: "new",
	},
	{
		id: "host:file-new-dir",
		slot: "contextmenu.file",
		labelKey: "fileNewDir",
		icon: "folder",
		kind: "action",
		context: "file",
		order: 22,
		group: "new",
	},
	{
		id: "host:file-upload",
		slot: "contextmenu.file",
		labelKey: "uploadToFolder",
		icon: "upload",
		kind: "action",
		context: "file",
		order: 23,
		group: "new",
	},
	{
		id: "host:file-paste",
		slot: "contextmenu.file",
		labelKey: "filePaste",
		icon: "paste",
		kind: "action",
		context: "file",
		order: 24,
		group: "new",
	},
	{
		id: "host:file-attach-inline",
		slot: "contextmenu.file",
		labelKey: "attachInlineTip",
		icon: "plus",
		kind: "action",
		context: "file",
		order: 31,
		group: "chat",
	},
	{
		id: "host:file-attach-ref",
		slot: "contextmenu.file",
		labelKey: "referenceTip",
		icon: "link",
		kind: "action",
		context: "file",
		order: 32,
		group: "chat",
	},
	{
		id: "host:file-attach-folder",
		slot: "contextmenu.file",
		labelKey: "linkFolderTip",
		icon: "link",
		kind: "action",
		context: "file",
		order: 33,
		group: "chat",
	},
	{
		id: "host:file-rename",
		slot: "contextmenu.file",
		labelKey: "fileRename",
		icon: "edit",
		kind: "action",
		context: "file",
		order: 41,
		group: "edit",
	},
	{
		id: "host:file-duplicate",
		slot: "contextmenu.file",
		labelKey: "fileDuplicate",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 42,
		group: "edit",
	},
	{
		id: "host:file-cut",
		slot: "contextmenu.file",
		labelKey: "fileCut",
		icon: "cut",
		kind: "action",
		context: "file",
		order: 43,
		group: "edit",
	},
	{
		id: "host:file-copy",
		slot: "contextmenu.file",
		labelKey: "fileCopyEntry",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 44,
		group: "edit",
	},
	{
		id: "host:file-copy-name",
		slot: "contextmenu.file",
		labelKey: "copyName",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 51,
		group: "clipboard",
	},
	{
		id: "host:file-copy-path",
		slot: "contextmenu.file",
		labelKey: "copyPath",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 52,
		group: "clipboard",
	},
	{
		id: "host:file-copy-rel",
		slot: "contextmenu.file",
		labelKey: "fileCopyRelPath",
		icon: "copy",
		kind: "action",
		context: "file",
		order: 53,
		group: "clipboard",
	},
	{
		id: "host:file-refresh",
		slot: "contextmenu.file",
		labelKey: "fileRefresh",
		icon: "refresh",
		kind: "action",
		context: "file",
		order: 54,
		group: "clipboard",
	},
	{
		id: "host:file-delete",
		slot: "contextmenu.file",
		labelKey: "fileDelete",
		icon: "trash",
		kind: "action",
		context: "file",
		order: 61,
		group: "danger",
	},

	// ---- v8 新增槽位一律纯插件新增位，不登记宿主占位（宁缺勿造） ----
	// leftpanel.sessions / notice.actions 等在宿主侧都没有可整理的独立入口
	// （会话行点行即打开、通知条无常驻按钮），保持空数组，无插件贡献时
	// 渲染层返回 null / 不渲染，DOM 与旧版一字不差。
];

/**
 * 左栏分区别名条目（host:lp-projects / lp-running / lp-history）：只管三个分区的
 * 显隐＋纵向顺序，会话行内不渲染 —— renderLeftSessions 进门先滤掉它们，否则每条
 * 会话行尾都会多出三个按钮（且 icon 名会按原文画出来）。
 */
export const LP_SECTION_ENTRY_IDS: ReadonlySet<string> = new Set([
	"host:lp-projects",
	"host:lp-running",
	"host:lp-history",
]);

/** 插件视图 tab 的合成条目 id（`<pluginId>:__view`，`__view` 为保留字）。 */
export const PLUGIN_VIEW_ITEM_ID = "__view";

/** 宿主必须常驻顶栏的入口：不能被插件 arrange 或用户布局偏好隐藏。 */
export const REQUIRED_TOPBAR_ITEM_IDS: ReadonlySet<string> = new Set(["host:settings"]);

/** 某个插件的视图条目全局 id（`<pluginId>:__view`）—— 顶栏与布局偏好的 key。 */
export function pluginViewItemId(pluginId: string): string {
	return `${pluginId}:${PLUGIN_VIEW_ITEM_ID}`;
}

/** 这条槽位条目是不是「插件视图 tab」（`<pluginId>:__view`，且来源就是那个插件）。 */
export function isPluginViewItem(entry: { id: string; source: string }): boolean {
	if (!entry.source.startsWith("plugin:")) return false;
	return entry.id === pluginViewItemId(entry.source.slice("plugin:".length));
}

/**
 * 钉住 / 取消钉住某个插件的视图 tab，返回新的 UiLayoutPrefs。
 *
 * 语义与设置面板「界面布局」页的勾选框完全一致（hidden = 藏、shown = 显），只是换了个入口：
 * 钉住 = 写进 shown（并把它从 hidden 里摘掉），取消钉住 = 写进 hidden（并从 shown 摘掉）。
 * 两边都写是为了覆盖两类插件：合成的视图条目默认 hidden（钉住靠 shown 把它翻出来），
 * 而插件自己声明的 `__view` 条目默认可见（取消钉住必须写 hidden 才压得下去）。
 * 纯函数：不改入参。
 */
export function setPluginViewPinned(
	layout: UiLayoutPrefs | undefined,
	pluginId: string,
	pinned: boolean,
): UiLayoutPrefs {
	const id = pluginViewItemId(pluginId);
	const hidden = (layout?.hidden ?? []).filter((x) => x !== id);
	const shown = (layout?.shown ?? []).filter((x) => x !== id);
	if (pinned) shown.push(id);
	else hidden.push(id);
	return { ...layout, hidden, shown };
}

/**
 * 保存插件视图 tab 的相对顺序，同时完整保留其它槽位的排序偏好。
 * 面板传插件 id；持久层仍使用 `<pluginId>:__view` 的全局条目 id。
 */
export function setPluginViewOrder(layout: UiLayoutPrefs | undefined, pluginIds: readonly string[]): UiLayoutPrefs {
	const pluginItemIds = pluginIds.map(pluginViewItemId);
	const pluginSet = new Set(pluginItemIds);
	const order = (layout?.order ?? []).filter((id) => !pluginSet.has(id));
	return { ...layout, order: [...order, ...pluginItemIds] };
}

/** 品牌旧 id（已合并为 `host:brand`，此处仅做偏好迁移用）。 */
export const BRAND_ITEM_ID = "host:brand";
const BRAND_OLD_IDS: readonly string[] = ["host:brand-logo", "host:brand-name"];

/**
 * 品牌二合一迁移（host:brand-logo/host:brand-name → host:brand）。
 * 服务端持久层（normalizeUiLayout）已做同口径迁移，这里再兜一层 —— 内存里的旧偏好
 * 与单测直调 buildUiSlots 时同样生效。规则：列表去重映射；align/groups 跟 logo 的值、
 * labels 跟名称的值；显式写在新 id 上的值永远赢。纯函数：不改入参。
 */
export function migrateBrandLayout<T extends UiLayoutPrefs>(src: T): T {
	const hasOld =
		(src.hidden ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.shown ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		(src.order ?? []).some((id) => BRAND_OLD_IDS.includes(id)) ||
		BRAND_OLD_IDS.some((id) => src.align?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.groups?.[id] !== undefined) ||
		BRAND_OLD_IDS.some((id) => src.labels?.[id] !== undefined);
	if (!hasOld) return src;
	const mapList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = BRAND_OLD_IDS.includes(id) ? BRAND_ITEM_ID : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out;
	};
	const foldDict = (
		dict: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = logoFirst
				? (dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!])
				: (dict[BRAND_OLD_IDS[1]!] ?? dict[BRAND_OLD_IDS[0]!]);
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	const foldAlign = (dict: Record<string, UiAlign> | undefined): Record<string, UiAlign> | undefined => {
		if (!dict) return undefined;
		const out: Record<string, UiAlign> = {};
		for (const [k, v] of Object.entries(dict)) {
			if (BRAND_OLD_IDS.includes(k)) continue;
			out[k] = v;
		}
		if (out[BRAND_ITEM_ID] === undefined) {
			const picked = dict[BRAND_OLD_IDS[0]!] ?? dict[BRAND_OLD_IDS[1]!];
			if (picked !== undefined) out[BRAND_ITEM_ID] = picked;
		}
		return out;
	};
	return {
		...src,
		...(src.hidden ? { hidden: mapList(src.hidden) } : {}),
		...(src.shown ? { shown: mapList(src.shown) } : {}),
		...(src.order ? { order: mapList(src.order) } : {}),
		...(src.groups ? { groups: foldDict(src.groups, true) } : {}),
		...(src.labels ? { labels: foldDict(src.labels, false) } : {}),
		...(src.align ? { align: foldAlign(src.align) } : {}),
	};
}

/**
 * 给有独立视图的插件补一条合成的顶栏贡献（kind="view"），让插件视图 tab 和宿主三连
 * （chat/terminal/git）走同一个槽位（topbar.primary）：布局页可见、可隐藏、可调序，
 * 插件 arrange 也能整理它。调用方（App / 设置面板）在调 buildUiSlots 之前包一层即可。
 *
 * 纯函数：不改入参（只为需要补条目的插件浅拷贝）；view:false（纯渲染器）与已声明过
 * 同名条目的插件原样返回。报错/被禁用的插件由 buildUiSlots 整份丢弃（含这条合成）。
 *
 * `hidden: true`：插件视图 tab **默认不钉顶栏**（顶栏只留一个 🧩 插件面板入口），
 * 用户在面板里钉住某个插件时才由 `setPluginViewPinned` 把它写进 layout.shown 翻出来。
 */
export function withPluginViewItems(plugins: UiPluginInfo[]): UiPluginInfo[] {
	return plugins.map((p) => {
		if (p.view === false) return p;
		const items = p.ui?.items ?? [];
		if (items.some((it) => it.id === PLUGIN_VIEW_ITEM_ID)) return p;
		const viewItem: UiContribution = {
			id: PLUGIN_VIEW_ITEM_ID,
			slot: "topbar.primary",
			label: p.name,
			...(p.icon ? { icon: p.icon } : {}),
			...(p.iconSvg ? { iconSvg: p.iconSvg } : {}),
			kind: "view",
			view: `plugin:${p.id}`,
			order: 23,
			align: "end",
			hidden: true,
		};
		return {
			...p,
			ui: { items: [...items, viewItem], arrange: p.ui?.arrange ?? [] },
		};
	});
}

/** 一个已合并的挂载点条目（渲染层 / 布局页消费的就是它）。 */
export interface UiSlotEntry {
	/** 全局 id：`host:<name>` 或 `<pluginId>:<itemId>`（= 用户偏好与 arrange 的 key）。 */
	id: string;
	slot: UiSlotId;
	/** 谁贡献的（布局页显示「来源」用）。 */
	source: "host" | `plugin:${string}`;
	/**
	 * 当前界面语言下的最终文案：host 走传入的 t(labelKey)、插件走 label/labelEn，
	 * 再被插件 arrange 的 label 与用户自定义文案依次覆盖。
	 * 渲染层直接用 label；想自己重翻一次（例如补占位符参数）时才看 labelKey。
	 */
	label: string;
	/** host 条目保留的 i18n key（插件条目没有）。 */
	labelKey?: string;
	icon?: string;
	/** 内联 SVG 图标（有则优先于 icon 渲染，见 web/src/plugin-icon.tsx）。 */
	iconSvg?: string;
	/** 悬浮提示（插件 `hint`/`hintEn` 或 arrange 的 `hint` 覆盖后的最终文案）。
	 *  渲染层把它当 `title` 用；宿主内置条目的提示文案由各渲染层自己写（不入本表）。 */
	hint?: string;
	kind: UiItemKind;
	/** kind="action"：点击回给插件/宿主的动作名。 */
	action?: string;
	/** kind="view"：目标视图。 */
	view?: string;
	group?: string;
	/** 权重（缺省 100 已填实，渲染层不用再兜底）。 */
	order: number;
	/** 对齐组（缺省 start 已填实；同组内仍按 order/声明顺序排）。
	 *  是否真分组渲染由各槽位的渲染层决定 —— 输入框动作区（composer.actions）落成左/中/右
	 *  三组，底栏（bottombar）落成左/右两区；其余槽位按顺序整串渲染（见 groupByAlign）。 */
	align: UiAlign;
	hidden: boolean;
	/** kind="badge"：角标/状态文本（运行时经 host.ui.update 刷新）。 */
	badge?: string;
	/** kind="toggle" 的开关态（运行时经 host.ui.update 刷新，点击回 onUiAction）。 */
	checked?: boolean;
	/** kind="input" 的输入值（运行时经 host.ui.update 刷新，回车/失焦回 onUiAction）。 */
	value?: string;
	/** kind="progress" 的进度（0-100，越界已钳制；运行时经 host.ui.update 刷新，只展示）。 */
	progress?: number;
	/** kind="select" 的候选项（label 已按界面语言落定；value 回传给插件）。 */
	options?: { value: string; label: string }[];
	/** 上下文条件（宿主不认识的值直接忽略，不报错）。 */
	when?: string[];
	/**
	 * kind="menu" 的子项（一层，协议不再递归）。子项**不参与** arrange 与用户偏好：
	 * 协议里 arrange.id / prefs 的 key 只指顶层条目（子项没有稳定全局 id，允许整理会
	 * 出现「父菜单被挪走、子项还挂在原处」的歧义），因此子项只是一次性算好的最终条目。
	 */
	children?: UiSlotEntry[];
	/** 用户偏好里对该条目做过覆盖的字段名（如 ["hidden","order"]），布局页显示「已自定义」。 */
	userOverrides: string[];
	/** 被哪些插件 arrange 改过（插件 id，按应用顺序），布局页显示「来源」。 */
	arrangedBy: string[];
	/** 被 arrange 的 slot 字段移走时的原 slot（布局页显示「从顶栏主栏移来」）。 */
	movedFrom?: UiSlotId;
}

/** 合并过程中的可变条目：多一个 seq（声明序号）用来做稳定排序。 */
interface WorkingEntry extends UiSlotEntry {
	seq: number;
}

/** 偏好 order 列表里出现过的条目名次（没出现 = undefined = 排在所有列出者之后）。 */
type RankMap = Map<string, number>;

function isSlotId(v: unknown): v is UiSlotId {
	return typeof v === "string" && (SLOT_IDS as string[]).includes(v);
}

/** 插件文案随语言取：中文界面优先 label，其它语言 labelEn ?? label（与 plugin-topbar 同口径）。 */
function pluginLabel(item: UiContribution, zh: boolean): string {
	return zh ? item.label : (item.labelEn ?? item.label);
}

/** 插件悬浮提示随语言取：没给对应语言就用另一种（对齐 pluginLabel 的回落口径）。 */
function pluginHint(item: UiContribution, zh: boolean): string | undefined {
	return zh ? (item.hint ?? item.hintEn) : (item.hintEn ?? item.hint);
}

/** 插件子项 → 最终条目（继承父条目的 slot 与来源；id 用 `<父全局 id>#<子 id>` 便于排障）。 */
function toChildEntry(
	parentId: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	item: UiContribution,
	zh: boolean,
): UiSlotEntry {
	const id = `${parentId}#${item.id}`;
	const children = childEntries(id, slot, source, item.children, zh);
	const hint = pluginHint(item, zh);
	const options = toSlotOptions(item.options, zh);
	return {
		id,
		slot,
		source,
		label: pluginLabel(item, zh),
		...(item.icon ? { icon: item.icon } : {}),
		...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
		...(hint ? { hint } : {}),
		kind: item.kind ?? "action",
		...(item.action ? { action: item.action } : {}),
		...(item.view ? { view: item.view } : {}),
		...(item.group ? { group: item.group } : {}),
		order: item.order ?? 100,
		align: "start",
		hidden: item.hidden ?? false,
		...(item.badge ? { badge: item.badge } : {}),
		...(item.when ? { when: item.when } : {}),
		...(options ? { options } : {}),
		...(children.length > 0 ? { children } : {}),
		userOverrides: [],
		arrangedBy: [],
	};
}

/**
 * 子项列表：与顶层同一套排序口径（权重 → 声明顺序），但**不**参与 arrange / 用户偏好
 * （见 UiSlotEntry.children 的说明）。
 */
function childEntries(
	parentId: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	children: UiContribution[] | undefined,
	zh: boolean,
): UiSlotEntry[] {
	if (!children?.length) return [];
	return children
		.map((child, index) => ({ entry: toChildEntry(parentId, slot, source, child, zh), index }))
		.sort((a, b) => (a.entry.order === b.entry.order ? a.index - b.index : a.entry.order - b.entry.order))
		.map((x) => x.entry);
}

/** select 候选项文案随语言落定（中文用 label，其它语言 labelEn ?? label ?? value）。 */
function toSlotOptions(
	options: UiSelectOption[] | undefined,
	zh: boolean,
): { value: string; label: string }[] | undefined {
	if (!options?.length) return undefined;
	return options.slice(0, 32).map((o) => ({
		value: o.value,
		label: zh ? (o.label ?? o.labelEn ?? o.value) : (o.labelEn ?? o.label ?? o.value),
	}));
} /** progress 越界钳制到 0-100（非数字直接回 0，不把 NaN 漏给渲染层）。 */
function clampProgress(v: unknown): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) return 0;
	return Math.min(100, Math.max(0, n));
}

/** 插件声明 → 工作条目。 */
function toWorkingEntry(
	id: string,
	slot: UiSlotId,
	source: `plugin:${string}`,
	item: UiContribution,
	zh: boolean,
	seq: number,
): WorkingEntry {
	const children = childEntries(id, slot, source, item.children, zh);
	const hint = pluginHint(item, zh);
	// 新 kind（toggle/input/progress/select）直接透传不丢；kind 缺省逻辑不变
	// （settings.pages 缺省 page，其余缺省 action）。
	const progress = clampProgress(item.progress);
	const options = toSlotOptions(item.options, zh);
	return {
		id,
		slot,
		source,
		label: pluginLabel(item, zh),
		...(item.icon ? { icon: item.icon } : {}),
		...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
		...(hint ? { hint } : {}),
		// 设置页的缺省种类是 "page"（协议规定），其余槽位缺省 "action"。
		kind: item.kind ?? (slot === "settings.pages" ? "page" : "action"),
		...(item.action ? { action: item.action } : {}),
		...(item.view ? { view: item.view } : {}),
		...(item.group ? { group: item.group } : {}),
		order: item.order ?? 100,
		align: item.align ?? "start",
		hidden: item.hidden ?? false,
		...(item.badge ? { badge: item.badge } : {}),
		...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
		...(typeof item.value === "string" ? { value: item.value } : {}),
		...(progress !== undefined ? { progress } : {}),
		...(options ? { options } : {}),
		...(item.when ? { when: item.when } : {}),
		...(children.length > 0 ? { children } : {}),
		userOverrides: [],
		arrangedBy: [],
		seq,
	};
}

/** 稳定排序：用户排序 > 权重 > 声明序号。 */
function sortEntries(entries: WorkingEntry[], rank: RankMap): WorkingEntry[] {
	return [...entries].sort((a, b) => {
		const ra = rank.get(a.id);
		const rb = rank.get(b.id);
		// 用户排序列表里的条目一律排在最前，且严格按列表顺序 —— 用户拖出来的顺序
		// 不该被权重或声明序号二次打乱（否则拖完 UI 会「跳回去」）。
		if (ra !== undefined || rb !== undefined) {
			if (ra !== undefined && rb !== undefined) return ra - rb;
			return ra !== undefined ? -1 : 1;
		}
		if (a.order !== b.order) return a.order - b.order;
		return a.seq - b.seq;
	});
}

/** 顶栏的插件视图是一个独立区段：固定插件从 Git 后开始排，不能被旧布局偏好挤到最前。 */
function placeTopbarPluginViews(entries: WorkingEntry[]): WorkingEntry[] {
	const views = entries.filter((entry) => isPluginViewItem(entry));
	if (views.length === 0) return entries;
	const rest = entries.filter((entry) => !isPluginViewItem(entry));
	const anchor =
		["host:git", "host:terminal", "host:chat"]
			.map((id) => rest.findIndex((entry) => entry.id === id))
			.find((index) => index >= 0) ?? -1;
	const panel = rest.findIndex((entry) => entry.id === "host:plugins");
	let insertAt = anchor + 1;
	if (panel >= insertAt) insertAt = panel;
	insertAt = Math.max(0, Math.min(insertAt, rest.length));
	return [...rest.slice(0, insertAt), ...views, ...rest.slice(insertAt)];
}

/**
 * 合并出每个挂载点的最终条目列表。返回值一定包含全部 SLOT_IDS（没用到的槽位是空数组），
 * 渲染层可以直接 `slots[slot]` 而不必判空。
 */
export function buildUiSlots(
	plugins: UiPluginInfo[],
	opts: {
		/** 当前界面语言（"zh" 时文案用 label 字段；其它语言插件回落 labelEn）。 */
		locale: string;
		/** host 条目的翻译函数（无参；带占位符的 key 由渲染层用 labelKey 自行补参）。 */
		t: (key: string) => string;
		/** 设置面板里整体禁用的插件 → 它的贡献与 arrange 全部丢弃。 */
		disabledPlugins?: string[];
		/** 用户偏好（最高优先级）。 */
		layout?: UiLayoutPrefs;
	},
): Record<UiSlotId, UiSlotEntry[]> {
	const zh = opts.locale === "zh";
	const disabled = new Set(opts.disabledPlugins ?? []);
	const layout = migrateBrandLayout(opts.layout ?? {});

	// 声明序号：新增条目时自增。同 id 覆盖（后声明的插件赢）**复用**原序号 —— 覆盖的是
	// 「条目内容」，位置仍以首次声明为准；否则某个插件重声明一次就会无理由地把自己挪到
	// 列表尾部，用户看到的顺序会莫名其妙地变。
	const byId = new Map<string, WorkingEntry>();
	let seq = 0;

	// ---- 第 1 层：宿主默认 ----
	for (const item of BUILTIN_UI_ITEMS) {
		byId.set(item.id, {
			id: item.id,
			slot: item.slot,
			source: "host",
			label: opts.t(item.labelKey),
			labelKey: item.labelKey,
			...(item.icon ? { icon: item.icon } : {}),
			kind: item.kind,
			...(item.view ? { view: item.view } : {}),
			...(item.group ? { group: item.group } : {}),
			order: item.order ?? 100,
			align: item.align ?? "start",
			hidden: item.hidden ?? false,
			userOverrides: [],
			arrangedBy: [],
			seq: seq++,
		});
	}

	// ---- 第 2 层：插件贡献 ----
	for (const plugin of plugins) {
		if (plugin.error || disabled.has(plugin.id)) continue;
		const source = `plugin:${plugin.id}` as const;
		for (const item of plugin.ui?.items ?? []) {
			// slot 只信任枚举成员：manifest 解析已经过滤过一遍，这里再兜一层，
			// 脏数据只会丢条目，不会污染结果对象的 key。
			if (!isSlotId(item.slot)) continue;
			const id = `${plugin.id}:${item.id}`;
			const prev = byId.get(id);
			byId.set(id, toWorkingEntry(id, item.slot, source, item, zh, prev?.seq ?? seq++));
		}
	}

	// ---- 第 3 层：插件 arrange（只能改已存在的条目） ----
	for (const plugin of plugins) {
		if (plugin.error || disabled.has(plugin.id)) continue;
		for (const op of plugin.ui?.arrange ?? []) applyArrange(byId, op, plugin.id);
	}

	// ---- 第 4 层：用户偏好（最高） ----
	const overrides = new Map<string, string[]>();
	const mark = (id: string, field: string) => {
		const list = overrides.get(id) ?? [];
		if (!list.includes(field)) list.push(field);
		overrides.set(id, list);
	};
	// hidden 与 shown 同时含一条时，shown 后应用 → 「显示」赢。理由：用户点「显示」是对
	// 上一次隐藏的撤销，撤销必须生效，否则条目会永远卡在被隐藏的状态里出不来。
	for (const id of layout.hidden ?? []) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.hidden = true;
		mark(id, "hidden");
	}
	for (const id of layout.shown ?? []) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.hidden = false;
		mark(id, "hidden");
	}
	for (const [id, group] of Object.entries(layout.groups ?? {})) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.group = group;
		mark(id, "group");
	}
	for (const [id, align] of Object.entries(layout.align ?? {})) {
		const entry = byId.get(id);
		// 脏值（手改 client-state / 旧版本残留）不进条目：缺省回到 start，不污染合并结果。
		if (!entry || (align !== "start" && align !== "center" && align !== "end")) continue;
		entry.align = align;
		mark(id, "align");
	}
	for (const [id, label] of Object.entries(layout.labels ?? {})) {
		const entry = byId.get(id);
		if (!entry) continue;
		entry.label = label;
		mark(id, "label");
	}
	// 设置是用户找回其它入口与布局的最后通道，必须留在顶栏。
	for (const id of REQUIRED_TOPBAR_ITEM_IDS) {
		const entry = byId.get(id);
		if (entry) {
			entry.slot = "topbar.primary";
			entry.hidden = false;
		}
	}
	const rank: RankMap = new Map();
	(layout.order ?? []).forEach((id, index) => {
		// 已不存在条目的历史排序照旧忽略（但保留在 prefs 里，条目回来了仍生效）。
		if (!byId.has(id)) return;
		if (!rank.has(id)) rank.set(id, index);
		mark(id, "order");
	});

	// ---- 按挂载点分组 + 排序 + 落成只读条目 ----
	const buckets = new Map<UiSlotId, WorkingEntry[]>();
	for (const id of SLOT_IDS) buckets.set(id, []);
	for (const entry of byId.values()) buckets.get(entry.slot)?.push(entry);
	const out = {} as Record<UiSlotId, UiSlotEntry[]>;
	for (const id of SLOT_IDS) {
		const sorted = sortEntries(buckets.get(id) ?? [], rank);
		const placed = id === "topbar.primary" ? placeTopbarPluginViews(sorted) : sorted;
		out[id] = placed.map((entry) => toSlotEntry(entry, overrides.get(entry.id) ?? []));
	}
	return out;
}

/** 落成对外条目：去掉内部实现细节 seq，并写上该条目当前生效的用户覆盖字段。 */
function toSlotEntry(entry: WorkingEntry, userOverrides: string[]): UiSlotEntry {
	const out: UiSlotEntry = { ...entry, userOverrides };
	delete (out as Partial<WorkingEntry>).seq;
	return out;
}

/**
 * 应用一条 arrange：只改**已存在**的条目（目标不存在 = 忽略；op 里各字段逐个生效，
 * undefined 表示「不动」）。整理别人的条目（宿主内置或别的插件）会记进该条目的
 * arrangedBy —— 布局页靠它告诉用户「这条是 X 插件挪走的」，这是「插件不许偷偷改
 * 宿主 UI」的唯一可见性保障；整理自己的条目不算（那就是它自己的声明方式，无需留痕）。
 */
function applyArrange(byId: Map<string, WorkingEntry>, op: UiArrangeOp, pluginId: string): void {
	const entry = byId.get(op.id);
	if (!entry) return; // 目标不存在（id 打错 / 目标插件没装）：静默忽略，不生成幽灵条目
	let applied = false;
	if (op.hide !== undefined) {
		entry.hidden = op.hide;
		applied = true;
	}
	if (op.group !== undefined) {
		entry.group = op.group;
		applied = true;
	}
	if (op.order !== undefined) {
		entry.order = op.order;
		applied = true;
	}
	if (op.align !== undefined) {
		entry.align = op.align;
		applied = true;
	}
	if (op.label !== undefined) {
		entry.label = op.label;
		applied = true;
	}
	if (op.hint !== undefined) {
		entry.hint = op.hint;
		applied = true;
	}
	if (op.icon !== undefined) {
		entry.icon = op.icon;
		applied = true;
	}
	if (op.iconSvg !== undefined) {
		entry.iconSvg = op.iconSvg || undefined;
		applied = true;
	}
	if (op.slot !== undefined && isSlotId(op.slot) && op.slot !== entry.slot) {
		// 记下「从哪来」：布局页要显示「被 X 插件从顶栏主栏移到了溢出菜单」。
		entry.movedFrom = entry.movedFrom ?? entry.slot;
		entry.slot = op.slot;
		applied = true;
	}
	if (applied && entry.source !== `plugin:${pluginId}` && !entry.arrangedBy.includes(pluginId)) {
		entry.arrangedBy.push(pluginId);
	}
}

/**
 * 按对齐组切分（保持组内相对顺序，不重排、不丢、不复制）。
 * 用它的渲染层：输入框动作区（composer.actions）落成左/中/右三组，底栏
 * （bottombar）落成左/右两区（start → 左，end → 右，center 并入左）。
 */
export function groupByAlign(entries: UiSlotEntry[]): {
	start: UiSlotEntry[];
	center: UiSlotEntry[];
	end: UiSlotEntry[];
} {
	const start: UiSlotEntry[] = [];
	const center: UiSlotEntry[] = [];
	const end: UiSlotEntry[] = [];
	for (const e of entries) {
		if (e.align === "end") end.push(e);
		else if (e.align === "center") center.push(e);
		else start.push(e);
	}
	return { start, center, end };
}

/**
 * 溢出切分：主栏最多放 max 个，其余按相对顺序进溢出菜单（不重排、不丢、不复制）。
 * 于是 topbar.overflow 天然就是「主栏的尾部」——插件也可以直接声明常驻在溢出槽位的条目。
 */
export function splitOverflow(entries: UiSlotEntry[], max: number): { inline: UiSlotEntry[]; overflow: UiSlotEntry[] } {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
	if (limit >= entries.length) return { inline: [...entries], overflow: [] };
	return { inline: entries.slice(0, limit), overflow: entries.slice(limit) };
}

/**
 * 恢复单条：把该 id 从用户偏好的五个字段里摘干净，返回新的 UiLayoutPrefs
 * （空数组/空对象会被删掉，不留空壳；结果为空则返回 `{}`）。
 * 只清**用户偏好**，插件 arrange 的效果会在下一次 buildUiSlots 时重新生效 —— 这正是
 * 「恢复默认」的语义：用户的意见撤回，插件的意见还在（要连插件的一起撤，就禁用插件）。
 */
export function restoreUiItem(layout: UiLayoutPrefs | undefined, id: string): UiLayoutPrefs {
	const src = layout ?? {};
	const next: UiLayoutPrefs = {};
	// 品牌恢复连带清掉旧双 id 的残留（老存档里可能还留着它们）。
	const dropIds = id === BRAND_ITEM_ID ? [id, ...BRAND_OLD_IDS] : [id];
	const hidden = (src.hidden ?? []).filter((x) => !dropIds.includes(x));
	const shown = (src.shown ?? []).filter((x) => !dropIds.includes(x));
	const order = (src.order ?? []).filter((x) => !dropIds.includes(x));
	if (hidden.length > 0) next.hidden = hidden;
	if (shown.length > 0) next.shown = shown;
	if (order.length > 0) next.order = order;
	let groups = omitKey(src.groups, id);
	let labels = omitKey(src.labels, id);
	let align = omitKey(src.align, id);
	if (id === BRAND_ITEM_ID) {
		for (const old of BRAND_OLD_IDS) {
			groups = omitKey(groups, old);
			labels = omitKey(labels, old);
			align = omitKey(align, old);
		}
	}
	if (groups) next.groups = groups;
	if (labels) next.labels = labels;
	if (align) next.align = align;
	// 非布局字段（顶栏文字开关等）原样保留 —— 单条恢复只动该条目。
	if (src.topbarText !== undefined) next.topbarText = src.topbarText;
	return next;
}

/** 一键恢复全部：所有条目回到「宿主默认 + 插件安排」的状态。 */
export function restoreAllUi(): UiLayoutPrefs {
	return {};
}

/** 复制一份去掉某个 key 的记录；结果为空则返回 undefined（不留下空对象）。 */
function omitKey<T>(rec: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
	if (!rec) return undefined;
	const out: Record<string, T> = {};
	let kept = false;
	for (const [k, v] of Object.entries(rec)) {
		if (k === key) continue;
		out[k] = v;
		kept = true;
	}
	return kept ? out : undefined;
}

/**
 * 宿主图标词表（BuiltinUiItem.icon / UiSlotEntry.icon 的取值），渲染层据此映射 react-icons：
 *   chat / terminal / git / search / browser / layers / settings / sound / globe / sun /
 *   download / github / plus / menu / folder / dot / cpu / gauge / coins / database /
 *   download / github / plus / menu / folder / dot / cpu / gauge / coins / database /
 *   message / activity / edit / copy / text / markdown / image / x / upload / mic
 * 插件条目里的 icon 可以是 emoji/单字符（manifest 已裁剪长度）：渲染层按「是否落在词表内」
 * 二选一即可 —— 不认识的字符串原样当文本画，不报错。
 */
