/**
 * pi-web-ui 插件管理器 —— 可选界面组件的加载与桥接。
 *
 * 一个插件 = <dataDir>/plugins/<id>/ 目录：
 *   manifest.json   元数据 { id?, name, version?, description? }（id 缺省取目录名）
 *   index.mjs       服务端入口（可选）：export default { activate(host) → deactivate? }
 *   client/         前端资源（可选），经 /plugins/<id>/client/* 以静态文件暴露；
 *     entry.mjs      视图入口：export default { mount(el, ctx) → cleanup? }
 *
 * 设计要点：
 * - 不装即不存在：目录不在就没有任何协议/UI 痕迹；每次客户端 attach 时重扫目录，
 *   新丢进来的插件无需重启服务即可出现在顶栏（import 只做一次并缓存）。
 * - id 必须匹配 ID_RE，防路径穿越；client 静态服务同样逐段校验。
 * - host 窄接口：broadcast(pluginId, payload) 广播 plugin_data、onMessage 注册
 *   客户端上行处理、dataDir/cwd/log 环境。发送通道由 index.ts 注入（每个 socket
 *   的 send 函数），插件本身不接触 ws。
 * - activate 抛错只标记 error 字段并记日志，绝不影响主进程。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerMessage, UiPluginInfo, BgServer, UiPluginSettingField } from "./protocol.js";
import { PluginStorage, PluginSecrets, ensurePluginDeps, WorkspaceFS } from "./plugin-facilities.js";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

/** 合法插件 id：字母/数字/下划线/连字符，防路径穿越（同 themes.ts 的做法）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 插件收到的工具执行事件（agent-service 的 SDK tool_execution_start/end 转发）。 */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	/** 事件所属对话（会话未就绪时可能为空）。 */
	conversationId?: string;
	/** end 独有：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
}

/**
 * 插件注册的 AI 工具（结构化定义，与 SDK ToolDefinition 解耦——由
 * agent-service 负责转换）。execute 返回 { content, details? }（content 为
 * [{type:"text",text}] 或图片块），或直接返回字符串/对象（自动包成文本）。
 */
export interface PluginAgentTool {
	/** 工具名（建议 <插件名>_<动作> 前缀，如 mail_list；全局唯一，重复注册后者被拒）。 */
	name: string;
	/** UI 显示标签。 */
	label?: string;
	/** 给 LLM 的工具描述。 */
	description: string;
	/** 可选：出现在系统提示词 Available tools 区的一行摘要。 */
	promptSnippet?: string;
	/** 可选：追加到系统提示词 Guidelines 的要点。 */
	promptGuidelines?: string[];
	/** 参数 JSON Schema（TypeBox/JSON Schema 兼容）。缺省为空对象。 */
	parameters?: Record<string, unknown>;
	/** 执行体；onUpdate 可流式上报部分结果（同形结构）。 */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** 插件服务端入口拿到的宿主接口。 */
export interface PluginHost {
	/** 向所有已连接的浏览器广播一条本插件的消息（plugin_data）。 */
	broadcast(payload: unknown): void;
	/** 发一条系统通知条（notice）给所有已连接的浏览器。 */
	notify(level: "info" | "warning" | "error", text: string): void;
	/** 注册客户端上行消息（plugin_message）处理器；回调第二参为发送方 clientId
	 *  （可用于 sendTo 定向回复）。返回注销函数。 */
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** 给指定客户端定向发一条本插件消息（不广播）；clientId 来自 onMessage。 */
	sendTo(clientId: string, payload: unknown): void;
	/** 注册「新客户端接入」钩子：每次浏览器 attach（含插件刚激活时已在场的连接、
	 *  以及 plugins_reload 后的重新接入）都会以 clientId 回调。插件应借此主动
	 *  推送自身完整状态（kind:"state" 等）——服务端是唯一事实源，不要依赖客户端
	 *  挂载后自己来拉（裸 ctx.send({action:"state"}) 无 reqId，响应会被客户端的
	 *  pending 匹配静默丢弃，这是已踩过两次的坑）。返回注销函数。 */
	onAttach(handler: (clientId: string) => void): () => void;
	/** 订阅智能体的工具执行事件（bash/读写文件等，start+end 成对）；返回注销函数。 */
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	/** 注册一个供 AI 调用的工具（新对话创建时带上，已有会话动态注入）；
	 *  返回注销函数——插件可按自己的配置开关随时注册/注销（如邮箱插件的
	 *  「让 AI 管理邮件」开关）。 */
	registerAgentTool(tool: PluginAgentTool): () => void;
	/** 插件自己的持久化目录（<dataDir>/plugins/<id>）——凭据等放这里。 */
	dir: string;
	/** 全局数据目录（~/.pi-web）。 */
	dataDir: string;
	/** 当前智能体工作区——**活的**：跟随任意客户端 set_cwd 成功后的新根，
	 *  插件可随时读；想主动感知变化用 onCwdChange。 */
	get cwd(): string;
	/** 注册工作区切换回调（主应用 set_cwd 成功后以新绝对路径触发）。
	 *  返回注销函数。旧版宿主无此方法（可选链兼容）。 */
	onCwdChange(handler: (cwd: string) => void): () => void;
	/** 注册一个斜杠命令（/name），出现在输入框命令选择器里，服务端拦截执行。
	 *  返回注销函数；重名拒绝（内置命令优先，先注册的插件优先）。 */
	registerCommand(cmd: PluginCommandDef): () => void;
	/** 插件私有 KV 存储（<pluginDir>/storage.json，原子写、卸载即删除）。 */
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	/** 加密机密存储（AES-256-GCM；存密码/API key/token 等）。
	 *  明文绝不落盘；拷到别的机器因无宿主密钥解不开。 */
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
	};
	/** 确保依赖就绪：缺了自动 npm install 到插件目录（单飞合并）。
	 *  resolve 后的 import 才能成功——插件动态加载重型依赖前应 await 它。 */
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	/** 挂载 HTTP 路由：实际暴露为 /plugins-api/<id><path>（GET/POST/PUT/DELETE）。
	 *  主站的 PI_WEB_TOKEN 鉴权自动覆盖这些路由；body 已过 express.json 解析。
	 *  handler 抛错由宿主转成 500，不炸进程。返回注销函数。需要能力 "http"。 */
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: Request, res: Response) => void,
	): () => void;
	/** 受限工作区文件访问（读/写/列/删）：路径永远锚定「当前工作区根」
	 *  （活值，跟随 set_cwd），越界拒绝——与插件自己 import node:fs 不同，
	 *  这一层是宿主强制执行的。需要能力 "fs"。 */
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		read(relPath: string): Promise<Buffer>;
		readText(relPath: string, maxBytes?: number): Promise<string>;
		write(relPath: string, data: string | Uint8Array): Promise<void>;
		remove(relPath: string): Promise<void>;
	};
	/** 注册一个常驻后台任务（轮询器/连接池/后台 worker…）：出现在顶栏「后台任务」
	 *  面板，用户可一键停止。返回 { update, unregister }。id 在插件内唯一。 */
	registerBackgroundTask(task: {
		id: string;
		/** 面板显示名（如「📬 邮件轮询」）。 */
		label: string;
		/** 停止回调（面板「停止」按钮触发；用户也可能直接 kill 进程树）。 */
		stop?: () => void;
		/** 可选初始状态文案，之后可经 update() 刷新。 */
		status?: string;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	/** 读取宿主管理的设置值（manifest "settings" 声明的字段，storage.json
	 *  存值 + 默认值合并）。插件应以此为准做运行时行为。 */
	getSettings(): Record<string, unknown>;
	/** 订阅「用户在 ⚙ 面板改了这个插件的声明式设置」事件（保存后触发，
	 *  参数为新值对象）；返回注销函数。改完应自行重读 getSettings()。 */
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	/** 带前缀的日志。 */
	log(...args: unknown[]): void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	/** onAttach 钩子（新客户端接入时逐个回调）。 */
	attachHandlers: Set<(clientId: string) => void>;
	/** onCwdChange 钩子（工作区切换时逐个回调）。 */
	cwdHandlers: Set<(cwd: string) => void>;
	/** 该插件注册的全部 AI 工具注销函数（反激活时逐个调用）。 */
	agentToolUnsubscribers?: Array<() => void>;
	/** 该插件注册的全部斜杠命令注销函数。 */
	commandUnsubscribers?: Array<() => void>;
	/** 该插件挂载的 HTTP 路由表："METHOD /path" → handler。 */
	httpRoutes: Map<string, (req: Request, res: Response) => void>;
	/** manifest.permissions 原始声明（空/缺省 = 未声明，旧全权模式）。错误路径占位可缺省。 */
	permsDeclared?: string[];
	/** 声明中的能力族（去冒号前缀）：fs/net/tools/http/terminal… */
	permFamilies?: Set<string>;
	/** 旧格式全权模式的「未声明」警告是否已发过（每次激活一次）。 */
	legacyWarned?: boolean;
	/** onSettingsChanged 钩子（⚙ 面板保存声明式设置后触发）。 */
	settingsHandlers: Set<(values: Record<string, unknown>) => void>;
}

/** 宿主提供的插件设施版本——manifest 声明的 apiVersion 高于此值则拒绝激活，
 *  插件能拿到明确的「请升级 pi-web-ui」而不是在新接口上莫名 undefined。 */
export const PLUGIN_API_VERSION = 1;

/** 插件通过 host.registerCommand 注册的斜杠命令。run 的返回值若为非空字符串，
 *  会作为系统通知条回显给发起人；需要富展示的视图插件应改用 broadcast/sendTo。
 *  命令是纯配置动作（不消耗 token），与内置命令同级拦截执行。 */
export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** 每个插件的 AI 工具注册表（name → 定义）。 */
type AgentToolTable = Map<string, PluginAgentTool>;

/** 插件注册的常驻后台任务（经 host.registerBackgroundTask）。 */
export interface PluginBgTask {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
	since: number;
}

/** 消息处理器超时：仅作为不再等待的日志阈值（响应由 handler 自己发出）。 */
const MESSAGE_TIMEOUT_MS = 30_000;

/** host.fs 被能力门控拒绝时的共享 rejected promise（类型对齐用）。 */
const NO_FS_PROMISE = Promise.reject(new Error('插件未声明能力 "fs"（manifest.permissions）——请求被拒'));
NO_FS_PROMISE.catch(() => {}); // 避免未处理 rejection 噪音；调用方 await 时拿到错误

/** 每个 WS 连接注册一个 sender；cid() 返回该 socket 的 clientId（attach 前 null）。 */
interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
}

// ---------------------------------------------------------------------------
// 声明式设置 schema（manifest "settings"）
// ---------------------------------------------------------------------------

const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select"]);

/** 解析 manifest.settings → 合法 schema（坏字段跳过，最多 32 个）。 */
function parseSettingsSchema(raw: unknown): UiPluginSettingField[] {
	if (!Array.isArray(raw)) return [];
	const out: UiPluginSettingField[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const o = f as Record<string, unknown>;
		const key = typeof o.key === "string" ? o.key.trim() : "";
		const type = typeof o.type === "string" ? o.type : "";
		if (!key || !SETTING_TYPES.has(type) || out.some((x) => x.key === key)) continue;
		const field: UiPluginSettingField = {
			key,
			type: type as UiPluginSettingField["type"],
			label: typeof o.label === "string" && o.label ? o.label : key,
			...(o.default !== undefined ? { default: o.default as string | number | boolean } : {}),
			...(typeof o.min === "number" ? { min: o.min } : {}),
			...(typeof o.max === "number" ? { max: o.max } : {}),
			...(Array.isArray(o.options) ? { options: o.options.filter((x): x is string => typeof x === "string") } : {}),
			...(typeof o.hint === "string" ? { hint: o.hint } : {}),
		};
		out.push(field);
		if (out.length >= 32) break;
	}
	return out;
}

/** 从 <pluginDir>/storage.json 读 settings 存值，按 schema 并默认值。 */
function storedSettingsValues(dir: string, schema: UiPluginSettingField[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let stored: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
			stored = parsed.settings as Record<string, unknown>;
		}
	} catch {
		/* 无存储文件 = 全默认 */
	}
	for (const f of schema) out[f.key] = stored[f.key] ?? f.default;
	return out;
}

/** 校验并写回 settings（storage.json 的 settings 键，原子写）；返回错误信息或 null。 */
function saveSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	values: Record<string, unknown> | undefined,
): { error?: string; clean: Record<string, unknown> } {
	const clean: Record<string, unknown> = {};
	for (const f of schema) {
		const v = values?.[f.key];
		if (f.type === "number") {
			const n = v === undefined ? Number(f.default ?? 0) : Number(v);
			if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
				return { error: `${f.label} 超出范围`, clean };
			}
			clean[f.key] = n;
		} else if (f.type === "boolean") {
			clean[f.key] = v === undefined ? Boolean(f.default) : Boolean(v);
		} else if (f.type === "select") {
			if (v !== undefined && !f.options?.includes(String(v))) return { error: `${f.label} 值非法`, clean };
			clean[f.key] = v === undefined ? f.default : String(v);
		} else {
			clean[f.key] = v === undefined ? (f.default ?? "") : String(v);
		}
	}
	try {
		// 保留 storage.json 里其它键（插件自己的数据），只动 settings。
		const file = join(dir, "storage.json");
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			/* 首次 */
		}
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ ...existing, settings: clean }));
		renameSync(tmp, file);
	} catch (err) {
		console.error(`[plugins] settings persist failed (${dir}):`, err);
	}
	return { clean };
}

export class PluginManager {
	private loaded = new Map<string, LoadedPlugin>();
	/** 已 import 过但无入口/失败的目录——避免重复 import 与重复报错。 */
	private attempted = new Set<string>();
	private senders = new Set<Sender>();
	private messageHandlers = new Map<string, Set<(payload: unknown, from?: string) => void>>();
	/** 插件注册的 AI 工具：pluginId → (name → 定义)。宿主经 agentTools() 读取。 */
	private agentTools = new Map<string, AgentToolTable>();
	/** AI 工具集合变化回调（index.ts 接到 AgentService，把新工具推入活跃会话）。 */
	onAgentToolsChanged: (() => void) | undefined = undefined;
	/** 插件斜杠命令注册表：pluginId → (name → 定义)。宿主经 listCommands() 读取。 */
	private pluginCommands = new Map<string, Map<string, PluginCommandDef>>();
	/** 命令集合变化回调（index.ts 接到 AgentService，刷新各客户端命令目录）。 */
	onCommandsChanged: (() => void) | undefined = undefined;
	/** 插件常驻任务：pluginId → Map<taskId, PluginBgTask>。宿主经 bgTasks() 读取。 */
	private pluginBgTasks = new Map<string, Map<string, PluginBgTask>>();
	/** 任务集合变化回调（index.ts 接到 AgentService，重推 bg_servers）。 */
	onBgTasksChanged: (() => void) | undefined = undefined;
	/** 服务端重载纪元：每次 reload() +1，前端用作 import 缓存击穿参数。 */
	private epochCounter = 0;
	/** 当前全局工作区（host.cwd 的背后存储）——随 notifyCwd 更新。 */
	private cwdValue: string;

	constructor(
		private readonly dataDir: string,
		cwd: string,
	) {
		this.cwdValue = resolve(cwd);
	}

	/** index.ts 在客户端 set_cwd 成功后调用：更新全局工作区并扇出给
	 *  所有已激活插件的 onCwdChange 钩子（异常隔离，不炸主进程）。 */
	notifyCwd(next: string): void {
		const abs = resolve(next);
		if (abs === this.cwdValue) return; // 幂等：重复通知/同路径 no-op
		this.cwdValue = abs;
		for (const [id, p] of this.loaded) {
			for (const h of p.cwdHandlers) {
				try {
					h(abs);
				} catch (err) {
					console.error(`[plugin:${id}] cwd-change handler failed:`, err);
				}
			}
		}
	}

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	/** 全部插件注册的斜杠命令（按插件 id 稳定排序）。 */
	listCommands(): PluginCommandDef[] {
		const out: PluginCommandDef[] = [];
		for (const id of [...this.pluginCommands.keys()].sort()) {
			out.push(...this.pluginCommands.get(id)!.values());
		}
		return out;
	}

	/** 按名查找命令（供 prompt() 拦截执行；找不到返回 null）。 */
	findCommand(name: string): { def: PluginCommandDef; pluginId: string } | null {
		for (const [pluginId, table] of this.pluginCommands) {
			if (table.has(name)) return { def: table.get(name)!, pluginId };
		}
		return null;
	}

	/** 全部插件注册的常驻后台任务（扁平化为 BgServer 形状）。 */
	bgTasks(): BgServer[] {
		const out: BgServer[] = [];
		for (const [pluginId, table] of this.pluginBgTasks) {
			for (const t of table.values()) {
				out.push({
					taskId: t.id,
					plugin: pluginId,
					since: t.since,
					name: t.label,
					...(t.status ? { status: t.status } : {}),
				});
			}
		}
		return out;
	}

	/** 停止一个插件任务（kill_background_server with taskId）；返回是否命中。 */
	stopPluginBgTask(taskId: string): boolean {
		for (const [pluginId, table] of this.pluginBgTasks) {
			const t = table.get(taskId);
			if (!t) continue;
			try {
				t.stop?.();
			} catch (err) {
				console.error(`[plugin:${pluginId}] background task ${taskId} stop failed:`, err);
			}
			table.delete(taskId);
			if (table.size === 0) this.pluginBgTasks.delete(pluginId);
			try {
				this.onBgTasksChanged?.();
			} catch {}
			return true;
		}
		return false;
	}

	/** 保存某插件的声明式设置（⚙ 面板 → plugin_settings 消息）：按 schema 校验、
	 *  原子写 storage.json 的 settings 键、通知插件 onSettingsChanged、重推清单
	 *  让前端回显。返回错误信息或 null（成功）。 */
	savePluginSettings(pluginId: string, values: Record<string, unknown>): { error?: string } {
		if (!ID_RE.test(pluginId)) return { error: "非法的插件 id" };
		const dir = join(this.pluginsDir, pluginId);
		const info = this.loaded.get(pluginId)?.info;
		const schema = info?.settingsSchema ?? [];
		if (!schema.length) return { error: "该插件没有声明式设置（manifest 未声明 settings）" };
		const { error, clean } = saveSettingsValues(dir, schema, values);
		if (error) return { error };
		// 通知插件（异常隔离）
		for (const h of this.loaded.get(pluginId)?.settingsHandlers ?? []) {
			try {
				h(clean);
			} catch (err) {
				console.error(`[plugin:${pluginId}] onSettingsChanged handler failed:`, err);
			}
		}
		// 重推 plugins 清单（含新 settingsValues），前端回显。
		void this.pushToAll().catch(() => {});
		return {};
	}

	/** 当前重载纪元（随 plugins 消息下发）。 */
	get epoch(): number {
		return this.epochCounter;
	}

	addSender(send: (msg: ServerMessage) => void, cid: () => string | null): () => void {
		const s: Sender = { cid, send };
		this.senders.add(s);
		return () => this.senders.delete(s);
	}

	/** 客户端上行：路由给对应插件的处理器；未知/未激活的插件静默丢弃。
	 *  插件代码不可信——同步抛错与返回的 Promise rejection 都必须隔离在
	 *  这里，绝不能炸主进程。 */
	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				const ret = h(payload, from) as unknown;
				if (ret instanceof Promise) {
					ret.catch((err) => {
						console.error(`[plugin:${pluginId}] async message handler failed:`, err);
					});
					// 超时护栏：响应由 handler 自己 sendTo/broadcast 发出，超时只是记
					// 日志不再等待——绝不能让单条消息把客户端 pending 管线无限拖死。
					const timer = setTimeout(() => {
						console.error(`[plugin:${pluginId}] message handler 超时（>${MESSAGE_TIMEOUT_MS}ms），已不再等待`);
					}, MESSAGE_TIMEOUT_MS);
					void ret.finally(() => clearTimeout(timer));
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	/** 首次安装/能力变更时提醒在线用户（marker 文件记录上次激活时的声明）。 */
	private async maybeConsentNotice(info: UiPluginInfo, dir: string, perms: string[]): Promise<void> {
		try {
			const markerFile = join(dir, ".pi-approved");
			const key = createHash("sha256").update(JSON.stringify(perms)).digest("hex").slice(0, 32);
			let prev = "";
			try {
				prev = JSON.parse(readFileSync(markerFile, "utf8"))?.key ?? "";
			} catch {
				/* 无 marker = 首次安装 */
			}
			if (prev === key) return; // 同版本能力清单，不再打扰
			const list = perms.length ? perms.join(", ") : "无";
			this.notifyAll(
				perms.length ? "warning" : "info",
				`插件「${info.name}」已激活（${prev ? "能力清单变更" : "首次安装"}；声明能力：${list}）——请确认来源可信`,
			);
			writeFileSync(markerFile, JSON.stringify({ v: 1, key, perms }), "utf8");
		} catch (err) {
			console.error(`[plugin:${info.id}] consent notice failed:`, err);
		}
	}

	/** index.ts 的 /plugins-api/:id/* 挂载点转发到这里：找到对应插件的已注册
	 *  路由并执行；未知插件/路径 → 404，handler 抛错 → 500（不炸进程）。 */
	handleHttp(pluginId: string, method: string, pathIn: string, req: Request, res: Response): void {
		if (!ID_RE.test(pluginId)) {
			res.status(404).end("plugin not found");
			return;
		}
		const table = this.loaded.get(pluginId)?.httpRoutes;
		const path = "/" + pathIn.replace(/^\/+/, "");
		const handler = table?.get(`${method.toUpperCase()} ${path}`);
		if (!handler) {
			res.status(404).end("not found");
			return;
		}
		try {
			handler(req, res);
		} catch (err) {
			console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
			if (!res.headersSent) res.status(500).end("internal error");
			else res.end();
		}
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	/** 系统通知：发给所有 socket（复用 notice 消息，前端 toast 展示）。 */
	notifyAll(level: "info" | "warning" | "error", text: string): void {
		this.deliverAll({ type: "notice", level, text });
	}

	/** 给指定客户端定向发一条插件消息；找不到该 socket 时静默忽略。 */
	sendTo(clientId: string, pluginId: string, payload: unknown): void {
		for (const s of this.senders) {
			if (s.cid() !== clientId) continue;
			try {
				s.send({ type: "plugin_data", pluginId, payload });
			} catch {
				/* dead socket */
			}
		}
	}

	/** 目录清单 + 当前 epoch 推给所有 socket。 */
	async pushToAll(): Promise<void> {
		const list = await this.scan();
		this.deliverAll({ type: "plugins", plugins: list, epoch: this.epochCounter });
	}

	/** 服务端热重载：反激活全部 → 清缓存 → 重扫重激活 → epoch+1。
	 *  返回新目录清单（含激活结果）。重激活后的插件实例是新模块，
	 *  内存状态为初始值——逐个客户端触发 onAttach 让它们重推自身状态。 */
	async reload(): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		const list = await this.ensureLoaded();
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) this.notifyAttach(cid);
		}
		return list;
	}

	/** 每个客户端 attach 后调用：让各插件向该客户端推送自身完整状态。
	 *  异常隔离——单个插件钩子报错不影响其他插件与其他钩子。 */
	notifyAttach(clientId: string): void {
		for (const [id, p] of this.loaded) {
			for (const h of p.attachHandlers) {
				try {
					h(clientId);
				} catch (err) {
					console.error(`[plugin:${id}] onAttach handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：把 SDK 工具执行事件扇出给所有插件（异常隔离）。 */
	emitToolEvent(ev: PluginToolEvent): void {
		for (const p of this.loaded.values()) {
			for (const h of p.toolHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-event handler failed:`, err);
				}
			}
		}
	}

	/** 当前全部插件注册的 AI 工具（扁平化，按插件 id 稳定排序）。 */
	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const table of [...this.agentTools.values()].sort()) out.push(...table.values());
		return out;
	}
	/** 注册一个供 AI 调用的工具；重名拒绝并返回空操作注销函数。 */
	private registerAgentTool(pluginId: string, tool: PluginAgentTool): () => void {
		if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
			console.error(`[plugin:${pluginId}] registerAgentTool: 缺少 name/description/execute，忽略`);
			return () => {};
		}
		let table = this.agentTools.get(pluginId);
		if (!table) this.agentTools.set(pluginId, (table = new Map()));
		if (table.has(tool.name)) {
			console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 重复注册，忽略`);
			return () => {};
		}
		table.set(tool.name, tool);
		console.log(`[plugin:${pluginId}] registered AI tool: ${tool.name}`);
		try {
			this.onAgentToolsChanged?.();
		} catch (err) {
			console.error("[plugins] onAgentToolsChanged failed:", err);
		}
		return () => {
			if (table.delete(tool.name)) {
				if (table.size === 0) this.agentTools.delete(pluginId);
				try {
					this.onAgentToolsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** 注册斜杠命令：跨插件重名拒绝（先注册者胜出），onCommandsChanged 通知目录刷新。 */
	private registerCommand(pluginId: string, cmd: PluginCommandDef): () => void {
		const name = String(cmd?.name ?? "").replace(/^\/+/, ""); // 容忍误带的前导 /
		if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerCommand: 非法名称「${cmd?.name}」（需字母开头，允许字母数字:_-），忽略`,
			);
			return () => {};
		}
		if (typeof cmd?.run !== "function") {
			console.error(`[plugin:${pluginId}] registerCommand: ${name} 缺少 run，忽略`);
			return () => {};
		}
		for (const [pid, table] of this.pluginCommands) {
			if (table.has(name) && pid !== pluginId) {
				console.error(`[plugin:${pluginId}] 命令 /${name} 已被插件 ${pid} 注册，忽略重复`);
				return () => {};
			}
		}
		let table = this.pluginCommands.get(pluginId);
		if (!table) this.pluginCommands.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] 命令 /${name} 重复注册，忽略`);
			return () => {};
		}
		const def: PluginCommandDef = { ...cmd, name };
		table.set(name, def);
		console.log(`[plugin:${pluginId}] registered command: /${name}`);
		try {
			this.onCommandsChanged?.();
		} catch (err) {
			console.error("[plugins] onCommandsChanged failed:", err);
		}
		return () => {
			if (table!.delete(name)) {
				if (table!.size === 0) this.pluginCommands.delete(pluginId);
				try {
					this.onCommandsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	private deliverAll(msg: ServerMessage): void {
		for (const s of this.senders) {
			try {
				s.send(msg);
			} catch {
				/* dead socket — index.ts cleans it up */
			}
		}
	}

	/** 当前目录清单（重扫 manifest，不重新 import）。 */
	async list(): Promise<UiPluginInfo[]> {
		return this.scan();
	}

	/**
	 * attach 时调用：重扫目录 + 激活尚未加载的新插件。
	 * 返回给浏览器的目录（含激活失败的条目，前端显示为不可用）。
	 */
	async ensureLoaded(): Promise<UiPluginInfo[]> {
		const found = await this.scan();
		for (const info of found) {
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue; // 纯前端插件
			await this.activate(info);
		}
		// 已被删除的插件：调用 deactivate 并移出缓存
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		return found.map((f) => this.loaded.get(f.id)?.info ?? f);
	}

	/** 反激活单个插件：deactivate + 注销 AI 工具 + 清缓存。 */
	private deactivateEntry(id: string, p: LoadedPlugin): void {
		try {
			p.deactivate?.();
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
		for (const off of [...(p.agentToolUnsubscribers ?? [])]) {
			try {
				off();
			} catch {
				/* already gone */
			}
		}
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
		console.log(`[plugin:${id}] removed`);
	}

	/** 关机时反激活全部插件。 */
	dispose(): void {
		for (const [id, p] of this.loaded) {
			try {
				p.deactivate?.();
			} catch (err) {
				console.error(`[plugin:${id}] deactivate failed:`, err);
			}
			for (const off of [...(p.agentToolUnsubscribers ?? []), ...(p.commandUnsubscribers ?? [])]) {
				try {
					off();
				} catch {
					/* shutting down */
				}
			}
			// 反激活时停掉它注册的常驻后台任务（轮询器等），不留孤儿计时器。
			for (const t of this.pluginBgTasks.get(id)?.values() ?? []) {
				try {
					t.stop?.();
				} catch {}
			}
		}
		this.pluginBgTasks.clear();
		this.loaded.clear();
		this.messageHandlers.clear();
	}

	/** 读 manifest 清单；坏目录（无 manifest/id 非法）直接跳过。 */
	private async scan(): Promise<UiPluginInfo[]> {
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
		} catch {
			return []; // 目录不存在 = 没装任何插件
		}
		const out: UiPluginInfo[] = [];
		for (const name of names.sort()) {
			if (!ID_RE.test(name)) continue;
			const dir = join(this.pluginsDir, name);
			try {
				if (!(await stat(dir)).isDirectory()) continue;
				const raw = await readFile(join(dir, "manifest.json"), "utf8");
				const m = JSON.parse(raw) as {
					id?: string;
					name?: string;
					version?: string;
					description?: string;
					icon?: string;
					apiVersion?: number;
					permissions?: unknown;
					settings?: unknown;
				};
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description: typeof m.description === "string" ? m.description : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: this.loaded.get(name)?.info.error,
					// manifest 声明的能力清单（fs/net/tools…）——设置面板展示用
					permissions: Array.isArray(m.permissions)
						? m.permissions.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 16)
						: undefined,
					// 声明式设置 schema + 当前存值（⚙ 面板自动渲染表单用）
					settingsSchema: parseSettingsSchema(m.settings),
					settingsValues: storedSettingsValues(dir, parseSettingsSchema(m.settings)),
					// 安装来源（pi-web-ui install 写入的 .pi-source.json）——
					// 设置面板据此显示「更新」按钮；手工拷入的插件没有此文件。
					source: await readFile(join(dir, ".pi-source.json"), "utf8")
						.then((raw) => {
							try {
								const s = JSON.parse(raw) as { source?: unknown };
								return typeof s.source === "string" && s.source ? s.source : undefined;
							} catch {
								return undefined;
							}
						})
						.catch(() => undefined),
				});
			} catch {
				continue; // 无 manifest / JSON 坏 —— 不是插件
			}
		}
		return out;
	}

	private async activate(info: UiPluginInfo): Promise<void> {
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const httpRoutes = new Map<string, (req: Request, res: Response) => void>();
		const unregisterTools: Array<() => void> = [];
		const unregisterCommands: Array<() => void> = [];
		const bgTaskTable = new Map<string, PluginBgTask>();
		const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();
		// 宿主 API 版本协商：插件要的比宿主新 → 明确拒绝（而不是让它在运行期
		// 撞 undefined 接口莫名其妙地坏）。与激活失败同一处理：error 字段 + 置灰。
		let apiVersion = 1;
		try {
			apiVersion = Number(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).apiVersion ?? 1) || 1;
		} catch {}
		if (apiVersion > PLUGIN_API_VERSION) {
			const msg = `插件要求宿主 API v${apiVersion}，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`;
			console.error(`[plugin:${info.id}] ${msg}`);
			this.loaded.set(info.id, {
				info: { ...info, error: msg },
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			return;
		}
		// 能力声明：写了 permissions → 严格模式（受控宿主 API 按声明族强制执行）；
		// 未写且 apiVersion < 2 → 旧全权模式（首次使用受控 API 时警告一次，v2 起默认拒绝）。
		const permsDeclared = (info.permissions ?? []).slice();
		const strict = permsDeclared.length > 0 || apiVersion >= 2;
		const permFamilies = new Set(permsDeclared.map((x) => x.split(":")[0]!));
		const p: LoadedPlugin = {
			info,
			toolHandlers,
			attachHandlers,
			cwdHandlers,
			commandUnsubscribers: unregisterCommands,
			httpRoutes,
			settingsHandlers,
		};
		p.permsDeclared = permsDeclared;
		p.permFamilies = permFamilies;
		p.legacyWarned = false;
		// 每插件的私有设施：KV 存储 + 加密 secrets + 依赖自动补装（单飞）。
		const storage = new PluginStorage(join(dir, "storage.json"));
		const secrets = new PluginSecrets(this.dataDir, dir);
		// 受限工作区文件访问（能力 "fs" 门控；根随 set_cwd 活值移动）。
		const workspaceFs = new WorkspaceFS(() => self.cwdValue);
		/** 能力门控：严格模式下查声明族；旧模式放行但每个激活期只警告一次。
		 *  返回 false = 已记日志，调用方应拒绝。 */
		const can = (family: string): boolean => {
			if (permFamilies.has(family)) return true;
			if (!strict) {
				if (!p.legacyWarned) {
					p.legacyWarned = true;
					console.warn(
						`[plugin:${info.id}] manifest 未声明 permissions（旧格式全权模式）——已放行 "${family}"；apiVersion 2 起将默认拒绝，请尽快声明`,
					);
				}
				return true;
			}
			console.error(`[plugin:${info.id}] 缺少能力声明 "${family}"（manifest.permissions）——请求被拒`);
			return false;
		};
		const self = this; // 对象字面量 getter 里不能用插件宿主的 this
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text) => this.notifyAll(level, text),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			registerCommand: (cmd) => {
				const off = this.registerCommand(info.id, cmd);
				unregisterCommands.push(off);
				return () => {
					const i = unregisterCommands.indexOf(off);
					if (i >= 0) unregisterCommands.splice(i, 1);
					off();
				};
			},
			storage,
			secrets,
			ensureDeps: (specs, opts) => ensurePluginDeps(dir, specs ?? [], opts?.onProgress),
			route: (method, path, handler) => {
				if (!can("http")) return () => {};
				const m = String(method ?? "GET").toUpperCase();
				if (
					!["GET", "POST", "PUT", "DELETE"].includes(m) ||
					typeof path !== "string" ||
					!path.startsWith("/") ||
					typeof handler !== "function"
				) {
					console.error(`[plugin:${info.id}] route: 非法参数（method=${method} path=${path}），忽略`);
					return () => {};
				}
				httpRoutes.set(`${m} ${path}`, handler);
				return () => httpRoutes.delete(`${m} ${path}`);
			},
			// 包一层：插件反激活时自动注销它注册的全部 AI 工具，不留悬挂项。
			registerAgentTool: (tool) => {
				if (!can("tools")) return () => {};
				const off = this.registerAgentTool(info.id, tool);
				unregisterTools.push(off);
				return () => {
					const i = unregisterTools.indexOf(off);
					if (i >= 0) unregisterTools.splice(i, 1);
					off();
				};
			},
			dir,
			dataDir: this.dataDir,
			get cwd() {
				return self.cwdValue;
			},
			fs: {
				list: (relDir) => (can("fs") ? workspaceFs.list(relDir) : NO_FS_PROMISE),
				read: (p) => (can("fs") ? workspaceFs.read(p) : NO_FS_PROMISE),
				readText: (p, max) => (can("fs") ? workspaceFs.readText(p, max) : NO_FS_PROMISE),
				write: (p, data) => (can("fs") ? workspaceFs.write(p, data) : NO_FS_PROMISE),
				remove: (p) => (can("fs") ? workspaceFs.remove(p) : NO_FS_PROMISE),
			},
			registerBackgroundTask: (task) => {
				const id = String(task?.id ?? "").trim();
				if (!id || bgTaskTable.has(id)) {
					console.error(`[plugin:${info.id}] registerBackgroundTask: 非法/重复 id「${task?.id}」，忽略`);
					return { update: () => {}, unregister: () => {} };
				}
				const entry: PluginBgTask = {
					id,
					label: String(task?.label ?? id),
					since: Date.now(),
					...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
					...(typeof task?.status === "string" ? { status: task.status } : {}),
				};
				bgTaskTable.set(id, entry);
				this.pluginBgTasks.set(info.id, bgTaskTable);
				const fire = () => {
					try {
						this.onBgTasksChanged?.();
					} catch {}
				};
				fire();
				return {
					update: (next) => {
						if (!bgTaskTable.has(id)) return;
						if (next.label !== undefined) entry.label = String(next.label);
						if (next.status !== undefined) entry.status = next.status;
						if (typeof next.stop === "function") entry.stop = next.stop;
						fire();
					},
					unregister: () => {
						if (bgTaskTable.delete(id)) {
							if (bgTaskTable.size === 0) this.pluginBgTasks.delete(info.id);
							fire();
						}
					},
				};
			},
			getSettings: () => storedSettingsValues(dir, info.settingsSchema ?? []),
			onSettingsChanged: (h) => {
				settingsHandlers.add(h);
				return () => settingsHandlers.delete(h);
			},
			log: (...args) => console.log(`[plugin:${info.id}]`, ...args),
		};
		try {
			// Node 对同一 URL 的 import() 永远返回缓存模块——追加 epoch 作查询串
			// 击穿缓存，让 plugins_reload 后的重新激活能拿到磁盘上的新代码。
			const mod = (await import(pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`)) as {
				default?: {
					activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
				};
			};
			const ret = await mod.default?.activate?.(host);
			this.loaded.set(info.id, {
				info: { ...info },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				agentToolUnsubscribers: unregisterTools,
				commandUnsubscribers: unregisterCommands,
				httpRoutes,
				settingsHandlers,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
			// 首次安装/能力变更提醒（尽力而为）：<dir>/.pi-approved 记录上次激活时
			// 的能力清单——新装或 permissions 变更后向在线客户端推一条警告通知，
			// 用户装前可见、日常启动不打扰。
			void this.maybeConsentNotice(info, dir, permsDeclared);
		} catch (err) {
			httpRoutes.clear();
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message },
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		}
	}
}

/**
 * 把 /plugins/:id/client/<rest> 安全映射到 <pluginsDir>/<id>/client/<rest>。
 * 返回绝对路径；任何越界/非法 id 返回 null（调用方回 404）。
 */
export function resolvePluginClientFile(pluginsDir: string, id: string, rest: string): string | null {
	if (!ID_RE.test(id)) return null;
	const root = resolve(join(pluginsDir, id, "client"));
	// rest 由 express 路由保证不带 ".."，但双保险：resolve 后必须仍在 root 内
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

/**
 * 把插件 AI 工具定义同步进一个「会话状对象」（SDK AgentSession 的结构子集：
 * 内部 _customTools 数组 + _refreshToolRegistry()——refresh 会重读数组，且新
 * 工具名自动加入活跃集）。新增/更新/移除三向 diff；对象不兼容（SDK 改名）返回
 * null 由调用方静默降级。返回新的已注入名单。
 *
 * 纯函数、不 import SDK —— vitest 直接测（tests/unit/plugin-tools.test.ts）。
 */
export function syncPluginToolsIntoSession(
	session: {
		_customTools?: Array<{ name: string } & Record<string, unknown>>;
		_refreshToolRegistry?: () => void;
	},
	defs: Array<{ name: string } & Record<string, unknown>>,
	prevNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const byName = new Map(session._customTools.map((d) => [d.name, d]));
	let changed = false;
	for (const d of defs) {
		if (byName.get(d.name) !== d) {
			byName.set(d.name, d);
			changed = true;
		}
	}
	for (const name of prevNames) {
		if (!defs.some((d) => d.name === name) && byName.has(name)) {
			byName.delete(name);
			changed = true;
		}
	}
	if (!changed) return new Set(defs.map((d) => d.name));
	session._customTools = [...byName.values()];
	session._refreshToolRegistry();
	return new Set(defs.map((d) => d.name));
}
