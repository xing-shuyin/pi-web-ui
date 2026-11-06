import { describe, expect, it } from "vitest";
import {
	LP_SECTION_DEFAULT_ORDER,
	LP_SECTION_ENTRY_ID,
	flexSectionKeys,
	isPluginSectionKey,
	parseLpWeights,
	planLeftSections,
	sashPairs,
	withDeviceGroupSection,
	type LpSectionKey,
} from "../../web/src/left-sections.js";

const entry = (id: string, hidden = false) => ({ id, hidden });

describe("群组分区的拖动布局", () => {
	it("群组位于项目之后，并与上下展开分区形成分隔条", () => {
		const plan = withDeviceGroupSection(planLeftSections(undefined));
		expect(plan.map((item) => item.key)).toEqual(["projects", "groups", "convs", "sessions"]);
		expect(
			sashPairs(
				flexSectionKeys(plan, () => true),
				() => false,
			),
		).toEqual([
			["projects", "groups"],
			["groups", "convs"],
			["convs", "sessions"],
		]);
	});

	it("项目隐藏时群组置顶，折叠群组不生成其边界分隔条", () => {
		const plan = withDeviceGroupSection(planLeftSections([entry("host:lp-projects", true)]));
		const flex = flexSectionKeys(plan, () => true);
		expect(flex).toEqual(["groups", "convs", "sessions"]);
		expect(sashPairs(flex, (key) => key === "groups")).toEqual([["convs", "sessions"]]);
	});

	it("项目没有内容时群组仍与运行区配对，保存的群组权重可恢复", () => {
		const plan = withDeviceGroupSection(planLeftSections(undefined));
		expect(
			sashPairs(
				flexSectionKeys(plan, (key) => key !== "projects"),
				() => false,
			)[0],
		).toEqual(["groups", "convs"]);
		expect(parseLpWeights('{"groups":0.4}', { projects: 1, groups: 1, convs: 1, sessions: 1 }).groups).toBe(0.4);
	});

	it("合并引擎已给出 groups 条目时显隐跟随布局页（hidden → 不渲染），不兑底重排", () => {
		const plan = withDeviceGroupSection(
			planLeftSections([
				entry(LP_SECTION_ENTRY_ID.projects),
				entry(LP_SECTION_ENTRY_ID.groups, true),
				entry(LP_SECTION_ENTRY_ID.convs),
			]),
		);
		expect(plan.map((item) => item.key)).toEqual(["projects", "groups", "convs", "sessions"]);
		expect(plan.find((item) => item.key === "groups")?.shown).toBe(false);
		const shown = plan.filter((item) => item.shown).map((item) => item.key);
		expect(shown).toEqual(["projects", "convs", "sessions"]);
		expect(
			sashPairs(
				flexSectionKeys(plan, () => true),
				() => false,
			),
		).toEqual([
			["projects", "convs"],
			["convs", "sessions"],
		]);
	});

	it("合并引擎已给出 groups 条目时顺序跟随引擎（调序生效，不再插到项目后）", () => {
		const plan = withDeviceGroupSection(
			planLeftSections([
				entry(LP_SECTION_ENTRY_ID.sessions),
				entry(LP_SECTION_ENTRY_ID.groups),
				entry(LP_SECTION_ENTRY_ID.projects),
			]),
		);
		expect(plan.map((item) => item.key)).toEqual(["sessions", "groups", "projects", "convs"]);
	});
});

describe("planLeftSections（顺序 + 显隐）", () => {
	it("没有条目信息时回落缺省顺序（与改造前的 JSX 先后一致）、全部显示", () => {
		expect(planLeftSections(undefined)).toEqual([
			{ key: "projects", shown: true },
			{ key: "convs", shown: true },
			{ key: "sessions", shown: true },
		]);
		expect(LP_SECTION_DEFAULT_ORDER).toEqual(["projects", "convs", "sessions"]);
	});

	it("跟随条目顺序（布局页调序的结果）", () => {
		const plan = planLeftSections([
			entry(LP_SECTION_ENTRY_ID.sessions),
			entry(LP_SECTION_ENTRY_ID.projects),
			entry(LP_SECTION_ENTRY_ID.convs),
		]);
		expect(plan.map((p) => p.key)).toEqual(["sessions", "projects", "convs"]);
	});

	it("hidden 的分区 shown=false，其余不受影响", () => {
		const plan = planLeftSections([
			entry(LP_SECTION_ENTRY_ID.projects, true),
			entry(LP_SECTION_ENTRY_ID.convs),
			entry(LP_SECTION_ENTRY_ID.sessions),
		]);
		expect(plan).toEqual([
			{ key: "projects", shown: false },
			{ key: "convs", shown: true },
			{ key: "sessions", shown: true },
		]);
	});

	it("不认识的条目 id 忽略（插件误放进来的条目不会凭空变成一个分区）", () => {
		const plan = planLeftSections([entry("p:fake"), entry(LP_SECTION_ENTRY_ID.sessions)]);
		expect(plan.map((p) => p.key)).toEqual(["sessions", "projects", "convs"]);
	});

	it("缺失的分区按缺省顺序补在末尾（条目被整体去掉时界面仍完整）", () => {
		const plan = planLeftSections([entry(LP_SECTION_ENTRY_ID.convs)]);
		expect(plan.map((p) => p.key)).toEqual(["convs", "projects", "sessions"]);
		expect(plan.every((p) => p.shown)).toBe(true);
	});
});

describe("flexSectionKeys（参与权重的分区）", () => {
	it("隐藏的分区与『无内容』的分区都不参与权重", () => {
		const plan = planLeftSections([entry(LP_SECTION_ENTRY_ID.convs, true)]);
		const keys = flexSectionKeys(plan, (k) => k === "sessions");
		expect(keys).toEqual(["sessions"]);
	});

	it("保持计划顺序", () => {
		const plan = planLeftSections([entry(LP_SECTION_ENTRY_ID.sessions), entry(LP_SECTION_ENTRY_ID.projects)]);
		expect(flexSectionKeys(plan, () => true)).toEqual(["sessions", "projects", "convs"]);
	});
});

describe("sashPairs（分隔条配对）", () => {
	const none = () => false;

	it("两两相邻、两端都展开才配对", () => {
		expect(sashPairs(["projects", "convs", "sessions"], none)).toEqual([
			["projects", "convs"],
			["convs", "sessions"],
		]);
	});

	it("中间分区折叠 → 两侧都不配对（折叠区只剩标题，不需要分隔条）", () => {
		const collapsed = (k: LpSectionKey) => k === "convs";
		expect(sashPairs(["projects", "convs", "sessions"], collapsed)).toEqual([]);
	});

	it("隐藏一个分区后相邻关系重新配对（而不是沿用旧的位置）", () => {
		const plan = planLeftSections([entry(LP_SECTION_ENTRY_ID.convs, true)]);
		const flex = flexSectionKeys(plan, () => true);
		expect(sashPairs(flex, none)).toEqual([["projects", "sessions"]]);
	});

	it("只有一个分区 → 没有分隔条", () => {
		expect(sashPairs(["sessions"], none)).toEqual([]);
	});
});

describe("P4：插件自定义分区（plugin:<条目id>）", () => {
	const pluginView = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		source: "plugin:" + id.split(":")[0],
		kind: "view",
		...extra,
	});

	it("插件 view 条目成为 plugin:<id> 分区，位置跟随引擎给出的顺序", () => {
		const plan = planLeftSections([
			entry(LP_SECTION_ENTRY_ID.projects),
			pluginView("notes:fav"),
			entry(LP_SECTION_ENTRY_ID.sessions),
		]);
		expect(plan.map((p) => p.key)).toEqual(["projects", "plugin:notes:fav", "sessions", "convs"]);
		expect(plan[1]!.entry?.id).toBe("notes:fav");
	});

	it("插件分区的 hidden 生效；插件分区不会被缺省顺序补出来", () => {
		const plan = planLeftSections([pluginView("notes:fav", { hidden: true })]);
		expect(plan.find((p) => p.key === "plugin:notes:fav")?.shown).toBe(false);
		expect(plan.map((p) => p.key).filter((k) => k.startsWith("plugin:"))).toEqual(["plugin:notes:fav"]);
	});

	it("只认 kind=view 且来自插件的条目：宿主 action、其它种类一律不成为分区", () => {
		const plan = planLeftSections([
			{ id: "notes:bad", source: "plugin:notes", kind: "action" },
			{ id: "host:whatever", source: "host", kind: "view" },
			{ id: "x", source: undefined, kind: "view" },
		]);
		expect(plan.some((p) => p.key.startsWith("plugin:"))).toBe(false);
		expect(plan.map((p) => p.key)).toEqual(["projects", "convs", "sessions"]);
	});

	it("插件分区参与 flex（有内容由调用方判定，插件分区视为有内容）", () => {
		const plan = planLeftSections([pluginView("notes:fav")]);
		const flex = flexSectionKeys(plan, (k) => k !== "convs");
		expect(flex).toContain("plugin:notes:fav");
		expect(flex).not.toContain("convs");
	});

	it("isPluginSectionKey 区分宿主键与插件键", () => {
		expect(isPluginSectionKey("plugin:a:b")).toBe(true);
		expect(isPluginSectionKey("plugin:")).toBe(false);
		expect(isPluginSectionKey("projects")).toBe(false);
	});

	it("权重存档：插件分区键保留，宿主键只收已知键，非法值丢弃", () => {
		const defaults = { projects: 1, convs: 1, sessions: 1 };
		const raw = JSON.stringify({ projects: 2, "plugin:notes:fav": 3, bogus: 9, convs: -1, sessions: "x" });
		expect(parseLpWeights(raw, defaults)).toEqual({ projects: 2, convs: 1, sessions: 1, "plugin:notes:fav": 3 });
	});

	it("权重存档：坏 JSON / 空值回落默认", () => {
		const defaults = { projects: 1, convs: 1, sessions: 1 };
		expect(parseLpWeights("{oops", defaults)).toEqual(defaults);
		expect(parseLpWeights(null, defaults)).toEqual(defaults);
	});
});
