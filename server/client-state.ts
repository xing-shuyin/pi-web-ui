/**
 * client-state — 每浏览器客户端的持久化 UI 状态（<dataDir>/client-state.json）：
 * 最近项目/工作目录、目标审查偏好、设置面板状态（提示词模式 + 技能/插件开关 +
 * 视觉桥偏好）、命名预设。文件 I/O 一律 best-effort：持久化故障绝不能
 * 弄崩 server 或阻塞会话。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { normalizeSoftCapByModel, normalizeSoftCapTokens } from "./soft-cap.js";
import { deriveLegacy, legacyToDisabled, normalizeDisabledAgentTools } from "./tool-manager.js";
import type { UiAlign, UiLayoutPrefs } from "./protocol.js";

/** System-prompt mode: append the custom text to the built prompt, or replace
 *  the whole system prompt with it. (遗留字段：主会话已迁移到 compose 模板，
 *  仅 DSH 子系统与旧存档仍读写它。) */
export type PromptMode = "append" | "replace";

/** 大模型 API 出错自动重试次数的默认值（SDK 默认 3）。 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 6;

/** 工具执行看门狗超时的默认值（默认 20 分钟；环境变量 PI_WEB_TOOL_TIMEOUT_MS 覆盖）。 */
export const DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v >= 0 ? v : 20 * 60_000;
})();

/** 归一化工具看门狗超时（毫秒）：0 = 禁用；非数值、负数或空值回落默认值，非负整数保留。 */
export function normalizeToolWatchdogTimeoutMs(v: unknown): number {
	if (v === null || v === undefined || v === "") return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS;
	return n;
}

/** 工具自己声明超时时留给它的余量（毫秒）：让工具先自己超时并返回错误，
 *  而不是看门狗先下手把整轮对话 abort 掉。 */
export const TOOL_WATCHDOG_EXPLICIT_GRACE_MS = 5_000;

/** 计算单次工具调用的有效看门狗超时（毫秒；≤0 = 不布看门狗）。
 *  基础值来自设置/环境变量（见 DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS）；**若工具调用
 *  自己声明了更长的超时**（目前只有 bash 的 `args.timeout`，单位秒），自动顺延到
 *  「工具超时 + 余量」—— 否则 AI 明确要求跑 90 分钟的命令，会被 20 分钟的看门狗
 *  连同整轮对话一起剁掉。纯函数，可单测。 */
export function effectiveToolWatchdogMs(baseMs: number, toolName?: string, args?: unknown): number {
	if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
	let ms = baseMs;
	if (toolName === "bash" && args && typeof args === "object") {
		const raw = (args as { timeout?: unknown }).timeout;
		const sec = typeof raw === "number" ? raw : Number(raw);
		if (Number.isFinite(sec) && sec > 0) ms = Math.max(ms, sec * 1000 + TOOL_WATCHDOG_EXPLICIT_GRACE_MS);
	}
	return ms;
}

/** 归一化插件 AI 工具禁用名单：只收非空字符串（去重，上限 256 个）。
 *  与 disabledAgentTools 不同——插件工具名是动态的（注册才知道），不能按
 *  固定目录校验；未知/已卸载插件的条目刻意保留（重装后仍保持关闭）。
 *  纯函数，可单测。 */
export function normalizeDisabledPluginTools(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== "string") continue;
		const name = x.trim();
		if (!name || name.length > 128 || out.includes(name)) continue;
		out.push(name);
		if (out.length >= 256) break;
	}
	return out;
}

/** 归一化重试次数：非数值回落默认，钳制到 [0, 100] 整数。 */
export function normalizeRetryMaxAttempts(v: unknown): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_RETRY_MAX_ATTEMPTS;
	return Math.min(100, Math.max(0, n));
}

/**
 * 归一化 UI 布局偏好（UiLayoutPrefs）：只收字符串数组 / 字符串字典，去重 + 长度上限。
 * 脏数据（数字、对象、超长 key、嵌套）一律丢弃而不是整份回落 —— 用户手动调过的那部分
 * 不该因为插件写坏了一个字段就全丢。
 */
export function normalizeUiLayout(v: unknown): UiLayoutPrefs {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const o = v as Record<string, unknown>;
	const arr = (x: unknown, max: number): string[] | undefined => {
		if (!Array.isArray(x)) return undefined;
		const out = [
			...new Set(x.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 96)),
		].slice(0, max);
		return out.length ? out : undefined;
	};
	const dict = (x: unknown, max: number): Record<string, string> | undefined => {
		if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(x as Record<string, unknown>).slice(0, max)) {
			if (k.length > 0 && k.length <= 96 && typeof val === "string" && val.length > 0 && val.length <= 120) {
				out[k] = val;
			}
		}
		return Object.keys(out).length ? out : undefined;
	};
	// 品牌二合一迁移：旧 host:brand-logo/host:brand-name → host:brand（去重；显式新值赢）。
	const BRAND_NEW = "host:brand";
	const isBrandOld = (id: string): boolean => id === "host:brand-logo" || id === "host:brand-name";
	const mapBrandList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = isBrandOld(id) ? BRAND_NEW : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out.length ? out : undefined;
	};
	/** 旧品牌 key 折进 host:brand：logo 优先还是名称优先由调用方定（对齐/分组跟 logo，走名称）。 */
	const foldBrandDict = (
		src: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!src) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(src)) {
			if (isBrandOld(k)) continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = logoFirst
				? (src["host:brand-logo"] ?? src["host:brand-name"])
				: (src["host:brand-name"] ?? src["host:brand-logo"]);
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		return Object.keys(out).length ? out : undefined;
	};
	const hidden = mapBrandList(arr(o.hidden, 200));
	const shown = mapBrandList(arr(o.shown, 200));
	const order = mapBrandList(arr(o.order, 200));
	const groups = foldBrandDict(dict(o.groups, 200), true);
	const labels = foldBrandDict(dict(o.labels, 200), false);
	// 用户对齐：只收 start/center/end（手改脏值回落丢弃，不污染合并结果）。
	let align: Record<string, UiAlign> | undefined;
	if (o.align && typeof o.align === "object" && !Array.isArray(o.align)) {
		align = {};
		for (const [k, val] of Object.entries(o.align as Record<string, unknown>).slice(0, 200)) {
			if (k.length > 0 && k.length <= 96 && (val === "start" || val === "center" || val === "end")) {
				align[k] = val;
			}
		}
		if (Object.keys(align).length === 0) align = undefined;
	}
	// 品牌对齐同样折进 host:brand（跟 logo 的值，显式新值赢）。
	if (align && ("host:brand-logo" in align || "host:brand-name" in align)) {
		const out: Record<string, UiAlign> = {};
		for (const [k, val] of Object.entries(align)) {
			if (k === "host:brand-logo" || k === "host:brand-name") continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = align["host:brand-logo"] ?? align["host:brand-name"];
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		align = Object.keys(out).length ? out : undefined;
	}
	// 顶栏按钮文字总开关：只收布尔值（缺席 = 显示，兼容老存档）。
	const topbarText = typeof o.topbarText === "boolean" ? (o.topbarText as boolean) : undefined;
	return {
		...(hidden ? { hidden } : {}),
		...(shown ? { shown } : {}),
		...(order ? { order } : {}),
		...(groups ? { groups } : {}),
		...(align ? { align } : {}),
		...(labels ? { labels } : {}),
		...(topbarText !== undefined ? { topbarText } : {}),
	};
}

/** 归一化技能名单：字符串数组原样过滤；其他（含旧 bool 开关）回落空数组。 */
export function normalizeSkillList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Settings-panel state (system prompt + disabled skills/extensions). */
export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	/** 组合模板（主会话系统提示词 = 自由拼装 {{token}}，见 server/prompt-composer.ts）。
	 *  空 = 默认模板（全部自动段按自然顺序）；promptMode/customSystemPrompt 为
	 *  遗留字段（旧存档迁移到 overrides，DSH 仍共用存储）。 */
	promptTemplate: string;
	/** 每个来源 token 的独立覆盖文本（空串/缺省 = 用该来源的自动内容）。 */
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Persistent-terminal tools on/off（遗留别名，兼容旧客户端/旧存档；以 disabledAgentTools 为准同步）。 */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）。开 → bash 工具的执行体改为持久终端：命令在可见
	 *  PTY 里跑、跨调用保留 shell 状态（cd/venv/ssh），静默超阈值自动转后台。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值（毫秒，默认 15000；0 = 一直等到结束）。 */
	terminalBashIdleMs: number;
	/** 接管模式下 bash 前台最长等待毫秒（默认 60000 即 60 秒；0 = 不限）。 */
	terminalBashMaxForegroundMs: number;
	/** 工具执行看门狗超时（毫秒，默认 20 分钟；0 = 禁用看门狗）。
	 *  单个工具调用的最长执行时长，超时自动 abort 会话以防挂死。
	 *  若工具调用显式指定了更长超时（如 bash timeout），看门狗将自动顺延。
	 *  逐 run 实时读取，设置即时生效，无需 reload runtime。 */
	toolWatchdogTimeoutMs: number;
	/** read 工具读目录开关（默认开，见 server/read-tool.ts）：开 → read(目录路径)
	 *  列出目录条目；关 → 原样交回内置 read。行为开关（read 本体不可关），
	 *  覆盖定义每次调用实时读取，无需 reload。 */
	readDirEnabled: boolean;
	/** Agent 工具禁用名单（统一开关，见 tool-manager.ts；live 生效无需 reload）。 */
	disabledAgentTools: string[];
	/** 插件 AI 工具禁用名单（工具名全局唯一；live 生效无需 reload；
	 *  可选字段：旧存档缺省 = 空（全开）。运行时门控，随设置预设走（同 disabledAgentTools）。 */
	disabledPluginTools?: string[];
	/** edit_soft 工具开关（遗留别名，兼容旧客户端/旧存档；以 disabledAgentTools 为准同步）。 */
	editSoftEnabled: boolean;
	/** 问卷提问开关（默认开；关 → 不弹对话框且 ask_user_question 工具同步禁用。不进预设）。 */
	questionnaireEnabled: boolean;
	/** 同项目并行提醒开关（默认开）。关 → 同一项目另有对话在跑时不再发 notice，
	 *  也不给 AI 注提醒、不通知对端。纯运行开关，不进预设、不需 reload。 */
	parallelReminderEnabled: boolean;
	/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
	 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，不进预设、不需 reload。 */
	goalModeEnabled: boolean;
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (same semantics as promptMode). */
	visionBridgePromptMode: PromptMode;
	/** Custom vision-bridge transcription prompt text (empty = built-in default). */
	visionBridgePrompt: string;
	/** SCM「AI 生成提交信息」提示词模式：追加/替换内置提示词（语义同 promptMode）。 */
	scmCommitMsgPromptMode: PromptMode;
	/** SCM「AI 生成提交信息」自定义提示词（空 = 内置默认）。 */
	scmCommitMsgPrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** Installed UI plugins hidden in the settings panel (UI-only toggle).
	 *  Optional: presets deliberately do NOT capture it (same as the
	 *  vision-bridge prefs) — applying a preset keeps the current toggles. */
	disabledPlugins?: string[];
	/** 宿主 UI 布局的用户偏好（插件 UI 贡献 + 宿主内置条目的隐藏/排序/分组，
	 *  见 protocol 的 UiLayoutPrefs）。纯 UI 偏好，与 disabledPlugins 一样不进预设。 */
	uiLayout?: UiLayoutPrefs;
	/** 思考块默认折叠与否（默认关 = 折叠；开 = 始终完整展开并自动换行，流式推理
	 *  也实时可见）。纯 UI 偏好，与视觉桥 / disabledPlugins 一样不进预设。 */
	thinkingWrap: boolean;
	/** 开发模式：index.html 不缓存（源码运行默认开，安装包默认关）。 */
	devNoCache?: boolean;
	/** 新构建就绪自动重载页面（源码运行默认开，安装包默认关）。 */
	autoReload?: boolean;
	/** 新构建就绪自动重载页面（源码运行默认开，安装包默认关）。 */
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。纯 UI 偏好，不进预设。 */
	toolsWrap: boolean;
	/** 工具结果里的图片直接显示（默认开 = 卡片里出缩略图、点开放大；关 = 不渲染）。
	 *  纯 UI 偏好，不进预设。 */
	toolImagesEnabled: boolean;
	/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能 {{skills}} 展开正文
	 *  （oh-my-pi 式全文注入；单文件 8KB、总量 32KB 封顶，超限回落名录）。
	 *  进预设；逐 run 实时读取，改动下一轮即生效。 */
	skillsFullText: string[];
	/** 子代理默认模型 ("provider/id")；null/未设 = 跟随主对话当前模型。不改会话右侧栏的模型。 */
	subagentDefaultModel?: string | null;
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。SDK
	 *  settings.retry.maxRetries 的按客户端覆盖（SDK 默认 3），经
	 *  applyOverrides 注入各会话的 SettingsManager（session.reload()
	 *  会重读磁盘，需重放）。 */
	retryMaxAttempts: number;
	/** 上下文压缩软上限（tokens，0 = 关闭）：会话 tokens 达到即触发压缩，
	 *  而不是堆到物理上限。防阶梯计费翻倍 + 长上下文降智（issue #229）。
	 *  经 compaction reserveTokens 覆盖注入 SDK（见 server/soft-cap.ts）。 */
	softCapTokens: number;
	/** 按模型覆盖软上限（key = "provider/id"，value > 0 才生效，缺省用全局）。 */
	softCapByModel: Record<string, number>;
	/** 输入框上方的快捷短语（点击即发送）。纯 UI 偏好，不进预设、不需 reload。 */
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	/** DSH Agent 预设默认（新会话取值；pi 引擎忽略）。全局共享，不进设置预设。 */
	defaultAgentPreset?: string;
	/** DSH 新会话默认权限预设（三档之一；pi 引擎忽略）。全局共享，不进设置预设。 */
	defaultPermissionPreset?: string;
}

/** A named combo of prompt + skill/extension toggles the user can re-apply.
 *  Vision-bridge prefs are intentionally NOT part of a preset — they stay
 *  whatever the user currently has set when a preset is applied. */
export interface SettingsPreset extends Omit<
	ClientSettings,
	| "visionBridgeEnabled"
	| "visionBridgeModel"
	| "visionBridgePromptMode"
	| "visionBridgePrompt"
	| "scmCommitMsgPromptMode"
	| "scmCommitMsgPrompt"
	| "questionnaireEnabled"
	| "goalModeEnabled"
	| "parallelReminderEnabled"
	// 纯运行行为开关（不进预设：应用预设时保持当前值）。
	| "readDirEnabled"
	| "toolWatchdogTimeoutMs"
	| "thinkingWrap"
	| "toolsWrap"
	| "toolImagesEnabled"
	| "devNoCache"
	| "autoReload"
	| "subagentDefaultModel"
	| "quickPhrases"
	| "quickPhrasesEnabled"
> {
	name: string;
}

/** Stable identity of an extension for the enable/disable toggle: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

/** All identities an extension may be disabled by. The SDK applies
 *  `sourceInfo` only AFTER extensionsOverride runs (resource-loader reload():
 *  override first, applyExtensionSourceInfo second), so inside the override a
 *  package extension still has no sourceInfo and extensionKey() falls back to
 *  the raw entry path — which never matches the "npm:<pkg>" id the settings
 *  panel stores. Derive the package name from the entry path
 *  (.../node_modules/<pkg>/... or .../node_modules/@scope/<pkg>/...) so both
 *  sides agree. */
export function extensionKeyCandidates(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string[] {
	const keys = new Set<string>([extensionKey(e)]);
	const norm = e.path.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const idx = norm.lastIndexOf(marker);
	if (idx !== -1) {
		const segs = norm.slice(idx + marker.length).split("/");
		// Scoped package @scope/name spans two segments.
		const name = segs[0]?.startsWith("@") && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
		if (name) keys.add(`npm:${name}`);
	}
	return [...keys];
}

/** Whether an extension is covered by the disabled list (any identity match). */
export function isExtensionDisabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
	},
	disabled: readonly string[],
): boolean {
	if (disabled.length === 0) return false;
	const keys = extensionKeyCandidates(e);
	return disabled.some((d) => keys.includes(d));
}

/** Whether an extension is covered by an ENABLED whitelist (any identity
 *  match). Empty whitelist = not whitelisting = everything allowed. Used by
 *  subagent templates（白名单语义：模板勾选 = 子代理只加载这些扩展）。 */
export function isExtensionEnabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
	},
	enabled: readonly string[],
): boolean {
	if (enabled.length === 0) return true;
	const keys = extensionKeyCandidates(e);
	return enabled.some((d) => keys.includes(d));
}

/** 额外工作区根（宿主侧多根，issue #146）上限：右栏文件树可切换的根数量。 */
export const MAX_WORKSPACE_ROOTS = 8;

/**
 * 归一化「额外工作区根」列表：只收**绝对路径**（相对路径在服务端没有任何可靠基准）、
 * 去重（win32 折大小写）、上限 MAX_WORKSPACE_ROOTS，并 resolve 成规范形式以便与工作区
 * 做前缀比较。脏数据（数字/空串/对象）逐个丢弃而不是整份回落 —— 用户加过的根不该因为
 * 前端传坏了一个元素就全丢。
 */
export function normalizeWorkspaceRoots(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of v) {
		if (typeof raw !== "string") continue;
		const p = raw.trim();
		if (!p || !isAbsolute(p)) continue;
		const abs = resolve(p);
		const key = process.platform === "win32" ? abs.toLowerCase() : abs;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(abs);
		if (out.length >= MAX_WORKSPACE_ROOTS) break;
	}
	return out;
}

export interface MarkerSettings {
	markersEnabled: boolean;
	disabledMarkers: string[];
}

export interface ClientState {
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most recent first (capped at 30). */
	projects: { path: string; lastUsed: number }[];
	/** Last-used goal / review preferences (model choice, max rounds, locked) so
	 *  they survive a reload — "全局记忆". maxRounds: 0 means unlimited. The model
	 *  choice is shared by both the goal-reviewer and the goal-wizard. */
	goalPrefs?: {
		reviewModel: string | null;
		maxRounds: number;
		locked: boolean;
	};
	/** Settings-panel state (system prompt mode/text + disabled skills/
	 *  extensions) so toggles survive a reload. */
	settings?: ClientSettings;
	/** Named settings presets (prompt + skill/extension toggles combos). */
	presets?: SettingsPreset[];
	/** Conversations that were STILL STREAMING when the server last shut down
	 *  (SIGTERM / self-update restart). Consumed once on the next attach so
	 *  the user learns a run was lost instead of wondering where it went. */
	interrupted?: { title: string; cwd: string; at: number; sessionFile?: string }[];
	/** Workspaces the user explicitly removed from the recent list. Kept as
	 *  tombstones so cwds re-discovered from session files stay hidden until
	 *  the workspace is opened again. */
	removedProjects?: string[];
	/** 每个项目（cwd）的**额外工作区根**（宿主侧多根，issue #146，见 protocol 的
	 *  set_workspace_roots）。AI 仍只在主 cwd 里干活；右栏文件树可跨这些根浏览，
	 *  插件的受支持路径（host.fs / host.project.create）也把这些根当作「工作区内」。
	 *  空数组/缺省 = 单根。按项目存：切项目各带各自的多根。 */
	workspaceRoots?: Record<string, string[]>;
	/** Per-project provider key preference: cwd -> provider -> keyName.
	 *  Remember which key was last used for each provider in each project,
	 *  so switching projects restores the correct key (model is already
	 *  per-conversation, but key was global). */
	projectProviderKeys?: Record<string, Record<string, string>>;
	/** Per-project model preference: cwd -> "provider/id". Saved IMMEDIATELY when
	 *  the user selects a model (not only after a turn — the SDK only flushes a
	 *  model_change entry to disk once an assistant message exists, so a fresh
	 *  conversation's model choice would otherwise be lost on project switch).
	 *  Together with projectProviderKeys it makes the whole {model, key} pair
	 *  project-bound, so switching back restores both right away. */
	projectModels?: Record<string, string>;
	/** 全局默认模型（"provider/id"，跨项目、新项目回落用）。
	 *  存在全局键 __settings__ 下（见 GLOBAL_SETTINGS_KEY 注释：clientId 每标签页独立，
	 *  放 per-client 下新标签页会丢），所有客户端共享、服务端持久化、重启不丢。
	 *  优先级：项目记忆 projectModels[cwd] > 全局默认 > SDK 默认。 */
	defaultModel?: string;
	/** 全局默认模型各 provider 当时用的 key（provider -> keyName），随全局默认一起记；
	 *  新项目回落到全局默认模型时一并恢复 key（同 projectProviderKeys 的作用）。 */
	defaultProviderKeys?: Record<string, string>;
	/** 内置标记工具开关（全局 + 按 marker 禁用）。 */
	markers?: MarkerSettings;
	/** Browser UI locale code as reported by hello/set_locale (e.g. "zh",
	 *  "en", "ja"). Server resolves it via resolveServerLang (non-zh →
	 *  English default, issue #91) for tool return values / AI prompts.
	 *  Missing = never reported → English. */
	locale?: string;
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	/** 长期设置（设置面板 config + 预设 + 标记开关）的固定存储键。
	 *
	 * 为什么用固定全局键而非 per-clientId：clientId 存 sessionStorage（每标签页独立、
	 * 关浏览器即失），按 clientId 存设置会在每次新会话/重启后生成新 id → 设置全部重置、
	 * 且各标签页/浏览器各有一套互不同步。改为全局共享后：所有客户端（标签页/浏览器）
	 * 使用同一套配置，且持久化在服务端，重启不丢（「同一套配置」）。会话级状态
	 * （最近项目 / lastCwd / 项目模型与密钥等）仍按 clientId 各自保留。 */
	private static readonly GLOBAL_SETTINGS_KEY = "__settings__";

	/** <dataDir>（client-state.json 的上一级）——共享配置（子代理模板库等）落在这里。 */
	get dataDir(): string {
		return dirname(this.filePath);
	}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, ClientState>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			// Atomic write (tmp + rename): a crash mid-write must never leave a
			// half-written JSON — that would wipe ALL persisted state (recent
			// projects / presets / settings / goal prefs) on next load.
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
			renameSync(tmp, this.filePath);
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Remember which workspace a client last used; bumps its project entry. */
	remember(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.lastCwd = cwd;
		const now = Date.now();
		state.projects = [{ path: cwd, lastUsed: now }, ...state.projects.filter((p) => p.path !== cwd)].slice(0, 30);
		// Opening the workspace again clears its removal tombstone across all clients and global settings.
		for (const cState of Object.values(all)) {
			if (cState.removedProjects?.length) {
				cState.removedProjects = cState.removedProjects.filter((p) => p !== cwd);
			}
		}
		this.save();
	}

	/** Drop one workspace from the recent-project list (user-requested removal).
	 *  Records a tombstone too: pushProjects() re-discovers cwds from session
	 *  files on every listing, so without it the entry would instantly reappear.
	 *  Recorded in both the requesting client and GLOBAL_SETTINGS_KEY so the
	 *  removal stays across all browser tabs and server restarts until the user
	 *  explicitly opens that project again. */
	removeProject(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.projects = state.projects.filter((p) => p.path !== cwd);
		if (state.lastCwd === cwd) delete state.lastCwd;
		const removed = new Set(state.removedProjects ?? []);
		removed.add(cwd);
		state.removedProjects = [...removed];

		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const globalRemoved = new Set(globalState.removedProjects ?? []);
		globalRemoved.add(cwd);
		globalState.removedProjects = [...globalRemoved];

		for (const [id, cState] of Object.entries(all)) {
			if (id !== ClientStateStore.GLOBAL_SETTINGS_KEY && cState.projects) {
				cState.projects = cState.projects.filter((p) => p.path !== cwd);
			}
		}
		this.save();
	}

	/** Tombstoned projects (explicitly removed by the user) for filtering the
	 *  merged recent-project list across clients. */
	getRemovedProjects(clientId: string): string[] {
		const all = this.load();
		const clientRemoved = all[clientId]?.removedProjects ?? [];
		const globalRemoved = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.removedProjects ?? [];
		if (globalRemoved.length === 0) return clientRemoved;
		if (clientRemoved.length === 0) return globalRemoved;
		return [...new Set([...clientRemoved, ...globalRemoved])];
	}

	/** Last-used goal/review prefs for a client, or undefined if never set. */
	getGoalPrefs(clientId: string): ClientState["goalPrefs"] {
		const s = this.load()[clientId];
		if (!s?.goalPrefs) return undefined;
		return {
			reviewModel: s.goalPrefs.reviewModel ?? null,
			maxRounds: s.goalPrefs.maxRounds ?? 0,
			locked: s.goalPrefs.locked ?? true,
		};
	}

	/** 某项目当前的额外工作区根（空数组 = 单根）。 */
	getWorkspaceRoots(clientId: string, cwd: string): string[] {
		return this.load()[clientId]?.workspaceRoots?.[cwd] ?? [];
	}

	/** 记下某项目的额外工作区根（空数组 = 清掉该项目的键，不留空壳）。 */
	saveWorkspaceRoots(clientId: string, cwd: string, roots: string[]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		const next = normalizeWorkspaceRoots(roots);
		if (next.length === 0) {
			if (state.workspaceRoots) {
				delete state.workspaceRoots[cwd];
				if (Object.keys(state.workspaceRoots).length === 0) delete state.workspaceRoots;
			}
			this.save();
			return;
		}
		(state.workspaceRoots ??= {})[cwd] = next;
		this.save();
	}

	/** Persist the client's UI locale code (hello/set_locale; best-effort). */
	saveLocale(clientId: string, locale: string): void {
		const code = locale.trim().slice(0, 16);
		if (!code) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		if (state.locale === code) return;
		state.locale = code;
		this.save();
	}

	/** Persist the client's goal/review preferences (model choice, rounds, lock). */
	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.goalPrefs = {
			reviewModel: prefs?.reviewModel ?? null,
			maxRounds: prefs?.maxRounds ?? 0,
			locked: prefs?.locked ?? true,
		};
		this.save();
	}

	/** Remember conversations that were still streaming at shutdown (best-
	 *  effort; called during the graceful-shutdown path). */
	saveInterrupted(clientId: string, list: { title: string; cwd: string; at: number; sessionFile?: string }[]): void {
		if (list.length === 0) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.interrupted = list.slice(0, 8);
		this.save();
	}

	/** Consume the interrupted-conversation record (returns and clears it) —
	 *  called once on the client's first attach after a restart. */
	takeInterrupted(clientId: string): ClientState["interrupted"] {
		const all = this.load();
		const state = all[clientId];
		const list = state?.interrupted;
		if (list?.length && state) {
			delete state.interrupted;
			this.save();
		}
		return list;
	}

	/** 设置面板状态（系统提示词模式/文字 + 禁用技能/扩展）——全局共享同一套配置。 */
	getSettings(_clientId: string): ClientSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY];
		const stored = s?.settings;
		// 旧存档（promptMode/customSystemPrompt）迁移到 compose：追加文字成为独立
		// {{append}} 覆盖、替换文字成为 {{soul}} 覆盖；无自定义则用默认模板。
		let promptTemplate = "";
		let promptOverrides: Record<string, string> = {};
		if (stored?.promptTemplate !== undefined) {
			promptTemplate = stored.promptTemplate ?? "";
			promptOverrides = { ...stored?.promptOverrides };
		} else if (stored && typeof stored.customSystemPrompt === "string" && stored.customSystemPrompt.trim()) {
			promptOverrides = {
				[stored.promptMode === "replace" ? "soul" : "append"]: stored.customSystemPrompt,
			};
		}
		return {
			promptMode: stored?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: stored?.customSystemPrompt ?? "",
			promptTemplate,
			promptOverrides,
			disabledSkills: stored?.disabledSkills ?? [],
			disabledExtensions: stored?.disabledExtensions ?? [],
			disabledAgentTools: legacyToDisabled(stored ?? {}),
			disabledPluginTools: normalizeDisabledPluginTools(stored?.disabledPluginTools),
			// 新字段已存在时遗留三开关以它为准推导（旧文件才读遗留值），保证两边一致。
			terminalToolsEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).terminalToolsEnabled
					: (stored?.terminalToolsEnabled ?? false),
			terminalBash: stored?.terminalBash ?? false,
			terminalBashIdleMs: stored?.terminalBashIdleMs ?? 15_000,
			terminalBashMaxForegroundMs: stored?.terminalBashMaxForegroundMs ?? 60_000,
			toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(stored?.toolWatchdogTimeoutMs),
			readDirEnabled: stored?.readDirEnabled ?? true,
			editSoftEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).editSoftEnabled
					: (stored?.editSoftEnabled ?? false),
			questionnaireEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).questionnaireEnabled
					: (stored?.questionnaireEnabled ?? true),
			goalModeEnabled: stored?.goalModeEnabled ?? true,
			parallelReminderEnabled: stored?.parallelReminderEnabled ?? true,
			thinkingWrap: stored?.thinkingWrap ?? false,
			devNoCache: stored?.devNoCache,
			autoReload: stored?.autoReload,
			toolsWrap: stored?.toolsWrap ?? true,
			toolImagesEnabled: stored?.toolImagesEnabled ?? true,
			skillsFullText: normalizeSkillList(stored?.skillsFullText),
			visionBridgeEnabled: stored?.visionBridgeEnabled ?? true,
			visionBridgeModel: stored?.visionBridgeModel ?? null,
			visionBridgePromptMode: stored?.visionBridgePromptMode === "replace" ? "replace" : "append",
			visionBridgePrompt: stored?.visionBridgePrompt ?? "",
			scmCommitMsgPromptMode: stored?.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
			scmCommitMsgPrompt: stored?.scmCommitMsgPrompt ?? "",
			subagentDefaultModel: stored?.subagentDefaultModel ?? null,
			retryMaxAttempts: normalizeRetryMaxAttempts(stored?.retryMaxAttempts),
			softCapTokens: normalizeSoftCapTokens(stored?.softCapTokens),
			softCapByModel: normalizeSoftCapByModel(stored?.softCapByModel),
			quickPhrases: stored?.quickPhrases ?? [],
			quickPhrasesEnabled: stored?.quickPhrasesEnabled ?? true,
			reviewPrompt: stored?.reviewPrompt ?? "",
			reviewDisabledSkills: stored?.reviewDisabledSkills ?? [],
			disabledPlugins: stored?.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(stored?.uiLayout),
			defaultAgentPreset:
				typeof stored?.defaultAgentPreset === "string" && stored.defaultAgentPreset
					? stored.defaultAgentPreset
					: "standard",
			defaultPermissionPreset:
				typeof stored?.defaultPermissionPreset === "string" && stored.defaultPermissionPreset
					? stored.defaultPermissionPreset
					: "workspace-write-never",
		};
	}

	/** Persist the settings-panel state (partial merge) — global shared config. */
	saveSettings(_clientId: string, settings: Partial<ClientSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.settings ?? ({} as ClientSettings);
		state.settings = {
			promptMode: settings.promptMode ?? cur.promptMode ?? "append",
			customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
			promptTemplate: settings.promptTemplate ?? cur.promptTemplate ?? "",
			promptOverrides: { ...(settings.promptOverrides ?? cur.promptOverrides) },
			disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
			disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
			disabledAgentTools: normalizeDisabledAgentTools(settings.disabledAgentTools ?? cur.disabledAgentTools),
			disabledPluginTools: normalizeDisabledPluginTools(settings.disabledPluginTools ?? cur.disabledPluginTools),
			terminalToolsEnabled: settings.terminalToolsEnabled ?? cur.terminalToolsEnabled ?? false,
			terminalBash: settings.terminalBash ?? cur.terminalBash ?? false,
			terminalBashIdleMs: settings.terminalBashIdleMs ?? cur.terminalBashIdleMs ?? 15_000,
			terminalBashMaxForegroundMs: settings.terminalBashMaxForegroundMs ?? cur.terminalBashMaxForegroundMs ?? 60_000,
			toolWatchdogTimeoutMs: normalizeToolWatchdogTimeoutMs(
				settings.toolWatchdogTimeoutMs ?? cur.toolWatchdogTimeoutMs ?? DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
			),
			readDirEnabled: settings.readDirEnabled ?? cur.readDirEnabled ?? true,
			editSoftEnabled: settings.editSoftEnabled ?? cur.editSoftEnabled ?? false,
			questionnaireEnabled: settings.questionnaireEnabled ?? cur.questionnaireEnabled ?? true,
			goalModeEnabled: settings.goalModeEnabled ?? cur.goalModeEnabled ?? true,
			parallelReminderEnabled: settings.parallelReminderEnabled ?? cur.parallelReminderEnabled ?? true,
			thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
			devNoCache: settings.devNoCache ?? cur.devNoCache,
			autoReload: settings.autoReload ?? cur.autoReload,
			toolsWrap: settings.toolsWrap ?? cur.toolsWrap ?? true,
			toolImagesEnabled: settings.toolImagesEnabled ?? cur.toolImagesEnabled ?? true,
			skillsFullText: normalizeSkillList(settings.skillsFullText ?? cur.skillsFullText),
			visionBridgeEnabled: settings.visionBridgeEnabled ?? cur.visionBridgeEnabled ?? true,
			visionBridgeModel: settings.visionBridgeModel ?? cur.visionBridgeModel ?? null,
			subagentDefaultModel: settings.subagentDefaultModel ?? cur.subagentDefaultModel ?? null,
			retryMaxAttempts: normalizeRetryMaxAttempts(
				settings.retryMaxAttempts ?? cur.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
			),
			softCapTokens: normalizeSoftCapTokens(settings.softCapTokens ?? cur.softCapTokens ?? 0),
			softCapByModel: normalizeSoftCapByModel(settings.softCapByModel ?? cur.softCapByModel ?? {}),
			visionBridgePromptMode: settings.visionBridgePromptMode ?? cur.visionBridgePromptMode ?? "append",
			visionBridgePrompt: settings.visionBridgePrompt ?? cur.visionBridgePrompt ?? "",
			scmCommitMsgPromptMode: settings.scmCommitMsgPromptMode ?? cur.scmCommitMsgPromptMode ?? "append",
			scmCommitMsgPrompt: settings.scmCommitMsgPrompt ?? cur.scmCommitMsgPrompt ?? "",
			reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
			reviewDisabledSkills: settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
			disabledPlugins: settings.disabledPlugins ?? cur.disabledPlugins ?? [],
			uiLayout: normalizeUiLayout(settings.uiLayout ?? cur.uiLayout),
			quickPhrases: settings.quickPhrases ?? cur.quickPhrases ?? [],
			quickPhrasesEnabled: settings.quickPhrasesEnabled ?? cur.quickPhrasesEnabled ?? true,
			defaultAgentPreset: settings.defaultAgentPreset ?? cur.defaultAgentPreset ?? "standard",
			defaultPermissionPreset:
				settings.defaultPermissionPreset ?? cur.defaultPermissionPreset ?? "workspace-write-never",
		};
		this.save();
	}

	/** Named settings presets for a client (empty if never saved) — global shared. */
	getPresets(_clientId: string): SettingsPreset[] {
		return (this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.presets ?? []).map((p) => ({
			...p,
			// Older client-state files predate review settings.
			reviewPrompt: p.reviewPrompt ?? "",
			reviewDisabledSkills: p.reviewDisabledSkills ?? [],
			// Older presets predate the configurable retry count.
			retryMaxAttempts: normalizeRetryMaxAttempts(p.retryMaxAttempts),
			// Older presets predate the compaction soft cap (issue #229).
			softCapTokens: normalizeSoftCapTokens((p as { softCapTokens?: unknown }).softCapTokens),
			softCapByModel: normalizeSoftCapByModel((p as { softCapByModel?: unknown }).softCapByModel),
		}));
	}

	/** Persist the named settings presets — global shared config. */
	savePresets(_clientId: string, presets: SettingsPreset[]): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.presets = presets;
		this.save();
	}

	/** Get per-project provider keys for a cwd, or undefined. */
	getProjectProviderKeys(clientId: string, cwd: string): Record<string, string> | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd];
	}

	/** Get a single provider's saved key for a project. */
	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined {
		const all = this.load();
		const globalHit = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectProviderKeys?.[cwd]?.[provider];
		if (globalHit) return globalHit;
		const direct = all[clientId]?.projectProviderKeys?.[cwd]?.[provider];
		if (direct) return direct;
		for (const [id, state] of Object.entries(all)) {
			if (id === clientId || id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
			const hit = state.projectProviderKeys?.[cwd]?.[provider];
			if (hit) return hit;
		}
		return undefined;
	}

	/** Remember which key was last used for a provider in a project. */
	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void {
		const all = this.load();
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const gMap = (globalState.projectProviderKeys ??= {});
		(gMap[cwd] ??= {})[provider] = keyName;

		const state = (all[clientId] ??= { projects: [] });
		const map = (state.projectProviderKeys ??= {});
		const inner = (map[cwd] ??= {});
		inner[provider] = keyName;
		this.save();
	}

	/** Delete a per-project provider key (e.g. when the key is removed). */
	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void {
		const all = this.load();
		const gInner = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectProviderKeys?.[cwd];
		if (gInner && provider in gInner) {
			delete gInner[provider];
			if (Object.keys(gInner).length === 0) {
				delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.projectProviderKeys![cwd];
			}
		}
		const inner = all[clientId]?.projectProviderKeys?.[cwd];
		if (!inner || !(provider in inner)) return;
		delete inner[provider];
		if (Object.keys(inner).length === 0) {
			delete all[clientId]!.projectProviderKeys![cwd];
		}
		this.save();
	}

	/** Remove one provider from EVERY project's saved keys (all clients, all
	 *  cwds) — e.g. the provider was cleared and returned to unconfigured.
	 *  Returns the number of entries removed. */
	deleteProviderEverywhere(provider: string): number {
		const all = this.load();
		let removed = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner && provider in inner) {
					delete inner[provider];
					removed++;
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (removed > 0) this.save();
		return removed;
	}

	/** Fix every project that still references a deleted key: point it at the
	 *  key that took over (`newActive`), or drop the reference when the
	 *  provider has no keys left (`newActive` null). A key deletion made in
	 *  one project must not keep haunting every other project that once used
	 *  the same key on every project switch. Returns entries touched. */
	repointDeletedKeyEverywhere(provider: string, deletedKeyName: string, newActive: string | null): number {
		const all = this.load();
		let touched = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner?.[provider] !== deletedKeyName) continue;
				if (newActive) inner[provider] = newActive;
				else {
					delete inner[provider];
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
				touched++;
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (touched > 0) this.save();
		return touched;
	}

	/** Get the model the user last selected in a project, or undefined. */
	getProjectModel(clientId: string, cwd: string): string | undefined {
		const all = this.load();
		// 1. 全局项目模型记忆（跨标签页、跨客户端、重启浏览器共享，优先级最高）
		const globalHit = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectModels?.[cwd];
		if (globalHit) return globalHit;
		// 2. 本客户端记忆
		const direct = all[clientId]?.projectModels?.[cwd];
		if (direct) return direct;
		// 3. 其他客户端按最近活跃时间倒序查找兜底
		const candidates: { model: string; lastUsed: number }[] = [];
		for (const [id, state] of Object.entries(all)) {
			if (id === clientId || id === ClientStateStore.GLOBAL_SETTINGS_KEY) continue;
			const m = state.projectModels?.[cwd];
			if (m) {
				const p = state.projects?.find((proj) => proj.path === cwd);
				candidates.push({ model: m, lastUsed: p?.lastUsed ?? 0 });
			}
		}
		if (candidates.length > 0) {
			candidates.sort((a, b) => b.lastUsed - a.lastUsed);
			return candidates[0].model;
		}
		return undefined;
	}

	/** Remember the model last selected in a project (immediate, not after a turn). */
	saveProjectModel(clientId: string, cwd: string, modelId: string): void {
		const all = this.load();
		// 写入全局项目记忆（保证新标签页/重启浏览器时确定可用）
		const globalState = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		(globalState.projectModels ??= {})[cwd] = modelId;
		// 同时写入本客户端
		const state = (all[clientId] ??= { projects: [] });
		(state.projectModels ??= {})[cwd] = modelId;
		this.save();
	}

	/** Drop the per-project model memory for a project (e.g. when the model is
	 *  removed from the catalog). */
	deleteProjectModel(clientId: string, cwd: string): void {
		const all = this.load();
		const gMap = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.projectModels;
		if (gMap && cwd in gMap) {
			delete gMap[cwd];
			if (Object.keys(gMap).length === 0) delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.projectModels;
		}
		const map = all[clientId]?.projectModels;
		if (!map || !(cwd in map)) return;
		delete map[cwd];
		if (Object.keys(map).length === 0) delete all[clientId]!.projectModels;
		this.save();
	}

	/** 全局默认模型（跨客户端共享，存 __settings__ 键）。缺省 = 未设置。 */
	getDefaultModel(): string | undefined {
		return this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultModel;
	}

	/** 设置全局默认模型（"provider/id"）。 */
	saveDefaultModel(modelId: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.defaultModel = modelId;
		this.save();
	}

	/** 清除全局默认模型（连带其 key 记忆）。 */
	clearDefaultModel(): void {
		const all = this.load();
		const state = all[ClientStateStore.GLOBAL_SETTINGS_KEY];
		if (!state) return;
		delete state.defaultModel;
		delete state.defaultProviderKeys;
		this.save();
	}

	/** 取全局默认的某 provider key。 */
	getDefaultProviderKey(provider: string): string | undefined {
		return this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultProviderKeys?.[provider];
	}

	/** 记全局默认的某 provider key（设全局默认模型时连带记）。 */
	saveDefaultProviderKey(provider: string, keyName: string): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		(state.defaultProviderKeys ??= {})[provider] = keyName;
		this.save();
	}

	/** 全局默认 key 跟随删除：被删的 key 若是全局默认记的，指到接替者（无接替则删引用）。 */
	repointDeletedKeyInDefault(provider: string, deletedKeyName: string, newActive: string | null): void {
		const all = this.load();
		const map = all[ClientStateStore.GLOBAL_SETTINGS_KEY]?.defaultProviderKeys;
		if (!map || map[provider] !== deletedKeyName) return;
		if (newActive) map[provider] = newActive;
		else {
			delete map[provider];
			if (Object.keys(map).length === 0) delete all[ClientStateStore.GLOBAL_SETTINGS_KEY]!.defaultProviderKeys;
		}
		this.save();
	}

	/** 全局「快捷短语已 seed」标记（非 per-clientId）。
	 *
	 * 为什么全局：clientId 存 sessionStorage（每标签页独立、关浏览器即失），按
	 * clientId 记 seed 会在每次新会话生成新 clientId 时误判为「从未 seed」，导致
	 * 用户删掉的默认短语又被填回默认。seed 只需一次（首次见空列表），之后即为用户
	 * 数据，增删改/恢复默认/关闭都走设置面板。存服务端而非浏览器 localStorage，
	 * 任何浏览器/标签页/清缓存都不受影响。 */
	getQuickPhrasesSeeded(): boolean {
		const meta = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY] as { quickPhrasesSeeded?: boolean } | undefined;
		return !!meta?.quickPhrasesSeeded;
	}

	markQuickPhrasesSeeded(): void {
		const all = this.load();
		const meta = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] }) as {
			projects: unknown[];
			quickPhrasesSeeded?: boolean;
		};
		if (meta.quickPhrasesSeeded) return;
		meta.quickPhrasesSeeded = true;
		this.save();
	}

	/** 内置标记工具开关（全局共享同一套 + 按 marker 禁用）。 */
	getMarkerSettings(_clientId: string): MarkerSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.markers;
		return {
			markersEnabled: s?.markersEnabled ?? true,
			disabledMarkers: s?.disabledMarkers ?? [],
		};
	}

	saveMarkerSettings(_clientId: string, settings: Partial<MarkerSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.markers ?? { markersEnabled: true, disabledMarkers: [] };
		state.markers = {
			markersEnabled: settings.markersEnabled ?? cur.markersEnabled ?? true,
			disabledMarkers: settings.disabledMarkers ?? cur.disabledMarkers ?? [],
		};
		this.save();
	}
}
