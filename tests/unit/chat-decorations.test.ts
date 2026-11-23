import { describe, expect, it } from "vitest";
import {
	MAX_DECORATIONS_PER_PLUGIN,
	MAX_DECORATIONS_TOTAL,
	MAX_MATCHES_PER_BLOCK,
	MAX_PATTERN_LENGTH,
	compileChatDecorations,
	findDecorationMatches,
	normalizeChatDecorations,
	planDecorationRanges,
	type ChatDecorationSource,
} from "../../shared/chat-decorations.js";
const src = (over: Partial<ChatDecorationSource> = {}): ChatDecorationSource => ({
	pluginId: "dialogue-color",
	permissions: ["decorate"],
	decorations: [{ id: "quotes", pattern: "「[^」]+」", style: { color: "#e8832a" } }],
	...over,
});

const compileOne = (over: Partial<ChatDecorationSource> = {}) => compileChatDecorations([src(over)]);

describe("manifest.chatDecorations 形状归一（服务端）", () => {
	it("非数组 / 脏条目 / 超长 pattern 一律丢掉，不做猜测", () => {
		expect(normalizeChatDecorations(undefined)).toEqual([]);
		expect(normalizeChatDecorations("nope")).toEqual([]);
		expect(
			normalizeChatDecorations([
				null,
				3,
				[],
				{ pattern: 42 },
				{ pattern: "   " },
				{ pattern: "x".repeat(MAX_PATTERN_LENGTH + 1) },
				{ pattern: "ok", id: "  a  ", flags: "gu" },
			]),
		).toEqual([{ pattern: "ok", id: "a", flags: "gu" }]);
	});

	it("样式只保留白名单 prop，设置引用保留为 { setting }", () => {
		const [spec] = normalizeChatDecorations([
			{
				pattern: "x",
				style: {
					color: { setting: "color" },
					backgroundColor: "#000",
					fontWeight: 700,
					boxShadow: "0 0 99px red",
				},
			},
		]);
		expect(spec?.style).toEqual({ color: { setting: "color" }, backgroundColor: "#000" });
	});

	it("条数按单插件上限收敛（不静默吞掉作者的其它声明：超出的由客户端报诊断）", () => {
		const many = Array.from({ length: MAX_DECORATIONS_PER_PLUGIN + 4 }, (_, i) => ({ pattern: `p${i}` }));
		expect(normalizeChatDecorations(many)).toHaveLength(MAX_DECORATIONS_PER_PLUGIN);
	});
});

describe("chatDecorations 编译（客户端唯一语义闸门）", () => {
	it("没有 decorate 权限：整份忽略并留诊断", () => {
		const r = compileOne({ permissions: ["ui"] });
		expect(r.rules).toEqual([]);
		expect(r.diagnostics.join("\n")).toContain('"decorate"');
		expect(compileOne({ permissions: ["decorate:chat"] }).rules).toHaveLength(1);
	});

	it("非法正则只丢这一条，不影响后面的规则", () => {
		const r = compileOne({
			decorations: [
				{ id: "bad", pattern: "([", style: { color: "red" } },
				{ id: "good", pattern: "ok", style: { color: "red" } },
			],
		});
		expect(r.rules.map((x) => x.ruleId)).toEqual(["good"]);
		expect(r.diagnostics.join("\n")).toContain("正则非法");
	});

	it("flags 只留白名单字符，且强制带 g", () => {
		const [rule] = compileOne({ decorations: [{ pattern: "a", flags: "yqd", style: { color: "red" } }] }).rules;
		expect(rule?.regex.flags).toBe("g");
		expect(rule?.regex.global).toBe(true);
		const [iu] = compileOne({ decorations: [{ pattern: "a", flags: "iu", style: { color: "red" } }] }).rules;
		expect(iu?.regex.flags).toBe("giu");
	});

	it("CSS 取值白名单：越界值整条丢弃，不允许拼进样式表", () => {
		for (const evil of ["red;} body{display:none", "url(https://x/y.png)", "rgb(0,0,0);", 'red"']) {
			const r = compileOne({ decorations: [{ id: "x", pattern: "a", style: { color: evil } }] });
			expect(r.rules, evil).toEqual([]);
			expect(r.diagnostics.length).toBeGreaterThan(0);
		}
		expect(compileOne({ decorations: [{ pattern: "a", style: { color: "rgb(1 2 3 / 40%)" } }] }).rules).toHaveLength(1);
	});

	it("fontWeight 只认 CSS 关键字与百位数值", () => {
		const ok = compileOne({ decorations: [{ pattern: "a", style: { fontWeight: "700" } }] }).rules;
		expect(ok[0]?.declarations).toBe("font-weight:700;");
		expect(compileOne({ decorations: [{ pattern: "a", style: { fontWeight: "heavy" } }] }).rules).toEqual([]);
	});

	it("设置引用：text / select / number 可用，secret 永不进样式", () => {
		const schema = [
			{ key: "color", type: "text", default: "#e8832a" },
			{ key: "tone", type: "select", default: "bold" },
			{ key: "token", type: "secret" },
		];
		const deco = (key: string, prop: "color" | "fontWeight") => ({
			pattern: "a",
			style: prop === "color" ? { color: { setting: key } } : { fontWeight: { setting: key } },
		});
		const ok = compileChatDecorations([
			src({ settingsSchema: schema, settingsValues: { color: "#ff8800" }, decorations: [deco("color", "color")] }),
		]);
		expect(ok.rules[0]?.declarations).toBe("color:#ff8800;");

		const fallback = compileChatDecorations([src({ settingsSchema: schema, decorations: [deco("color", "color")] })]);
		expect(fallback.rules[0]?.declarations).toBe("color:#e8832a;");

		expect(
			compileChatDecorations([src({ settingsSchema: schema, decorations: [deco("token", "color")] })]).rules,
		).toEqual([]);
		expect(
			compileChatDecorations([src({ settingsSchema: schema, decorations: [deco("nope", "color")] })]).diagnostics.join(
				"\n",
			),
		).toContain("settingsSchema 里没有");
	});

	it("重复规则 id / 超过总数上限都只保留先来的", () => {
		const dup = compileOne({
			decorations: [
				{ id: "a", pattern: "1", style: { color: "red" } },
				{ id: "a", pattern: "2", style: { color: "red" } },
			],
		});
		expect(dup.rules.map((r) => r.name)).toEqual(["pi-deco-dialogue-color-a"]);

		const sources = Array.from({ length: 5 }, (_, i) =>
			src({
				pluginId: `p${i}`,
				decorations: Array.from({ length: MAX_DECORATIONS_PER_PLUGIN }, (_, j) => ({
					id: `r${j}`,
					pattern: "x",
					style: { color: "red" },
				})),
			}),
		);
		expect(compileChatDecorations(sources).rules).toHaveLength(MAX_DECORATIONS_TOTAL);
	});

	it("没有可用样式 / 空 pattern 的规则不产生空 Highlight", () => {
		expect(compileOne({ decorations: [{ pattern: "a", style: { color: "not a color?" } }] }).rules).toEqual([]);
		expect(compileOne({ decorations: [{ pattern: "  ", style: { color: "red" } }] }).rules).toEqual([]);
	});

	it("enabledBy：关掉的分组静默不生效，写错的开关报诊断（不静默失效）", () => {
		const schema = [
			{ key: "master", type: "boolean", default: true },
			{ key: "group", type: "boolean", default: true },
			{ key: "color", type: "text", default: "red" },
			{ key: "notBool", type: "text", default: "x" },
		];
		const deco = (enabledBy: string | string[]) => ({
			id: "r",
			pattern: "a",
			enabledBy,
			style: { color: { setting: "color" } },
		});

		const on = compileChatDecorations([src({ settingsSchema: schema, decorations: [deco(["master", "group"])] })]);
		expect(on.rules).toHaveLength(1);
		expect(on.diagnostics).toEqual([]);

		const off = compileChatDecorations([
			src({ settingsSchema: schema, settingsValues: { group: false }, decorations: [deco(["master", "group"])] }),
		]);
		expect(off.rules).toEqual([]);
		expect(off.diagnostics).toEqual([]);

		for (const bad of ["missing", "notBool"]) {
			const r = compileChatDecorations([src({ settingsSchema: schema, decorations: [deco(bad)] })]);
			expect(r.rules, bad).toEqual([]);
			expect(r.diagnostics.join("\n"), bad).toContain(bad);
		}
	});

	it("pattern 可以引用设置：留空静默跳过，非法正则只丢它自己", () => {
		const schema = [
			{ key: "pattern", type: "text", default: "" },
			{ key: "toggle", type: "boolean", default: true },
		];
		const deco = (id: string) => ({
			id,
			pattern: { setting: "pattern" },
			enabledBy: "toggle",
			style: { color: "red" },
		});

		const empty = compileChatDecorations([src({ settingsSchema: schema, decorations: [deco("r")] })]);
		expect(empty.rules).toEqual([]);
		expect(empty.diagnostics).toEqual([]);

		const filled = compileChatDecorations([
			src({ settingsSchema: schema, settingsValues: { pattern: "a+" }, decorations: [deco("r")] }),
		]);
		expect(filled.rules[0]?.regex.source).toBe("a+");

		const broken = compileChatDecorations([
			src({ settingsSchema: schema, settingsValues: { pattern: "([" }, decorations: [deco("r")] }),
		]);
		expect(broken.rules).toEqual([]);
		expect(broken.diagnostics.join("\n")).toContain("正则非法");
	});

	it("scope 归一：只有 assistant / user 被认可，其余一律 all", () => {
		const scopes = (["assistant", "user", "all", "tool", undefined] as const).map(
			(scope) =>
				compileOne({
					decorations: [{ pattern: "a", scope: scope as "all" | undefined, style: { color: "red" } }],
				}).rules[0]?.scope,
		);
		expect(scopes).toEqual(["assistant", "user", "all", "all", "all"]);
	});
});

describe("正文匹配与节点映射（DOM 无关）", () => {
	it("findDecorationMatches 按上限截断，零宽模式不会死循环", () => {
		const many = findDecorationMatches("a".repeat(50), /a/g, 3);
		expect(many).toHaveLength(3);
		expect(findDecorationMatches("abc", /(?=b)/g, MAX_MATCHES_PER_BLOCK)).toEqual([]);
	});

	it("跨文本节点的命中映射成首尾节点 + 偏移", () => {
		// 「你 好」= ["你", " 好"]：命中从节点 0 偏移 0 到节点 1 偏移 2
		expect(planDecorationRanges([1, 2], [[0, 3]])).toEqual([{ fromNode: 0, fromOffset: 0, toNode: 1, toOffset: 2 }]);
	});

	it("落在节点边界 / 越界的命中：边界收进相邻节点，越界跳过", () => {
		expect(planDecorationRanges([2, 3], [[2, 5]])).toEqual([{ fromNode: 1, fromOffset: 0, toNode: 1, toOffset: 3 }]);
		expect(planDecorationRanges([2], [[1, 99]])).toEqual([]);
	});
});
