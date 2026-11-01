/**
 * fake-session —— `ClientSession` / `AgentService` 的测试假体工厂。
 *
 * ## 为什么要有这个文件（而不是继续手搓 `Object.assign(Object.create(proto), {...})`）
 *
 * 生产类的原型方法能靠 `Object.create(原型)` 白拿，但**实例字段拿不到**（它们在
 * `constructor` 里初始化，而假体绕过了 constructor）。于是每加一个字段/方法，
 * 守卫测试就以 `TypeError: xxx is not a function` / `Cannot read properties of
 * undefined (reading 'get')` 的形式在 CI 上炸，而修法永远是「每个文件补一行」——
 * 一次修不干净、反复复发（一次 CI 复盘里 `sharedViewers` / `sharedPendingMessages`
 * / `parentExecution` / `parentExecutionKey` / `conversationSettingsTargets` 五个新
 * 成员同时打红了 9 个文件的 15 个用例）。
 *
 * 这里把「实例字段默认值」改成**从生产源码自动推导**（字段初始化式 + 构造器里的
 * `this.x = …`），按初始化式品类给默认值（Map / WeakMap / Set / 数组 / 空对象 /
 * 空串 / 0 / false / null / 函数）。生产类新增字段自动带上默认值，**不需要改这里**。
 *
 * ## 用法
 *
 * ```ts
 * const cs = fakeClientSession({ convs: new Map([["c1", conv]]), emit: vi.fn() });
 * const service = fakeAgentService({ clients: new Map([[clientId, cs]]) });
 * ```
 *
 * - 原型方法全部继承真实现（`parentExecution` 这类不会再「不是函数」）；
 * - 字段默认值由源码推导，测试只覆写自己关心的那几个；
 * - 覆写永远赢（最后 Object.assign）。
 *
 * ## 边界
 *
 * - 只处理「初始化式品类可判定」的字段；`this.x = makeState()` 这类调用式初始化给
 *   `undefined`（需要时在测试里覆写）。品类清单见 `defaultFromInitializer`。
 * - 真实构造器的副作用（定时器、事件订阅、读磁盘）**不会**发生——这正是假体的意义。
 * - 推导正确性由 `tests/unit/fake-session-sync.test.ts` 守卫（含多行泛型初始化式）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClientSession } from "../../server/agent-service.js";
import { AgentService } from "../../server/agent-service-daemon.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 生产类的源码位置 + 类名（字段默认值的推导输入）。 */
const SOURCES = {
	ClientSession: { file: `${ROOT}server/agent-service.ts`, className: "ClientSession" },
	AgentService: { file: `${ROOT}server/agent-service-daemon.ts`, className: "AgentService" },
} as const;

type SourceKey = keyof typeof SOURCES;

/**
 * 把字符串/注释抹成空格（长度不变）——之后所有结构扫描都跑在 mask 上，
 * 这样引号里的 `{` `;` 注释里的 `class X` 都不会骗到扫描器。
 */
function maskNonCode(text: string): string {
	const out = text.split("");
	let i = 0;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			const stop = end === -1 ? text.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end === -1 ? text.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			let k = i + 1;
			while (k < text.length) {
				if (text[k] === "\\") {
					k += 2;
					continue;
				}
				if (text[k] === quote) {
					k++;
					break;
				}
				k++;
			}
			blank(i + 1, k - 1);
			i = k;
			continue;
		}
		i++;
	}
	return out.join("");
}

/** 从 `from` 处的开括号开始，返回与之配对的闭括号下标（跑在 mask 上）。 */
function matchBracket(mask: string, from: number): number {
	const open = mask[from];
	const close = open === "{" ? "}" : open === "(" ? ")" : "]";
	let depth = 0;
	for (let i = from; i < mask.length; i++) {
		const ch = mask[i];
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** 类体（`{ ... }` 内部）在原文里的 [start, end) 区间。 */
function classBodySpan(source: string, className: string): { start: number; end: number } | undefined {
	const mask = maskNonCode(source);
	const at = mask.search(new RegExp(`\\bclass\\s+${className}\\b`));
	if (at === -1) return undefined;
	const open = mask.indexOf("{", at);
	if (open === -1) return undefined;
	const close = matchBracket(mask, open);
	if (close === -1) return undefined;
	return { start: open + 1, end: close };
}

/** 初始化式 → 默认值。认不出的品类一律 `undefined`（测试按需覆写）。 */
export function defaultFromInitializer(rhs: string): unknown {
	const text = rhs.trim();
	if (/^new\s+Map\b/.test(text)) return new Map();
	if (/^new\s+WeakMap\b/.test(text)) return new WeakMap();
	if (/^new\s+Set\b/.test(text)) return new Set();
	if (/^new\s+WeakSet\b/.test(text)) return new WeakSet();
	if (/^new\s+Array\b/.test(text)) return [];
	if (text === "[]") return [];
	if (text === "{}") return {};
	if (/^(""|''|``)$/.test(text)) return "";
	if (/^\d+$/.test(text)) return 0;
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "null") return null;
	if (/^(\(|async\s*\(|function\b|async\s+function\b)/.test(text)) return () => undefined;
	return undefined;
}

/** 解析结果按类缓存：同一进程（= 同一测试文件）只扫一次源码。 */
const cache = new Map<SourceKey, Record<string, unknown>>();

/**
 * 从生产源码推导某类的实例字段默认值：
 * ① 类体里的字段声明（`private x = …` / `readonly y: T = …`，含**多行泛型初始化式**）；
 * ② 构造器里的 `this.x = …`。
 *
 * 这是本模块唯一的推导点：生产类加字段 → 这里自动跟上。推导可信度由
 * `tests/unit/fake-session-sync.test.ts` 断言（字段数量、多行 Map、函数字段等）。
 */
export function instanceFieldDefaults(key: SourceKey): Record<string, unknown> {
	const cached = cache.get(key);
	if (cached) return cloneDefaults(cached);
	const { file, className } = SOURCES[key];
	const source = readFileSync(file, "utf8");
	const span = classBodySpan(source, className);
	if (!span) throw new Error(`fake-session: 源码里找不到 class ${className}（${file}）`);
	const body = source.slice(span.start, span.end);
	const mask = maskNonCode(body);
	const out: Record<string, unknown> = {};

	// ① 字段声明：类体里缩进 = 1 个制表符的 `名字[?!]* [: 类型] = 初始化式`
	const decl =
		/^\t(?!\t)((?:private|protected|public|readonly|override|declare|#)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=;\n]+?)?\s*=(?!=)\s*/gm;
	for (let m = decl.exec(mask); m; m = decl.exec(mask)) {
		const name = m[2];
		if (name === "constructor" || name === "static") continue;
		const rhsStart = m.index + m[0].length;
		// 初始化式到同级 `;` 结束（多行泛型 `new Map<\n…>()` 也吃得住）
		let depth = 0;
		let end = rhsStart;
		for (; end < mask.length; end++) {
			const ch = mask[end];
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === ";" && depth <= 0) break;
		}
		if (!(name in out)) out[name] = defaultFromInitializer(body.slice(rhsStart, end));
	}

	// ② 构造器里的 this.x = …
	const ctor = /^\t(?:(?:private|protected|public|override)\s+)*constructor\s*\(/m.exec(mask);
	if (ctor) {
		const bodyOpen = mask.indexOf("{", ctor.index);
		const bodyClose = bodyOpen === -1 ? -1 : matchBracket(mask, bodyOpen);
		if (bodyOpen !== -1 && bodyClose > bodyOpen) {
			const ctorMask = mask.slice(bodyOpen, bodyClose);
			const ctorSrc = body.slice(bodyOpen, bodyClose);
			const assign = /(?<![=!<>])this\.([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g;
			for (let m = assign.exec(ctorMask); m; m = assign.exec(ctorMask)) {
				const rhsStart = m.index + m[0].length;
				let depth = 0;
				let end = rhsStart;
				for (; end < ctorMask.length; end++) {
					const ch = ctorMask[end];
					if (ch === "(" || ch === "[" || ch === "{") depth++;
					else if (ch === ")" || ch === "]" || ch === "}") depth--;
					else if (ch === ";" && depth <= 0) break;
				}
				if (!(m[1] in out)) out[m[1]] = defaultFromInitializer(ctorSrc.slice(rhsStart, end));
			}
		}
	}

	cache.set(key, out);
	return cloneDefaults(out);
}

type Loose = Record<string, unknown>;

/**
 * 假体的静态类型**刻意宽松**：守卫测试本来就要摸私有成员（`cs.removeConversation`
 * / `service.clients` / `service.armOfflineRowExpiry`），用真类型会逼着每个调用点写
 * `as any`。这与仓库既有约定一致（见 AGENTS.md §4「单测 mock 用 ``{} as any``」）。
 * 结构正确性由运行时守卫测试 `tests/unit/fake-session-sync.test.ts` 兜底。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeAgentService = any;

/**
 * 每次取默认值都必须给**新的**集合实例。
 *
 * 踩过：把解析结果缓存后浅拷贝出去，同一测试里两个假体（`source` / `target`）
 * 就共用了同一个 `convs` Map —— 过户类用例全绿变全红，而报错完全看不出「共享」。
 * WeakMap/WeakSet 无法克隆内容，直接给空的（默认值本来就是空的）。
 */
function cloneDefault(value: unknown): unknown {
	if (value instanceof Map) return new Map(value);
	if (value instanceof Set) return new Set(value);
	if (value instanceof WeakMap) return new WeakMap();
	if (value instanceof WeakSet) return new WeakSet();
	if (Array.isArray(value)) return [];
	if (value !== null && typeof value === "object") return {};
	return value;
}

function cloneDefaults(defaults: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(defaults)) out[key] = cloneDefault(value);
	return out;
}

/**
 * 造自己的**数据属性**而不是赋值：`ClientSession.prototype` 上有 `get conv()`
 * 之类的访问器（没有 setter），`Object.assign` / 直接赋值都会抛
 * `Cannot set property … which has only a getter`；而测试假体的语义本来就是
 * 「自有字段盖住原型」。这里统一用 defineProperty（与手搓字面量假体等价）。
 */
function defineOwn(target: Loose, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * 原型上的访问器（`get conv()` 之类）不能被子类自有数据属性顶掉：
 * `this.conv` 在生产代码里是「活跃会话」的派生视图，塞个 `undefined` 进去会让
 * 一整片逻辑静默走空分支（迁移过程中真踩到过：`expected true to be false`）。
 * 所以推导出的默认值**跳过**访问器名；测试显式覆写才允许盖住。
 */
function isPrototypeAccessor(proto: object, key: string): boolean {
	for (
		let cursor: object | null = proto;
		cursor && cursor !== Object.prototype;
		cursor = Object.getPrototypeOf(cursor)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
		if (descriptor) return typeof descriptor.get === "function" || typeof descriptor.set === "function";
	}
	return false;
}

/**
 * 哪些推导值可以被「无差别地」装到假体上？
 *
 * 只装**集合**（Map / WeakMap / Set / WeakSet）：这类字段正是历史上把测试打红的
 * 漂移源（`sharedViewers.get` / `conversationSettingsTargets`），而它们「空着」
 * 与「不存在」对被测逻辑的差别极小，装上更接近真实实例。
 * 原始值（`disposed=false` / `approvalSeq=0` / `activeId=""`）**不自动装**：
 * 生产代码里有不少 `if (this.x)` / `if (this.x != null)` 分支，凭空把字段变成
 * false/0/"" 会静默改写被测行为（迁移时真踩到过）。需要就在用例里显式给。
 */
function isSafeDefault(value: unknown): boolean {
	return value instanceof Map || value instanceof WeakMap || value instanceof Set || value instanceof WeakSet;
}

function buildFake(proto: object, defaults: Record<string, unknown>, overrides: Loose): Loose {
	const target = Object.create(proto) as Loose;
	for (const [key, value] of Object.entries(defaults)) {
		if (!isSafeDefault(value)) continue;
		if (isPrototypeAccessor(proto, key)) continue;
		defineOwn(target, key, value);
	}
	for (const [key, value] of Object.entries(overrides)) defineOwn(target, key, value);
	return target;
}

/**
 * `ClientSession` 假体：原型真方法 + 源码推导的实例字段默认值 + 你的覆写。
 *
 * 覆写优先级最高；要「故意空着某个字段」时显式写 `undefined`。
 */
export function fakeClientSession(overrides: Loose = {}): FakeSession {
	return buildFake(ClientSession.prototype, instanceFieldDefaults("ClientSession"), overrides) as FakeSession;
}

/** `AgentService`（守护进程侧）假体。口径同 {@link fakeClientSession}。 */
export function fakeAgentService(overrides: Loose = {}): FakeAgentService {
	return buildFake(AgentService.prototype, instanceFieldDefaults("AgentService"), overrides) as FakeAgentService;
}

/** 原型上某个私有方法的引用（`private` 只在编译期，运行时可按名取）。 */
export function protoMethod(proto: object, name: string): (...args: never[]) => unknown {
	return (proto as Loose)[name] as (...args: never[]) => unknown;
}
