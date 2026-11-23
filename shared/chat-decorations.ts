/**
 * 聊天正文装饰（`manifest.chatDecorations`）的唯一契约。
 *
 * 分层（一份实现，三个使用者）：
 * - 服务端只调 `normalizeChatDecorations()` 做**形状**归一（类型 / 条数 / 长度），不做语义判断；
 * - 浏览器只调 `compileChatDecorations()` 做**语义**编译（权限、正则、设置引用、CSS 取值白名单）——
 *   规则真正的执行者只有它，所以限额与净化只有这一份实现；
 * - 渲染层（`web/src/plugin-decorations.ts`）拿 `CompiledChatDecoration` 直接画，**不再解析 manifest**。
 *
 * 纯模块：不碰 DOM / 文件 / 进程 / 计时器，服务端（NodeNext）与浏览器（bundler）都编译它。
 *
 * 能力边界：只上"颜色 / 背景色 / 字重"，不替换文本、不插 HTML。所以复制、全局搜索、
 * 导出图片、TTS 读到的仍是原文；装饰永远改不了内容。
 */

/** 声明式能力：`permissions: ["decorate"]`。宿主不提供任何被门禁扣住的服务端 API，它只用于「可见/可审计」与客户端放行。 */
export const DECORATION_PERMISSION = "decorate";

export const MAX_DECORATIONS_PER_PLUGIN = 12;
export const MAX_DECORATIONS_TOTAL = 48;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_MATCHES_PER_BLOCK = 200;
export const MAX_STYLE_VALUE_LENGTH = 64;
export const MAX_RULE_ID_LENGTH = 32;
export const MAX_SETTING_KEY_LENGTH = 64;

/** CSS Highlight 名的前缀；全名形如 `pi-deco-<pluginId>-<ruleId>`（自定义标识符里不能有冒号）。 */
export const HIGHLIGHT_PREFIX = "pi-deco-";

export type DecorationStyleProp = "color" | "backgroundColor" | "fontWeight";

export const DECORATION_STYLE_PROPS: readonly DecorationStyleProp[] = ["color", "backgroundColor", "fontWeight"];

const CSS_PROP: Record<DecorationStyleProp, string> = {
	color: "color",
	backgroundColor: "background-color",
	fontWeight: "font-weight",
};

/** 引用插件自己的设置项（`settingsSchema` 的 key），解析不到就整条样式丢弃。 */
export interface DecorationSettingRef {
	setting: string;
}

export type DecorationStyleValue = string | DecorationSettingRef;

/** 规则可用于哪些消息：`assistant` / `user` 靠单条消息根上的 `[data-role]` 判定。 */
export type DecorationScope = "all" | "assistant" | "user";

/** pattern 可以字面量，也可以引用插件设置（例如「自定义关键词」）；用户没填时静默不生效。 */
export type ChatDecorationPattern = string | DecorationSettingRef;

export interface ChatDecorationSpec {
	/** 规则 id（可选）：用来生成稳定的 Highlight 名，改顺序不影响已注入的规则。 */
	id?: string;
	pattern: ChatDecorationPattern;
	flags?: string;
	/** 缺省 `all`。 */
	scope?: DecorationScope;
	/**
	 * 生效开关：引用一个或多个 **boolean** 设置（AND 关系），用于「总开关 + 分组开关」。
	 * 引用的 key 必须是 boolean；否则整条规则丢弃并报诊断。
	 */
	enabledBy?: string | readonly string[];
	style?: Partial<Record<DecorationStyleProp, DecorationStyleValue>>;
}

/** 编译产物：渲染层只认这个，不再回头看 manifest。 */
export interface CompiledChatDecoration {
	/** CSS Highlight 名（跨插件唯一）。 */
	name: string;
	pluginId: string;
	ruleId: string;
	regex: RegExp;
	/** 已净化的声明文本：`color:#e8832a;font-weight:700;`。 */
	declarations: string;
	/** 只作用于哪类消息。 */
	scope: DecorationScope;
}

/** 编译输入：刻意不依赖 `UiPluginInfo`，让本模块与协议层解耦（客户端自己映射）。 */
export interface ChatDecorationSource {
	pluginId: string;
	permissions?: readonly string[];
	decorations?: readonly ChatDecorationSpec[];
	settingsSchema?: readonly { key: string; type: string; default?: unknown }[];
	settingsValues?: Record<string, unknown>;
}

export interface CompileChatDecorationsResult {
	rules: CompiledChatDecoration[];
	/** 作者可读的忽略原因（客户端只打日志；服务端 manifest 校验另有一份面向面板的告警）。 */
	diagnostics: string[];
}

/** 规则 id 只留 CSS 标识符安全字符；缺省按序号补 `r<n>`。 */
function normalizeRuleId(raw: unknown, index: number): string {
	const text = typeof raw === "string" ? raw.trim().slice(0, MAX_RULE_ID_LENGTH) : "";
	const safe = text
		.replace(/[^A-Za-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	return safe || `r${index + 1}`;
}

function normalizeFlags(raw: unknown): string {
	const allowed = "gimsu";
	let flags = "";
	if (typeof raw === "string") {
		for (const ch of raw) {
			if (allowed.includes(ch) && !flags.includes(ch)) flags += ch;
		}
	}
	// 必须有 g：匹配器按 exec 循环取全部命中。
	if (!flags.includes("g")) flags += "g";
	return flags;
}

/** CSS 取值白名单：只接受普通颜色/数值语法，拒绝 `{}` `;` `<>` `\` 引号与 `url(`，杜绝样式表越界。 */
function sanitizeCssValue(prop: DecorationStyleProp, raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value || value.length > MAX_STYLE_VALUE_LENGTH) return null;
	if (/[{}<>;\\"'`]/.test(value)) return null;
	if (/url\s*\(/i.test(value)) return null;
	if (prop === "fontWeight") return /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(value) ? value : null;
	return /^[#A-Za-z0-9(),.%\s\-/+]+$/.test(value) ? value : null;
}

function resolveStyleValue(
	prop: DecorationStyleProp,
	raw: DecorationStyleValue,
	source: ChatDecorationSource,
	ruleId: string,
	diagnostics: string[],
): string | null {
	if (typeof raw === "string") return sanitizeCssValue(prop, raw);
	const key = typeof raw?.setting === "string" ? raw.setting.trim().slice(0, MAX_SETTING_KEY_LENGTH) : "";
	if (!key) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}.${prop}: 非法设置引用（缺少 setting）`);
		return null;
	}
	const field = source.settingsSchema?.find((f) => f.key === key);
	if (!field) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}.${prop}: settingsSchema 里没有 "${key}"`);
		return null;
	}
	// secret / password 永不进样式：那会把凭据写进 CSS。
	if (field.type !== "text" && field.type !== "select" && field.type !== "number") {
		diagnostics.push(`[${source.pluginId}] ${ruleId}.${prop}: 设置 "${key}" 的类型 ${field.type} 不能用于样式`);
		return null;
	}
	const value = source.settingsValues?.[key] ?? field.default;
	if (value === undefined || value === null || value === "") {
		diagnostics.push(`[${source.pluginId}] ${ruleId}.${prop}: 设置 "${key}" 没有值`);
		return null;
	}
	const text = sanitizeCssValue(prop, String(value));
	if (!text) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}.${prop}: 设置 "${key}" 的值不是合法 CSS`);
		return null;
	}
	return text;
}

function buildDeclarations(
	spec: ChatDecorationSpec,
	source: ChatDecorationSource,
	ruleId: string,
	diagnostics: string[],
): string | null {
	const parts: string[] = [];
	for (const prop of DECORATION_STYLE_PROPS) {
		const raw = spec.style?.[prop];
		if (raw === undefined) continue;
		const value = resolveStyleValue(prop, raw, source, ruleId, diagnostics);
		if (value) parts.push(`${CSS_PROP[prop]}:${value}`);
	}
	return parts.length ? `${parts.join(";")};` : null;
}

function hasDecorationPermission(permissions: readonly string[] | undefined): boolean {
	if (!permissions) return false;
	return permissions.some((p) => String(p).split(":")[0]?.trim() === DECORATION_PERMISSION);
}

function settingKeyOf(raw: unknown): string {
	const key = (raw as { setting?: unknown } | null | undefined)?.setting;
	return typeof key === "string" ? key.trim().slice(0, MAX_SETTING_KEY_LENGTH) : "";
}

function findSetting(source: ChatDecorationSource, key: string) {
	return source.settingsSchema?.find((f) => f.key === key);
}

function normalizeScope(raw: unknown): DecorationScope {
	return raw === "assistant" || raw === "user" ? raw : "all";
}

/**
 * 开关：引用一个或多个 boolean 设置（AND）。未声明 = 恒生效；
 * 引用了不存在 / 非 boolean 的设置 = 作者写错，丢规则并报诊断（不静默失效）。
 */
function resolveEnabled(
	spec: ChatDecorationSpec,
	source: ChatDecorationSource,
	ruleId: string,
	diagnostics: string[],
): boolean {
	const raw = spec.enabledBy;
	if (raw === undefined) return true;
	const keys = (Array.isArray(raw) ? raw : [raw]).map((k) => String(k).trim()).filter(Boolean);
	if (keys.length === 0) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}: enabledBy 为空，规则被丢弃`);
		return false;
	}
	for (const key of keys) {
		const field = findSetting(source, key);
		if (!field) {
			diagnostics.push(`[${source.pluginId}] ${ruleId}: enabledBy 引用的设置 "${key}" 不存在`);
			return false;
		}
		if (field.type !== "boolean") {
			diagnostics.push(`[${source.pluginId}] ${ruleId}: 设置 "${key}" 不是 boolean，不能当开关`);
			return false;
		}
		const value = source.settingsValues?.[key] ?? field.default;
		if (value !== true) return false;
	}
	return true;
}

/**
 * pattern：字面量，或引用插件设置（「自定义关键词」）。
 * 引用设置但用户没填 = 静默不生效（不是作者写错，不报诊断）。
 */
function resolvePattern(
	spec: ChatDecorationSpec,
	source: ChatDecorationSource,
	ruleId: string,
	diagnostics: string[],
): string | null {
	if (typeof spec.pattern === "string") {
		const text = spec.pattern.trim();
		if (!text) {
			diagnostics.push(`[${source.pluginId}] ${ruleId}: pattern 为空`);
			return null;
		}
		if (text.length > MAX_PATTERN_LENGTH) {
			diagnostics.push(`[${source.pluginId}] ${ruleId}: pattern 超过 ${MAX_PATTERN_LENGTH} 字符`);
			return null;
		}
		return text;
	}
	const key = settingKeyOf(spec.pattern);
	if (!key) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}: 非法 pattern 引用（缺少 setting）`);
		return null;
	}
	const field = findSetting(source, key);
	if (!field) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}: pattern 引用的设置 "${key}" 不存在`);
		return null;
	}
	if (field.type !== "text" && field.type !== "select") {
		diagnostics.push(`[${source.pluginId}] ${ruleId}: 设置 "${key}" 的类型 ${field.type} 不能当 pattern`);
		return null;
	}
	const value = source.settingsValues?.[key] ?? field.default;
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return null;
	if (text.length > MAX_PATTERN_LENGTH) {
		diagnostics.push(`[${source.pluginId}] ${ruleId}: 设置 "${key}" 的 pattern 超过 ${MAX_PATTERN_LENGTH} 字符`);
		return null;
	}
	return text;
}

/** 服务端用：把 manifest 里的裸数组收成严格形状（不编译正则、不判权限、不解析设置）。 */
export function normalizeChatDecorations(raw: unknown): ChatDecorationSpec[] {
	if (!Array.isArray(raw)) return [];
	const out: ChatDecorationSpec[] = [];
	for (const item of raw.slice(0, MAX_DECORATIONS_PER_PLUGIN)) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const o = item as Record<string, unknown>;
		let pattern: ChatDecorationPattern | null = null;
		if (typeof o.pattern === "string") {
			const text = o.pattern.trim();
			if (text) pattern = text.length > MAX_PATTERN_LENGTH ? null : text;
		} else if (o.pattern && typeof o.pattern === "object" && !Array.isArray(o.pattern)) {
			const key = settingKeyOf(o.pattern);
			if (key) pattern = { setting: key };
		}
		if (pattern === null) continue;
		const spec: ChatDecorationSpec = { pattern };
		if (typeof o.id === "string" && o.id.trim()) spec.id = o.id.trim().slice(0, MAX_RULE_ID_LENGTH);
		if (typeof o.flags === "string") spec.flags = o.flags.slice(0, 8);
		if (o.scope === "assistant" || o.scope === "user" || o.scope === "all") spec.scope = o.scope;
		const keys = Array.isArray(o.enabledBy) ? o.enabledBy : o.enabledBy === undefined ? [] : [o.enabledBy];
		const enabledBy = keys
			.map((k) => (typeof k === "string" ? k.trim().slice(0, MAX_SETTING_KEY_LENGTH) : ""))
			.filter(Boolean);
		if (enabledBy.length) spec.enabledBy = enabledBy;
		if (o.style && typeof o.style === "object" && !Array.isArray(o.style)) {
			const src = o.style as Record<string, unknown>;
			const style: NonNullable<ChatDecorationSpec["style"]> = {};
			for (const prop of DECORATION_STYLE_PROPS) {
				const v = src[prop];
				if (typeof v === "string") style[prop] = v.slice(0, MAX_STYLE_VALUE_LENGTH + 8);
				else if (v && typeof v === "object" && !Array.isArray(v)) {
					const key = settingKeyOf(v);
					if (key) style[prop] = { setting: key };
				}
			}
			if (Object.keys(style).length) spec.style = style;
		}
		out.push(spec);
	}
	return out;
}

/**
 * 客户端用：把多个插件的声明编译成可执行规则。这里是**唯一**的语义闸门：
 * 权限、条数、正则合法性、样式白名单、设置引用解析、名字唯一性，全在这一处。
 */
export function compileChatDecorations(sources: readonly ChatDecorationSource[]): CompileChatDecorationsResult {
	const rules: CompiledChatDecoration[] = [];
	const diagnostics: string[] = [];
	const names = new Set<string>();
	let totalCapReported = false;

	for (const source of sources) {
		const specs = source.decorations ?? [];
		if (specs.length === 0) continue;
		if (!hasDecorationPermission(source.permissions)) {
			diagnostics.push(
				`[${source.pluginId}] chatDecorations 已忽略：manifest.permissions 未声明 "${DECORATION_PERMISSION}"`,
			);
			continue;
		}
		if (specs.length > MAX_DECORATIONS_PER_PLUGIN) {
			diagnostics.push(
				`[${source.pluginId}] 只应用前 ${MAX_DECORATIONS_PER_PLUGIN} 条 chatDecorations（声明了 ${specs.length} 条）`,
			);
		}
		specs.slice(0, MAX_DECORATIONS_PER_PLUGIN).forEach((spec, index) => {
			if (rules.length >= MAX_DECORATIONS_TOTAL) {
				if (!totalCapReported) {
					totalCapReported = true;
					diagnostics.push(`装饰规则总数上限 ${MAX_DECORATIONS_TOTAL}：超出的插件/规则被丢弃`);
				}
				return;
			}
			const ruleId = normalizeRuleId(spec.id, index);
			// 开关先判：用户关掉的分组既不编译也不报错（否则每次拉清单都吵）。
			if (!resolveEnabled(spec, source, ruleId, diagnostics)) return;
			const name = `${HIGHLIGHT_PREFIX}${source.pluginId}-${ruleId}`;
			if (names.has(name)) {
				diagnostics.push(`[${source.pluginId}] 重复的规则 id "${ruleId}"：后者被丢弃`);
				return;
			}
			const pattern = resolvePattern(spec, source, ruleId, diagnostics);
			if (!pattern) return;
			const declarations = buildDeclarations(spec, source, ruleId, diagnostics);
			if (!declarations) {
				diagnostics.push(`[${source.pluginId}] ${ruleId}: 没有任何可用的样式，规则被丢弃`);
				return;
			}
			let regex: RegExp;
			try {
				regex = new RegExp(pattern, normalizeFlags(spec.flags));
			} catch (err) {
				diagnostics.push(`[${source.pluginId}] ${ruleId}: 正则非法（${(err as Error).message}）`);
				return;
			}
			names.add(name);
			rules.push({ name, pluginId: source.pluginId, ruleId, regex, declarations, scope: normalizeScope(spec.scope) });
		});
	}
	return { rules, diagnostics };
}

/** 取一段文本里的全部命中（[start, end)）。规则自带 g，但仍重置 lastIndex，避免跨块残留。 */
export function findDecorationMatches(
	text: string,
	regex: RegExp,
	cap: number = MAX_MATCHES_PER_BLOCK,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	if (!text) return out;
	regex.lastIndex = 0;
	try {
		let m: RegExpExecArray | null;
		while ((m = regex.exec(text))) {
			// 零宽命中不做装饰（画不出范围），但必须推进 lastIndex，否则死循环。
			if (m[0].length === 0) {
				regex.lastIndex = m.index + 1;
				continue;
			}
			out.push([m.index, m.index + m[0].length]);
			if (out.length >= cap) break;
		}
	} finally {
		regex.lastIndex = 0;
	}
	return out;
}

/** DOM 无关的节点定位结果：节点用下标表示，渲染层再换成真的 Range。 */
export interface PlannedDecorationRange {
	fromNode: number;
	fromOffset: number;
	toNode: number;
	toOffset: number;
}

/**
 * 把文本偏移映射回「文本节点下标 + 偏移」。跨节点（多段行内格式）的命中也会被正确切开，
 * 但一个命中必须完整落在收集到的节点串里。
 */
export function planDecorationRanges(
	lengths: readonly number[],
	matches: readonly (readonly [number, number])[],
): PlannedDecorationRange[] {
	const out: PlannedDecorationRange[] = [];
	if (lengths.length === 0 || matches.length === 0) return out;
	const starts = new Array<number>(lengths.length);
	let total = 0;
	for (let i = 0; i < lengths.length; i++) {
		starts[i] = total;
		total += lengths[i]!;
	}
	const locate = (pos: number, isEnd: boolean): { node: number; offset: number } | null => {
		for (let i = lengths.length - 1; i >= 0; i--) {
			const start = starts[i]!;
			const len = lengths[i]!;
			if (len <= 0) continue;
			if (isEnd ? pos > start && pos <= start + len : pos >= start && pos < start + len) {
				return { node: i, offset: pos - start };
			}
		}
		return null;
	};
	for (const [start, end] of matches) {
		const from = locate(start, false);
		const to = locate(end, true);
		if (!from || !to) continue;
		out.push({ fromNode: from.node, fromOffset: from.offset, toNode: to.node, toOffset: to.offset });
	}
	return out;
}
