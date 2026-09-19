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
	PLUGIN_VIEW_ITEM_ID,
	buildUiSlots,
	isPluginViewItem,
	pluginViewItemId,
	restoreAllUi,
	restoreUiItem,
	setPluginViewPinned,
	splitOverflow,
	withPluginViewItems,
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
		// 顶栏：视图三连 + 搜索/浏览器/后台任务/设置/声音/语言/主题/更新
		expect(bySlot("topbar.primary")).toEqual(
			expect.arrayContaining([
				"host:chat",
				"host:terminal",
				"host:git",
				"host:search",
				"host:browser",
				"host:tasks",
				"host:settings",
				"host:sound",
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
		// 消息区今天没有右键菜单 → 一条都不登记（宁缺勿造）；设置页是插件专属。
		expect(bySlot("contextmenu.message")).toEqual([]);
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
			"host:chat",
			"host:terminal",
			"host:git",
			"host:plugins",
			"host:search",
			"host:browser",
			"host:tasks",
			"host:settings",
			"host:sound",
			"host:language",
			"host:theme",
			"host:update",
			"host:new-chat",
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
		// 没用到的槽位是空数组（渲染层不必判空），且全部槽位都在（20 个 + modal.dialog）
		expect(Object.keys(slots)).toHaveLength(21);
		expect(slots["composer.leading"]).toEqual([]);
		// 输入框动作区有 7 个宿主内置（上传/模板/模型/思考/DSH×2/发送），发送簇 align=end
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
	it("缺省收进「⋯」的 6 条 + 常驻的 12 条", () => {
		const slots = build([]);
		const top = slots["topbar.primary"];
		expect(top.filter((e) => e.hidden).map((e) => e.id)).toEqual([
			"host:browser",
			"host:sound",
			"host:language",
			"host:theme",
			"host:update",
			"host:github",
		]);
		// 常驻 = 「切视图（chat/terminal/git） / 起新活（new-chat） / 看运行态（tasks） /
		// 进设置（settings）」四类，加品牌、项目、搜索、面板开关
		expect(top.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
			"host:history",
			"host:brand",
			"host:open-project",
			"host:chat",
			"host:terminal",
			"host:git",
			"host:plugins",
			"host:search",
			"host:tasks",
			"host:settings",
			"host:new-chat",
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
			"contextmenu.file",
			"settings.pages",
			"modal.dialog",
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
		expect(Object.keys(slots)).toHaveLength(21);
		expect(ids(Object.values(slots).flat()).some((id) => id === "dirty:bad")).toBe(false);
	});
});

describe("buildUiSlots / 第 3 层：插件 arrange", () => {
	it("hide/order/group/label/icon/slot 逐字段生效，并记进 arrangedBy", () => {
		const p = plugin("p", {
			items: [],
			arrange: [
				{
					id: "host:settings",
					slot: "topbar.overflow",
					hide: true,
					group: "p-group",
					order: 7,
					label: "设置（改过）",
					icon: "star",
				},
			],
		});
		const slots = build([p]);
		expect(ids(slots["topbar.primary"])).not.toContain("host:settings");
		const moved = slots["topbar.overflow"].find((e) => e.id === "host:settings");
		expect(moved?.label).toBe("设置（改过）");
		expect(moved?.icon).toBe("star");
		expect(moved?.group).toBe("p-group");
		expect(moved?.order).toBe(7);
		expect(moved?.hidden).toBe(true);
		expect(moved?.movedFrom).toBe("topbar.primary");
		expect(moved?.arrangedBy).toEqual(["p"]);
		// 没被 arrange 碰过的内置条目审计字段为空
		expect(slots["topbar.primary"].find((e) => e.id === "host:chat")?.arrangedBy).toEqual([]);
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
			"host:fp-html",
			"host:fp-edit",
			"host:fp-wrap",
			"host:fp-zoom",
			"host:fp-inline",
			"host:fp-ref",
			"host:fp-full",
			"host:fp-close",
		]);
		expect(ids(slots["goalbar.actions"])).toEqual([
			"host:goal-pill",
			"host:goal-set",
			"host:goal-wizard",
			"host:goal-lock",
			"host:goal-collapse",
			"host:goal-model",
			"host:goal-rounds",
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
		expect(ids(slots["leftpanel.sessions"])).toEqual(["host:lp-projects", "host:lp-running", "host:lp-history"]);
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
				// 插件视图 tab 默认不钉顶栏（顶栏只留一个 🧩 插件面板入口），
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
		expect(ids(ordered["topbar.primary"]).slice(0, 2)).toEqual(["mail:__view", "host:chat"]);
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
