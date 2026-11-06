import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, parseUiContributions, parseUiArrange, type PluginHost } from "../../server/plugins.js";

function mkItems(n: number, prefix = "it", slot = "topbar.primary"): Array<Record<string, unknown>> {
	return Array.from({ length: n }, (_, i) => ({ slot, id: `${prefix}${i}`, label: `L${prefix}${i}` }));
}

function itemOf(raw: unknown, idx = 0) {
	const parsed = parseUiContributions(raw);
	expect(parsed, "parseUiContributions 应返回对象").toBeTruthy();
	const it = parsed!.items[idx];
	expect(it, `第 ${idx} 个条目应存在（实际 ${parsed!.items.length} 条）`).toBeTruthy();
	return it!;
}

describe("parseUiContributions —— 形状与 slot 别名", () => {
	it("按 slot 分组：7 个别名逐条映射到完整名，声明顺序保留", () => {
		const parsed = parseUiContributions({
			topbar: [{ id: "a", label: "A" }],
			"topbar.more": [{ id: "b", label: "B" }],
			composer: [{ id: "c", label: "C" }],
			message: [{ id: "d", label: "D" }],
			rightpanel: [{ id: "e", label: "E" }],
			settings: [{ id: "f", label: "F" }],
			modal: [{ id: "g", label: "G" }],
		});
		expect(parsed?.items.map((i) => [i.id, i.slot])).toEqual([
			["a", "topbar.primary"],
			["b", "topbar.overflow"],
			["c", "composer.actions"],
			["d", "message.actions"],
			["e", "rightpanel.tabs"],
			["f", "settings.pages"],
			["g", "modal.dialog"],
		]);
	});

	it("完整 slot 名原样接受（含没有别名的 bottombar / composer.leading / contextmenu.*）", () => {
		const parsed = parseUiContributions({
			bottombar: [{ id: "a", label: "A" }],
			"composer.leading": [{ id: "lead", label: "L" }],
			"contextmenu.topbar": [{ id: "b", label: "B" }],
			"contextmenu.message": [{ id: "c", label: "C" }],
			"contextmenu.session": [{ id: "d", label: "D" }],
			"contextmenu.file": [{ id: "e", label: "E" }],
		});
		expect(parsed?.items.map((i) => i.slot)).toEqual([
			"bottombar",
			"composer.leading",
			"contextmenu.topbar",
			"contextmenu.message",
			"contextmenu.session",
			"contextmenu.file",
		]);
	});

	it("不认识的 slot（含拼错的别名）整组丢弃；值不是数组也丢弃", () => {
		expect(parseUiContributions({ topbars: [{ id: "a", label: "A" }] })).toBeUndefined();
		expect(parseUiContributions({ topar: [{ id: "a", label: "A" }] })).toBeUndefined();
		expect(
			parseUiContributions({ topbar: "nope", bottombar: [{ id: "ok", label: "OK" }] })?.items.map((i) => i.id),
		).toEqual(["ok"]);
	});

	it("平铺 items：每项自带 slot，且同样走别名映射", () => {
		const parsed = parseUiContributions({
			items: [
				{ slot: "topbar", id: "a", label: "A" },
				{ slot: "settings", id: "b", label: "B" },
				{ slot: "bottombar", id: "c", label: "C" },
			],
		});
		expect(parsed?.items.map((i) => [i.id, i.slot])).toEqual([
			["a", "topbar.primary"],
			["b", "settings.pages"],
			["c", "bottombar"],
		]);
	});

	it("平铺 items 里 slot 缺失 / 不合法 → 该条丢弃（其余条目照收）", () => {
		const parsed = parseUiContributions({
			items: [
				{ id: "noslot", label: "L" },
				{ slot: "", id: "emptyslot", label: "L" },
				{ slot: "nowhere", id: "badslot", label: "L" },
				null,
				"string",
				{ slot: "topbar.more", id: "good", label: "L" },
			],
		});
		expect(parsed?.items.map((i) => i.id)).toEqual(["good"]);
	});

	it("两种写法可混写：平铺项先收，分组项随后", () => {
		const parsed = parseUiContributions({
			topbar: [{ id: "grouped", label: "G" }],
			items: [{ slot: "composer.actions", id: "flat", label: "F" }],
		});
		expect(parsed?.items.map((i) => [i.id, i.slot])).toEqual([
			["flat", "composer.actions"],
			["grouped", "topbar.primary"],
		]);
	});

	it("arrange 键不会当成 slot 组解析，且只有 arrange 时仍返回对象", () => {
		const parsed = parseUiContributions({ arrange: [{ id: "host:files", hide: true }] });
		expect(parsed?.items).toEqual([]);
		expect(parsed?.arrange).toEqual([{ id: "host:files", hide: true }]);
	});
});

describe("parseUiContributions —— 非法输入与条目级丢弃", () => {
	it("raw 不是对象（含 null/undefined/字符串/数字/数组）→ undefined", () => {
		for (const bad of [undefined, null, "topbar", 42, true, []] as unknown[]) {
			expect(parseUiContributions(bad)).toBeUndefined();
		}
	});

	it("整份都是垃圾 → undefined", () => {
		expect(parseUiContributions({})).toBeUndefined();
		expect(parseUiContributions({ foo: 1, bar: "x", items: 5, arrange: "no" })).toBeUndefined();
	});

	it("条目缺 label / label 只有空白 → 丢弃", () => {
		expect(parseUiContributions({ topbar: [{ id: "a" }] })).toBeUndefined();
		expect(parseUiContributions({ topbar: [{ id: "a", label: "   " }] })).toBeUndefined();
		expect(parseUiContributions({ topbar: [{ id: "a", label: 42 }] })).toBeUndefined();
	});

	it("id 必须匹配插件 id 字符集（字母/数字/下划线/连字符）", () => {
		const raw = {
			bottombar: [
				{ id: "a.b", label: "点" },
				{ id: "a:b", label: "冒号" },
			],
		};
		expect(parseUiContributions(raw)).toBeUndefined();
		expect(
			parseUiContributions({
				bottombar: [
					{ id: "中文 id", label: "坏" },
					{ id: "ok-1_A", label: "好" },
				],
			})?.items.map((i) => i.id),
		).toEqual(["ok-1_A"]);
	});

	it("label 首尾空白被 trim，空 label 因此不产生条目", () => {
		expect(itemOf({ bottombar: [{ id: "a", label: "  文案  " }] }).label).toBe("文案");
	});
});

describe("parseUiContributions —— kind 缺省与回落", () => {
	it("一般 slot 缺省 action，settings.pages 缺省 page", () => {
		expect(itemOf({ topbar: [{ id: "a", label: "A" }] }).kind).toBe("action");
		expect(itemOf({ settings: [{ id: "p", label: "P" }] }).kind).toBe("page");
		expect(itemOf({ items: [{ slot: "settings.pages", id: "p", label: "P" }] }).kind).toBe("page");
		expect(itemOf({ items: [{ slot: "bottombar", id: "b", label: "B" }] }).kind).toBe("action");
	});

	it("显式合法 kind 生效，未知 kind 回落缺省", () => {
		expect(itemOf({ topbar: [{ id: "a", label: "A", kind: "badge" }] }).kind).toBe("badge");
		expect(itemOf({ settings: [{ id: "p", label: "P", kind: "view" }] }).kind).toBe("view");
		expect(itemOf({ topbar: [{ id: "a", label: "A", kind: "wat" }] }).kind).toBe("action");
		expect(itemOf({ settings: [{ id: "p", label: "P", kind: "wat" }] }).kind).toBe("page");
	});

	it("order 只在能转成有限数字时才带上；hidden 只认 true", () => {
		expect(itemOf({ topbar: [{ id: "a", label: "A", order: 7 }] }).order).toBe(7);
		expect(itemOf({ topbar: [{ id: "a", label: "A", order: "7" }] }).order).toBe(7);
		expect(itemOf({ topbar: [{ id: "a", label: "A", order: "abc" }] })).not.toHaveProperty("order");
		expect(itemOf({ topbar: [{ id: "a", label: "A", hidden: true }] }).hidden).toBe(true);
		expect(itemOf({ topbar: [{ id: "a", label: "A", hidden: "yes" }] })).not.toHaveProperty("hidden");
	});
});

describe("parseUiContributions —— 上限、children、when、截断", () => {
	it("平铺 items 喂 40 条 → 只收前 32 条", () => {
		const items = parseUiContributions({ items: mkItems(40) })?.items ?? [];
		expect(items).toHaveLength(32);
		expect(items[0]?.id).toBe("it0");
		expect(items[31]?.id).toBe("it31");
	});

	it("单个 slot 数组喂 40 条 → 只收前 32 条", () => {
		const items = parseUiContributions({ composer: mkItems(40, "c", "composer.actions") })?.items ?? [];
		expect(items).toHaveLength(32);
		expect(items.map((i) => i.slot)).toEqual(Array.from({ length: 32 }, () => "composer.actions"));
	});

	it("混写时 32 是**总量**上限（平铺 20 + 分组 20 → 共 32，分组只挤进 12 条）", () => {
		const items =
			parseUiContributions({
				items: mkItems(20, "flat", "bottombar"),
				composer: mkItems(20, "grp", "composer.actions"),
			})?.items ?? [];
		expect(items).toHaveLength(32);
		expect(items[19]?.id).toBe("flat19");
		expect(items[20]?.id).toBe("grp0");
		expect(items[31]?.id).toBe("grp11");
	});

	it("children 只保留一层（孙子节点被清掉），坏子项静默丢弃", () => {
		const withGrandchild = itemOf({
			topbar: [
				{
					id: "parent",
					label: "父",
					children: [{ id: "child", label: "子", children: [{ id: "grand", label: "孙" }] }],
				},
			],
		});
		expect(withGrandchild.children?.map((c) => c.id)).toEqual(["child"]);
		expect(withGrandchild.children?.[0]).toHaveProperty("children", undefined);
		expect(withGrandchild.children?.[0]?.children).toBeUndefined();

		const dropped = itemOf({
			topbar: [{ id: "parent", label: "父", children: [{ id: "bad.id", label: "坏" }, { id: "nolabel" }] }],
		});
		expect(dropped).not.toHaveProperty("children");
	});

	it("children 每条最多 16 个", () => {
		const child = itemOf({
			topbar: [{ id: "parent", label: "父", children: mkItems(20, "ch", "topbar.primary") }],
		});
		expect(child.children).toHaveLength(16);
		expect(child.children?.at(-1)?.id).toBe("ch15");
	});

	it("when：只留非空字符串、最多 8 项、值原样保留（不 trim 回写）", () => {
		const capped = itemOf({
			topbar: [{ id: "a", label: "A", when: ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"] }],
		});
		expect(capped.when).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]);

		const filtered = itemOf({ topbar: [{ id: "a", label: "A", when: [1, "", "  ", null, "  x  "] }] });
		expect(filtered.when).toEqual(["  x  "]);

		expect(itemOf({ topbar: [{ id: "a", label: "A", when: "always" }] })).not.toHaveProperty("when");
		expect(itemOf({ topbar: [{ id: "a", label: "A", when: [1, ""] }] })).not.toHaveProperty("when");
	});

	it("文本字段截断：id ≤ 64、label ≤ 60、icon ≤ 16、hint ≤ 200", () => {
		const it = itemOf({
			topbar: [
				{
					id: "x".repeat(70),
					label: "字".repeat(100),
					icon: "i".repeat(40),
					hint: "h".repeat(300),
					labelEn: "e".repeat(80),
					group: "g".repeat(60),
					badge: "b".repeat(40),
				},
			],
		});
		expect(it.id).toHaveLength(64);
		expect(it.label).toHaveLength(60);
		expect(it.icon).toHaveLength(16);
		expect(it.hint).toHaveLength(200);
		expect(it.labelEn).toHaveLength(60);
		expect(it.group).toHaveLength(40);
		expect(it.badge).toHaveLength(24);

		const exact = itemOf({ topbar: [{ id: "a", label: "字".repeat(60), icon: "i".repeat(16) }] });
		expect(exact.label).toHaveLength(60);
		expect(exact.icon).toHaveLength(16);
	});
});

describe("parseUiArrange", () => {
	it("非数组（含 undefined/null/对象/字符串）→ []", () => {
		for (const bad of [undefined, null, "x", 42, { id: "host:files" }] as unknown[]) {
			expect(parseUiArrange(bad)).toEqual([]);
		}
	});

	it("目标 id 必须是 `xxx:yyy` 形态（host:files / plugin:id 合法）", () => {
		const ops = parseUiArrange([
			{ id: "host:files" },
			{ id: "my-plugin_1:item.name" },
			{ id: "nocolon" },
			{ id: ":x" },
			{ id: "x:" },
			{ id: "" },
			{ id: "   " },
			{ id: "a b:c" },
			{ id: "有中文:x" },
			{ id: 42 },
		]);
		expect(ops.map((o) => o.id)).toEqual(["host:files", "my-plugin_1:item.name"]);
	});

	it("slot 必须落在枚举内；别名不做映射（topbar 会被丢）", () => {
		const ops = parseUiArrange([
			{ id: "host:a", slot: "topbar.primary" },
			{ id: "host:b", slot: "settings.pages" },
			{ id: "host:c", slot: "topbar" },
			{ id: "host:d", slot: "nowhere" },
			{ id: "host:e", slot: 7 },
		]);
		expect(ops.map((o) => [o.id, o.slot])).toEqual([
			["host:a", "topbar.primary"],
			["host:b", "settings.pages"],
			["host:c", undefined],
			["host:d", undefined],
			["host:e", undefined],
		]);
	});

	it("hide 三态：true / false 都保留，非布尔不带该字段", () => {
		const [on, off, skip1, skip2] = parseUiArrange([
			{ id: "host:a", hide: true },
			{ id: "host:b", hide: false },
			{ id: "host:c", hide: 1 },
			{ id: "host:d", hide: "true" },
		]);
		expect(on).toEqual({ id: "host:a", hide: true });
		expect(off).toEqual({ id: "host:b", hide: false });
		expect(skip1).toEqual({ id: "host:c" });
		expect(skip2).toEqual({ id: "host:d" });
		expect(skip1).not.toHaveProperty("hide");
	});

	it("order 非数字被丢（数字字符串可转则以数字收），group/label/icon 走截断", () => {
		const [keep, str, drop1, drop2, texts] = parseUiArrange([
			{ id: "host:a", order: 3 },
			{ id: "host:b", order: "5" },
			{ id: "host:c", order: "abc" },
			{ id: "host:d", order: {} },
			{ id: "host:e", group: "g".repeat(60), label: "l".repeat(80), icon: "i".repeat(30) },
		]);
		expect(keep).toEqual({ id: "host:a", order: 3 });
		expect(str).toEqual({ id: "host:b", order: 5 });
		expect(drop1).toEqual({ id: "host:c" });
		expect(drop2).toEqual({ id: "host:d" });
		expect(texts?.group).toHaveLength(40);
		expect(texts?.label).toHaveLength(60);
		expect(texts?.icon).toHaveLength(16);
	});

	it("最多 64 条：上限切在**入参切片**上（非对象垃圾也占名额）", () => {
		const valid: unknown[] = Array.from({ length: 70 }, (_, i) => ({ id: `host:i${i}` }));
		const ops = parseUiArrange(valid);
		expect(ops).toHaveLength(64);
		expect(ops[0]?.id).toBe("host:i0");
		expect(ops.at(-1)?.id).toBe("host:i63");

		const withJunk = parseUiArrange([null, "x", 42, ...valid]);
		expect(withJunk).toHaveLength(61);
		expect(withJunk[0]?.id).toBe("host:i0");
		expect(withJunk.at(-1)?.id).toBe("host:i60");
	});

	it("arrange 不带上没有给出的字段（不产生 undefined 键）", () => {
		const [op] = parseUiArrange([{ id: "host:a" }]);
		expect(op).toEqual({ id: "host:a" });
	});
});

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>, body = ""): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; ${body} } };`,
	);
}

async function load(id: string, manifest: Record<string, unknown> = {}, body = ""): Promise<PluginHost | undefined> {
	makePlugin(id, manifest, body);
	await mgr.ensureLoaded();
	return (globalThis as unknown as { __hosts: Record<string, PluginHost | undefined> }).__hosts[id];
}

async function activate(id: string, manifest: Record<string, unknown> = {}, body = ""): Promise<PluginHost> {
	const h = await load(id, manifest, body);
	expect(h, `插件 ${id} 应激活成功`).toBeTruthy();
	return h!;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-ui-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.ui —— 能力门控", () => {
	it('permissions: ["ui"] → activate 里注册 + 测试侧注册都生效，注销函数移除本次注册的条目', async () => {
		const h = await activate(
			"ui-ok",
			{ permissions: ["ui"] },
			`globalThis.__uiOff = h.ui.register([{ slot: "composer.actions", id: "act", label: "激活时注册" }]);`,
		);
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["act"]);

		const off = h.ui.register([
			{ slot: "topbar.primary", id: "btn", label: "按钮", order: 3 },
			{ slot: "settings.pages", id: "page", label: "设置页" },
		]);
		expect(off).toBeTypeOf("function");
		expect(h.ui.list().items.map((i) => [i.id, i.slot, i.kind, i.order])).toEqual([
			["act", "composer.actions", "action", undefined],
			["btn", "topbar.primary", "action", 3],
			["page", "settings.pages", "page", undefined],
		]);

		off();
		off();
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["act"]);

		(globalThis as unknown as { __uiOff: () => void }).__uiOff();
		expect(h.ui.list().items).toEqual([]);
	});

	it("register 里的非法条目静默跳过（缺 label / id 非法 / slot 缺失）", async () => {
		const h = await activate("ui-partial", { permissions: ["ui"] });
		h.ui.register([
			{ slot: "topbar.primary", id: "good", label: "好" },
			{ slot: "topbar.primary", id: "bad.id", label: "坏 id" },
			{ slot: "topbar.primary", id: "nolabel" },
			{ id: "noslot", label: "无槽位" },
			null,
		]);
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["good"]);
	});

	it("未声明 permissions 且 apiVersion 1（旧全权模式）→ 放行 + 每个激活期只警告一次", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = await activate("ui-legacy", { apiVersion: 1, ui: { topbar: [{ id: "m", label: "manifest 条目" }] } });
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["m"]);

		h.ui.register({ slot: "composer.actions", id: "r1", label: "R1" });
		h.ui.register({ slot: "composer.actions", id: "r2", label: "R2" });
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["m", "r1", "r2"]);

		const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("未声明 permissions"));
		expect(warns).toHaveLength(1);
	});

	it("apiVersion 2 且未声明 permissions → 默认拒绝（v2 严格语义，宿主已升 v2）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = await load("ui-v2", { apiVersion: 2, ui: { topbar: [{ id: "m", label: "M" }] } });
		expect(h, "插件 ui-v2 应被拒绝激活").toBeUndefined();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("manifest"));
		const info = (await mgr.list()).find((x) => x.id === "ui-v2");
		expect(info?.error).toMatch(/manifest/);
		expect(info?.ui).toBeUndefined();
		expect(info?.diagnostics?.join("\n")).toMatch(/permissions/);
	});

	it("只声明别的能力（fs）却写 ui → manifest 校验失败即拒（P1-6）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = await load("ui-fsonly", {
			permissions: ["fs"],
			ui: { topbar: [{ id: "m", label: "M" }] },
		});
		expect(h, "插件 ui-fsonly 应被拒绝激活").toBeUndefined();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("manifest"));
		const info = (await mgr.list()).find((x) => x.id === "ui-fsonly");
		expect(info?.error).toMatch(/manifest/);
		expect(info?.ui).toBeUndefined();
		expect(info?.diagnostics?.join("\n")).toMatch(/ui/);
	});

	it('permissions: ["ui:read"] 这类带子命名空间的声明也算 ui 族', async () => {
		const h = await activate("ui-scoped", { permissions: ["ui:read"] });
		h.ui.register({ slot: "topbar.primary", id: "x", label: "X" });
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["x"]);
	});
});

describe("host.ui —— 合并、更新、移除、arrange", () => {
	it("运行时同 id 覆盖 manifest 条目；update 只改已存在条目；remove 后 manifest 条目也不复活", async () => {
		const h = await activate("ui-merge", {
			permissions: ["ui"],
			ui: { topbar: [{ id: "dup", label: "来自 manifest", order: 5 }] },
		});
		expect(h.ui.list().items.map((i) => ({ id: i.id, slot: i.slot, label: i.label, order: i.order }))).toEqual([
			{ id: "dup", slot: "topbar.primary", label: "来自 manifest", order: 5 },
		]);

		h.ui.register({ slot: "topbar.primary", id: "dup", label: "来自运行时", order: 9 });
		expect(h.ui.list().items).toHaveLength(1);
		expect(h.ui.list().items[0]).toMatchObject({ id: "dup", label: "来自运行时", order: 9, slot: "topbar.primary" });

		h.ui.update("dup", { label: "更新后", order: 1, badge: "3", slot: "settings.pages" });
		expect(h.ui.list().items[0]).toMatchObject({
			id: "dup",
			slot: "topbar.primary",
			label: "更新后",
			order: 1,
			badge: "3",
		});

		h.ui.update("nope", { label: "凭空造", slot: "topbar.primary" });
		expect(h.ui.list().items.map((i) => i.id)).toEqual(["dup"]);

		h.ui.remove("dup");
		expect(h.ui.list().items).toEqual([]);
	});

	it("arrange 追加本插件意图；单条（非数组）也收；全非法则一条不追加", async () => {
		const h = await activate("ui-arrange", { permissions: ["ui"] });
		expect(h.ui.list().arrange).toEqual([]);

		h.ui.arrange([{ id: "host:files", hide: true }]);
		expect(h.ui.list().arrange).toEqual([{ id: "host:files", hide: true }]);

		h.ui.arrange({ id: "host:cost", order: 1 });
		expect(h.ui.list().arrange).toEqual([
			{ id: "host:files", hide: true },
			{ id: "host:cost", order: 1 },
		]);

		h.ui.arrange([{ id: "nocolon", hide: true }, null, { id: "host:ok", hide: false }]);
		expect(h.ui.list().arrange.map((o) => o.id)).toEqual(["host:files", "host:cost", "host:ok"]);
		expect(h.ui.list().arrange.at(-1)).toEqual({ id: "host:ok", hide: false });
	});

	it("一次 register 超过 32 条 → 只收前 32 条（先注册的保留，后面的挤掉）", async () => {
		const h = await activate("ui-cap", { permissions: ["ui"] });
		h.ui.register(mkItems(40, "rt", "topbar.primary"));
		const ids = h.ui.list().items.map((i) => i.id);
		expect(ids).toHaveLength(32);
		expect(ids[0]).toBe("rt0");
		expect(ids.at(-1)).toBe("rt31");
	});

	it("运行时 register 与 manifest 同口径：别名要映射、非枚举 slot 要丢", async () => {
		const h = await activate("ui-rawslot", { permissions: ["ui"] });
		h.ui.register([
			{ slot: "topbar", id: "alias", label: "别名" },
			{ slot: "nowhere.at.all", id: "junk", label: "野槽位" },
		]);
		expect(h.ui.list().items.map((i) => [i.id, i.slot])).toEqual([["alias", "topbar.primary"]]);
	});
});

describe("parseUiContributions —— kind=select 与 options（P0-2）", () => {
	it("select 的 options 逐项校验：value 必填、去重、上限 32", () => {
		const parsed = parseUiContributions({
			topbar: [
				{
					id: "tone",
					label: "语气",
					kind: "select",
					action: "x:tone",
					value: "short",
					options: [
						{ value: "short", label: "简短" },
						{ value: "full", labelEn: "Verbose" },
						{ value: "", label: "空值丢弃" },
						{ value: "short", label: "重复丢弃" },
						"not-an-object",
						...Array.from({ length: 40 }, (_, i) => ({ value: `v${i}` })),
					],
				},
			],
		});
		const item = parsed!.items[0]!;
		expect(item.kind).toBe("select");
		expect(item.value).toBe("short");
		expect(item.options!.length).toBeLessThanOrEqual(32);
		expect(item.options!.slice(0, 2)).toEqual([
			{ value: "short", label: "简短" },
			{ value: "full", labelEn: "Verbose" },
		]);
	});
	it("没写 kind 但给了合法 options → 视为 select", () => {
		const parsed = parseUiContributions({
			topbar: [{ id: "s", label: "S", options: [{ value: "a" }] }],
		});
		expect(parsed!.items[0]!.kind).toBe("select");
	});
	it("options 全非法 → 不挂 options 字段、kind 保持 action", () => {
		const parsed = parseUiContributions({
			topbar: [{ id: "s", label: "S", kind: "select", options: [{ value: "" }] }],
		});
		expect(parsed!.items[0]!.kind).toBe("select");
		expect(parsed!.items[0]!.options).toBeUndefined();
	});
	it("host.ui.update 可刷新 select 的 value（运行时 patch 直通）", async () => {
		const h = await activate("ui-select", { permissions: ["ui"] });
		h.ui.register({
			slot: "topbar.primary",
			id: "tone",
			label: "语气",
			kind: "select",
			action: "x:tone",
			value: "short",
			options: [{ value: "short" }, { value: "full" }],
		});
		h.ui.update("tone", { value: "full" });
		expect(h.ui.list().items.find((i) => i.id === "tone")?.value).toBe("full");
	});
});

describe("parseUiContributions —— modal 别名", () => {
	it("modal → modal.dialog；平铺写法同口径", () => {
		const grouped = parseUiContributions({ modal: [{ id: "m", label: "弹窗", kind: "view" }] });
		expect(grouped!.items[0]!.slot).toBe("modal.dialog");
		const flat = parseUiContributions({ items: [{ slot: "modal", id: "m", label: "弹窗" }] });
		expect(flat!.items[0]!.slot).toBe("modal.dialog");
		const full = parseUiContributions({ items: [{ slot: "modal.dialog", id: "m", label: "弹窗" }] });
		expect(full!.items[0]!.slot).toBe("modal.dialog");
	});
});
