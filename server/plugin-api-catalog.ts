import type { CatalogHostMethod, CatalogSlotEntry, CatalogSlotOccupant, PluginApiCatalog } from "./protocol.js";

export const PLUGIN_API_CATALOG_VERSION = 1 as const;

export const SLOT_EXAMPLES: Readonly<Record<string, string>> = {
	"topbar.primary": `{ "topbar": [{ "id": "inbox", "label": "收件箱", "kind": "action", "action": "my:open" }] }`,
	"topbar.overflow": `{ "topbar.more": [{ "id": "about", "label": "关于", "kind": "action", "action": "my:about" }] }`,
	bottombar: `{ "ui": { "bottombar": [{ "id": "st", "label": "状态", "kind": "action", "action": "my:st" }] } }`,
	"composer.leading": `{ "ui": { "composer.leading": [{ "id": "m", "label": "＋", "kind": "action", "action": "my:m" }] } }`,
	"composer.actions": `{ "composer": [{ "id": "pick", "label": "拾取", "kind": "action", "action": "my:pick" }] }`,
	"message.actions": `{ "message": [{ "id": "send", "label": "转存", "kind": "action", "action": "my:send" }] }`,
	"rightpanel.tabs": `{ "rightpanel": [{ "id": "mail", "label": "邮件", "kind": "view" }] }`,
	"contextmenu.topbar": `{ "ui": { "contextmenu.topbar": [{ "id": "m", "label": "顶栏菜单", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.message": `{ "ui": { "contextmenu.message": [{ "id": "m", "label": "消息菜单", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.session": `{ "ui": { "contextmenu.session": [{ "id": "m", "label": "会话菜单", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.project": `{ "ui": { "contextmenu.project": [{ "id": "m", "label": "项目菜单", "kind": "action", "action": "my:m" }] } }`,
	"contextmenu.file": `{ "contextmenu.file": [{ "id": "mail", "label": "发到邮箱", "kind": "action", "action": "my:send" }] }`,
	"contextmenu.toolcall": `{ "ui": { "contextmenu.toolcall": [{ "id": "m", "label": "工具菜单", "kind": "action", "action": "my:m" }] } }`,
	"tool.card.footer": `{ "ui": { "tool.card.footer": [{ "id": "m", "label": "工具卡底部", "kind": "action", "action": "my:m" }] } }`,
	"settings.pages": `{ "settings": [{ "id": "conf", "label": "邮箱设置", "kind": "page" }] }`,
	"tasks.panel": `{ "ui": { "tasks.panel": [{ "id": "pm2", "label": "pm2 托管的应用", "kind": "view" }] } }`,
	"leftpanel.projects.actions": `{ "ui": { "leftpanel.projects.actions": [{ "id": "m", "label": "项目标题按钮", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.project": `{ "ui": { "leftpanel.project": [{ "id": "m", "label": "项目行", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.running.actions": `{ "ui": { "leftpanel.running.actions": [{ "id": "m", "label": "运行标题按钮", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.history.actions": `{ "ui": { "leftpanel.history.actions": [{ "id": "m", "label": "历史标题按钮", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.sections": `{ "ui": { "leftpanel.sections": [{ "id": "m", "label": "我的分区", "kind": "view" }] } }`,
	"leftpanel.running": `{ "ui": { "leftpanel.running": [{ "id": "m", "label": "运行行", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.history": `{ "ui": { "leftpanel.history": [{ "id": "m", "label": "历史行", "kind": "action", "action": "my:m" }] } }`,
	"leftpanel.sessions": `{ "ui": { "leftpanel.sessions": [{ "id": "m", "label": "会话区", "kind": "action", "action": "my:m" }] } }`,
	"chat.header": `{ "ui": { "chat.header": [{ "id": "m", "label": "会话题头", "kind": "action", "action": "my:m" }] } }`,
	"chat.empty": `{ "ui": { "chat.empty": [{ "id": "m", "label": "空态", "kind": "action", "action": "my:m" }] } }`,
	"file.preview.toolbar": `{ "ui": { "file.preview.toolbar": [{ "id": "m", "label": "预览工具", "kind": "action", "action": "my:m" }] } }`,
	"terminal.toolbar": `{ "ui": { "terminal.toolbar": [{ "id": "m", "label": "终端工具", "kind": "action", "action": "my:m" }] } }`,
	"scm.toolbar": `{ "ui": { "scm.toolbar": [{ "id": "m", "label": "SCM 工具", "kind": "action", "action": "my:m" }] } }`,
	"goalbar.actions": `{ "ui": { "goalbar.actions": [{ "id": "m", "label": "目标条", "kind": "action", "action": "my:m" }] } }`,
	"notice.actions": `{ "ui": { "notice.actions": [{ "id": "m", "label": "通知动作", "kind": "action", "action": "my:m" }] } }`,
	"modal.dialog": `{ "modal": [{ "id": "m", "label": "弹窗", "kind": "action", "action": "my:m" }] }`,
	"sidebar.left": `{ "sidebar.left": [{ "id": "m", "label": "左侧悬浮", "kind": "action", "action": "my:m" }] }`,
	"sidebar.right": `{ "sidebar.right": [{ "id": "m", "label": "右侧悬浮", "kind": "action", "action": "my:m" }] }`,
};

export const HOST_METHODS: ReadonlyArray<CatalogHostMethod> = [
	{
		name: "leftPanel.setRunning",
		needs: "ui",
		summary: "左栏「运行的对话」登记插件运行条目（整体替换即心跳；ttlMs 缺省 60s 无心跳自动清空）",
		example: `host.leftPanel.setRunning([{ id: "sync-1", title: "同步邮件", status: "running", hint: "3/10" }])`,
	},
	{
		name: "leftPanel.clear",
		needs: "ui",
		summary: "立即清空本插件在左栏的运行条目",
		example: `host.leftPanel.clear()`,
	},
	{
		name: "ui.register",
		needs: "ui",
		summary: "运行时注册 UI 条目（与 manifest 同口径，别名映射+枚举校验）",
		example: `host.ui.register({ slot: "topbar.primary", id: "btn", label: "按钮" })`,
	},
	{
		name: "ui.update",
		needs: "ui",
		summary: "按 id 改已存在条目（label/badge/checked/value/progress）",
		example: `host.ui.update("btn", { badge: "3" })`,
	},
	{
		name: "ui.remove",
		needs: "ui",
		summary: "移除条目（manifest 声明的也能压住，直到 reload）",
		example: `host.ui.remove("btn")`,
	},
	{
		name: "ui.arrange",
		needs: "ui",
		summary: "整理任何条目（含 host:* 内置）：hide/order/group/label",
		example: `host.ui.arrange([{ id: "host:tasks", hide: true }])`,
	},
	{
		name: "ui.list",
		needs: "ui",
		summary: "自查本插件的 items + arrange（调别的插件看不见）",
		example: `host.ui.list()`,
	},
	{
		name: "onUiAction",
		needs: "ui",
		summary: "订阅条目点击（action 名 → 回调，client bundle 侧）",
		example: `__piWebUiHost.onUiAction("my:open", () => {})`,
	},
	{
		name: "registerAgentTool",
		needs: "tools",
		summary: "给 AI 注册工具（插件给模型加能力，与 AI 写插件方向相反）",
		example: `host.registerAgentTool({ name: "mail", description: "…", execute: async () => ({}) })`,
	},
	{
		name: "registerMarker",
		needs: "tools",
		summary: "注册内联状态标记（如 [[name:op:...]]；模型直接输出触发副作用，正文自动剥离）",
		example: `host.registerMarker({ name: "flag", guidance: ["[[flag:mark:<id>]] mark item"], apply: (token, ctx) => ({ applied: true }) })`,
	},
	{
		name: "onToolPre",
		needs: "tools",
		summary: "工具 pre 拦截（仅 bash/read）：allow/deny/ask，首个阻断胜出",
		example: `host.onToolPre((req) => req.params?.command?.includes("rm -rf") ? { decision: "deny" } : undefined)`,
	},
	{
		name: "onToolPost",
		needs: "tools",
		summary: "工具 post 编辑（仅 bash/read）：换 content / 补 additionalContext",
		example: `host.onToolPost(({ result }) => ({ content: result.content }))`,
	},
	{
		name: "onToolEvent",
		needs: "-",
		summary: "订阅工具执行事件（start/end 成对，只观测）",
		example: `host.onToolEvent((ev) => {})`,
	},
	{
		name: "bash",
		needs: "tools",
		summary: "受限 shell（无 piped shell，按词切分；cwd 锁工作区内，默认 60s 超时）",
		example: `await host.bash("ls", { timeoutMs: 10000 })`,
	},
	{
		name: "registerCommand",
		needs: "-",
		summary: "注册斜杠命令（/name 选择器 + prompt 拦截执行）",
		example: `host.registerCommand({ name: "deploy", description: "部署", run: (args) => {} })`,
	},
	{
		name: "route",
		needs: "http",
		summary: "挂载 HTTP 路由（/plugins-api/<id><path>）",
		example: `host.route("GET", "/inbox", (req, res) => res.json([]))`,
	},
	{
		name: "registerProxy",
		needs: "http",
		summary: "反向代理前缀（透传到 127.0.0.1:port，防 SSRF 锁回环）",
		example: `host.registerProxy("/app", 3000)`,
	},
	{
		name: "chat",
		needs: "chat",
		summary: "无头调用：把外部通道文本投给 agent（fire-and-forget）",
		example: `await host.chat({ text: "hi" })`,
	},
	{
		name: "chatWait",
		needs: "chat",
		summary: "等无头调用的 run_end（默认 120s，上下钳制）",
		example: `await host.chatWait({ conversationId })`,
	},
	{
		name: "llm.complete",
		needs: "llm",
		summary: "孤立无工具一次性补全（花用户模型额度）",
		example: `await host.llm.complete({ prompt: "…" })`,
	},
	{
		name: "requestPermission",
		needs: "-",
		summary: "申请能力授权（net 主机 / llm 模型作用域，用户确认）",
		example: `await host.requestPermission({ family: "net", hosts: ["api.example.com"] })`,
	},
	{
		name: "fs",
		needs: "fs",
		summary: "工作区文件（list/read/readText/write/remove…，锚定活 cwd，越界拒绝）",
		example: `await host.fs.readText("notes/todo.md")`,
	},
	{
		name: "fs.requestAccess",
		needs: "fs",
		summary: "申请工作区外目录授权（浏览器确认框，remember 记盘）",
		example: `await host.fs.requestAccess("/data")`,
	},
	{
		name: "project.create",
		needs: "fs",
		summary: "在已授权目录组装项目（mkdir/clone/写文件/git init）",
		example: `await host.project.create({ dir: "/data/app", files: {} })`,
	},
	{
		name: "schedule",
		needs: "-",
		summary: "定时任务（cron/延迟，持久化可重启不丢，远期分片防溢出）",
		example: `host.schedule("0 9 * * *", () => {})`,
	},
	{
		name: "registerBackgroundTask",
		needs: "-",
		summary: "常驻后台任务（并入后台任务面板，随反激活移除）",
		example: `host.registerBackgroundTask({ id: "svc", label: "服务" })`,
	},
	{
		name: "onRunEvent",
		needs: "-",
		summary: "订阅运行轨迹（run/message/tool…，时间线聚合用）",
		example: `host.onRunEvent((ev) => {})`,
	},
	{
		name: "getActiveConversation",
		needs: "-",
		summary: "读对话快照：{clientId} 取该标签页正在看的对话，缺省=最近活跃的非子代理会话",
		example: `host.getActiveConversation({ clientId })`,
	},
	{
		name: "onConversationChanged",
		needs: "-",
		summary: "订阅切对话（轨迹插件重拉时间线）",
		example: `host.onConversationChanged(() => {})`,
	},
	{
		name: "onClientModelChanged",
		needs: "-",
		summary: "订阅模型切换成功（回调带 clientId/对话/model；失败与重复不发）",
		example: `host.onClientModelChanged((snap) => {})`,
	},
	{
		name: "storage",
		needs: "-",
		summary: "插件私有 KV（storage.json，原子写，卸载即删）",
		example: `host.storage.get("k")`,
	},
	{ name: "secrets", needs: "-", summary: "加密 secrets（明文永不落盘/下发）", example: `host.secrets.get("token")` },
	{
		name: "tts",
		needs: "-",
		summary: "统一 TTS：注册引擎、列出引擎与音色、合成音频",
		example: `await host.tts.synthesize({ text: "你好", engine: "builtin" })`,
	},
	{
		name: "ensureDeps",
		needs: "-",
		summary: "依赖自动补装（单飞，npm 包）",
		example: `await host.ensureDeps(["dayjs"])`,
	},
	{
		name: "getSettings",
		needs: "-",
		summary: "读声明式设置值（manifest.settings 字段）",
		example: `host.getSettings()`,
	},
	{
		name: "onSettingsChanged",
		needs: "-",
		summary: "订阅设置保存（⚙ 面板保存后触发）",
		example: `host.onSettingsChanged((v) => {})`,
	},
	{ name: "onCwdChange", needs: "-", summary: "订阅工作区切换", example: `host.onCwdChange((cwd) => {})` },
	{
		name: "onAttach",
		needs: "-",
		summary: "订阅浏览器接入（主动推完整状态，服务端是唯一事实源）",
		example: `host.onAttach((clientId) => {})`,
	},
	{
		name: "broadcast",
		needs: "-",
		summary: "向所有浏览器广播本插件消息",
		example: `host.broadcast({ kind: "state" })`,
	},
	{ name: "notify", needs: "-", summary: "发系统通知条（notice toast）", example: `host.notify("info", "完成")` },
	{
		name: "effect",
		needs: "-",
		summary: "自建副作用挂进 effect 栈（反激活逆序回卷）",
		example: `host.effect("timer", () => clearInterval(t))`,
	},
	{
		name: "events.emit/on",
		needs: "-",
		summary: "插件间事件总线（topic 建议 <id>: 前缀，发送方不可伪造）",
		example: `host.events.on("notes:changed", () => {})`,
	},
	{ name: "models.list", needs: "-", summary: "列出已配置鉴权的模型（provider/id）", example: `host.models.list()` },
	{
		name: "mcp.list",
		needs: "-",
		summary: "列出已配置的全局与项目级 MCP 服务器及运行态/工具列表",
		example: `await host.mcp.list()`,
	},
	{
		name: "mcp.check",
		needs: "-",
		summary: "按名称、npm 包名、命令或 URL 检查指定 MCP 是否已安装/运行中",
		example: `await host.mcp.check("filesystem")`,
	},
	{
		name: "mcp.install",
		needs: "tools",
		summary: "安装/配置 MCP 服务器（支持 package 快捷方式）并立即触发热加载",
		example: `await host.mcp.install({ package: "@modelcontextprotocol/server-memory" })`,
	},
	{
		name: "mcp.promptInstall",
		needs: "chat",
		summary: "向当前对话发送指令，让 AI 检查并安装指定的 MCP 服务器",
		example: `await host.mcp.promptInstall("@modelcontextprotocol/server-filesystem")`,
	},
	{
		name: "scm",
		needs: "-",
		summary: "只读 git 查询（status/branches/history，不经过 shell）",
		example: `await host.scm.status()`,
	},
	{
		name: "net.fetch",
		needs: "net",
		summary: "出站网络（白名单命中才放行，失败回 {ok:false} 不抛）",
		example: `await host.net.fetch("https://api.example.com/x")`,
	},
	{
		name: "conversations",
		needs: "-",
		summary: "会话目录（list/get/search，只读组装+定向投递）",
		example: `await host.conversations.list()`,
	},
	{
		name: "prompt",
		needs: "-",
		summary: "向指定对话发一条用户消息（无注入回 ok:false）",
		example: `await host.prompt(convId, { text: "hi" })`,
	},
	{ name: "steer", needs: "-", summary: "插队指定对话的当前运行", example: `await host.steer(convId, "换方向")` },
	{ name: "abortRun", needs: "-", summary: "中止指定对话的运行", example: `await host.abortRun(convId)` },
];

export function buildPluginApiCatalog(opts: {
	slots: string[];
	aliases: Record<string, string>;
	kinds: string[];
	agentTools: Array<{ name: string; group: string; defaultOn: boolean; dshVisible: boolean }>;
	occupantsOf: (slot: string) => CatalogSlotOccupant[];
}): PluginApiCatalog {
	const aliasByTarget = new Map<string, string[]>();
	for (const [alias, target] of Object.entries(opts.aliases)) {
		const list = aliasByTarget.get(target) ?? [];
		list.push(alias);
		aliasByTarget.set(target, list);
	}
	const slots = [...opts.slots].sort().map((slot): CatalogSlotEntry => {
		const example =
			SLOT_EXAMPLES[slot] ??
			`{ "ui": { "${slot}": [{ "id": "m", "label": "条目", "kind": "action", "action": "my:m" }] } }`;
		return {
			slot,
			aliases: [...(aliasByTarget.get(slot) ?? [])].sort(),
			kinds: [...opts.kinds].sort(),
			occupants: [...opts.occupantsOf(slot)].sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1)),
			replaceRisk: "插件 arrange 可改任何条目（含 host:* 内置），用户偏好最后说话（布局页可恢复）",
			example,
		};
	});
	return {
		version: PLUGIN_API_CATALOG_VERSION,
		slots,
		agentTools: opts.agentTools.map((t) => ({
			name: t.name,
			group: t.group,
			defaultOn: t.defaultOn,
			dshVisible: t.dshVisible,
		})),
		hostMethods: HOST_METHODS.map((m) => ({ ...m })),
	};
}
