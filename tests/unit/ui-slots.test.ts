/**
 * 宿主 UI 扩展点引擎（web/src/ui-slots.ts，issue #146）单测。
 *
 * 锁的是**合并优先级**这条契约（宿主默认 < 插件贡献 < 插件 arrange < 用户偏好），
 * 以及布局页要用的审计字段（arrangedBy / userOverrides / movedFrom）。
 * 假数据自己构造（参考 plugin-topbar.test.ts）：UiPluginInfo 里只填本用例关心的字段。
 *
 * 另一个不变量：BUILTIN_UI_ITEMS 的 labelKey 必须真实存在于 zh 文案表里 ——
 * 内置条目表是「宿主入口的登记册」，key 打错 = 运行时显示成 key 本身，
 * 用一条断言把它挡在提交前（zh 表就是 i18n.tsx 里那份，见 locales.test.ts 同款导入）。
 */
import { describe, expect, it } from "vitest";
import {
	BUILTIN_UI_ITEMS,
	HIDDEN_FROM_LAYOUT_ITEM_IDS,
	UI_SLOT_SPECS,
	applyUiSlotCardinality,
	PLUGIN_VIEW_ITEM_ID,
	buildUiSlots,
	isPluginViewItem,
	pluginViewItemId,
	restoreAllUi,
	restoreUiItem,
	setPluginViewPinned,
	setPluginViewOrder,
	splitOverflow,
	withPluginViewItems,
	type UiDiagnostic,
} from "../../web/src/ui-slots.js";
import type { UiPluginInfo, UiSlotId } from "../../server/protocol.js";
import { zh } from "../../web/src/i18n.js";

const zhTable = zh as Record<string, string>;

/** 一个只带 ui 贡献的插件假数据。 */
function plugin(id: string, ui: UiPluginInfo["ui"], extra?: Partial<UiPluginInfo>): UiPluginInfo {
	return {
		id,
		name: id,
		hasClient: true,
		...(ui ? { ui } : {}),
		...extra,
	};
}

/** 测试用的 t()：直接回显 key —— 断言里就能看出「文案来自哪个 key」。 */
const t = (key: string) => `#${key}`;

/** 默认调用：中文界面 + 回显翻译。 */
function build(plugins: UiPluginInfo[], opts?: Partial<Parameters<typeof buildUiSlots>[1]>) {
	return buildUiSlots(plugins, { locale: "zh", t, ...opts });
}

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);

describe("UI slot cardinality（P1-4）", () => {
	it("所有现有挂载点都有显式 list 规格，新增 single 不会改变现有入口语义", () => {
		expect(UI_SLOT_SPECS).toHaveLength(37);
		expect(UI_SLOT_SPECS.every((spec) => spec.cardinality === "list")).toBe(true);
		expect(new Set(UI_SLOT_SPECS.map((spec) => spec.slot)).size).toBe(UI_SLOT_SPECS.length);
	});

	it("list 保留条目，返回新数组且不修改输入", () => {
		const input = [
			{ id: "a", hidden: false },
			{ id: "b", hidden: true },
		];
		const result = applyUiSlotCardinality(input, "list");
		expect(result.entries).toEqual(input);
		expect(result.entries).not.toBe(input);
		expect(result.conflicts).toEqual([]);
	});

	it("single 选择排序后的第一个可见条目，保留隐藏候选并置隐藏其它可见条目", () => {
		const input = [
			{ id: "winner", hidden: false },
			{ id: "hidden", hidden: true },
			{ id: "loser", hidden: false },
		];
		const result = applyUiSlotCardinality(input, "single");
		expect(result.winner?.id).toBe("winner");
		expect(result.conflicts.map((entry) => entry.id)).toEqual(["loser"]);
		expect(result.entries).toEqual([
			{ id: "winner", hidden: false },
			{ id: "hidden", hidden: true },
			{ id: "loser", hidden: true },
		]);
		expect(input[2]?.hidden).toBe(false);
	});

	it("single 没有可见候选时不选举、不产生冲突", () => {
		const input = [
			{ id: "a", hidden: true },
			{ id: "b", hidden: true },
		];
		expect(applyUiSlotCardinality(input, "single")).toEqual({ entries: input, conflicts: [] });
	});
});

describe("BUILTIN_UI_ITEMS（宿主默认）", () => {
	it("id 全局唯一、都以 host: 开头", () => {
		const all = BUILTIN_UI_ITEMS.map((i) => i.id);
		expect(new Set(all).size).toBe(all.length);
		for (const id of all) expect(id.startsWith("host:")).toBe(true);
	});

	it("每个内置条目的 labelKey 都在 zh 文案表里（写错 key 立刻失败）", () => {
		for (const item of BUILTIN_UI_ITEMS) {
			expect(zhTable[item.labelKey], `${item.id} → ${item.labelKey}`).toBeTypeOf("string");
			expect(zhTable[item.labelKey]?.trim().length, item.labelKey).toBeGreaterThan(0);
		}
	});

	it("覆盖宿主既有入口（顶栏/底栏/右键菜单），且没有把 settings.pages 列成内置", () => {
		const bySlot = (slot: UiSlotId) => BUILTIN_UI_ITEMS.filter((i) => i.slot === slot).map((i) => i.id);
		// 顶栏：视图三连 + 搜索/浏览器/后台任务/设置/语言/主题/更新
		expect(bySlot("topbar.primary")).toEqual(
			expect.arrayContaining([
				"host:chat",
				"host:terminal",
				"host:git",
				"host:search",
				"host:browser",
				"host:tasks",
				"host:settings",
				"host:language",
				"host:update",
			]),
		);
		// 底栏：上下文/成本/缓存/消息数/主机指标/工作目录
		expect(bySlot("bottombar")).toEqual(
			expect.arrayContaining([
				"host:ctx",
				"host:cost",
				"host:cache",
				"host:msg-count",
				"host:host-metrics",
				"host:cwd",
			]),
		);
		expect(bySlot("contextmenu.session").length).toBeGreaterThan(0);
		expect(bySlot("contextmenu.file").length).toBeGreaterThan(0);
		// 消息区右键菜单登记宿主操作项（复制/编辑/分支/回滚/朗读）
		expect(bySlot("contextmenu.message").length).toBeGreaterThan(0);
		expect(bySlot("settings.pages")).toEqual([]);
	});
});

describe("buildUiSlots / 第 1 层：宿主默认", () => {
	it("无插件、无偏好时：返回全部槽位，按 order 排序，文案走 t(labelKey)", () => {
		const slots = build([]);
		expect(ids(slots["topbar.primary"])).toEqual([
			"host:history",
			"host:brand",
			"host:open-project",
			"host:worktrees",
			"host:chat",
			"host:terminal",
			"host:git",
			"host:canvas",
			"host:plugins",
			"host:search",
			"host:browser",
			"host:tasks",
			"host:zen-mode",
			"host:device-center",
			"host:settings",
			"host:language",
			"host:theme",
			"host:update",
			"host:new-chat",
			"host:new-ephemeral-chat",
			"host:new-sandbox",
			"host:files",
			// order 200：尾部条目 = 实测溢出的第一顺位被收起者（见 BUILTIN_UI_ITEMS 注释）
			"host:github",
		]);
		expect(ids(slots.bottombar)).toEqual([
			"host:conn",
			"host:engine",
			"host:ctx",
			"host:cost",
			"host:cache",
			"host:msg-count",
			"host:plugin-status",
			"host:working",
			"host:status-delegate",
			"host:host-metrics",
			"host:cwd",
		]);
		const settings = slots["topbar.primary"].find((e) => e.id === "host:settings");
		expect(settings?.label).toBe("#settingsTitle");
		expect(settings?.labelKey).toBe("settingsTitle");
		expect(settings?.source).toBe("host");
		expect(settings?.kind).toBe("action");
		expect(settings?.hidden).toBe(false);
		expect(settings?.order).toBe(60);
		expect(slots["topbar.primary"].find((e) => e.id === "host:device-center")).toMatchObject({
			source: "host",
			label: "#deviceCenter",
			labelKey: "deviceCenter",
			kind: "view",
			view: "devices",
			hidden: false,
			order: 59,
			align: "end",
		});
		// 没用到的槽位是空数组（渲染层不必判空），且全部槽位都在
		expect(Object.keys(slots)).toHaveLength(37);
		expect(slots["composer.leading"]).toEqual([]);
		// 输入框动作区有 7 个宿主内置（上传/模板/模型/思考/DSH×2/发送），发送簇 align=end
		// （计划模式已搬到目标条 host:goal-plan）
		expect(ids(slots["composer.actions"])).toEqual([
			"host:composer-upload",
			"host:composer-templates",
			"host:composer-model",
			"host:composer-thinking",
			"host:composer-dsh-perm",
			"host:composer-dsh-preset",
			"host:composer-send",
		]);
		expect(slots["composer.actions"].find((e) => e.id === "host:composer-send")?.align).toBe("end");
		expect(slots["modal.dialog"]).toEqual([]);
	});

	/** 缺省收起 = 低频 / 有替代入口的条目落进顶栏「⋯」（App.tsx 把 hidden 的 primary 条目
	 *  塞进 uiOverflow → 菜单里能点，菜单型条目在菜单里是整块组件，功能不少）。
	 *  这条断言是「顶栏默认长什么样」的唯一入口 —— 想改默认口径就改这里与 BUILTIN_UI_ITEMS。 */
	it("缺省收进「⋯」的 5 条 + 常驻的 18 条", () => {
		const slots = build([]);
		const top = slots["topbar.primary"];
		expect(top.filter((e) => e.hidden).map((e) => e.id)).toEqual([
			"host:browser",
			"host:language",
			"host:theme",
			"host:update",
			"host:github",
		]);
		// 常驻 = 「切视图（chat/terminal/git/canvas/plugins/device-center） / 起新活（new-chat/new-ephemeral-chat/new-sandbox） /
		// 看运行态（tasks） / 进设置（settings）」四类，加品牌、项目、搜索、面板开关
		expect(top.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
			"host:history",
			"host:brand",
			"host:open-project",
			"host:worktrees",
			"host:chat",
			"host:terminal",
			"host:git",
			"host:canvas",
			"host:plugins",
			"host:search",
			"host:tasks",
			"host:zen-mode",
			"host:device-center",
			"host:settings",
			"host:new-chat",
			"host:new-ephemeral-chat",
			"host:new-sandbox",
			"host:files",
		]);
		// 缺省收起是「内置默认」，不写成用户覆盖 —— 否则布局页会把它们标成「已自定义」，
		// 「恢复」按钮还会把它们恢复成同一个值
		for (const e of top) expect(e.userOverrides).toEqual([]);
	});

	it("槽位 key 顺序 = 实际界面的 DOM/视觉顺序（布局页分区同表）", () => {
		const slots = build([]);
		expect(Object.keys(slots)).toEqual([
			"topbar.primary",
			"topbar.overflow",
			"notice.actions",
			"leftpanel.sections",
			"leftpanel.projects.actions",
			"leftpanel.project",
			"leftpanel.running.actions",
			"leftpanel.running",
			"leftpanel.history.actions",
			"leftpanel.history",
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
			"contextmenu.project",
			"contextmenu.file",
			"contextmenu.toolcall",
			"tool.card.footer",
			"settings.pages",
			"tasks.panel",
			"modal.dialog",
			"sidebar.left",
			"sidebar.right",
			"device.group.header",
			"device.group.actions",
			"device.group.workspace",
		]);
	});

	it("kind=view 的条目带 view 目标（宿主据此切视图）", () => {
		const slots = build([]);
		expect(slots["topbar.primary"].find((e) => e.id === "host:git")?.view).toBe("git");
		expect(slots["rightpanel.tabs"].map((e) => [e.id, e.view])).toEqual([["host:right-files", "files"]]);
	});

	it("同 order 时保持声明顺序（稳定排序）", () => {
		const slots = build([
			plugin("p", {
				items: [
					{ id: "b", slot: "bottombar", label: "B", order: 1 },
					{ id: "a", slot: "bottombar", label: "A", order: 1 },
					{ id: "c", slot: "bottombar", label: "C", order: 1 },
				],
				arrange: [],
			}),
		]);
		// 三个插件条目同权重 → 按声明顺序插在底栏最前（权重 1 < 内置的 5/10…）
		expect(ids(slots.bottombar).slice(0, 3)).toEqual(["p:b", "p:a", "p:c"]);
	});

	it("composer.leading：纯插件槽位，贡献按 order 落槽、无内置条目", () => {
		const slots = build([
			plugin("third", {
				items: [
					{ id: "b", slot: "composer.leading", label: "B", order: 20 },
					{ id: "a", slot: "composer.leading", label: "A", order: 10 },
				],
				arrange: [],
			}),
		]);
		expect(ids(slots["composer.leading"])).toEqual(["third:a", "third:b"]);
		// leading 的贡献不串进 actions（actions 只有 7 个宿主内置）
		expect(ids(slots["composer.actions"])).toEqual([
			"host:composer-upload",
			"host:composer-templates",
			"host:composer-model",
			"host:composer-thinking",
			"host:composer-dsh-perm",
			"host:composer-dsh-preset",
			"host:composer-send",
		]);
	});

	it("composer.actions：插件默认位（100）落在上传之后、模板之前，老按钮位置不动", () => {
		const slots = build([
			plugin("p", {
				items: [{ id: "x", slot: "composer.actions", label: "X" }],
				arrange: [],
			}),
		]);
		expect(ids(slots["composer.actions"])).toEqual([
			"host:composer-upload",
			"p:x",
			"host:composer-templates",
			"host:composer-model",
			"host:composer-thinking",
			"host:composer-dsh-perm",
			"host:composer-dsh-preset",
			"host:composer-send",
		]);
	});
});

describe("buildUiSlots / 第 2 层：插件贡献", () => {
	const alpha = plugin("alpha", {
		items: [
			{ id: "one", slot: "topbar.primary", label: "一号", labelEn: "One", order: 1 },
			{
				id: "menu",
				slot: "topbar.primary",
				label: "更多",
				order: 2,
				kind: "menu",
				// 子项的 slot 类型上也要求填（协议里由所在数组决定），实际渲染用父条目的槽位。
				children: [{ id: "sub", slot: "topbar.primary", label: "子项", action: "alpha:sub" }],
			},
		],
		arrange: [],
	});
	const beta = plugin("beta", { items: [{ id: "go", slot: "topbar.overflow", label: "去" }], arrange: [] });

	it("全局 id = <pluginId>:<itemId>；文案随语言（无 labelEn 时回落 label）", () => {
		const zhSlots = build([alpha, beta]);
		// 只看插件自己的条目（内置条目增减不该震到插件断言）
		expect(ids(zhSlots["topbar.primary"]).filter((id) => id.startsWith("alpha:"))).toEqual(["alpha:one", "alpha:menu"]);
		const one = zhSlots["topbar.primary"].find((e) => e.id === "alpha:one");
		expect(one?.label).toBe("一号");
		expect(one?.source).toBe("plugin:alpha");
		expect(one?.kind).toBe("action"); // 缺省 action
		const enSlots = build([alpha, beta], { locale: "en" });
		expect(enSlots["topbar.primary"].find((e) => e.id === "alpha:one")?.label).toBe("One");
		expect(enSlots["topbar.primary"].find((e) => e.id === "alpha:menu")?.label).toBe("更多"); // beta/alpha 没写 labelEn → 回落 label
	});

	it("插件条目进它声明的槽位；子项带在父条目上（子项不单列成挂载点条目）", () => {
		const slots = build([alpha, beta]);
		expect(ids(slots["topbar.overflow"])).toEqual(["beta:go"]);
		const menu = slots["topbar.primary"].find((e) => e.id === "alpha:menu");
		expect(menu?.kind).toBe("menu");
		expect(menu?.children?.map((c) => [c.id, c.label, c.action])).toEqual([["alpha:menu#sub", "子项", "alpha:sub"]]);
		// 子项不会变成顶层条目
		expect(ids(slots["topbar.primary"]).some((id) => id.endsWith("#sub"))).toBe(false);
	});

	it("子项完整继承并透传 checked, value, progress", () => {
		const custom = plugin("custom", {
			items: [
				{
					id: "menu2",
					slot: "topbar.primary",
					label: "菜单",
					kind: "menu",
					children: [
						{ id: "toggle1", slot: "topbar.primary", label: "开", kind: "toggle", checked: true },
						{ id: "input1", slot: "topbar.primary", label: "输入", kind: "input", value: "hello" },
						{ id: "prog1", slot: "topbar.primary", label: "进度", kind: "progress", progress: 65 },
					],
				},
			],
			arrange: [],
		});
		const slots = build([custom]);
		const menu = slots["topbar.primary"].find((e) => e.id === "custom:menu2");
		expect(menu?.children).toHaveLength(3);
		expect(menu?.children?.[0]?.checked).toBe(true);
		expect(menu?.children?.[1]?.value).toBe("hello");
		expect(menu?.children?.[2]?.progress).toBe(65);
	});

	it("报错插件与整体禁用的插件整份丢弃", () => {
		const broken = plugin(
			"broken",
			{ items: [{ id: "x", slot: "topbar.primary", label: "X" }], arrange: [] },
			{ error: "boom" },
		);
		expect(ids(build([broken])["topbar.primary"])).not.toContain("broken:x");
		expect(ids(build([alpha], { disabledPlugins: ["alpha"] })["topbar.primary"])).not.toContain("alpha:one");
	});

	it("同 id 后声明的插件覆盖前面的，但位置仍按首次声明（不会被挤到列表尾部）", () => {
		const first = plugin("p", {
			items: [{ id: "x", slot: "topbar.primary", label: "旧", order: 1, icon: "old" }],
			arrange: [],
		});
		const second = plugin("p", { items: [{ id: "x", slot: "topbar.primary", label: "新", order: 1 }], arrange: [] });
		const slots = build([first, second]);
		const entry = slots["topbar.primary"].find((e) => e.id === "p:x");
		expect(entry?.label).toBe("新");
		expect(entry?.icon).toBeUndefined(); // 覆盖是整条替换，旧 icon 不会残留
		// 位置仍按首次声明：order 1 的它排在 order 20 的 chat 前面，而不是被挤到尾部
		const list = ids(slots["topbar.primary"]);
		expect(list.indexOf("p:x")).toBeLessThan(list.indexOf("host:chat"));
	});

	it("脏 slot 直接丢条目，不污染结果对象的 key", () => {
		const dirty = plugin("dirty", {
			items: [{ id: "bad", slot: "nope.anywhere" as unknown as UiSlotId, label: "坏" }],
			arrange: [],
		});
		const slots = build([dirty]);
		expect(Object.keys(slots)).toHaveLength(37);
		expect(ids(Object.values(slots).flat()).some((id) => id === "dirty:bad")).toBe(false);
	});
});

describe("buildUiSlots / 第 3 层：插件 arrange", () => {
	it("hide/order/group/label/icon/slot 逐字段生效，并记进 arrangedBy", () => {
		const p = plugin("p", {
			items: [],
			arrange: [
				{
					id: "host:chat",
					slot: "topbar.overflow",
					hide: true,
					group: "p-group",
					order: 7,
					label: "对话（改过）",
					icon: "star",
				},
			],
		});
		const slots = build([p]);
		expect(ids(slots["topbar.primary"])).not.toContain("host:chat");
		const moved = slots["topbar.overflow"].find((e) => e.id === "host:chat");
		expect(moved?.label).toBe("对话（改过）");
		expect(moved?.icon).toBe("star");
		expect(moved?.group).toBe("p-group");
		expect(moved?.order).toBe(7);
		expect(moved?.hidden).toBe(true);
		expect(moved?.movedFrom).toBe("topbar.primary");
		expect(moved?.arrangedBy).toEqual(["p"]);
		// 没被 arrange 碰过的内置条目审计字段为空
		expect(slots["topbar.primary"].find((e) => e.id === "host:terminal")?.arrangedBy).toEqual([]);
	});

	it("设置入口不能被插件移走或隐藏", () => {
		const p = plugin("p", {
			items: [],
			arrange: [{ id: "host:settings", slot: "topbar.overflow", hide: true }],
		});
		const settings = build([p])["topbar.primary"].find((e) => e.id === "host:settings");
		expect(settings?.hidden).toBe(false);
		expect(settings?.slot).toBe("topbar.primary");
	});

	it("手机端抽屉入口（host:history / host:files）不能被插件或偏好移走或隐藏", () => {
		const p = plugin("p", {
			items: [],
			arrange: [
				{ id: "host:history", slot: "topbar.overflow", hide: true },
				{ id: "host:files", slot: "topbar.overflow", hide: true },
			],
		});
		const slots = build([p], { layout: { hidden: ["host:history", "host:files"] } });
		for (const id of ["host:history", "host:files"]) {
			const entry = slots["topbar.primary"].find((e) => e.id === id);
			expect(entry?.hidden).toBe(false);
			expect(entry?.slot).toBe("topbar.primary");
		}
	});

	it("HIDDEN_FROM_LAYOUT_ITEM_IDS 锁定手机端抽屉按钮不进入布局设置", () => {
		expect([...HIDDEN_FROM_LAYOUT_ITEM_IDS].sort()).toEqual(["host:files", "host:history"]);
	});

	it("undefined 的字段 = 不动（hide 缺省不会把条目藏起来）", () => {
		const p = plugin("p", { items: [], arrange: [{ id: "host:chat", order: 1 }] });
		const slots = build([p]);
		const chat = slots["topbar.primary"].find((e) => e.id === "host:chat");
		expect(chat?.id).toBe("host:chat");
		expect(chat?.hidden).toBe(false);
		expect(chat?.label).toBe("#chat"); // label 没被改
	});

	it("arrange 不存在的 id 被忽略（不生成幽灵条目）", () => {
		const before = build([]);
		const p = plugin("p", {
			items: [],
			arrange: [
				{ id: "host:nope", hide: true },
				{ id: "ghost:x", order: 1 },
			],
		});
		const after = build([p]);
		expect(after).toEqual(before);
	});

	it("跨插件 arrange：后声明插件的整理叠加在前面的之上，arrangedBy 按应用顺序累积", () => {
		const first = plugin("first", { items: [], arrange: [{ id: "beta:go", group: "g1", order: 5 }] });
		const beta = plugin("beta", { items: [{ id: "go", slot: "topbar.primary", label: "去" }], arrange: [] });
		const second = plugin("second", { items: [], arrange: [{ id: "beta:go", group: "g2" }] });
		const slots = build([first, beta, second]);
		const go = slots["topbar.primary"].find((e) => e.id === "beta:go");
		expect(go?.group).toBe("g2"); // 后者覆盖前者
		expect(go?.order).toBe(5); // 后者没提供 order → 保留前者的整理结果
		expect(go?.arrangedBy).toEqual(["first", "second"]);
	});

	it("插件整理自己的条目不留痕（那是它自己的声明方式）", () => {
		const p = plugin("p", {
			items: [{ id: "x", slot: "topbar.primary", label: "X" }],
			arrange: [{ id: "p:x", order: 3, group: "self" }],
		});
		const slots = build([p]);
		const entry = slots["topbar.primary"].find((e) => e.id === "p:x");
		expect(entry?.order).toBe(3);
		expect(entry?.arrangedBy).toEqual([]);
	});

	it("报错/被禁用插件的 arrange 不生效", () => {
		const broken = plugin("broken", { items: [], arrange: [{ id: "host:chat", hide: true }] }, { error: "boom" });
		expect(ids(build([broken])["topbar.primary"])).toContain("host:chat");
		const disabled = plugin("d", { items: [], arrange: [{ id: "host:chat", hide: true }] });
		expect(ids(build([disabled], { disabledPlugins: ["d"] })["topbar.primary"])).toContain("host:chat");
	});

	it("没有 ui 字段的插件不报错", () => {
		expect(ids(build([plugin("noview", undefined)])["topbar.primary"])).toContain("host:chat");
	});
});

describe("顶栏插件视图区段", () => {
	it("未显式排序的固定插件默认从 Git 后开始，旧布局顺序中未列出的插件不会乱跑", () => {
		const slots = build(
			withPluginViewItems([
				plugin("run-trace", { items: [], arrange: [] }),
				plugin("editor", { items: [], arrange: [] }),
			]),
			{
				layout: {
					shown: ["run-trace:__view", "editor:__view"],
					// 旧布局顺序只列了宿主条目，没有列新插件视图
					order: ["host:chat", "host:terminal", "host:git"],
				},
			},
		);
		const ids = slots["topbar.primary"].filter((entry) => !entry.hidden).map((entry) => entry.id);
		expect(ids.indexOf("host:git")).toBeLessThan(ids.indexOf("run-trace:__view"));
		expect(ids.indexOf("run-trace:__view")).toBeLessThan(ids.indexOf("host:plugins"));
		expect(ids.indexOf("run-trace:__view")).toBeLessThan(ids.indexOf("editor:__view"));
	});

	it("用户显式排序的插件视图（如拖拽或界面布局调整）严格遵循用户位置，允许自由移动", () => {
		const slots = build(
			withPluginViewItems([
				plugin("run-trace", { items: [], arrange: [] }),
				plugin("editor", { items: [], arrange: [] }),
			]),
			{
				layout: {
					shown: ["run-trace:__view", "editor:__view"],
					// 用户将 run-trace:__view 显式移到了 host:chat 前面
					order: ["run-trace:__view", "host:chat", "editor:__view"],
				},
			},
		);
		const ids = slots["topbar.primary"].filter((entry) => !entry.hidden).map((entry) => entry.id);
		expect(ids.indexOf("run-trace:__view")).toBeLessThan(ids.indexOf("host:chat"));
		expect(ids.indexOf("host:chat")).toBeLessThan(ids.indexOf("editor:__view"));
	});
});

describe("buildUiSlots / 第 4 层：用户偏好（最高）", () => {
	const p = plugin("p", {
		items: [{ id: "x", slot: "topbar.primary", label: "X 插件条目", order: 1, hidden: true }],
		arrange: [{ id: "host:settings", hide: true }],
	});

	it("hidden/shown 互相覆盖：shown 后应用 → 显示赢（撤销必须生效）", () => {
		const hiddenOnly = build([p], { layout: { hidden: ["p:x"] } });
		expect(hiddenOnly["topbar.primary"].find((e) => e.id === "p:x")?.hidden).toBe(true);
		// shown 覆盖插件声明的 hidden
		const shown = build([p], { layout: { shown: ["p:x"] } });
		expect(shown["topbar.primary"].find((e) => e.id === "p:x")?.hidden).toBe(false);
		// 同时写了 hidden 与 shown → shown 赢
		const both = build([p], { layout: { hidden: ["p:x"], shown: ["p:x"] } });
		const entry = both["topbar.primary"].find((e) => e.id === "p:x");
		expect(entry?.hidden).toBe(false);
		expect(entry?.userOverrides).toEqual(["hidden"]);
	});

	it("shown 能覆盖插件 arrange 的隐藏（用户 > 插件）", () => {
		const slots = build([p], { layout: { shown: ["host:settings"] } });
		expect(slots["topbar.primary"].find((e) => e.id === "host:settings")?.hidden).toBe(false);
		expect(slots["topbar.primary"].find((e) => e.id === "host:settings")?.arrangedBy).toEqual(["p"]);
	});

	it("order 列表：列出的按列表顺序排在最前，未列出的保持原顺序", () => {
		const slots = build([], { layout: { order: ["host:github", "host:chat"] } });
		expect(ids(slots["topbar.primary"]).slice(0, 2)).toEqual(["host:github", "host:chat"]);
		// 其余仍按权重排：github/chat 置顶之后是 history(0) → brand(1) → open-project(3) …
		expect(ids(slots["topbar.primary"]).slice(2, 5)).toEqual(["host:history", "host:brand", "host:open-project"]);
		expect(slots["topbar.primary"].find((e) => e.id === "host:chat")?.userOverrides).toEqual(["order"]);
	});

	it("order 列表里的历史 id（条目已不存在）被忽略", () => {
		const slots = build([], { layout: { order: ["ghost:gone", "host:github"] } });
		expect(ids(slots["topbar.primary"])[0]).toBe("host:github");
		expect(slots["topbar.primary"]).toHaveLength(BUILTIN_UI_ITEMS.filter((i) => i.slot === "topbar.primary").length);
	});

	it("groups/labels 覆盖，并记进 userOverrides", () => {
		const slots = build([], {
			layout: { groups: { "host:chat": "我的组" }, labels: { "host:chat": "聊天", "host:settings": "设置面板" } },
		});
		const chat = slots["topbar.primary"].find((e) => e.id === "host:chat");
		expect(chat?.group).toBe("我的组");
		expect(chat?.label).toBe("聊天");
		expect(chat?.labelKey).toBe("chat"); // host 条目保留 key，便于渲染层自行翻译/恢复
		expect(chat?.userOverrides).toEqual(["group", "label"]);
		expect(slots["topbar.primary"].find((e) => e.id === "host:settings")?.userOverrides).toEqual(["label"]);
	});

	it("用户 labels 覆盖插件 arrange 改过的文案（层序：arrange < 用户）", () => {
		const arr = plugin("a", { items: [], arrange: [{ id: "host:chat", label: "插件改的" }] });
		const slots = build([arr], { layout: { labels: { "host:chat": "用户改的" } } });
		expect(slots["topbar.primary"].find((e) => e.id === "host:chat")?.label).toBe("用户改的");
	});

	it("slots 覆盖条目槽位（可在顶部/底部/左侧/右侧自由移动）", () => {
		const slots = build([], {
			layout: {
				slots: {
					"host:settings": "sidebar.left",
					"host:search": "bottombar",
					"host:ctx": "topbar.primary",
				},
			},
		});
		expect(ids(slots["sidebar.left"])).toContain("host:settings");
		expect(ids(slots["topbar.primary"])).not.toContain("host:settings");
		expect(slots["sidebar.left"].find((e) => e.id === "host:settings")?.userOverrides).toContain("slot");
		expect(slots["sidebar.left"].find((e) => e.id === "host:settings")?.movedFrom).toBe("topbar.primary");

		expect(ids(slots["bottombar"])).toContain("host:search");
		expect(ids(slots["topbar.primary"])).not.toContain("host:search");

		expect(ids(slots["topbar.primary"])).toContain("host:ctx");
		expect(ids(slots["bottombar"])).not.toContain("host:ctx");
	});

	it("偏好指向不存在的 id 时不报错、不新增条目", () => {
		const slots = build([], {
			layout: { hidden: ["ghost:1"], groups: { "ghost:1": "g" }, labels: { "ghost:1": "l" } },
		});
		expect(slots["topbar.primary"]).toHaveLength(BUILTIN_UI_ITEMS.filter((i) => i.slot === "topbar.primary").length);
	});

	it("不改动传入的 plugins / layout（纯函数）", () => {
		const layout = { hidden: ["host:chat"], order: ["host:github"] };
		const snapshot = JSON.stringify(layout);
		const pluginSnapshot = JSON.stringify(p);
		build([p], { layout });
		expect(JSON.stringify(layout)).toBe(snapshot);
		expect(JSON.stringify(p)).toBe(pluginSnapshot);
	});
});

describe("splitOverflow", () => {
	const entries = build([]).bottombar;

	it("主栏最多 max 个，其余进溢出且保持相对顺序、不重复", () => {
		const { inline, overflow } = splitOverflow(entries, 3);
		expect(ids(inline)).toEqual(ids(entries).slice(0, 3));
		expect(ids(overflow)).toEqual(ids(entries).slice(3));
		expect(ids([...inline, ...overflow])).toEqual(ids(entries));
	});

	it("max >= 长度 → 全在主栏；max<=0 → 全在溢出", () => {
		expect(splitOverflow(entries, entries.length).overflow).toEqual([]);
		expect(splitOverflow(entries, 99).inline).toHaveLength(entries.length);
		const zero = splitOverflow(entries, 0);
		expect(zero.inline).toEqual([]);
		expect(ids(zero.overflow)).toEqual(ids(entries));
	});

	it("不修改入参数组（返回新数组）", () => {
		const copy = [...entries];
		const { inline, overflow } = splitOverflow(entries, 2);
		expect(entries).toEqual(copy);
		inline.pop();
		expect(overflow).toHaveLength(entries.length - 2);
	});
});

describe("restoreUiItem / restoreAllUi", () => {
	it("清掉该 id 在各偏好字段里的所有痕迹（顶栏文字开关原样保留）", () => {
		const layout = {
			hidden: ["host:chat", "host:sound"],
			shown: ["host:chat"],
			order: ["host:chat", "host:github"],
			groups: { "host:chat": "g", "host:sound": "s" },
			labels: { "host:chat": "聊天", "host:sound": "声音" },
		};
		expect(restoreUiItem(layout, "host:chat")).toEqual({
			hidden: ["host:sound"],
			order: ["host:github"],
			groups: { "host:sound": "s" },
			labels: { "host:sound": "声音" },
		});
	});

	it("清空后不留空数组/空对象；全清光返回 {}", () => {
		expect(restoreUiItem({ hidden: ["host:chat"], groups: { "host:chat": "g" } }, "host:chat")).toEqual({});
		expect(restoreUiItem(undefined, "host:chat")).toEqual({});
		expect(restoreUiItem({}, "host:chat")).toEqual({});
	});

	it("不修改入参（纯函数），恢复后 buildUiSlots 回到插件安排的状态", () => {
		const layout = { hidden: ["host:chat"], labels: { "host:chat": "聊天" } };
		const restored = restoreUiItem(layout, "host:chat");
		expect(layout).toEqual({ hidden: ["host:chat"], labels: { "host:chat": "聊天" } });
		const arr = plugin("a", { items: [], arrange: [{ id: "host:chat", hide: true }] });
		const slots = build([arr], { layout: restored });
		const chat = slots["topbar.primary"].find((e) => e.id === "host:chat");
		expect(chat?.label).toBe("#chat"); // 用户文案已撤回
		expect(chat?.hidden).toBe(true); // 插件 arrange 重新生效
		expect(chat?.arrangedBy).toEqual(["a"]);
	});

	it("restoreAllUi 返回空偏好", () => {
		expect(restoreAllUi()).toEqual({});
		expect(build([], { layout: restoreAllUi() })).toEqual(build([]));
	});
});

describe("品牌二合一（host:brand-logo/host:brand-name → host:brand）", () => {
	it("buildUiSlots：旧偏好直接对新品牌生效", () => {
		const slots = build([], {
			layout: {
				hidden: ["host:brand-logo"],
				order: ["host:brand-name", "host:chat"],
				labels: { "host:brand-name": "我的站" },
			},
		});
		const brand = slots["topbar.primary"].find((e) => e.id === "host:brand");
		expect(brand?.hidden).toBe(true);
		expect(brand?.label).toBe("我的站");
		expect(brand?.userOverrides).toEqual(expect.arrayContaining(["hidden", "order", "label"]));
		expect(ids(slots["topbar.primary"]).slice(0, 2)).toEqual(["host:brand", "host:chat"]);
		// 旧 id 不再登记为条目。
		expect(slots["topbar.primary"].some((e) => e.id === "host:brand-logo" || e.id === "host:brand-name")).toBe(false);
	});

	it("restoreUiItem(host:brand) 连带清掉旧双 id 残留", () => {
		expect(
			restoreUiItem({ hidden: ["host:brand", "host:brand-logo"], labels: { "host:brand-name": "旧" } }, "host:brand"),
		).toEqual({});
	});
});

describe("插件悬浮提示（hint / hintEn / arrange 覆盖）", () => {
	it("中文界面用 hint，别的语言回落 hintEn ?? hint（与 label 同口径）", () => {
		const p = plugin("a", {
			items: [
				{ id: "t", slot: "topbar.primary", label: "收件箱", labelEn: "Inbox", hint: "看信", hintEn: "Read mail" },
				{ id: "only-en", slot: "topbar.primary", label: "只有英文", labelEn: "EN only", hintEn: "EN hint" },
			],
			arrange: [],
		});
		const zhSlots = build([p]);
		const enSlots = build([p], { locale: "en" });
		const find = (slots: ReturnType<typeof build>, id: string) =>
			slots["topbar.primary"].find((e) => e.id === `a:${id}`);
		expect(find(zhSlots, "t")?.hint).toBe("看信");
		expect(find(enSlots, "t")?.hint).toBe("Read mail");
		// 只给一种语言 → 另一种回落它（否则非中文界面就静默没有提示）
		expect(find(zhSlots, "only-en")?.hint).toBe("EN hint");
		expect(find(enSlots, "only-en")?.hint).toBe("EN hint");
	});

	it("没写 hint 时条目上不带该字段（渲染层据此区分「有提示」与「拿 label 凑」）", () => {
		const p = plugin("a", { items: [{ id: "t", slot: "topbar.primary", label: "无提示" }], arrange: [] });
		const entry = build([p])["topbar.primary"].find((e) => e.id === "a:t");
		expect(entry).toBeTruthy();
		expect("hint" in (entry ?? {})).toBe(false);
	});

	it("子条目也会带上 hint（右键菜单的子菜单用得上）", () => {
		const p = plugin("a", {
			items: [
				{
					id: "menu",
					slot: "contextmenu.file",
					label: "发送",
					kind: "menu",
					children: [{ id: "c", slot: "contextmenu.file", label: "到邮箱", hint: "走 SMTP" }],
				},
			],
			arrange: [],
		});
		const parent = build([p])["contextmenu.file"].find((e) => e.id === "a:menu");
		expect(parent?.children?.[0]?.hint).toBe("走 SMTP");
	});

	it("插件 arrange 能改提示（与改 label / icon 同级）", () => {
		const a = plugin("a", { items: [{ id: "x", slot: "topbar.primary", label: "X" }], arrange: [] });
		const b = plugin("b", { items: [], arrange: [{ id: "a:x", hint: "我改的提示" }] });
		const entry = build([a, b])["topbar.primary"].find((e) => e.id === "a:x");
		expect(entry?.hint).toBe("我改的提示");
		expect(entry?.arrangedBy).toEqual(["b"]);
	});
});

describe("kind=select（P0-2）", () => {
	it("options 透传 + 文案随语言落定（zh 用 label，其他语言 labelEn ?? label ?? value）", () => {
		const p = plugin("a", {
			items: [
				{
					id: "tone",
					slot: "topbar.primary",
					label: "语气",
					labelEn: "Tone",
					kind: "select",
					action: "a:tone",
					value: "full",
					options: [{ value: "short", label: "简短" }, { value: "full", labelEn: "Verbose" }, { value: "raw" }],
				},
			],
			arrange: [],
		});
		const zhEntry = build([p])["topbar.primary"].find((e) => e.id === "a:tone")!;
		expect(zhEntry.kind).toBe("select");
		expect(zhEntry.value).toBe("full");
		expect(zhEntry.options).toEqual([
			{ value: "short", label: "简短" },
			{ value: "full", label: "Verbose" },
			{ value: "raw", label: "raw" },
		]);
		const enEntry = build([p], { locale: "en" })["topbar.primary"].find((e) => e.id === "a:tone")!;
		expect(enEntry.options).toEqual([
			{ value: "short", label: "简短" },
			{ value: "full", label: "Verbose" },
			{ value: "raw", label: "raw" },
		]);
		const enLabeled = build(
			[
				plugin("b", {
					items: [
						{
							id: "s",
							slot: "topbar.primary",
							label: "X",
							labelEn: "X",
							kind: "select",
							options: [{ value: "v", label: "中文", labelEn: "English" }],
						},
					],
					arrange: [],
				}),
			],
			{ locale: "en" },
		)["topbar.primary"].find((e) => e.id === "b:s")!;
		expect(enLabeled.options).toEqual([{ value: "v", label: "English" }]);
	});
	it("无 options 的 select 照常合并（渲染层回落按钮，不断言崩溃）", () => {
		const p = plugin("a", {
			items: [{ id: "s", slot: "topbar.primary", label: "S", kind: "select", action: "a:s" }],
			arrange: [],
		});
		const e = build([p])["topbar.primary"].find((x) => x.id === "a:s")!;
		expect(e.kind).toBe("select");
		expect(e.options).toBeUndefined();
	});
});

describe("modal.dialog（P1-2）", () => {
	it("槽位存在且合并正常（hidden 照常生效）", () => {
		const p = plugin("a", {
			items: [
				{ id: "dlg", slot: "modal.dialog", label: "弹窗", kind: "view", view: "plugin:a" },
				{ id: "old", slot: "modal.dialog", label: "旧弹窗", kind: "view", hidden: true },
			],
			arrange: [],
		});
		const slots = build([p]);
		expect(Object.keys(slots)).toContain("modal.dialog");
		expect(slots["modal.dialog"].map((e) => e.id)).toEqual(["a:dlg", "a:old"]);
		expect(slots["modal.dialog"].find((e) => e.id === "a:old")!.hidden).toBe(true);
	});
});

describe("bottombar align 分区（P1-2 收尾：路由走数据不走 id）", () => {
	it("host:host-metrics 与 host:cwd 缺省 end，其余宿主条目缺省 start", () => {
		const slots = build([]);
		const end = slots["bottombar"].filter((e) => e.align === "end").map((e) => e.id);
		expect(end).toEqual(["host:host-metrics", "host:cwd"]);
	});
	it("arrange 与用户偏好能翻转分区（插件可把条目挪到右区）", () => {
		const p = plugin(
			"a",
			{
				items: [{ id: "r", slot: "bottombar", label: "R", align: "end" }],
				arrange: [{ id: "host:cost", align: "end" }],
			},
			{},
		);
		const slots = build([p]);
		expect(slots["bottombar"].filter((e) => e.align === "end").map((e) => e.id)).toEqual([
			"host:cost",
			"host:host-metrics",
			"host:cwd",
			"a:r",
		]);
		const flipped = build([p], { layout: { hidden: [], shown: [], order: [], align: { "host:cost": "start" } } });
		expect(flipped["bottombar"].find((e) => e.id === "host:cost")!.align).toBe("start");
	});
});

describe("面板 chrome 宿主条目（file.preview / goalbar / scm / terminal / leftpanel）", () => {
	it("各槽位默认顺序与旧硬编码一致", () => {
		const slots = build([]);
		expect(ids(slots["file.preview.toolbar"])).toEqual([
			"host:fp-md",
			"host:fp-toc",
			"host:fp-html",
			"host:fp-edit",
			"host:fp-wrap",
			"host:fp-zoom",
			"host:fp-download",
			"host:fp-ref",
			"host:fp-full",
			"host:fp-close",
		]);
		expect(ids(slots["goalbar.actions"])).toEqual([
			"host:goal-pill",
			"host:goal-set",
			"host:goal-wizard",
			"host:goal-plan",
			"host:goal-lock",
			"host:goal-collapse",
			"host:goal-model",
			"host:goal-execmodel",
			"host:goal-rounds",
			"host:goal-openrole",
			"host:goal-clear",
		]);
		expect(ids(slots["scm.toolbar"])).toEqual([
			"host:scm-changes",
			"host:scm-history",
			"host:scm-refresh",
			"host:scm-branch",
			"host:scm-switch",
			"host:scm-push",
			"host:scm-pull",
			"host:scm-input",
			"host:scm-genmsg",
			"host:scm-commit",
			"host:scm-commit-all",
			"host:scm-term",
		]);
		expect(ids(slots["terminal.toolbar"])).toEqual(["host:term-cmd-refresh", "host:term-cmd-new", "host:term-tab-new"]);
		expect(ids(slots["leftpanel.sessions"])).toEqual([]);
	});

	it("隐藏与调序走同一套偏好（与顶栏同口径）", () => {
		const slots = build([], {
			layout: { hidden: ["host:fp-close", "host:scm-push"], order: ["host:fp-close", "host:fp-md"] },
		});
		expect(slots["file.preview.toolbar"].find((e) => e.id === "host:fp-close")?.hidden).toBe(true);
		expect(slots["scm.toolbar"].find((e) => e.id === "host:scm-push")?.hidden).toBe(true);
		expect(ids(slots["file.preview.toolbar"]).slice(0, 2)).toEqual(["host:fp-close", "host:fp-md"]);
	});
});

describe("withPluginViewItems（插件视图 tab 进槽位）", () => {
	it("有视图的插件补一条 kind=view 合成条目（view:false 跳过）", () => {
		const input = [plugin("mail", { items: [], arrange: [] }), plugin("renderer", undefined, { view: false })];
		const out = withPluginViewItems(input);
		expect(out[0]?.ui?.items).toEqual([
			{
				id: "__view",
				slot: "topbar.primary",
				label: "mail",
				kind: "view",
				view: "plugin:mail",
				order: 23,
				align: "end",
				// 插件视图 tab 默认不钉顶栏（顶栏只留一个插件面板入口），
				// 用户钉住时才由 setPluginViewPinned 写进 layout.shown 翻出来。
				hidden: true,
			},
		]);
		expect(out[1]?.ui).toBeUndefined();
		// 不改入参
		expect(input[0]?.ui?.items).toEqual([]);
	});

	it("合成条目进槽位：排在 git 之后、插件数组顺序稳定", () => {
		const slots = build(
			withPluginViewItems([plugin("b", { items: [], arrange: [] }), plugin("a", { items: [], arrange: [] })]),
		);
		const tabs = ids(slots["topbar.primary"]).filter((id) => id === "host:git" || id.endsWith(":__view"));
		expect(tabs).toEqual(["host:git", "b:__view", "a:__view"]);
		const entry = slots["topbar.primary"].find((e) => e.id === "a:__view")!;
		expect(entry.kind).toBe("view");
		expect(entry.view).toBe("plugin:a");
		expect(entry.source).toBe("plugin:a");
	});

	it("插件自占 __view 时不覆盖（尊重插件自己的声明）", () => {
		const mine = plugin("p", {
			items: [{ id: "__view", slot: "topbar.primary", label: "我的", kind: "action", action: "p:go" }],
			arrange: [],
		});
		const out = withPluginViewItems([mine]);
		expect(out[0]?.ui?.items).toHaveLength(1);
		expect(out[0]?.ui?.items[0]?.label).toBe("我的");
	});

	it("报错/禁用插件的合成视图同样整份丢弃（与贡献同口径）", () => {
		const broken = plugin("broken", { items: [], arrange: [] }, { error: "boom" });
		const slots = build(withPluginViewItems([broken]));
		expect(ids(slots["topbar.primary"])).not.toContain("broken:__view");
		const p = plugin("d", { items: [], arrange: [] });
		const disabled = build(withPluginViewItems([p]), { disabledPlugins: ["d"] });
		expect(ids(disabled["topbar.primary"])).not.toContain("d:__view");
	});

	it("用户可隐藏插件视图、可调序（与宿主 tab 同口径）", () => {
		const ps = withPluginViewItems([plugin("mail", { items: [], arrange: [] })]);
		const hidden = build(ps, { layout: { hidden: ["mail:__view"] } });
		expect(hidden["topbar.primary"].find((e) => e.id === "mail:__view")?.hidden).toBe(true);
		const ordered = build(ps, { layout: { order: ["mail:__view", "host:chat"] } });
		const orderedIds = ids(ordered["topbar.primary"]);
		expect(orderedIds.indexOf("mail:__view")).toBeLessThan(orderedIds.indexOf("host:chat"));
	});

	it("合成条目默认 hidden：不钉顶栏时它落在溢出集合里，shown 才把它翻回主栏", () => {
		const ps = withPluginViewItems([plugin("mail", { items: [], arrange: [] })]);
		const plain = build(ps);
		expect(plain["topbar.primary"].find((e) => e.id === "mail:__view")?.hidden).toBe(true);
		const pinned = build(ps, { layout: { shown: ["mail:__view"] } });
		expect(pinned["topbar.primary"].find((e) => e.id === "mail:__view")?.hidden).toBe(false);
	});
});

describe("插件视图的钉住开关（pluginViewItemId / setPluginViewPinned / isPluginViewItem）", () => {
	it("插件排序只替换插件视图条目的相对顺序，保留其它偏好", () => {
		expect(
			setPluginViewOrder({ order: ["host:chat", "mail:__view", "unloaded:__view", "host:settings"] }, [
				"notes",
				"mail",
			]),
		).toEqual({
			order: ["host:chat", "unloaded:__view", "host:settings", "notes:__view", "mail:__view"],
		});
	});
	it("pluginViewItemId = <pluginId>:__view", () => {
		expect(pluginViewItemId("mail")).toBe("mail:__view");
		expect(PLUGIN_VIEW_ITEM_ID).toBe("__view");
	});

	it("isPluginViewItem：只认「来源插件自己的那条 __view」，不误伤同后缀的其他条目", () => {
		expect(isPluginViewItem({ id: "mail:__view", source: "plugin:mail" })).toBe(true);
		// id 恰好等于 source 的视图条目
		expect(isPluginViewItem({ id: "mail:__view", source: "plugin:other" })).toBe(false);
		// 宿主条目
		expect(isPluginViewItem({ id: "host:git", source: "host" })).toBe(false);
		// 插件贡献的普通条目，恰好也以 :__view 结尾（不误伤）
		expect(isPluginViewItem({ id: "mail:list:__view", source: "plugin:mail" })).toBe(false);
	});

	it("钉住：写进 shown、从 hidden 摘掉；取消钉住：反过来（两边都不留重复项）", () => {
		expect(setPluginViewPinned(undefined, "mail", true)).toEqual({ hidden: [], shown: ["mail:__view"] });
		expect(setPluginViewPinned(undefined, "mail", false)).toEqual({ hidden: ["mail:__view"], shown: [] });
		const both = { hidden: ["mail:__view", "host:sound"], shown: ["mail:__view"] };
		expect(setPluginViewPinned(both, "mail", true)).toEqual({
			hidden: ["host:sound"],
			shown: ["mail:__view"],
		});
		expect(setPluginViewPinned(both, "mail", false)).toEqual({
			hidden: ["host:sound", "mail:__view"],
			shown: [],
		});
		// 其他字段原样保留（只动这一个 id）
		const rich = { order: ["mail:__view"], labels: { "host:chat": "聊天" }, topbarText: false };
		expect(setPluginViewPinned(rich, "mail", true)).toEqual({
			order: ["mail:__view"],
			labels: { "host:chat": "聊天" },
			topbarText: false,
			hidden: [],
			shown: ["mail:__view"],
		});
	});

	it("钉住 → 取消钉住 → 再钉住：幂等，不累积脏数据", () => {
		let prefs = setPluginViewPinned(undefined, "mail", true);
		prefs = setPluginViewPinned(prefs, "mail", false);
		prefs = setPluginViewPinned(prefs, "mail", true);
		expect(prefs).toEqual({ hidden: [], shown: ["mail:__view"] });
	});
});

// ---------------------------------------------------------------------------
// P0-1：失败不许静默 —— buildUiSlots 的 diagnostics
// ---------------------------------------------------------------------------

describe("buildUiSlots —— diagnostics（P0-1）", () => {
	/** 造一个最小插件对象（默认合法贡献）。 */
	const plug = (id: string, ui?: UiPluginInfo["ui"], extra: Partial<UiPluginInfo> = {}): UiPluginInfo => ({
		id,
		name: id,
		hasClient: true,
		...(ui ? { ui } : {}),
		...extra,
	});

	it("不传 diagnostics 时行为与原来完全一致（纯函数，零副作用）", () => {
		const before = build([plug("p", { items: [{ id: "a", slot: "topbar.primary", label: "A" }], arrange: [] })]);
		const diagnostics: UiDiagnostic[] = [];
		const after = build([plug("p", { items: [{ id: "a", slot: "topbar.primary", label: "A" }], arrange: [] })], {
			diagnostics,
		});
		expect(ids(after["topbar.primary"])).toEqual(ids(before["topbar.primary"]));
		expect(diagnostics).toEqual([]);
	});

	it("未知 slot / 未知 kind / 未知 when 各产出一条带归因的诊断", () => {
		const diagnostics: UiDiagnostic[] = [];
		build(
			[
				plug("p", {
					items: [
						{ id: "bad-slot", slot: "nope.nope" as never, label: "X" },
						{ id: "bad-kind", slot: "topbar.primary", label: "K", kind: "sparkle" as never },
						{ id: "bad-when", slot: "topbar.primary", label: "W", when: ["message.hasSelection", "totally.made.up"] },
					],
					arrange: [],
				}),
			],
			{ diagnostics },
		);
		expect(diagnostics.some((d) => d.entryId === "bad-slot" && d.message.includes("unknown slot"))).toBe(true);
		expect(diagnostics.some((d) => d.entryId === "bad-kind" && d.message.includes('unknown kind "sparkle"'))).toBe(
			true,
		);
		expect(diagnostics.some((d) => d.entryId === "bad-when" && d.message.includes("totally.made.up"))).toBe(true);
		// 已知的 when 值不诊断（只报不认识的）。
		expect(diagnostics.some((d) => d.message.includes("message.hasSelection"))).toBe(false);
		// 全部诊断都带 pluginId 归因。
		expect(diagnostics.every((d) => d.pluginId === "p")).toBe(true);
	});

	it("arrange 目标不存在 → 诊断（不再静默忽略）", () => {
		const diagnostics: UiDiagnostic[] = [];
		build([plug("p", { items: [], arrange: [{ id: "host:does-not-exist", hide: true }] })], { diagnostics });
		expect(diagnostics.some((d) => d.entryId === "host:does-not-exist" && d.message.includes("does not exist"))).toBe(
			true,
		);
	});

	it("arrange 目标存在 → 不产诊断", () => {
		const diagnostics: UiDiagnostic[] = [];
		build([plug("p", { items: [], arrange: [{ id: "host:settings", order: 5 }] })], { diagnostics });
		expect(diagnostics.filter((d) => d.message.includes("does not exist"))).toEqual([]);
	});

	it("插件被禁用 / 激活失败 → 各一条诊断（说明为什么没渲染）", () => {
		const diagnostics: UiDiagnostic[] = [];
		build(
			[
				plug("disabled-one", { items: [{ id: "a", slot: "topbar.primary", label: "A" }], arrange: [] }),
				plug(
					"broken-one",
					{ items: [{ id: "b", slot: "topbar.primary", label: "B" }], arrange: [] },
					{ error: "boom" },
				),
			],
			{ diagnostics, disabledPlugins: ["disabled-one"] },
		);
		const disabledDiag = diagnostics.find((d) => d.pluginId === "disabled-one");
		expect(disabledDiag).toBeDefined();
		expect(disabledDiag?.message).toContain("disabled by the user");
		expect(disabledDiag?.level).toBe("info");
		expect(diagnostics.some((d) => d.pluginId === "broken-one" && d.level === "error")).toBe(true);
	});

	it("零 UI 项的插件被禁用 → 不产生无意义的假诊断（杜绝 0 UI items 假警告刷屏）", () => {
		const diagnostics: UiDiagnostic[] = [];
		build([plug("headless-one", { items: [], arrange: [] }), plug("no-ui-at-all")], {
			diagnostics,
			disabledPlugins: ["headless-one", "no-ui-at-all"],
		});
		expect(diagnostics).toEqual([]);
	});

	it("同 id 重复声明 → 诊断；跨插件同 itemId 不误报", () => {
		// 跨插件：全局 id 带插件前缀（<pluginId>:<itemId>），不同插件同 itemId 不该告警。
		const cross: UiDiagnostic[] = [];
		build(
			[
				plug("first", { items: [{ id: "shared", slot: "topbar.primary", label: "1st" }], arrange: [] }),
				plug("second", { items: [{ id: "shared", slot: "topbar.primary", label: "2nd" }], arrange: [] }),
			],
			{ diagnostics: cross },
		);
		expect(cross.filter((d) => d.message.includes("declared more than once"))).toEqual([]);

		// 同一插件重复声明同一 id（manifest 基线 + 运行时注册合并后的常见形态）→ 一条诊断。
		const same: UiDiagnostic[] = [];
		build(
			[
				plug("one", {
					items: [
						{ id: "dup", slot: "topbar.primary", label: "1st" },
						{ id: "dup", slot: "topbar.primary", label: "2nd" },
					],
					arrange: [],
				}),
			],
			{ diagnostics: same },
		);
		expect(same.some((d) => d.pluginId === "one" && d.entryId === "dup" && d.message.includes("more than once"))).toBe(
			true,
		);
	});
});

describe("左栏分区（P2 · leftpanel.sections）", () => {
	const sectionIds = (slots: ReturnType<typeof build>) => ids(slots["leftpanel.sections"]);

	it("四条宿主分区默认登记在 leftpanel.sections，顺序：项目 / 群组 / 运行 / 历史", () => {
		const slots = build([]);
		expect(sectionIds(slots)).toEqual(["host:lp-projects", "host:lp-groups", "host:lp-running", "host:lp-history"]);
		expect(slots["leftpanel.sections"].every((e) => e.source === "host" && !e.hidden)).toBe(true);
	});

	it("布局页隐藏某分区 → hidden=true，条目本身仍在（布局页才找得回来）", () => {
		const slots = build([], { layout: { hidden: ["host:lp-running"] } });
		expect(slots["leftpanel.sections"].find((e) => e.id === "host:lp-running")?.hidden).toBe(true);
		expect(sectionIds(slots)).toHaveLength(4);
	});

	it("用户调序（layout.order）改变分区先后", () => {
		const slots = build([], { layout: { order: ["host:lp-history", "host:lp-projects"] } });
		const order = sectionIds(slots);
		expect(order.indexOf("host:lp-history")).toBeLessThan(order.indexOf("host:lp-projects"));
	});

	it("插件往 leftpanel.sections 里放条目 → 丢弃并给出诊断（不静默）", () => {
		const diagnostics: UiDiagnostic[] = [];
		const p = plugin("p", { items: [{ id: "x", slot: "leftpanel.sections", label: "X" }], arrange: [] });
		const slots = build([p], { diagnostics });
		expect(slots["leftpanel.sections"].some((e) => e.id === "p:x")).toBe(false);
		expect(diagnostics.some((d) => d.pluginId === "p" && d.entryId === "x" && d.slot === "leftpanel.sections")).toBe(
			true,
		);
	});

	it("插件 arrange 把宿主分区挪到别的槽位 → 复位回 leftpanel.sections 并诊断", () => {
		const diagnostics: UiDiagnostic[] = [];
		const p = plugin("p", { items: [], arrange: [{ id: "host:lp-history", slot: "bottombar" }] });
		const slots = build([p], { diagnostics });
		expect(sectionIds(slots)).toContain("host:lp-history");
		expect(slots.bottombar.some((e) => e.id === "host:lp-history")).toBe(false);
		expect(
			diagnostics.some((d) => d.entryId === "host:lp-history" && /must stay in leftpanel\.sections/.test(d.message)),
		).toBe(true);
	});

	it("插件 arrange 隐藏宿主分区是允许的（它只是把 hidden 置位）", () => {
		const p = plugin("p", { items: [], arrange: [{ id: "host:lp-projects", hide: true }] });
		const slots = build([p]);
		expect(slots["leftpanel.sections"].find((e) => e.id === "host:lp-projects")?.hidden).toBe(true);
	});

	it("行内槽位 leftpanel.running / leftpanel.history 是独立挂载点（插件条目落在各自槽位）", () => {
		const p = plugin("p", {
			items: [
				{ id: "r", slot: "leftpanel.running", label: "R" },
				{ id: "h", slot: "leftpanel.history", label: "H" },
			],
			arrange: [],
		});
		const slots = build([p]);
		expect(ids(slots["leftpanel.running"])).toEqual(["p:r"]);
		expect(ids(slots["leftpanel.history"])).toEqual(["p:h"]);
		expect(ids(slots["leftpanel.sessions"])).toEqual([]);
	});
});

describe("左栏插件自定义分区（P4 · leftpanel.sections 接受 kind=view）", () => {
	const sectionIds = (slots: ReturnType<typeof build>) => ids(slots["leftpanel.sections"]);

	it("插件 kind=view 条目进入 leftpanel.sections（source=插件，位置在宿主分区之后）", () => {
		const p = plugin("notes", {
			items: [{ id: "fav", slot: "leftpanel.sections", kind: "view", label: "收藏" }],
			arrange: [],
		});
		const slots = build([p]);
		expect(sectionIds(slots)).toEqual([
			"host:lp-projects",
			"host:lp-groups",
			"host:lp-running",
			"host:lp-history",
			"notes:fav",
		]);
		const fav = slots["leftpanel.sections"].find((e) => e.id === "notes:fav");
		expect(fav?.source).toBe("plugin:notes");
		expect(fav?.kind).toBe("view");
		expect(fav?.label).toBe("收藏");
	});

	it("插件 kind=action 等非 view 条目仍被丢弃并给诊断（不静默）", () => {
		const diagnostics: UiDiagnostic[] = [];
		const p = plugin("notes", {
			items: [{ id: "x", slot: "leftpanel.sections", kind: "action", label: "X" }],
			arrange: [],
		});
		const slots = build([p], { diagnostics });
		expect(sectionIds(slots)).not.toContain("notes:x");
		expect(diagnostics.some((d) => d.entryId === "x" && /only kind="view"/.test(d.message))).toBe(true);
	});

	it("插件分区与宿主分区一样可被布局页隐藏（hidden 进入合并结果）", () => {
		const p = plugin("notes", {
			items: [{ id: "fav", slot: "leftpanel.sections", kind: "view", label: "收藏" }],
			arrange: [],
		});
		const slots = build([p], { layout: { hidden: ["notes:fav"] } });
		expect(slots["leftpanel.sections"].find((e) => e.id === "notes:fav")?.hidden).toBe(true);
	});

	it("插件分区不能挪走宿主分区（P2 的复位规则不受影响）；插件 arrange 只能隐藏插件分区", () => {
		const p = plugin("notes", {
			items: [{ id: "fav", slot: "leftpanel.sections", kind: "view", label: "收藏" }],
			arrange: [{ id: "notes:fav", hide: true }],
		});
		const slots = build([p]);
		expect(slots["leftpanel.sections"].find((e) => e.id === "notes:fav")?.hidden).toBe(true);
	});

	it("插件向 tool.card.footer 槽位贡献条目正常生效", () => {
		const p = plugin("custom-tool", {
			items: [{ id: "btn", slot: "tool.card.footer", kind: "action", label: "测试按钮" }],
			arrange: [],
		});
		const slots = build([p]);
		expect(slots["tool.card.footer"].map((e) => e.id)).toEqual(["custom-tool:btn"]);
		expect(slots["tool.card.footer"][0]?.label).toBe("测试按钮");
	});
});
