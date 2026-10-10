/// <reference lib="dom" />
/**
 * 通用右键菜单的**模块级状态 store** + 三个纯函数（定位 / 过滤排序 / 键盘导航）。
 *
 * 为什么要有这一层（而不是每个调用点自己 useState）：
 *  - 右键菜单是「从任意位置弹一次、同一时刻只能有一个」的瞬时 UI。若由各处宿主组件
 *    自己持有 open 状态，就会出现「左栏的会话菜单还开着，右栏又弹了一个文件菜单」，
 *    而且没人负责关掉前一个（各自只知道自己）。
 *  - 于是把「当前该弹哪个菜单」收敛成**全局唯一**的一份状态：`openContextMenu(req)`
 *    后开者覆盖先开者，`closeContextMenu()` 谁都调得动（Esc / 点击外部 / 滚动 / 条目点击后）。
 *  - 与 app-globals.ts / composer-bridge.ts 同一套写法：模块级 cached + listener 集合 +
 *    `useSyncExternalStore` 订阅；宿主组件只渲染（见 components/ContextMenu.tsx）。
 *
 * 分层（谁算什么）：
 *  - **宿主/调用方**：用 `buildUiSlots()`（web/src/ui-slots.ts）把「宿主内置 + 插件贡献 +
 *    用户偏好」合并成该槽位的最终条目，连坐标、槽位、被右键的对象一起交给本模块。
 *  - **本模块**：只做纯计算（钳制坐标、过滤+分组排序、键盘下标推进）与状态广播。
 *  - **渲染层**：ContextMenu.tsx 读状态 → portal 到 body 画出来，点击回 `onAction`；
 *    `source === "host"` 的**内置**条目先回请求里带的 `onHostAction`（见 ContextMenuRequest）。
 *    组件**不**重新算条目（否则「设置页看到的」和「右键弹出来的」会跑两套逻辑）。
 *
 * ⚠️ 纪律：`getContextMenu()` 必须返回稳定引用（未打开时恒为同一个 `null`；打开后直到
 * 下一次 open/close 之前不换对象），否则 useSyncExternalStore 会判定「快照每次都变」
 * 而不停重渲染 —— 同 app-globals.ts 的注释。
 */
import { useSyncExternalStore } from "react";
// UiSlotEntry 是合并后的最终条目（ui-slots.ts），UiSlotId 来自协议单源（types 是 type-only shim）。
import type { UiSlotEntry } from "./ui-slots";
import type { UiSlotId } from "./types";

/** 右键菜单的四个槽位（从协议枚举里切出来，新增槽位时这里自动跟着变）。 */
type ContextMenuSlot = Extract<UiSlotId, `contextmenu.${string}`>;

/** 一次右键请求：坐标 + 槽位 + 被右键的对象 + 该槽位算好的条目。 */
export interface ContextMenuRequest {
	/** 视口坐标（clientX/clientY）。 */
	x: number;
	/** 视口坐标（clientX/clientY）。 */
	y: number;
	/** 哪个槽位（决定渲染哪批条目）。 */
	slot: ContextMenuSlot;
	/** 被右键的对象标识（条目 id 会被回传；宿主用它决定禁用/显示）。
	 *  owner = 「另一处」行的持有方 clientId（过户目标定位用，其余行无此字段）。 */
	target: { id: string; kind?: string; label?: string; owner?: string };
	/** 该槽位的最终条目（调用方已用 buildUiSlots 算好；组件不再算）。 */
	entries: UiSlotEntry[];
	/**
	 * **host 内置条目**的分派器（可选；由打开菜单的那个宿主组件随请求带进来）。
	 *
	 * 为什么需要它：`onAction` 只把 `(entry, target)` 交回宿主 App，而 App 只分发**插件**
	 * 动作 —— 它不知道「右键的是哪个目录 / 哪条对话」。而 `host:*` 这类内置条目的实现就住在
	 * 打开菜单的那个组件里（右栏文件树 / 左栏会话行），所以让它随请求把分派器一起带进来：
	 * ContextMenu 对 `source === "host"` 的条目先调它，插件条目才落到 App 的 onAction。
	 *
	 * 返回值：`true` = 「先别关菜单」（分派器自己把菜单换成了下一段内容，例如强行关闭对话的
	 * 第一段确认 —— 见 LeftPanel）；其余（含 undefined）照常点完即关。
	 */
	onHostAction?: (entry: UiSlotEntry, target: ContextMenuRequest["target"]) => void | boolean;
}

/* ------------------------------------------------------------------ */
/* 状态 store（模块级单例）                                              */
/* ------------------------------------------------------------------ */

/** 当前打开的右键菜单；null = 没打开。**引用稳定**：只在 open/close 时替换。 */
let cached: ContextMenuRequest | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/**
 * 打开右键菜单（同一时刻只有一个 → 后开的直接顶掉先开的）。
 *
 * 不做「同内容不通知」的优化：打开菜单是**用户显式动作**，即使条目一模一样，
 * 坐标也可能变了（同一批条目在不同位置右键），漏通知就会出现「菜单停在旧位置」。
 * 而 `entries` 每次都是调用方新算的数组（buildUiSlots 的产物），本来也无法廉价比较。
 */
export function openContextMenu(req: ContextMenuRequest): void {
	cached = {
		x: Number.isFinite(req.x) ? req.x : 0,
		y: Number.isFinite(req.y) ? req.y : 0,
		slot: req.slot,
		target: req.target ?? { id: "" },
		// 脏数据（null / 非数组）当空菜单处理：组件会渲染出「空的菜单」而不是崩在 .filter 上。
		entries: Array.isArray(req.entries) ? req.entries : [],
		// host 分派器只在真的给了函数时才带上这个字段：没给时对象形状与从前完全一致
		// （单测/调试里对着快照断言不会平白多出一个 undefined 键）。
		...(typeof req.onHostAction === "function" ? { onHostAction: req.onHostAction } : {}),
	};
	notify();
}

/** 关闭右键菜单。已经关着时**不通知**（避免关闭动作引发多余的渲染）。 */
export function closeContextMenu(): void {
	if (cached === null) return;
	cached = null;
	notify();
}

/** 订阅变更（React 组件请用 useContextMenu）。返回退订函数。 */
export function subscribeContextMenu(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** 当前请求（未打开 = null，恒为同一引用）。 */
export function getContextMenu(): ContextMenuRequest | null {
	return cached;
}

/** 仅供单测：清空状态（不通知订阅者），避免用例之间互相串。 */
export function resetContextMenu(): void {
	cached = null;
}

/** React hook：组件里 `const menu = useContextMenu();` */
export function useContextMenu(): ContextMenuRequest | null {
	return useSyncExternalStore(subscribeContextMenu, getContextMenu, getContextMenu);
}

/* ------------------------------------------------------------------ */
/* 纯函数 1：定位钳制                                                    */
/* ------------------------------------------------------------------ */

/** 菜单与视口边缘之间保留的间距（px）。与 tip-position.ts 的 TIP_MARGIN 同值同义。 */
export const MENU_MARGIN = 8;

/** 非有限数（undefined / NaN / Infinity）一律当 0 —— 未实测到尺寸时只做贴边钳制，别算出 NaN。 */
function finite(v: number): number {
	return Number.isFinite(v) ? v : 0;
}

/**
 * 把菜单摆在光标处，但不让它越出视口。
 *
 * 规则：
 *  - 光标离左/上边不足 8px → 内缩到 8px（贴边不留缝）。
 *  - 光标右侧/下侧放不下 → 反向贴齐到 `视口 - 菜单尺寸 - 8`，即「向右下弹不下就向左上翻」。
 *  - 菜单比视口还大（`vw - w - 8 < 8`）→ 取 8，宁可裁掉右下角，也不要冒出负坐标（负坐标会把
 *    左上角的内容推到屏幕外，用户连第一项都点不到）。
 *
 * 纯函数：坐标/尺寸/视口都从外面传（组件里传 `window.innerWidth/Height` 与实测矩形），
 * 因此可穷举四角与极端尺寸。
 */
export function clampMenuPosition(
	x: number,
	y: number,
	w: number,
	h: number,
	vw: number,
	vh: number,
): { x: number; y: number } {
	const width = Math.max(0, finite(w));
	const height = Math.max(0, finite(h));
	const maxX = Math.max(MENU_MARGIN, finite(vw) - width - MENU_MARGIN);
	const maxY = Math.max(MENU_MARGIN, finite(vh) - height - MENU_MARGIN);
	return {
		x: Math.min(Math.max(MENU_MARGIN, finite(x)), maxX),
		y: Math.min(Math.max(MENU_MARGIN, finite(y)), maxY),
	};
}

/* ------------------------------------------------------------------ */
/* 纯函数 2：条目过滤 + 分组聚类排序                                      */
/* ------------------------------------------------------------------ */

/** `when` 条件求值的上下文：条件名 → 当前是否为真（由打开菜单的宿主现场构造）。
 *  已知条件名（协议 UiContribution.when 注释里的词表）：
 *  - `file.isDir` / `file.isFile`（contextmenu.file，取自 target.kind）
 *  - `session.isRunning`（contextmenu.session：running 对话为真，历史会话为假）
 *  - `message.hasSelection`（contextmenu.message：右键时有文本选中；宿主原生菜单让路时为假）
 *  宿主不认识的条件名一律忽略（不置灰），插件可放心写未来的条件。 */
type WhenContext = Record<string, boolean>;

/** 按槽位 + 被右键对象构造求值上下文（纯函数）。target.kind 由各打开方提供
 *  （RightPanel: file/dir；LeftPanel: running/history；Message: message）。 */
export function buildWhenContext(slot: ContextMenuSlot, target: ContextMenuRequest["target"] | undefined): WhenContext {
	const kind = String(target?.kind ?? "");
	if (slot === "contextmenu.file") {
		const isDir = kind === "dir" || (kind === "list" && target?.id !== "@root");
		return { "file.isDir": isDir, "file.isFile": kind === "file" };
	}
	if (slot === "contextmenu.session") return { "session.isRunning": kind === "running" };
	if (slot === "contextmenu.message") {
		let hasSelection = false;
		try {
			const sel = window.getSelection?.();
			hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
		} catch {
			hasSelection = false;
		}
		return { "message.hasSelection": hasSelection };
	}
	return {};
}

/** 求一批 `when` 条件 → 是否置灰（纯函数，单测覆盖）。
 *
 *  - `"disabled"` / `"never"`：恒置灰；`"always"`：恒不置灰（显式逃生舱）。
 *  - `"!x"`：要求 x 为真。ctx 里有 x 就按 ctx 判；ctx 没有 x（旧调用方没传上下文）
 *    按 legacy 语义直接置灰 —— 宿主过去只在「已评估为假」时才追加 `!` 前缀。
 *  - `"x"`（肯定形，插件声明的适用条件）：ctx 里有 x 且为假 → 置灰；ctx 里没有 x
 *    （宿主不认识的条件）→ 忽略，不断言 —— 未知条件默认可用，未来加新条件不翻旧插件。
 */
export function evaluateWhen(when: string[] | undefined, ctx?: WhenContext): boolean {
	if (!Array.isArray(when) || when.length === 0) return false;
	for (const raw of when) {
		if (typeof raw !== "string" || !raw) continue;
		const c = raw.trim();
		if (c === "disabled" || c === "never") return true;
		if (c === "always") continue;
		if (c.startsWith("!")) {
			const key = c.slice(1).trim();
			if (!key) continue;
			// 有上下文按上下文判；没有上下文 = legacy：宿主追加 `!` 即代表已评估为假。
			if (!ctx || ctx[key] !== true) return true;
			continue;
		}
		if (ctx && ctx[c] === false) return true;
	}
	return false;
}

/**
 * 「宿主已判定该条目当前不可用」的标注 —— UiSlotEntry 里没有 disabled 字段
 * （协议不为右键菜单单独加字段），所以借 `when` 这条既有通道表达：
 *
 *  - 字面量 `"disabled"`：无条件置灰（最简单的逃生舱，插件/宿主都能用）。
 *  - 以 `!` 开头的条件（如 `"!message.hasSelection"`）：宿主**已经评估过**这个条件且
 *    结论为假 —— 保留条目、置灰，让用户看得见「这里本来有个操作，只是现在不适用」。
 *    （真不该出现的条目请用 `hidden: true` 或让宿主从 entries 里剔除；置灰只是「不可用」。）
 *  - 肯定形条件（如 `"file.isDir"`）：插件声明的适用条件，调用方传了 ctx（见
 *    buildWhenContext）且该条件为假 → 置灰；没传 ctx 或宿主不认识 → 忽略。
 *
 * 置灰的条目**仍然渲染**（半透明、不可点、键盘导航跳过），这与「hidden = 直接不显示」
 * 是两件事：右键菜单里没有「溢出」概念，所以 hidden 一律跳过（见 contextMenuItems）。
 */
export function isContextMenuEntryDisabled(entry: UiSlotEntry | undefined, ctx?: WhenContext): boolean {
	if (!entry) return true;
	return evaluateWhen(entry.when, ctx);
}

/**
 * kind="select" 在右键菜单里没有下拉位置 —— 展开成子菜单：options 即子项
 * （`when` 等其它字段留在父条目上，子项只算自己的 `hidden`）。
 *
 * 返回展开后的条目（与入参一一对应、同长度同顺序，下标导航可直接对着它算）与
 * 合成子项 id → { 父条目, 选中的 option value } 的回查表（渲染层点选子项时用）。
 * 已有 children 的 select 不动（作者显式给了菜单结构，以作者为准）。
 * 纯函数，单测覆盖。
 */
export function expandSelectEntries(entries: UiSlotEntry[]): {
	items: UiSlotEntry[];
	selectParents: Map<string, { parent: UiSlotEntry; value: string }>;
} {
	const parents = new Map<string, { parent: UiSlotEntry; value: string }>();
	const items = (Array.isArray(entries) ? entries : []).map((it) => {
		if (!it || it.kind !== "select" || !it.options?.length || it.children?.length) return it;
		const children: UiSlotEntry[] = it.options.map((o, i) => ({
			id: `${it.id}#${i}`,
			slot: it.slot,
			source: it.source,
			label: o.label,
			kind: "action" as const,
			order: 100,
			align: "start" as const,
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		}));
		children.forEach((c, i) => parents.set(c.id, { parent: it, value: it.options![i]!.value }));
		return { ...it, kind: "menu" as const, children };
	});
	return { items, selectParents: parents };
}

/**
 * 右键菜单真正要呈现的条目（纯函数，可穷举）：
 *  1. **跳过 `hidden === true`** 的条目。注意这跟顶栏不一样 —— 顶栏里 hidden = 进溢出菜单，
 *     而「右键菜单」没有溢出概念（没有一个「更多」入口可以把隐藏项捞回来），留着等于
 *     永远看不到却又占位置，所以直接跳过。
 *  2. **保留 `kind === "divider"`**：显式分隔线是插件/宿主的排版意图，渲染层会画成分隔线。
 *  3. **按 group 聚类**：同一 group 的条目必须连续（不然「同组加分隔线」就无从谈起）。
 *     组的位次 = 组内最小 order，并列时用「组首次出现的序号」兜底 —— 与 ui-slots.ts 的
 *     「权重优先、声明顺序兜底」同一口径。没有 group 的条目视为同一个空组。
 *  4. 组内按 order 升序，order 相同保持**声明顺序**（稳定排序，不让插件因为 sort 的实现
 *     细节莫名其妙地换位置）。
 *
 * 分隔线的特殊处理：它**不参与上面的排序**，而是锚定在「输入顺序里紧跟在它后面的那个
 * 幸存条目」之前 —— 分隔线的语义是「我下面这条属于新的一段」，锚着后继条目走才能在条目
 * 因分组合并/权重变化而重排时仍然分隔在对的地方。没有后继幸存条目（末尾）的分隔线丢弃。
 */
export function contextMenuItems(entries: UiSlotEntry[]): UiSlotEntry[] {
	if (!Array.isArray(entries) || entries.length === 0) return [];
	const kept = entries.filter((e) => e && e.hidden !== true);
	const real = kept.filter((e) => e.kind !== "divider");

	// 组的位次：按输入顺序扫一遍，记下每个组的「最小 order」与「首现序号」。
	const groupRank = new Map<string, number>();
	const groupMinOrder = new Map<string, number>();
	real.forEach((e, index) => {
		const key = e.group ?? "";
		if (!groupRank.has(key)) groupRank.set(key, index);
		const order = Number.isFinite(e.order) ? e.order : 100;
		const min = groupMinOrder.get(key);
		if (min === undefined || order < min) groupMinOrder.set(key, order);
	});
	const sortedGroups = [...groupRank.keys()].sort((a, b) => {
		const oa = groupMinOrder.get(a) ?? 100;
		const ob = groupMinOrder.get(b) ?? 100;
		if (oa !== ob) return oa - ob;
		return (groupRank.get(a) ?? 0) - (groupRank.get(b) ?? 0);
	});
	const groupPos = new Map(sortedGroups.map((key, i) => [key, i]));

	// 组内：order → 声明序号（稳定）。
	const seq = new Map<UiSlotEntry, number>();
	real.forEach((e, i) => seq.set(e, i));
	const sorted = [...real].sort((a, b) => {
		const ga = groupPos.get(a.group ?? "") ?? 0;
		const gb = groupPos.get(b.group ?? "") ?? 0;
		if (ga !== gb) return ga - gb;
		const oa = Number.isFinite(a.order) ? a.order : 100;
		const ob = Number.isFinite(b.order) ? b.order : 100;
		if (oa !== ob) return oa - ob;
		return (seq.get(a) ?? 0) - (seq.get(b) ?? 0);
	});

	// 分隔线：锚到「输入顺序里它后面的第一个幸存条目」（对象引用作 key，不依赖 id 唯一）。
	const anchor = new Map<UiSlotEntry, UiSlotEntry[]>();
	kept.forEach((e, i) => {
		if (e.kind !== "divider") return;
		const next = kept.slice(i + 1).find((x) => x.kind !== "divider");
		if (!next) return; // 末尾的分隔线：没有下文可分隔 → 丢弃
		const list = anchor.get(next) ?? [];
		list.push(e);
		anchor.set(next, list);
	});

	const out: UiSlotEntry[] = [];
	for (const e of sorted) {
		for (const sep of anchor.get(e) ?? []) out.push(sep);
		out.push(e);
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* 纯函数 3：渲染行（显式分隔线 + 自动分组分隔线）                          */
/* ------------------------------------------------------------------ */

/** 一行渲染单元：分隔线，或某个条目（`index` = 它在 items 数组里的下标，键盘导航同款下标）。 */
type ContextMenuRow = { kind: "sep"; key: string } | { kind: "item"; key: string; index: number; entry: UiSlotEntry };

/**
 * items（contextMenuItems 的产物）→ 渲染行。
 *
 *  - `kind === "divider"` 的条目 → 一条分隔线（不渲染成可点条目）。
 *  - 相邻两条目 group 不同 → 自动补一条分隔线（「同组连续 + 组间分隔线」的落地）。
 *  - 折叠：开头的分隔线、连续重复的分隔线、结尾的分隔线一律不输出 —— 右键菜单里它们只会
 *    在边缘/中间多出一道空线；显式 divider 与自动分组线撞在一起时也自然并成一条。
 */
export function contextMenuRows(items: UiSlotEntry[]): ContextMenuRow[] {
	const rows: ContextMenuRow[] = [];
	let prevGroup: string | null = null; // null = 还没渲染过任何条目
	let pendingSep = false;
	items.forEach((entry, index) => {
		if (!entry || entry.kind === "divider") {
			pendingSep = true;
			return;
		}
		const group = entry.group ?? "";
		if (prevGroup !== null && (pendingSep || group !== prevGroup)) {
			rows.push({ kind: "sep", key: `sep:${index}` });
		}
		rows.push({ kind: "item", key: `${entry.id}#${index}`, index, entry });
		prevGroup = group;
		pendingSep = false;
	});
	return rows;
}

/* ------------------------------------------------------------------ */
/* 纯函数 4：键盘导航下标                                                */
/* ------------------------------------------------------------------ */

/** 该条目能不能被键盘选中（分隔线 / 置灰 / 隐藏都不能）。 */
function navigable(entry: UiSlotEntry | undefined, ctx?: WhenContext): boolean {
	if (!entry) return false;
	if (entry.kind === "divider") return false;
	if (entry.hidden === true) return false;
	return !isContextMenuEntryDisabled(entry, ctx);
}

/**
 * 从 current 出发按 delta 方向找下一个**可用**条目，环形（到底回顶/到顶回底）。
 *
 * 语义：
 *  - 带 `children` 的菜单项**可以**被选中（选中即展开子菜单），所以不跳过 —— 键盘用户
 *    必须能走到「更多操作」那一项上。（Enter 对它只展开、不触发动作，见组件里的 activate。）
 *  - `current` 不在 0..n-1 内（含 -1 = 还没选中任何项）时：向下取第一个可用条目，向上取最后一个。
 *  - `delta === 0` 按向下处理；全不可用（或空列表）→ `-1`（组件据此不画高亮，Enter 也无事发生）。
 */
export function nextEnabledIndex(items: UiSlotEntry[], current: number, delta: number, ctx?: WhenContext): number {
	const n = Array.isArray(items) ? items.length : 0;
	if (n === 0) return -1;
	const step = delta >= 0 ? 1 : -1;
	let i = Number.isFinite(current) ? Math.trunc(current) : -1;
	if (i < 0 || i >= n) i = step > 0 ? -1 : n;
	for (let k = 0; k < n; k++) {
		i = (i + step + n) % n;
		if (navigable(items[i], ctx)) return i;
	}
	return -1;
}

/* ------------------------------------------------------------------ */
/* 纯函数 5：图标字形                                                    */
/* ------------------------------------------------------------------ */

/**
 * 宿主图标词表（ui-slots.ts 末尾注释里那份）→ unicode 字形。
 *
 * 为什么不引 react-icons：本组件刻意只依赖 react + react-dom（右键菜单要给插件用，
 * 依赖面越小越好）。宿主条目里的 `icon` 是**词表名**（"folder" 这种字符串，直接画出来
 * 就是乱码），所以这里做一层名字→字形的映射；插件条目里的 icon 按协议本来就是 emoji /
 * 单字符，原样返回。
 */
const GLYPHS: Record<string, string> = {
	menu: "☰",
	folder: "📁",
	plus: "＋",
	chat: "💬",
	terminal: "▙",
	git: "⎇",
	search: "🔍",
	browser: "🌐",
	layers: "🗂",
	settings: "⚙",
	sound: "🔊",
	globe: "🌍",
	sun: "☀",
	download: "⤓",
	github: "⌗",
	x: "✕",
	upload: "⬆",
	copy: "⧉",
	cut: "✂",
	paste: "📋",
	trash: "🗑",
	file: "📄",
	open: "↗",
	refresh: "⟳",
	link: "🔗",
	edit: "✎",
	dot: "●",
	info: "ⓘ",
	cpu: "▣",
	gauge: "▤",
	coins: "◉",
	database: "▥",
	message: "✉",
	activity: "〜",
	markdown: "📄",
	text: "≡",
	image: "🖼",
	branch: "⚚",
	undo: "↺",
	pin: "📌",
	volume: "🔊",
};

/**
 * 图标字符串 → 可以安全当文本画的字形；画不出合适的就返回 ""（**宁可不画**，也不要把
 * "folder" 这种英文名当图标印在菜单上）。
 * 判定：词表命中直接用；否则「不含字母数字（即纯符号/emoji）」且长度 ≤ 4 的短串原样用
 * （emoji 带修饰符可能占 2 个 code unit，所以给到 4）。
 */
export function contextMenuGlyph(icon?: string): string {
	const s = (icon ?? "").trim();
	if (!s) return "";
	const known = GLYPHS[s.toLowerCase()];
	if (known) return known;
	return /[^\p{L}\p{N}\s]/u.test(s) && s.length <= 4 ? s : "";
}
