/**
 * 通用右键菜单基础设施（web/src/context-menu-state.ts + components/ContextMenu.tsx）单测。
 *
 * 只测**纯逻辑**（本环境的 vitest environment = "node"，见 vitest.config.ts）：坐标钳制、
 * 条目过滤/分组排序、渲染行、键盘下标推进、模块级 store 的订阅语义。
 * 渲染层（portal / 焦点 / 事件监听）由真浏览器回归覆盖，不在单测里造 DOM。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	buildWhenContext,
	clampMenuPosition,
	closeContextMenu,
	contextMenuGlyph,
	contextMenuItems,
	contextMenuRows,
	evaluateWhen,
	expandSelectEntries,
	getContextMenu,
	isContextMenuEntryDisabled,
	MENU_MARGIN,
	nextEnabledIndex,
	openContextMenu,
	resetContextMenu,
	subscribeContextMenu,
	type ContextMenuRequest,
} from "../../web/src/context-menu-state.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";

/** 造一条最终条目（只填用例关心的字段，其余走 UiSlotEntry 的缺省值）。 */
function entry(id: string, partial: Partial<UiSlotEntry> = {}): UiSlotEntry {
	return {
		id,
		slot: "contextmenu.message",
		source: "host",
		label: id,
		kind: "action",
		order: 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
		...partial,
	};
}

const ids = (list: UiSlotEntry[]) => list.map((e) => e.id);

afterEach(() => {
	resetContextMenu();
});

describe("clampMenuPosition", () => {
	const menu = { w: 200, h: 120 };
	const viewport = { vw: 1000, vh: 800 };

	it("中间：原样不动（不越界就不改坐标，菜单就长在光标右下角）", () => {
		expect(clampMenuPosition(400, 300, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({ x: 400, y: 300 });
	});

	it("左上角：光标贴边时内缩到 8px（不然菜单左上角在屏幕外）", () => {
		expect(clampMenuPosition(0, 0, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: MENU_MARGIN,
			y: MENU_MARGIN,
		});
		expect(clampMenuPosition(3, 7, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: MENU_MARGIN,
			y: MENU_MARGIN,
		});
	});

	it("右下角：放不下就向左/上翻，四条边都留 8px", () => {
		expect(clampMenuPosition(950, 790, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: viewport.vw - menu.w - MENU_MARGIN,
			y: viewport.vh - menu.h - MENU_MARGIN,
		});
	});

	it("只越右边 / 只越下边：各自独立钳制（另一轴不动）", () => {
		expect(clampMenuPosition(990, 300, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: viewport.vw - menu.w - MENU_MARGIN,
			y: 300,
		});
		expect(clampMenuPosition(400, 799, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: 400,
			y: viewport.vh - menu.h - MENU_MARGIN,
		});
	});

	it("菜单比视口还大：贴左上 8px（宁可裁右下，也不给负坐标）", () => {
		expect(clampMenuPosition(500, 500, 2000, 1200, viewport.vw, viewport.vh)).toEqual({
			x: MENU_MARGIN,
			y: MENU_MARGIN,
		});
	});

	it("脏输入（NaN / undefined 尺寸）当 0 处理，不产生 NaN 坐标", () => {
		expect(clampMenuPosition(400, 300, Number.NaN, Number.NaN, viewport.vw, viewport.vh)).toEqual({ x: 400, y: 300 });
		expect(clampMenuPosition(Number.NaN, Number.NaN, menu.w, menu.h, viewport.vw, viewport.vh)).toEqual({
			x: MENU_MARGIN,
			y: MENU_MARGIN,
		});
	});
});

describe("contextMenuItems（过滤 + 分组聚类 + 稳定排序）", () => {
	it("hidden 跳过、divider 保留", () => {
		const list = [
			entry("a", { order: 10 }),
			entry("h", { order: 15, hidden: true }),
			entry("d", { kind: "divider", order: 16 }),
			entry("b", { order: 20 }),
		];
		// divider 锚在输入顺序里它后面第一个幸存条目（b）之前。
		expect(ids(contextMenuItems(list))).toEqual(["a", "d", "b"]);
	});

	it("同组连续：按「组内最小 order」决定组的位次，组间不交错", () => {
		const list = [
			entry("a2", { group: "a", order: 30 }),
			entry("b1", { group: "b", order: 10 }),
			entry("a1", { group: "a", order: 20 }),
		];
		// b 组最小 order = 10 < a 组 20 → b 整组在前；a 组内 20 在 30 前。
		expect(ids(contextMenuItems(list))).toEqual(["b1", "a1", "a2"]);
	});

	it("无 group 的条目视为同一个（空）组：就是一条按 order 的流水", () => {
		const list = [entry("a", { order: 30 }), entry("b", { order: 10 }), entry("c", { order: 20 })];
		expect(ids(contextMenuItems(list))).toEqual(["b", "c", "a"]);
	});

	it("order 相同时保持声明顺序（稳定排序：插件不该因为排序实现细节换位置）", () => {
		const list = [entry("z"), entry("y"), entry("x")];
		expect(ids(contextMenuItems(list))).toEqual(["z", "y", "x"]);
	});

	it("末尾的显式分隔线被丢弃（没有下文可分隔）", () => {
		expect(ids(contextMenuItems([entry("a"), entry("d", { kind: "divider" })]))).toEqual(["a"]);
		// 只剩分隔线时结果为空
		expect(contextMenuItems([entry("d1", { kind: "divider" }), entry("d2", { kind: "divider" })])).toEqual([]);
	});

	it("空 / 脏输入返回空数组（不抛错）", () => {
		expect(contextMenuItems([])).toEqual([]);
		expect(contextMenuItems(undefined as unknown as UiSlotEntry[])).toEqual([]);
	});

	it("不修改入参数组（纯函数）", () => {
		const list = [entry("a", { order: 30 }), entry("b", { order: 10 })];
		const snapshot = [...list];
		contextMenuItems(list);
		expect(list).toEqual(snapshot);
	});
});

describe("contextMenuRows（分隔线合并 / 折叠）", () => {
	const rowKinds = (list: UiSlotEntry[]) =>
		contextMenuRows(contextMenuItems(list)).map((r) => (r.kind === "sep" ? "sep" : r.entry.id));

	it("跨组自动补分隔线", () => {
		expect(rowKinds([entry("a", { group: "x", order: 10 }), entry("b", { group: "y", order: 20 })])).toEqual([
			"a",
			"sep",
			"b",
		]);
	});

	it("同组之间不插线；显式 divider 与分组线撞在一起时并成一条", () => {
		expect(rowKinds([entry("a", { order: 10 }), entry("b", { order: 20 })])).toEqual(["a", "b"]);
		expect(
			rowKinds([
				entry("a", { group: "x", order: 10 }),
				entry("d", { kind: "divider", order: 11 }),
				entry("b", { group: "y", order: 20 }),
			]),
		).toEqual(["a", "sep", "b"]);
	});

	it("开头的分隔线不输出、结尾的不输出（边缘多一道空线只会显得没做完）", () => {
		expect(rowKinds([entry("d", { kind: "divider" }), entry("a", { order: 20 })])).toEqual(["a"]);
		expect(rowKinds([entry("a", { order: 20 }), entry("d", { kind: "divider" })])).toEqual(["a"]);
	});

	it("行的 index 是它在 items 数组里的下标（键盘导航与渲染共用同一套下标）", () => {
		const items = contextMenuItems([
			entry("a", { order: 10 }),
			entry("d", { kind: "divider" }),
			entry("b", { order: 20 }),
		]);
		const rows = contextMenuRows(items);
		for (const row of rows) {
			if (row.kind === "item") expect(items[row.index]).toBe(row.entry);
		}
	});
});

describe("nextEnabledIndex（键盘导航，环形）", () => {
	const items = [
		entry("a"),
		entry("sep", { kind: "divider" }),
		entry("dis", { when: ["disabled"] }),
		entry("neg", { when: ["!message.hasSelection"] }),
		entry("b"),
	];

	it("向下从 -1 起：第一条可用条目（跳过分隔线与置灰项）", () => {
		expect(nextEnabledIndex(items, -1, 1)).toBe(0);
		// 0 → 跳过 1/2/3 → 4
		expect(nextEnabledIndex(items, 0, 1)).toBe(4);
	});

	it("环形：到底回顶、到顶回底", () => {
		expect(nextEnabledIndex(items, 4, 1)).toBe(0);
		expect(nextEnabledIndex(items, 0, -1)).toBe(4);
	});

	it("向上从 -1 起：最后一条可用条目", () => {
		expect(nextEnabledIndex(items, -1, -1)).toBe(4);
	});

	it("带 children 的菜单项可以被选中（要能走到「更多操作」上），只是 Enter 不触发它", () => {
		const withSub = [entry("a"), entry("more", { kind: "menu", children: [entry("c1")] })];
		expect(nextEnabledIndex(withSub, 0, 1)).toBe(1);
	});

	it("全部不可用 → -1；空列表 → -1", () => {
		expect(nextEnabledIndex([entry("d", { kind: "divider" }), entry("x", { when: ["disabled"] })], -1, 1)).toBe(-1);
		expect(nextEnabledIndex([], 0, 1)).toBe(-1);
	});

	it("current 越界（比如收到旧下标）时按 -1 处理，不抛错", () => {
		expect(nextEnabledIndex(items, 99, 1)).toBe(0);
		expect(nextEnabledIndex(items, 99, -1)).toBe(4);
	});
});

describe("isContextMenuEntryDisabled", () => {
	it("when 里出现 disabled 或 !条件 → 置灰", () => {
		expect(isContextMenuEntryDisabled(entry("a"))).toBe(false);
		expect(isContextMenuEntryDisabled(entry("a", { when: ["always"] }))).toBe(false);
		expect(isContextMenuEntryDisabled(entry("a", { when: ["disabled"] }))).toBe(true);
		expect(isContextMenuEntryDisabled(entry("a", { when: ["message.hasSelection", "!file.isText"] }))).toBe(true);
	});

	it("undefined（下标越界）当作不可用", () => {
		expect(isContextMenuEntryDisabled(undefined)).toBe(true);
	});
});

describe("evaluateWhen（P0-3 条件表达式）", () => {
	it("特殊字面量：disabled/never 恒置灰，always 恒可用", () => {
		expect(evaluateWhen(["disabled"], {})).toBe(true);
		expect(evaluateWhen(["never"], {})).toBe(true);
		expect(evaluateWhen(["always"], {})).toBe(false);
		expect(evaluateWhen(["always", "disabled"], {})).toBe(true);
	});

	it("肯定形：ctx 里为假 → 置灰；ctx 里没有（宿主不认识）→ 忽略", () => {
		expect(evaluateWhen(["file.isDir"], { "file.isDir": true })).toBe(false);
		expect(evaluateWhen(["file.isDir"], { "file.isDir": false })).toBe(true);
		expect(evaluateWhen(["file.isDir"], {})).toBe(false);
		expect(evaluateWhen(["future.condition"], {})).toBe(false);
	});

	it("否定形：legacy（无 ctx）恒置灰；有 ctx 按 ctx 判", () => {
		expect(evaluateWhen(["!file.isText"])).toBe(true);
		expect(evaluateWhen(["!file.isDir"], { "file.isDir": true })).toBe(false);
		expect(evaluateWhen(["!file.isDir"], { "file.isDir": false })).toBe(true);
		expect(evaluateWhen(["!unknown"], {})).toBe(true);
	});

	it("空/脏输入不置灰不抛错", () => {
		expect(evaluateWhen(undefined, {})).toBe(false);
		expect(evaluateWhen([], {})).toBe(false);
		expect(evaluateWhen(["", null as unknown as string], {})).toBe(false);
	});
});

describe("buildWhenContext（按槽位 + target 现场构造）", () => {
	it("文件菜单按 kind 给 file.isDir/isFile（列表空白处代表当前目录，同样具备 file.isDir，机器根除外）", () => {
		expect(buildWhenContext("contextmenu.file", { id: "x", kind: "dir" })).toEqual({
			"file.isDir": true,
			"file.isFile": false,
		});
		expect(buildWhenContext("contextmenu.file", { id: "x", kind: "file" })["file.isFile"]).toBe(true);
		expect(buildWhenContext("contextmenu.file", { id: "", kind: "list" })["file.isDir"]).toBe(true);
		expect(buildWhenContext("contextmenu.file", { id: "src", kind: "list" })["file.isDir"]).toBe(true);
		expect(buildWhenContext("contextmenu.file", { id: "@root", kind: "list" })["file.isDir"]).toBe(false);
	});

	it("会话菜单按 kind 给 session.isRunning", () => {
		expect(buildWhenContext("contextmenu.session", { id: "x", kind: "running" })).toEqual({
			"session.isRunning": true,
		});
		expect(buildWhenContext("contextmenu.session", { id: "x", kind: "history" })["session.isRunning"]).toBe(false);
	});

	it("组合：目录行的只对文件条目在目录上置灰、在文件上可用", () => {
		const onlyFile = entry("only-file", { when: ["file.isFile"] });
		const dirCtx = buildWhenContext("contextmenu.file", { id: "d", kind: "dir" });
		const fileCtx = buildWhenContext("contextmenu.file", { id: "f", kind: "file" });
		expect(isContextMenuEntryDisabled(onlyFile, dirCtx)).toBe(true);
		expect(isContextMenuEntryDisabled(onlyFile, fileCtx)).toBe(false);
		expect(nextEnabledIndex([onlyFile], -1, 1, dirCtx)).toBe(-1);
		expect(nextEnabledIndex([onlyFile], -1, 1, fileCtx)).toBe(0);
	});
});

describe("contextMenuGlyph", () => {
	it("宿主词表名 → 字形；插件 emoji 原样；认不出的英文名不画", () => {
		expect(contextMenuGlyph("folder")).toBe("📁");
		expect(contextMenuGlyph("markdown")).toBe("📄");
		expect(contextMenuGlyph("image")).toBe("🖼");
		expect(contextMenuGlyph("branch")).toBe("⚚");
		expect(contextMenuGlyph("undo")).toBe("↺");
		expect(contextMenuGlyph("volume")).toBe("🔊");
		expect(contextMenuGlyph("X")).toBe("✕");
		expect(contextMenuGlyph("🗑")).toBe("🗑");
		expect(contextMenuGlyph("folder-open")).toBe("");
		expect(contextMenuGlyph(undefined)).toBe("");
		expect(contextMenuGlyph("  ")).toBe("");
	});
});

describe("context-menu-state store（打开 / 关闭 / 订阅）", () => {
	const req = (over: Partial<ContextMenuRequest> = {}): ContextMenuRequest => ({
		x: 10,
		y: 20,
		slot: "contextmenu.message",
		target: { id: "m1", kind: "assistant" },
		entries: [entry("a")],
		...over,
	});

	it("默认没打开，且 getContextMenu 返回同一引用 null（useSyncExternalStore 要引用稳定）", () => {
		expect(getContextMenu()).toBeNull();
		expect(getContextMenu()).toBe(getContextMenu());
	});

	it("打开后能读到请求，引用稳定到下一次 open/close", () => {
		openContextMenu(req());
		const first = getContextMenu();
		expect(first?.slot).toBe("contextmenu.message");
		expect(first?.target.id).toBe("m1");
		expect(getContextMenu()).toBe(first);
	});

	it("后开的顶掉先开的（同一时刻只有一个菜单）", () => {
		openContextMenu(req());
		openContextMenu(req({ slot: "contextmenu.file", target: { id: "f1" } }));
		expect(getContextMenu()?.slot).toBe("contextmenu.file");
		expect(getContextMenu()?.target.id).toBe("f1");
	});

	it("脏坐标 / 脏 entries 被规范化（不抛错、不产生 NaN）", () => {
		openContextMenu(req({ x: Number.NaN, entries: null as unknown as UiSlotEntry[] }));
		expect(getContextMenu()?.x).toBe(0);
		expect(getContextMenu()?.entries).toEqual([]);
	});

	it("订阅：open 与 close 各通知一次；已关着时再 close 不通知", () => {
		let hits = 0;
		const off = subscribeContextMenu(() => hits++);
		openContextMenu(req());
		expect(hits).toBe(1);
		closeContextMenu();
		expect(hits).toBe(2);
		closeContextMenu(); // 已经关着：静默
		expect(hits).toBe(2);
		off();
	});

	it("退订后不再收到通知（返回的退订函数可用）", () => {
		let hits = 0;
		const off = subscribeContextMenu(() => hits++);
		off();
		openContextMenu(req());
		closeContextMenu();
		expect(hits).toBe(0);
	});

	it("重复打开同一位置也照常通知（同位置重开菜单的用户动作不能被吞掉）", () => {
		let hits = 0;
		const off = subscribeContextMenu(() => hits++);
		openContextMenu(req());
		openContextMenu(req());
		expect(hits).toBe(2);
		off();
	});
});

describe("expandSelectEntries（右键菜单里 select 展开成子菜单）", () => {
	function selectEntry(partial: Partial<UiSlotEntry> = {}): UiSlotEntry {
		return {
			id: "p:tone",
			slot: "contextmenu.file",
			source: "plugin:p",
			label: "语气",
			kind: "select",
			order: 100,
			align: "start",
			hidden: false,
			action: "p:tone",
			value: "full",
			options: [
				{ value: "short", label: "简短" },
				{ value: "full", label: "详细" },
			],
			userOverrides: [],
			arrangedBy: [],
			...partial,
		};
	}
	it("select → menu + 子项，回查表能找回父条目与 value", () => {
		const { items, selectParents } = expandSelectEntries([selectEntry()]);
		expect(items).toHaveLength(1);
		expect(items[0]!.kind).toBe("menu");
		expect(items[0]!.children!.map((c) => c.label)).toEqual(["简短", "详细"]);
		const childId = items[0]!.children![1]!.id;
		expect(selectParents.get(childId)).toEqual({
			parent: expect.objectContaining({ id: "p:tone", action: "p:tone" }),
			value: "full",
		});
	});
	it("非 select / 无 options / 已有 children 的原样不动", () => {
		const action = entry("a");
		const noOpts = selectEntry({ options: undefined });
		const withKids = selectEntry({
			children: [{ ...entry("k"), id: "p:tone#k" }],
		});
		const { items, selectParents } = expandSelectEntries([action, noOpts, withKids]);
		expect(items[0]!.kind).toBe("action");
		expect(items[1]!.kind).toBe("select");
		expect(items[1]!.children).toBeUndefined();
		expect(items[2]!.children).toHaveLength(1);
		expect(selectParents.size).toBe(0);
	});
	it("空/脏输入返回空数组不抛错", () => {
		expect(expandSelectEntries([])).toEqual({ items: [], selectParents: new Map() });
		expect(expandSelectEntries(undefined as unknown as UiSlotEntry[]).items).toEqual([]);
	});
});
