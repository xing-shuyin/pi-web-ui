import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TEMPLATES,
	SubagentTemplatesStore,
	TEMPLATE_LIMITS,
	canonicalizeTemplate,
	localizeTemplate,
	type SubagentTemplate,
} from "../../server/subagent-templates.js";
import { BUILTIN_TEMPLATES_HANT } from "../../server/subagent-templates-hant.js";

const dirs: string[] = [];
function tmpStore(): SubagentTemplatesStore {
	const dir = mkdtempSync(join(tmpdir(), "satpl-"));
	dirs.push(dir);
	return new SubagentTemplatesStore(join(dir, "subagent-templates.json"));
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base: SubagentTemplate = {
	name: "reviewer",
	description: "只读审查子代理",
	promptMode: "replace",
	systemPrompt: "你是一名严格的代码审查者。",
	enabledSkills: ["code-review"],
	enabledExtensions: ["npm:pi-scm"],
	model: "",
	thinkingLevel: "",
	enabled: true,
};

describe("SubagentTemplatesStore", () => {
	it("首次加载以内置默认模板为种子（不落盘）", () => {
		const store = tmpStore();
		const names = store.list().map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["review", "implement", "research", "scout", "audit", "delegate"]));
		for (const t of store.list()) {
			expect(t.enabled).toBe(true);
			expect(t.promptMode).toMatch(/^(replace|append)$/);
		}
	});

	it("老用户旧文件：缺失的内置模板一次性补齐；此后删除不再复活", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(file, JSON.stringify([{ name: "review", systemPrompt: "old" }]));
		const a = new SubagentTemplatesStore(file);
		expect(a.get("oracle")).toBeDefined();
		expect(a.get("review")!.systemPrompt).toBe("old");
		expect(a.get("review")!.thinkingLevel).toBe("");
		a.remove("review");
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")).toBeUndefined();
		expect(b.get("oracle")).toBeDefined();
	});

	it("upsert / get / list / remove 基础流程（默认之上增删）", () => {
		const store = tmpStore();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		expect(store.upsert(base)).toBeNull();
		expect(store.get("reviewer")).toEqual(base);
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		expect(store.upsert({ ...base, description: "v2" })).toBeNull();
		expect(store.get("reviewer")!.description).toBe("v2");
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length + 1);
		store.remove("reviewer");
		expect(store.get("reviewer")).toBeUndefined();
		expect(store.list()).toHaveLength(DEFAULT_TEMPLATES.length);
		store.remove("nope");
	});

	it("用户改动后落盘，此后以文件为准（默认模板可被删除且不再复活）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		a.remove("review");
		a.upsert({ ...base, enabled: false });
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")).toBeUndefined();
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.list()).toHaveLength(DEFAULT_TEMPLATES.length - 1 + 1);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw.find((t) => t.name === "review")).toBeUndefined();
	});

	it("非法名称拒绝保存", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, name: "   " })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "x".repeat(61) })).toMatch(/名称/);
		expect(store.upsert({ ...base, name: "  合法 名称 " })).toBeNull();
		expect(store.get("合法 名称")).toBeDefined();
	});

	it("replace + 空提示词拒绝保存（静默失效不如保存期拦下）", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, promptMode: "replace", systemPrompt: "   ", systemPromptEn: "" })).toMatch(
			/replace/,
		);
		expect(store.get("reviewer")).toBeUndefined();
		expect(store.upsert({ ...base, promptMode: "replace", systemPrompt: "", systemPromptEn: "Be strict." })).toBeNull();
		expect(store.upsert({ ...base, name: "append-only", promptMode: "append", systemPrompt: "" })).toBeNull();
	});

	it("体积超限拒绝保存（明确报错，不静默截断）", () => {
		const store = tmpStore();
		expect(store.upsert({ ...base, systemPrompt: "x".repeat(TEMPLATE_LIMITS.systemPrompt + 1) })).toMatch(/超长/);
		expect(
			store.upsert({ ...base, name: "long-en", systemPromptEn: "x".repeat(TEMPLATE_LIMITS.systemPrompt + 1) }),
		).toMatch(/英文系统提示词超长/);
		expect(
			store.upsert({ ...base, name: "long-desc", description: "x".repeat(TEMPLATE_LIMITS.description + 1) }),
		).toMatch(/简介超长/);
		expect(
			store.upsert({ ...base, name: "long-desc-en", descriptionEn: "x".repeat(TEMPLATE_LIMITS.description + 1) }),
		).toMatch(/英文简介超长/);
		expect(
			store.upsert({
				...base,
				name: "too-many-skills",
				enabledSkills: Array.from({ length: TEMPLATE_LIMITS.whitelistEntries + 1 }, (_, i) => `s${i}`),
			}),
		).toMatch(/条目过多/);
		expect(
			store.upsert({
				...base,
				name: "long-extension",
				enabledExtensions: ["npm:" + "x".repeat(TEMPLATE_LIMITS.whitelistEntryLength)],
			}),
		).toMatch(/超长条目/);
		for (const name of ["reviewer", "long-en", "long-desc", "long-desc-en", "too-many-skills", "long-extension"]) {
			expect(store.get(name)).toBeUndefined();
		}
		expect(store.upsert({ ...base, systemPrompt: "x".repeat(TEMPLATE_LIMITS.systemPrompt) })).toBeNull();
		expect(
			store.upsert({
				...base,
				name: "edge-ok",
				enabledSkills: Array.from({ length: TEMPLATE_LIMITS.whitelistEntries }, (_, i) => `s${i}`),
			}),
		).toBeNull();
	});

	it("持久化到磁盘并可重载（全局共享语义）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		a.upsert({ ...base, enabled: false });
		const b = new SubagentTemplatesStore(file);
		expect(b.get("reviewer")).toEqual({ ...base, enabled: false });
		expect(b.get("reviewer")!.enabled).toBe(false);
		const raw = JSON.parse(readFileSync(file, "utf8")) as SubagentTemplate[];
		expect(raw).toHaveLength(DEFAULT_TEMPLATES.length + 1);
	});

	it("容忍脏数据：非法条目丢弃、字段缺失补默认", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "ok", systemPrompt: "x" }, { name: "", systemPrompt: "bad-name" }, "garbage", 42]),
		);
		const store = new SubagentTemplatesStore(file);
		const list = store.list();
		expect(list).toHaveLength(1 + DEFAULT_TEMPLATES.length);
		expect(list[0]).toEqual({
			name: "ok",
			description: "",
			promptMode: "append",
			systemPrompt: "x",
			enabledSkills: [],
			enabledExtensions: [],
			model: "",
			thinkingLevel: "",
			enabled: true,
		});
	});

	it("model 字段归一：空白 → 空串（跟随主对话）；脏类型 → 空串", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([{ name: "a", model: "anthropic/claude-opus-4-5" }, { name: "b", model: 42 }, { name: "c" }]),
		);
		const store = new SubagentTemplatesStore(file);
		expect(store.get("a")!.model).toBe("anthropic/claude-opus-4-5");
		expect(store.get("b")!.model).toBe("");
		expect(store.get("c")!.model).toBe("");
		store.upsert({ ...base, name: "withModel", model: "  dashscope/qwen-max " });
		expect(store.get("withModel")!.model).toBe("dashscope/qwen-max");
	});

	it("thinkingLevel 字段归一：只认 SDK 档位；空/脏值 → 空串（跟随主对话）", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		writeFileSync(
			file,
			JSON.stringify([
				{ name: "a", thinkingLevel: "high" },
				{ name: "b", thinkingLevel: "  xhigh " },
				{ name: "c", thinkingLevel: "off" },
				{ name: "d", thinkingLevel: "ultra" },
				{ name: "e", thinkingLevel: 42 },
				{ name: "f" },
			]),
		);
		const store = new SubagentTemplatesStore(file);
		expect(store.get("a")!.thinkingLevel).toBe("high");
		expect(store.get("b")!.thinkingLevel).toBe("xhigh");
		expect(store.get("c")!.thinkingLevel).toBe("off");
		expect(store.get("d")!.thinkingLevel).toBe("");
		expect(store.get("e")!.thinkingLevel).toBe("");
		expect(store.get("f")!.thinkingLevel).toBe("");
		store.upsert({ ...base, name: "ok", thinkingLevel: "medium" });
		expect(store.get("ok")!.thinkingLevel).toBe("medium");
		store.upsert({ ...base, name: "bad", thinkingLevel: "MAX" });
		expect(store.get("bad")!.thinkingLevel).toBe("");
	});

	it("list 返回副本（外部修改不影响库内）", () => {
		const store = tmpStore();
		store.upsert(base);
		const copy = store.list().find((t) => t.name === "reviewer")!;
		copy.enabledSkills.push("hack");
		expect(store.get("reviewer")!.enabledSkills).toEqual(["code-review"]);
	});
});

describe("oh-my-pi specialist 内置模板", () => {
	const names = ["oracle", "librarian", "explore", "metis", "momus", "multimodal-looker", "sisyphus-junior"];

	it("7 个 specialist 齐全且为 replace 模式", () => {
		for (const n of names) {
			const t = DEFAULT_TEMPLATES.find((x) => x.name === n);
			expect(t, n).toBeDefined();
			expect(t!.promptMode).toBe("replace");
			expect(t!.enabled).toBe(true);
			expect(t!.model).toBe("");
		}
	});

	it("内置模板不预设思考强度（空 = 跟随主对话，老用户升级后行为一致）", () => {
		for (const t of DEFAULT_TEMPLATES) {
			expect(t.thinkingLevel, t.name).toBe("");
		}
	});

	it("双语简介与提示词齐全", () => {
		for (const n of names) {
			const t = DEFAULT_TEMPLATES.find((x) => x.name === n)!;
			expect(t.description.trim().length, `${n}.description`).toBeGreaterThan(0);
			expect(t.descriptionEn?.trim().length, `${n}.descriptionEn`).toBeGreaterThan(0);
			expect(t.systemPrompt.trim().length, `${n}.systemPrompt`).toBeGreaterThan(100);
			expect(t.systemPromptEn?.trim().length, `${n}.systemPromptEn`).toBeGreaterThan(100);
		}
	});
});

describe("内置模板繁中视图（zh-TW / zh-HK / zh-Hant 共用一份台湾用语）", () => {
	const ZH_SOURCE_STRAY = ["_Number_"];
	const SIMPLIFIED_ONLY =
		"这与为个们发现档验证码类项请实阅读并统结构测试环风险总过关说对该态执览审计划议诊应误错没问题务备约规范释简编库";
	const asciiTokens = (s: string, strip: string[] = []) =>
		strip.reduce((acc, x) => acc.split(x).join(" "), s).match(/[A-Za-z0-9][A-Za-z0-9_./+-]*/g) ?? [];
	const review = () => DEFAULT_TEMPLATES.find((t) => t.name === "review")!;

	it("守卫：每个内置模板都有繁中文案，且没有多余/过期的条目", () => {
		expect(Object.keys(BUILTIN_TEMPLATES_HANT).sort()).toEqual(DEFAULT_TEMPLATES.map((t) => t.name).sort());
	});

	it("守卫：繁中文案与简中出厂文案结构对齐（行数、英文词元一致），且已不含简体字", () => {
		for (const d of DEFAULT_TEMPLATES) {
			const hant = BUILTIN_TEMPLATES_HANT[d.name]!;
			for (const field of ["description", "systemPrompt"] as const) {
				const zh = d[field];
				const tw = hant[field];
				expect(tw, `${d.name}.${field} 不应与简中相同`).not.toBe(zh);
				expect(tw.split("\n").length, `${d.name}.${field} 行数`).toBe(zh.split("\n").length);
				expect(asciiTokens(tw), `${d.name}.${field} 英文词元`).toEqual(asciiTokens(zh, ZH_SOURCE_STRAY));
				const leaked = [...tw].filter((ch) => SIMPLIFIED_ONLY.includes(ch));
				expect(leaked, `${d.name}.${field} 含简体字`).toEqual([]);
			}
		}
	});

	it("繁中界面（含 zh-HK / zh-Hant / 区域与分隔写法）拿到繁中视图，英文字段不动", () => {
		for (const locale of ["zh-TW", "zh-tw", "zh_TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) {
			const v = localizeTemplate(review(), locale);
			expect(v.description, locale).toBe(BUILTIN_TEMPLATES_HANT.review!.description);
			expect(v.systemPrompt, locale).toBe(BUILTIN_TEMPLATES_HANT.review!.systemPrompt);
			expect(v.descriptionEn, locale).toBe(review().descriptionEn);
			expect(v.systemPromptEn, locale).toBe(review().systemPromptEn);
		}
	});

	it("简中 / 英文 / 其它语言 / 未上报 locale 原样返回（同一对象）", () => {
		for (const locale of ["zh", "zh-CN", "zh-Hans", "zh-Hans-HK", "zh-SG", "en", "ja", "", undefined, null]) {
			const src = review();
			expect(localizeTemplate(src, locale), String(locale)).toBe(src);
		}
	});

	it("逐字段判断：用户改过的字段原样保留，没改的字段仍换成繁中；不改动入参", () => {
		const edited = { ...review(), systemPrompt: `${review().systemPrompt}\n- 额外约定。` };
		const v = localizeTemplate(edited, "zh-TW");
		expect(v.description).toBe(BUILTIN_TEMPLATES_HANT.review!.description);
		expect(v.systemPrompt).toBe(edited.systemPrompt);
		expect(edited.description).toBe(review().description);
	});

	it("自建模板 / 同名但内容不同 / 原型链属性名都不受影响", () => {
		const custom = { name: "reviewer", description: "只读审查", systemPrompt: "你是审查者。" };
		expect(localizeTemplate(custom, "zh-TW")).toBe(custom);
		const sameNameOtherText = { name: "review", description: "我的审查", systemPrompt: "我的提示词" };
		expect(localizeTemplate(sameNameOtherText, "zh-TW")).toBe(sameNameOtherText);
		for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			const proto = { name, description: "d", systemPrompt: "p" };
			expect(localizeTemplate(proto, "zh-TW")).toBe(proto);
			expect(canonicalizeTemplate(proto)).toBe(proto);
		}
	});

	it("canonicalizeTemplate 是 localizeTemplate 的逆运算（全部内置模板往返不变）", () => {
		for (const d of DEFAULT_TEMPLATES) {
			expect(canonicalizeTemplate(localizeTemplate(d, "zh-HK"))).toEqual(d);
			expect(canonicalizeTemplate(d)).toBe(d);
		}
		const mine = { ...review(), systemPrompt: `${BUILTIN_TEMPLATES_HANT.review!.systemPrompt}\n- 額外約定。` };
		expect(canonicalizeTemplate(mine)).toBe(mine);
	});

	it("upsert：设置页回传繁中视图（如只点启用开关）时，库里仍存出厂简中", () => {
		const store = tmpStore();
		const view = localizeTemplate(store.get("review")!, "zh-TW");
		expect(view.systemPrompt).not.toBe(review().systemPrompt);
		expect(store.upsert({ ...view, enabled: false })).toBeNull();
		const saved = store.get("review")!;
		expect(saved.enabled).toBe(false);
		expect(saved.description).toBe(review().description);
		expect(saved.systemPrompt).toBe(review().systemPrompt);
	});

	it("upsert：用户在繁中界面真正改了提示词，改动原样入库（不被还原）", () => {
		const store = tmpStore();
		const view = localizeTemplate(store.get("review")!, "zh-Hant");
		const edited = `${view.systemPrompt}\n- 額外約定。`;
		expect(store.upsert({ ...view, systemPrompt: edited })).toBeNull();
		const saved = store.get("review")!;
		expect(saved.systemPrompt).toBe(edited);
		expect(saved.description).toBe(review().description);
		expect(localizeTemplate(saved, "zh-Hant").systemPrompt).toBe(edited);
	});

	it("已落盘的旧数据无需迁移：出厂简中原样的内置模板在繁中界面直接换成繁中", () => {
		const dir = mkdtempSync(join(tmpdir(), "satpl-"));
		dirs.push(dir);
		const file = join(dir, "subagent-templates.json");
		const a = new SubagentTemplatesStore(file);
		a.upsert({ ...base });
		const b = new SubagentTemplatesStore(file);
		expect(b.get("review")!.systemPrompt).toBe(review().systemPrompt);
		expect(localizeTemplate(b.get("review")!, "zh-HK").systemPrompt).toBe(BUILTIN_TEMPLATES_HANT.review!.systemPrompt);
		expect(b.get("review")!.systemPrompt).toBe(review().systemPrompt);
	});
});
