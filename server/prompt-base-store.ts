/**
 * 提示词 base 的**唯一记录点**（key = resourceLoader / session 对象，WeakMap 随 session 回收）。
 *
 * 两格，读的人各取所需：
 *   system —— loader 观察到的原文（SYSTEM.md；"" = 没文件）。设置预览 / 迁移要的是它。
 *   soul   —— 灵魂槽位的**实际取值**：子代理模板 replace 时是模板，否则 = system。
 *             凡"组装最终提示词"的消费者都必须读 soul；读 system 会静默漏掉模板。
 *
 * 为什么 soul 要显式成为一格：模板 replace 曾经是 `before_agent_start` 里按渲染文本
 * 的 "Available tools:" 边界串切段（issue #999）。那是 SDK 的**输出**格式、不是契约，
 * SDK 0.86 换成分段提示词后边界恒不存在 → 模板退化成"前置拼接"，子代理照旧带着整段
 * 平台提示词（且与 SYSTEM.md 同时存在时模板出现两遍）。把"换灵魂槽位"收进 loader
 * 覆盖 + 这份记录，提示词就只有结构化来源，没有第二套实现，也不依赖任何渲染后字面量。
 */
export interface PromptBaseRecord {
	/** loader 观察到的原文（SYSTEM.md；"" = 没文件）。 */
	system: string;
	/** 灵魂槽位实际取值：模板 replace 时是模板，否则 = system。 */
	soul: string;
	append: readonly string[];
}

const EMPTY: PromptBaseRecord = { system: "", soul: "", append: [] };

const store = new WeakMap<object, PromptBaseRecord>();

function writeRecord(loader: object | undefined, record: { system?: unknown; soul?: unknown; append?: unknown }): void {
	if (!loader) return;
	const system = typeof record.system === "string" ? record.system : "";
	store.set(loader, {
		system,
		// 没记 soul = 没有覆盖（老调用方只给 system），语义上等价于 soul = system。
		soul: typeof record.soul === "string" && record.soul ? record.soul : system,
		append: Array.isArray(record.append) ? (record.append as string[]).slice() : [],
	});
}

export function readPromptBase(loader: object | undefined): PromptBaseRecord {
	if (!loader) return EMPTY;
	return store.get(loader) ?? EMPTY;
}

export function recordPromptBaseLoader(loader: object | undefined, record: PromptBaseRecord): void {
	writeRecord(loader, record);
}

export interface PromptBaseObservers {
	systemPromptOverride: (base?: string) => string | undefined;
	appendSystemPromptOverride: (base: string[]) => string[];
	bind(loader: object | undefined): void;
}

export interface PromptBaseHandlers {
	/**
	 * 灵魂槽位覆盖（子代理模板 replace）：返回非空白即生效。
	 * 与 base 有无无关 —— 这正是 issue #999 的病灶：过去的实现要求 base 非空才生效，
	 * 于是"没有 SYSTEM.md"的项目里模板只能靠 hook 拼接兜底。
	 */
	soul?: () => string | undefined;
	append?: (base: string[]) => string[];
}

export function createPromptBaseObservers(handlers: PromptBaseHandlers = {}): PromptBaseObservers {
	const observed: { system: string; soul: string; append: string[] } = { system: "", soul: "", append: [] };
	let loader: object | undefined;
	const write = () => writeRecord(loader, observed);
	return {
		systemPromptOverride: (base?: string) => {
			const observedBase = typeof base === "string" ? base : undefined;
			const candidate = handlers.soul?.();
			const override = candidate && candidate.trim() ? candidate : undefined;
			observed.system = observedBase ?? "";
			observed.soul = override ?? observedBase ?? "";
			write();
			return override ?? observedBase;
		},
		appendSystemPromptOverride: (base: string[]) => {
			observed.append = base.slice();
			write();
			return handlers.append ? handlers.append(base) : base;
		},
		bind: (next: object | undefined) => {
			loader = next;
			write();
		},
	};
}
