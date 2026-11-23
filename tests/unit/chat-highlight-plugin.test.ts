import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";
import {
	compileChatDecorations,
	findDecorationMatches,
	normalizeChatDecorations,
} from "../../shared/chat-decorations.js";

const MANIFEST_PATH = join(process.cwd(), "plugins/chat-highlight/manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
	id: string;
	permissions: string[];
	settings: { key: string; type: string; default?: unknown }[];
	chatDecorations: unknown;
};

/** 与宿主一致：设置值的缺省来自 schema 的 default。 */
const defaults = Object.fromEntries(
	manifest.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
);

const compile = (values: Record<string, unknown> = defaults) =>
	compileChatDecorations([
		{
			pluginId: manifest.id,
			permissions: manifest.permissions,
			decorations: normalizeChatDecorations(manifest.chatDecorations),
			settingsSchema: manifest.settings,
			settingsValues: values,
		},
	]);

const hits = (regex: RegExp, text: string) =>
	findDecorationMatches(text, regex).map(([start, end]) => text.slice(start, end));

const ruleOf = (id: string, values?: Record<string, unknown>) => {
	const rule = compile(values).rules.find((r) => r.ruleId === id);
	if (!rule) throw new Error(`规则 ${id} 没编译出来`);
	return rule;
};

describe("内置插件 chat-highlight（正文高亮）", () => {
	it("manifest 通过校验，且没有 chatDecorations 相关告警", () => {
		const v = validatePluginManifest(manifest, "chat-highlight");
		expect(v.errors).toEqual([]);
		expect(v.warnings.filter((w) => w.path === "chatDecorations")).toEqual([]);
	});

	it("默认配置编译出 9 条规则、零诊断（@提及 / 自定义默认关）", () => {
		const { rules, diagnostics } = compile();
		expect(diagnostics).toEqual([]);
		expect(rules.map((r) => r.ruleId).sort()).toEqual([
			"command",
			"contact",
			"date",
			"dialogue",
			"headers",
			"money",
			"speaker",
			"stage",
			"tech",
		]);
	});

	it("scope：台词/角色行只作用于助手，斜杠命令只作用于我的消息", () => {
		expect(ruleOf("dialogue").scope).toBe("assistant");
		expect(ruleOf("speaker").scope).toBe("assistant");
		expect(ruleOf("command").scope).toBe("user");
		expect(ruleOf("tech").scope).toBe("all");
	});

	it("各分组在自己的场景里命中，且只高亮片段本身", () => {
		expect(hits(ruleOf("dialogue").regex, "他说：“走吧。”然后转身。")).toEqual(["“走吧。”"]);
		expect(hits(ruleOf("dialogue").regex, 'She said "go" quietly.')).toEqual(['"go"']);
		expect(hits(ruleOf("speaker").regex, "Kanan: hi")).toEqual(["Kanan:"]);
		expect(hits(ruleOf("speaker").regex, "他说：走吧")).toEqual(["他说："]);
		expect(hits(ruleOf("stage").regex, "她抬眼（不动声色）看他")).toEqual(["（不动声色）"]);
		expect(hits(ruleOf("headers").regex, "Subject: 周报")).toEqual(["Subject:"]);
		expect(hits(ruleOf("tech").regex, "见 issue #956 与 deadbeef1")).toEqual(["#956", "deadbeef1"]);
		expect(hits(ruleOf("tech").regex, "改 server/plugins.ts:12 即可")).toEqual(["server/plugins.ts:12"]);
		expect(hits(ruleOf("contact").regex, "发 a.b+c@example.co 或 https://ex.com/a?b=1")).toEqual([
			"a.b+c@example.co",
			"https://ex.com/a?b=1",
		]);
		expect(hits(ruleOf("date").regex, "2026-11-22 14:05 开会")).toEqual(["2026-11-22", "14:05"]);
		expect(hits(ruleOf("money").regex, "共 ¥1,299.00 与 99 元")).toEqual(["¥1,299.00", "99 元"]);
		expect(hits(ruleOf("command").regex, "/compact now")).toEqual(["/compact"]);
	});

	it("斜杠命令不误伤 URL，@提及不拆邮箱", () => {
		expect(hits(ruleOf("command").regex, "https://ex.com/a")).toEqual([]);
		const mention = ruleOf("mention", { ...defaults, mention: true });
		expect(hits(mention.regex, "好 @alice 看下")).toEqual(["@alice"]);
		expect(hits(mention.regex, "a.b@example.com")).toEqual([]);
	});

	it("颜色默认走主题令牌，主题切换自动跟随", () => {
		expect(ruleOf("dialogue").declarations).toBe("color:var(--accent);");
		expect(ruleOf("stage").declarations).toBe("color:var(--text-dim);");
		expect(ruleOf("money").declarations).toBe("color:var(--amber, var(--accent));");
		expect(ruleOf("speaker").declarations).toContain("font-weight:700;");
	});

	it("总开关一关，全部规则消失（不是逐条判断）", () => {
		expect(compile({ ...defaults, enabled: false }).rules).toEqual([]);
		const off = compile({ ...defaults, enabled: false });
		expect(off.diagnostics).toEqual([]);
	});

	it("自定义规则：留空静默不生效，填了才编译，非法正则只丢它自己", () => {
		const empty = compile({ ...defaults, custom: true, customPattern: "  " });
		expect(empty.diagnostics).toEqual([]);
		expect(empty.rules.some((r) => r.ruleId === "custom")).toBe(false);

		const filled = compile({ ...defaults, custom: true, customPattern: "订单号[:：]\\s*\\w+" });
		expect(filled.diagnostics).toEqual([]);
		expect(
			hits(
				ruleOf("custom", { ...defaults, custom: true, customPattern: "订单号[:：]\\s*\\w+" }).regex,
				"订单号：A1234",
			),
		).toEqual(["订单号：A1234"]);

		const broken = compile({ ...defaults, custom: true, customPattern: "([" });
		expect(broken.rules.some((r) => r.ruleId === "custom")).toBe(false);
		expect(broken.rules.length).toBe(9);
		expect(broken.diagnostics.join("\n")).toContain("正则非法");
	});

	it("每个被引用的设置键都真实存在，类型也对得上（防止改 manifest 后静默失效）", () => {
		const byKey = new Map(manifest.settings.map((f) => [f.key, f.type]));
		for (const spec of normalizeChatDecorations(manifest.chatDecorations)) {
			for (const key of [spec.enabledBy ?? []].flat()) expect(byKey.get(String(key))).toBe("boolean");
			for (const value of Object.values(spec.style ?? {})) {
				if (typeof value === "object" && value && "setting" in value) {
					expect(["text", "select", "number"]).toContain(byKey.get(value.setting));
				}
			}
			if (typeof spec.pattern === "object" && spec.pattern && "setting" in spec.pattern) {
				expect(["text", "select"]).toContain(byKey.get(spec.pattern.setting));
			}
		}
	});
});
