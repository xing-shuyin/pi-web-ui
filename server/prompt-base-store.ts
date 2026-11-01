/**
 * prompt-base-store — SYSTEM.md / APPEND_SYSTEM.md 原文（SDK override **之前**的
 * base）的归属登记处，以及生产这两份 base 的 override 工厂。
 *
 * ## 为什么归到 loader 名下（issue #812）
 *
 * SDK 的 `systemPromptOverride` / `appendSystemPromptOverride` 是**回调**：它把
 * 「本次 reload 发现的 base」推给宿主。若宿主把「最近一次看到的值」存成
 * `AgentService` 字段（= 每个浏览器客户端一份），那份状态的生命周期就是**客户端**，
 * 而真相的生命周期是 **session**（= 一个 cwd 的 loader）：
 *
 * - 切项目 → 新会话的 base 是 `undefined`（没有 `.pi/SYSTEM.md`）→ 旧值没人清 →
 *   上一个项目的系统提示词泄漏到本项目的设置预览与新建对话，只有偶然访问一个
 *   含空白 SYSTEM.md 的项目才会「被修复」；
 * - 过户 → 搬的是 session 本体，客户端级字段留在旧宿主身上，新宿主读不到真相。
 *
 * 所以归属必须跟 loader 走：**key = resourceLoader 对象**（session 持有它，过户时
 * 跟着走；session 销毁后 WeakMap 自动回收，不需要清理钩子）。每次 reload 无条件
 * 覆盖式写入（base 缺失即写空），「没有文件」永远是空记录——结构上不可能串账。
 *
 * ## 为什么是工厂
 *
 * 「观察到 base → 登记到 loader 名下 → 再决定返回什么给 SDK」是同一件事的三步，
 * 拆到调用方（17k 行的 agent-service）里手写一遍，就等于允许有人只抄前两步——
 * 那正是本 bug 的形态。这里把三步收成一个单元，调用方只提供「拿到 base 后返回
 * 什么」（子代理模板替换等业务规则）。
 *
 * 注意登记的是 override **之前**的原文：子代理模板 replace 会把 base 整个换掉，
 * 但 {{soul}} 仍要反映用户写的 SYSTEM.md，预览与 token 估算才对得上。
 */

/** 一个 loader 本次 reload 观察到的提示词 base（原文）。 */
export interface PromptBaseRecord {
	/** SYSTEM.md 原文；没有文件（或 0 字节）时为空串。 */
	system: string;
	/** APPEND_SYSTEM.md 原文（SDK 支持多来源，base 是数组）；没有文件时为空数组。 */
	append: readonly string[];
}

/** 空记录：没有 SYSTEM.md / APPEND_SYSTEM.md。共享常量避免每次分配。 */
const EMPTY: PromptBaseRecord = { system: "", append: [] };

/** key = resourceLoader 对象本身（见模块头注释：归属跟 session 走）。 */
const store = new WeakMap<object, PromptBaseRecord>();

/** 登记某 loader 本次 reload 的 base（归一：undefined / null 一律记为空）。 */
function writeRecord(loader: object | undefined, record: { system?: unknown; append?: unknown }): void {
	if (!loader) return;
	store.set(loader, {
		system: typeof record.system === "string" ? record.system : "",
		append: Array.isArray(record.append) ? (record.append as string[]).slice() : [],
	});
}

/** 读某 loader 归属的 base。loader 缺失或无记录 → 空记录（= 内置默认提示词）。 */
export function readPromptBase(loader: object | undefined): PromptBaseRecord {
	if (!loader) return EMPTY;
	return store.get(loader) ?? EMPTY;
}

/**
 * 直接登记（给不经过 override 的调用方/测试用）。**必须每次 reload 都调用**，
 * 包括 base 为空时：覆盖式写入是「不跨会话串账」的唯一保证，任何「非空才写」
 * 的写法都会重新引入 issue #812。
 */
export function recordPromptBaseLoader(loader: object | undefined, record: PromptBaseRecord): void {
	writeRecord(loader, record);
}

/** SDK 的两个提示词 override（签名与 `DefaultResourceLoaderOptions` 一致）。 */
export interface PromptBaseObservers {
	/** 拿 SYSTEM.md 原文，登记后返回该 override 的最终值（返回 undefined = SDK 默认分支）。 */
	systemPromptOverride: (base?: string) => string | undefined;
	/** 拿 APPEND_SYSTEM.md 原文数组，登记后返回该 override 的最终数组。 */
	appendSystemPromptOverride: (base: string[]) => string[];
	/** 拿到 loader 后调用一次：把创建期（loader 还不存在时）观察到的 base 补登记。 */
	bind(loader: object | undefined): void;
}

/**
 * 造一对 override：**先登记归属，再问调用方返回什么**。
 *
 * `handlers.system` / `handlers.append` 是可选的业务规则（缺省 = 原样返回，
 * 即 TUI 语义：SYSTEM.md / APPEND_SYSTEM.md 直达 SDK）。
 */
export function createPromptBaseObservers(
	handlers: {
		system?: (base: string | undefined) => string | undefined;
		append?: (base: string[]) => string[];
	} = {},
): PromptBaseObservers {
	const observed: { system: string; append: string[] } = { system: "", append: [] };
	let loader: object | undefined;
	return {
		systemPromptOverride: (base?: string) => {
			observed.system = typeof base === "string" ? base : "";
			writeRecord(loader, observed);
			return handlers.system ? handlers.system(base) : base;
		},
		appendSystemPromptOverride: (base: string[]) => {
			observed.append = base.slice();
			writeRecord(loader, observed);
			return handlers.append ? handlers.append(base) : base;
		},
		bind: (next: object | undefined) => {
			loader = next;
			// override 首次重放发生在 loader 创建过程中（那时还没有句柄）：这里补写一次，
			// 之后的 reload 直接按 loader 写。
			writeRecord(loader, observed);
		},
	};
}
