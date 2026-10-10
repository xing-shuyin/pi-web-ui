/**
 * preset-share 单测：交换格式的解析/净化、目录解析与缓存、网址收口（SSRF）、
 * 以及 port 编排（导出/导入/分享/目录）在假 port 上的行为。
 * 全程零网络、零磁盘（gh 与 fetch 都不真跑；createPresetIssue 只用不存在
 * 的 ghPath 验证失败回落路径）。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildImportPreview,
	buildShareDoc,
	catalogBaseUrl,
	clearPresetCatalogCache,
	createPresetIssueViaApi,
	DEFAULT_PRESET_REPO,
	diagnoseShareFailure,
	exportPresetVia,
	fetchPresetCatalog,
	importPresetFromUrlVia,
	importPresetVia,
	isBlockedHost,
	normalizeCatalogEntry,
	normalizeTags,
	parseCatalog,
	parseShareDoc,
	presetCatalogUrl,
	presetFileName,
	presetIssueBody,
	presetIssueTitle,
	presetIssueWebUrl,
	presetRepoUrl,
	presetShareRepo,
	presetShareToken,
	presetShortHash,
	presetSummary,
	PRESET_FIELD_KIND_NAMES,
	PRESET_FIELD_NAMES_SORTED,
	PRESET_JSON_MAX_BYTES,
	PRESET_SHARE_FORMAT,
	PRESET_SHARE_VERSION,
	pushPresetCatalogVia,
	sanitizePresetSettings,
	serializeShareDoc,
	sharePresetVia,
	slugifyPresetName,
	toSettingsPreset,
	validateFetchUrl,
	type PresetCatalogCache,
	type PresetSharePort,
	type TextFetcher,
} from "../../server/preset-share.js";
import type { ClientMessage, ServerMessage, UiPresetCatalogEntry } from "../../server/protocol.js";
import {
	formatPresetFieldValue,
	normalizePresetFieldSelection,
	presetFieldGroup,
	presetFieldHint,
	presetFieldLabel,
	PRESET_FIELD_GROUPS,
	PRESET_FIELD_META,
	PRESET_FIELD_NAMES,
	PRESET_GROUP_ORDER,
	type PresetFieldName,
} from "../../server/preset-fields.js";
import type { ClientSettings } from "../../server/client-state.js";

/**
 * 编译期守卫：`ClientSettings` 的每个字段都必须在 `preset-fields.ts` 里登记。
 * 两者对不上时 `Exclude<...>` 不是 `never`，`Assert<true>` 立刻报类型错误。
 */
type Assert<T extends true> = T;
export type PresetFieldsCoverClientSettings = Assert<
	Exclude<keyof ClientSettings, PresetFieldName> extends never ? true : false
>;

const SETTINGS = {
	promptMode: "append",
	customSystemPrompt: "be brief",
	promptTemplate: "",
	promptOverrides: {},
	disabledSkills: ["a"],
	disabledExtensions: [],
	disabledAgentTools: [],
	disabledPluginTools: [],
	terminalToolsEnabled: true,
	terminalBash: false,
	terminalBashIdleMs: 0,
	terminalBashMaxForegroundMs: 0,
	editSoftEnabled: false,
	retryMaxAttempts: 6,
	softCapTokens: 0,
	softCapByModel: {},
	reviewPrompt: "",
	reviewDisabledSkills: [],
	skillsFullText: [],
};

function shareText(): string {
	return serializeShareDoc(
		buildShareDoc("My preset", SETTINGS, {
			description: "d",
			author: "me",
			tags: ["x"],
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
	);
}

/** 一个记录所有 emit 的假 port（编排测试用）。 */
function makePort(over: Partial<PresetSharePort> = {}): {
	port: PresetSharePort;
	sent: ServerMessage[];
	saved: string[];
} {
	const sent: ServerMessage[] = [];
	const saved: string[] = [];
	const port: PresetSharePort = {
		lang: () => "en",
		appVersion: () => "9.9.9",
		presets: () => [],
		currentSettings: () => ({ ...SETTINGS }),
		upsertPreset: (p) => saved.push(p.name),
		applyPreset: async (name) => {
			saved.push(`apply:${name}`);
		},
		pushSettings: () => saved.push("push"),
		emit: (m) => sent.push(m),
		...over,
	};
	return { port, sent, saved };
}

describe("slug / hash / file name", () => {
	it("slug 与共享仓库脚本同源（非 ASCII 退化成 preset）", () => {
		expect(slugifyPresetName("My Preset!")).toBe("my-preset");
		expect(slugifyPresetName("  A__b  ")).toBe("a-b");
		expect(slugifyPresetName("极简回复")).toBe("preset");
		expect(slugifyPresetName("")).toBe("preset");
	});

	it("短哈希稳定且定长，文件名 = slug-短哈希.json", () => {
		expect(presetShortHash("abc")).toBe(presetShortHash("abc"));
		expect(presetShortHash("abc")).toHaveLength(7);
		expect(presetShortHash("abc")).not.toBe(presetShortHash("abd"));
		expect(presetFileName("My Preset!")).toMatch(/^my-preset-[0-9a-f]{7}\.json$/);
	});
});

describe("sanitizePresetSettings（白名单 + 类型 + 上限）", () => {
	it("只留白名单字段，未知字段记入 ignored", () => {
		const r = sanitizePresetSettings({ ...SETTINGS, evil: "x", promptMode2: 1 });
		expect(r.ignored).toEqual(["evil", "promptMode2"]);
		expect(r.rejected).toEqual([]);
		expect(r.fields).toEqual([...r.fields].sort());
		expect(r.fields).toContain("customSystemPrompt");
		expect(r.settings).not.toHaveProperty("evil");
	});

	it("类型不符的已知字段丢弃（不抛错），并记入 rejected", () => {
		const r = sanitizePresetSettings({
			promptMode: "nope",
			customSystemPrompt: 42,
			disabledSkills: "not-an-array",
			terminalBash: "yes",
			retryMaxAttempts: "6",
			softCapByModel: [],
		});
		expect(r.rejected).toEqual([
			"customSystemPrompt",
			"disabledSkills",
			"promptMode",
			"retryMaxAttempts",
			"softCapByModel",
			"terminalBash",
		]);
		expect(r.fields).toEqual([]);
	});

	it("列表去重去空白并有条数上限；负数/非有限数被拒", () => {
		const r = sanitizePresetSettings({
			disabledSkills: [" a ", "a", "", 5, "b"],
			terminalBashIdleMs: -1,
			softCapTokens: Number.NaN,
		});
		expect(r.settings["disabledSkills"]).toEqual(["a", "b"]);
		expect(r.rejected).toEqual(["softCapTokens", "terminalBashIdleMs"]);
	});

	it("超长文本字段被拒（防一条巨型 JSON 顶爆设置存储）", () => {
		const r = sanitizePresetSettings({ customSystemPrompt: "x".repeat(100_001) });
		expect(r.rejected).toEqual(["customSystemPrompt"]);
	});

	it("promptOverrides / softCapByModel 走各自归一化", () => {
		const r = sanitizePresetSettings({
			promptOverrides: { soul: "hi", bad: 5 },
			softCapByModel: { "gpt-x": 1000 },
		});
		expect(r.settings["promptOverrides"]).toEqual({ soul: "hi" });
		// softCapByModel 的值走 soft-cap 归一化（<=1000 视为 K tokens）。
		expect(r.settings["softCapByModel"]).toEqual({ "gpt-x": 1_000_000 });
	});

	it("toSettingsPreset 只带回文档里存在的字段（缺的由 applyPreset 回落当前值）", () => {
		const p = toSettingsPreset("n", { promptMode: "replace" });
		expect(p.name).toBe("n");
		expect(p.promptMode).toBe("replace");
		// 部分预设：未出现的字段不聪凭空补默认值（由应用侧保留当前值）。
		expect("customSystemPrompt" in p).toBe(false);
		expect("terminalToolsEnabled" in p).toBe(false);
	});

	it("全量白名单：工具文案 / 界面偏好 / 专用提示词都能进预设（含 null 语义）", () => {
		const r = sanitizePresetSettings({
			toolPromptOverrides: { bash: { description: "  custom  ", promptGuidelines: ["a", ""] } },
			toolLazyLoading: false,
			readDirEnabled: false,
			toolWatchdogTimeoutMs: 1234,
			questionnaireEnabled: false,
			goalModeEnabled: false,
			parallelReminderEnabled: false,
			visionBridgeModel: null,
			subagentDefaultModel: "openai/gpt-x",
			visionBridgePrompt: "see this",
			scmCommitMsgPromptMode: "replace",
			planModePrompt: "plan first",
			uiLayout: { hidden: ["host:brand"], sideDockFloat: true },
			quickPhrases: ["hi"],
			defaultAgentPreset: "standard",
		});
		expect(r.rejected).toEqual([]);
		expect(r.settings["toolPromptOverrides"]).toEqual({
			bash: { description: "custom", promptGuidelines: ["a"] },
		});
		expect(r.settings["toolLazyLoading"]).toBe(false);
		expect(r.settings["visionBridgeModel"]).toBeNull();
		expect(r.settings["uiLayout"]).toEqual({ hidden: ["host:brand"], sideDockFloat: true });
		expect(r.settings["scmCommitMsgPromptMode"]).toBe("replace");
	});

	it("新增字段的类型不符也一律 rejected", () => {
		const r = sanitizePresetSettings({
			toolPromptOverrides: "nope",
			toolLazyLoading: "yes",
			visionBridgeModel: 42,
			uiLayout: [],
			defaultAgentPreset: { a: 1 },
			toolWatchdogTimeoutMs: -5,
		});
		expect(r.rejected).toEqual([
			"defaultAgentPreset",
			"toolLazyLoading",
			"toolPromptOverrides",
			"toolWatchdogTimeoutMs",
			"uiLayout",
			"visionBridgeModel",
		]);
	});
});

describe("字段清单一致性（守卫）", () => {
	it("白名单种类与 preset-fields 的字段名完全一致", () => {
		expect([...PRESET_FIELD_KIND_NAMES].sort()).toEqual(PRESET_FIELD_NAMES_SORTED);
		expect(PRESET_FIELD_NAMES_SORTED).toEqual([...PRESET_FIELD_NAMES].sort());
	});

	it("每个字段都有分组，组内字段不重复", () => {
		const seen = new Set<string>();
		for (const g of PRESET_GROUP_ORDER) {
			for (const f of PRESET_FIELD_GROUPS[g]) {
				expect(seen.has(f), f).toBe(false);
				seen.add(f);
				expect(presetFieldGroup(f)).toBe(g);
			}
		}
		expect(seen.size).toBe(PRESET_FIELD_NAMES_SORTED.length);
	});

	it("normalizePresetFieldSelection：只留合法名、按固定顺序、非数组返回 undefined", () => {
		expect(normalizePresetFieldSelection(undefined)).toBeUndefined();
		expect(normalizePresetFieldSelection("x")).toBeUndefined();
		expect(normalizePresetFieldSelection(["toolLazyLoading", "nope", 5, "promptMode"])).toEqual([
			"promptMode",
			"toolLazyLoading",
		]);
		expect(normalizePresetFieldSelection([])).toEqual([]);
	});
});

describe("parseShareDoc（形状校验 + 净化）", () => {
	it("接受导出文档，并在 settings 里只留白名单字段", () => {
		const r = parseShareDoc(shareText());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.format).toBe(PRESET_SHARE_FORMAT);
		expect(r.doc.version).toBe(PRESET_SHARE_VERSION);
		expect(r.doc.name).toBe("My preset");
		expect(r.doc.tags).toEqual(["x"]);
		expect(r.sanitized.fields).toContain("customSystemPrompt");
	});

	it("能取出 issue 正文里的 ```json 代码块（前后有说明文字）", () => {
		const body = ["由 pi-web-ui 生成。", "", "```json", shareText(), "```", "", "(说明)"].join("\n");
		const r = parseShareDoc(body);
		expect(r.ok).toBe(true);
	});

	it("空内容 / 坏 JSON / 错 format / 错 version / 无名 / 无 settings 各有稳定 errorKey", () => {
		const cases: [string, string][] = [
			["", "presets.import.empty"],
			["{oops", "presets.import.parse"],
			[JSON.stringify({ format: "other", version: 1, name: "a", settings: SETTINGS }), "presets.import.format"],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 2, name: "a", settings: SETTINGS }),
				"presets.import.version",
			],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "  ", settings: SETTINGS }),
				"presets.import.name",
			],
			[JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "a", settings: [] }), "presets.import.settings"],
			[
				JSON.stringify({ format: PRESET_SHARE_FORMAT, version: 1, name: "a", settings: { nope: 1 } }),
				"presets.import.noFields",
			],
			["[1,2,3]", "presets.import.shape"],
		];
		for (const [input, key] of cases) {
			const r = parseShareDoc(input);
			expect(r.ok, input).toBe(false);
			if (!r.ok) expect(r.errorKey, input).toBe(key);
		}
	});

	it("单元素数组也接受（有人会把一个预设包成数组）", () => {
		const r = parseShareDoc(`[${shareText()}]`);
		expect(r.ok).toBe(true);
	});

	it("超大内容直接拒绝（字节上限）", () => {
		const big = JSON.stringify({
			format: PRESET_SHARE_FORMAT,
			version: 1,
			name: "a",
			settings: { customSystemPrompt: "x".repeat(PRESET_JSON_MAX_BYTES) },
		});
		const r = parseShareDoc(big);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errorKey).toBe("presets.import.tooLarge");
	});

	it("中文名归一化（压缩空白 + 截断 60 字）", () => {
		const doc = buildShareDoc("  a   b  ", SETTINGS);
		expect(doc.name).toBe("a b");
		const r = parseShareDoc(JSON.stringify({ ...doc, name: "字".repeat(80) }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.doc.name).toHaveLength(60);
	});

	it("标签归一化：去重、去空白、单条 24 字、最多 8 条", () => {
		expect(normalizeTags([" a ", "a", "b"])).toEqual(["a", "b"]);
		expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(8);
		expect(normalizeTags("nope")).toEqual([]);
		expect(normalizeTags(["x".repeat(50)])[0]).toHaveLength(24);
	});
});

describe("摘要（列表徽标）", () => {
	it("统计禁用技能/工具并标记模板与审查提示词", () => {
		const s = presetSummary({
			promptMode: "replace",
			disabledSkills: ["a"],
			reviewDisabledSkills: ["b"],
			disabledAgentTools: ["c"],
			promptTemplate: "{{soul}}",
			reviewPrompt: "check",
		});
		expect(s).toEqual({ promptMode: "replace", skills: 2, agentTools: 1, hasTemplate: true, hasReviewPrompt: true });
		expect(presetSummary({}).promptMode).toBe("append");
	});
});

describe("网址收口（SSRF）", () => {
	it("内网/回环/链路本地/元数据地址一律拦截", () => {
		for (const host of [
			"localhost",
			"127.0.0.1",
			"10.0.0.5",
			"192.168.1.2",
			"172.16.0.1",
			"172.31.255.255",
			"169.254.169.254",
			"0.0.0.0",
			"::1",
			"fd00::1",
			"foo.local",
			"x.internal",
			"",
		]) {
			expect(isBlockedHost(host), host).toBe(true);
		}
		expect(isBlockedHost("raw.githubusercontent.com")).toBe(false);
		expect(isBlockedHost("172.32.0.1")).toBe(false);
	});

	it("validateFetchUrl 只放行 http/https 且非内网", () => {
		expect(validateFetchUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("not a url")).toEqual({ ok: false, reason: "scheme" });
		expect(validateFetchUrl("http://127.0.0.1/x.json")).toEqual({ ok: false, reason: "host" });
		const ok = validateFetchUrl("https://raw.githubusercontent.com/o/r/main/presets/a.json");
		expect(ok.ok).toBe(true);
	});
});

describe("目录解析与缓存", () => {
	const base = "https://raw.githubusercontent.com/o/r/main";
	const rawIndex = JSON.stringify({
		version: 1,
		presets: [
			{
				id: "a-1",
				name: "A",
				description: "d",
				author: "me",
				tags: ["t"],
				file: "presets/a-1.json",
				issue: 12,
				updatedAt: "2026-02-01T00:00:00.000Z",
				summary: { promptMode: "replace", skills: 1, agentTools: 0, hasTemplate: true, hasReviewPrompt: false },
			},
			{ id: "b-2", name: "B", file: "presets/b-2.json", updatedAt: "2026-03-01T00:00:00.000Z" },
			// 坏条目：缺 file / 越界 file / 重复 id → 全部丢弃
			{ id: "c-3", name: "C" },
			{ id: "d-4", name: "D", file: "../../etc/passwd" },
			{ id: "d-4", name: "D2", file: "/abs.json" },
			{ id: "a-1", name: "A dup", file: "presets/a-1.json" },
		],
	});

	it("条目校验：相对路径、id 去重、最近更新在前，url 由 raw 基址拼出", () => {
		const r = parseCatalog(rawIndex, { base, repoUrl: "https://github.com/o/r" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.entries.map((e) => e.id)).toEqual(["b-2", "a-1"]);
		expect(r.entries[1]?.url).toBe(`${base}/presets/a-1.json`);
		expect(r.entries[1]?.issueUrl).toBe("https://github.com/o/r/issues/12");
		expect(r.entries[0]?.issueUrl).toBe("");
	});

	it("坏目录（非对象 / 缺 presets 数组 / 坏 JSON）报错而不是空列表", () => {
		for (const text of ["[]", "{}", "{oops", JSON.stringify({ presets: {} })]) {
			const r = parseCatalog(text, { base });
			expect(r.ok, text).toBe(false);
		}
	});

	it("catalogBaseUrl 去掉最后一段（index.json → 目录）", () => {
		expect(catalogBaseUrl("https://x/y/main/index.json")).toBe("https://x/y/main");
		expect(catalogBaseUrl("https://x/y/main/catalog.json")).toBe("https://x/y/main");
	});

	it("normalizeCatalogEntry 对非对象/缺字段返回 null", () => {
		expect(normalizeCatalogEntry(null, base, "")).toBeNull();
		expect(normalizeCatalogEntry({ name: "x", file: "presets/x.json" }, base, "")).toBeNull();
	});

	it("fetchPresetCatalog：成功写缓存，TTL 内不再抓，refresh 强制重抓，失败保留上次列表", async () => {
		clearPresetCatalogCache();
		const url = "https://example.com/main/index.json";
		let calls = 0;
		let fail = false;
		const fetcher: TextFetcher = async () => {
			calls++;
			if (fail) return { ok: false, status: 500, text: async () => "" };
			return { ok: true, status: 200, text: async () => rawIndex };
		};
		const cache: PresetCatalogCache = (() => {
			let store: { entries: UiPresetCatalogEntry[]; fetchedAt: number } | undefined;
			return {
				get: () => store,
				set: (_u, v) => {
					store = v;
				},
				clear: () => {
					store = undefined;
				},
			};
		})();
		const first = await fetchPresetCatalog({ url, fetcher, cache });
		expect(first.ok).toBe(true);
		expect(first.cached).toBe(false);
		expect(calls).toBe(1);
		const second = await fetchPresetCatalog({ url, fetcher, cache });
		expect(second.cached).toBe(true);
		expect(calls).toBe(1);
		await fetchPresetCatalog({ url, fetcher, cache, refresh: true });
		expect(calls).toBe(2);
		fail = true;
		const failed = await fetchPresetCatalog({ url, fetcher, cache, refresh: true });
		expect(failed.ok).toBe(false);
		expect(failed.cached).toBe(true);
		expect(failed.entries.length).toBe(2);
		expect(failed.errorKey).toBe("presets.catalog.failed");
	});

	it("目录被关掉（无 url）时返回明确的错误", async () => {
		const r = await fetchPresetCatalog({ url: "" });
		expect(r.ok).toBe(false);
		expect(r.errorKey).toBe("presets.catalog.disabled");
	});

	it("内网目录地址被拦下（不抓取）", async () => {
		let called = false;
		const fetcher: TextFetcher = async () => {
			called = true;
			return { ok: true, status: 200, text: async () => rawIndex };
		};
		const r = await fetchPresetCatalog({ url: "http://127.0.0.1/index.json", fetcher, refresh: true });
		expect(r.ok).toBe(false);
		expect(called).toBe(false);
	});
});

describe("env 读取", () => {
	it("默认仓库与目录地址；off/空串可关掉", () => {
		const saved = { repo: process.env["PI_WEB_PRESET_REPO"], url: process.env["PI_WEB_PRESET_CATALOG_URL"] };
		try {
			delete process.env["PI_WEB_PRESET_REPO"];
			delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			expect(presetShareRepo()).toBe(DEFAULT_PRESET_REPO);
			expect(presetCatalogUrl()).toBe(`https://raw.githubusercontent.com/${DEFAULT_PRESET_REPO}/main/index.json`);
			expect(presetRepoUrl()).toBe(`https://github.com/${DEFAULT_PRESET_REPO}`);

			process.env["PI_WEB_PRESET_REPO"] = "https://github.com/me/my-presets.git";
			expect(presetShareRepo()).toBe("me/my-presets");
			expect(presetCatalogUrl()).toBe("https://raw.githubusercontent.com/me/my-presets/main/index.json");

			process.env["PI_WEB_PRESET_CATALOG_URL"] = "https://example.com/c.json";
			expect(presetCatalogUrl()).toBe("https://example.com/c.json");
			process.env["PI_WEB_PRESET_CATALOG_URL"] = "off";
			expect(presetCatalogUrl()).toBe("");
			process.env["PI_WEB_PRESET_REPO"] = "0";
			expect(presetShareRepo()).toBe("");
			expect(presetCatalogUrl()).toBe("");
		} finally {
			if (saved.repo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = saved.repo;
			if (saved.url === undefined) delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			else process.env["PI_WEB_PRESET_CATALOG_URL"] = saved.url;
		}
	});
});

describe("issue 文本", () => {
	it("标题前缀是仓库 Action 的触发条件", () => {
		expect(presetIssueTitle("My preset")).toBe("[preset] My preset");
	});

	it("正文含 ```json 代码块（Action 只取第一个代码块）", () => {
		const doc = buildShareDoc("A", SETTINGS);
		const body = presetIssueBody(doc, "https://github.com/o/r");
		expect(body).toContain("```json");
		const parsed = parseShareDoc(body);
		expect(parsed.ok).toBe(true);
	});

	it("网页回落：正文能塞进 URL 时预填正文（不带 template，点一下 Submit 就行）", () => {
		const small = presetIssueWebUrl("o/r", "A", "body");
		expect(small).toContain("body=body");
		// 带 template 时 GitHub 会忽略 body，所以两者不能同时给。
		expect(small).not.toContain("template=");
		expect(decodeURIComponent(small.replace(/\+/g, " "))).toContain("[preset] A");
	});

	it("网页回落：正文太长时退回模板页（只预填标题）", () => {
		const big = presetIssueWebUrl("o/r", "A", "x".repeat(9000));
		expect(big).not.toContain("body=");
		expect(big).toContain("template=share-preset.yml");
		expect(decodeURIComponent(big.replace(/\+/g, " "))).toContain("[preset] A");
	});

	it("网页回落：长度按**编码后**算（中文正文膨胀 9 倍也不能超限）", () => {
		const zh = presetIssueWebUrl("o/r", "中文名", "字".repeat(2000));
		expect(zh.length).toBeLessThanOrEqual(7_000 + 200);
		expect(zh).toContain("template=share-preset.yml");
	});
});

describe("分享令牌（无 gh 的直连 API 路径）", () => {
	const saved = {
		token: process.env["PI_WEB_PRESET_TOKEN"],
		gh: process.env["GH_TOKEN"],
		gha: process.env["GITHUB_TOKEN"],
	};
	const restore = () => {
		for (const [k, v] of [
			["PI_WEB_PRESET_TOKEN", saved.token],
			["GH_TOKEN", saved.gh],
			["GITHUB_TOKEN", saved.gha],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};

	it("令牌优先级：PI_WEB_PRESET_TOKEN > GH_TOKEN > GITHUB_TOKEN", () => {
		try {
			delete process.env["PI_WEB_PRESET_TOKEN"];
			delete process.env["GH_TOKEN"];
			delete process.env["GITHUB_TOKEN"];
			expect(presetShareToken()).toBe("");
			process.env["GITHUB_TOKEN"] = "g";
			expect(presetShareToken()).toBe("g");
			process.env["GH_TOKEN"] = "h";
			expect(presetShareToken()).toBe("h");
			process.env["PI_WEB_PRESET_TOKEN"] = "p";
			expect(presetShareToken()).toBe("p");
		} finally {
			restore();
		}
	});

	it("API 成功：POST 到 /repos/<repo>/issues，用 html_url 作为回执", async () => {
		const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
		const fetcher: TextFetcher = async (url, init) => {
			calls.push({ url, init });
			return {
				ok: true,
				status: 201,
				text: async () => JSON.stringify({ html_url: "https://github.com/o/r/issues/7" }),
			};
		};
		const r = await createPresetIssueViaApi({ repo: "o/r", name: "A", body: "b", token: "tok", fetcher });
		expect(r).toEqual({ ok: true, url: "https://github.com/o/r/issues/7" });
		expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/issues");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers?.["authorization"]).toBe("Bearer tok");
		expect(JSON.parse(String(calls[0]?.init?.body)).title).toBe("[preset] A");
	});

	it("API 失败：带上状态码与 GitHub 的 message", async () => {
		const fetcher: TextFetcher = async () => ({
			ok: false,
			status: 403,
			text: async () => JSON.stringify({ message: "Resource not accessible by integration" }),
		});
		const r = await createPresetIssueViaApi({ repo: "o/r", name: "A", body: "b", token: "bad", fetcher });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("403");
			expect(r.error).toContain("Resource not accessible");
			expect(r.errorKey).toBe("presets.share.apiFailed");
		}
	});

	it("API 异常（网络抛错）也返回 ok:false，不抛", async () => {
		const fetcher: TextFetcher = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const r = await createPresetIssueViaApi({ repo: "o/r", name: "A", body: "b", token: "t", fetcher });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("ECONNREFUSED");
	});

	it("API 回执缺 html_url 也算失败", async () => {
		const fetcher: TextFetcher = async () => ({ ok: true, status: 201, text: async () => "{}" });
		const r = await createPresetIssueViaApi({ repo: "o/r", name: "A", body: "b", token: "t", fetcher });
		expect(r.ok).toBe(false);
	});

	it("分享顺序：gh 不可用但有令牌 → method=api；两者都没有 → method=browser", async () => {
		const savedRepo = process.env["PI_WEB_PRESET_REPO"];
		const savedGh = process.env["PI_WEB_PRESET_GH"];
		process.env["PI_WEB_PRESET_REPO"] = "o/r";
		process.env["PI_WEB_PRESET_GH"] = join(tmpdir(), "pi-web-ui-no-such-gh-binary");
		try {
			vi.stubGlobal(
				"fetch",
				async () => new Response(JSON.stringify({ html_url: "https://github.com/o/r/issues/9" }), { status: 201 }),
			);
			process.env["PI_WEB_PRESET_TOKEN"] = "tok";
			const a = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(a.port, { type: "preset_share", name: "P" });
			const apiMsg = a.sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(apiMsg.ok).toBe(true);
			expect(apiMsg.method).toBe("api");
			expect(apiMsg.url).toContain("/issues/9");

			delete process.env["PI_WEB_PRESET_TOKEN"];
			const b = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(b.port, { type: "preset_share", name: "P" });
			const webMsg = b.sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(webMsg.ok).toBe(false);
			expect(webMsg.method).toBe("browser");
			expect(webMsg.url).toContain("github.com/o/r/issues/new");
		} finally {
			vi.unstubAllGlobals();
			delete process.env["PI_WEB_PRESET_TOKEN"];
			if (savedRepo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = savedRepo;
			if (savedGh === undefined) delete process.env["PI_WEB_PRESET_GH"];
			else process.env["PI_WEB_PRESET_GH"] = savedGh;
		}
	});
});

describe("编排：导出", () => {
	it("导出预设：回执带 json / fileName / name", () => {
		const { port, sent } = makePort({
			presets: () => [{ ...SETTINGS, name: "P" } as never],
		});
		exportPresetVia(port, { type: "preset_export", name: "P", requestId: "export:1" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.type).toBe("preset_export_result");
		expect(msg.ok).toBe(true);
		expect(msg.name).toBe("P");
		expect(msg.requestId).toBe("export:1");
		expect(msg.fileName).toMatch(/^p-[0-9a-f]{7}\.json$/);
		const doc = JSON.parse(String(msg.json));
		expect(doc.format).toBe(PRESET_SHARE_FORMAT);
		expect(doc.appVersion).toBe("9.9.9");
		expect(doc.settings).not.toHaveProperty("name");
		expect(doc.settings.customSystemPrompt).toBe("be brief");
	});

	it("导出当前设置：用 currentSettings 快照 + 兜底名", () => {
		const { port, sent } = makePort();
		exportPresetVia(port, { type: "preset_export", source: "current", requestId: "e" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.name).toBe("Current settings");
	});

	it("预设不存在：ok:false 且带 error（不抛）", () => {
		const { port, sent } = makePort();
		exportPresetVia(port, { type: "preset_export", name: "ghost" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_export_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("ghost");
	});
});

describe("编排：导入", () => {
	it("dryRun 只回预览，不落盘", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: shareText(), dryRun: true, requestId: "paste:1" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.dryRun).toBe(true);
		expect(msg.preview?.name).toBe("My preset");
		expect(msg.preview?.replaces).toBe(false);
		expect(saved).toEqual([]);
	});

	it("确认导入：落盘 + 推送 + notice；apply=true 时顺带应用", async () => {
		const { port, sent, saved } = makePort({ presets: () => [{ ...SETTINGS, name: "My preset" } as never] });
		await importPresetVia(port, { type: "preset_import", json: shareText(), apply: true, requestId: "paste:2" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.dryRun).toBe(false);
		expect(msg.preview?.replaces).toBe(true);
		expect(saved).toEqual(["My preset", "push", "apply:My preset"]);
		const notice = sent[1] as Extract<ServerMessage, { type: "notice" }>;
		expect(notice.type).toBe("notice");
		expect(notice.textEn).toContain("My preset");
	});

	it("导入可改名（name 覆盖文档里的名字）", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: shareText(), name: "Renamed" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.preview?.name).toBe("Renamed");
		expect(saved).toEqual(["Renamed", "push"]);
	});

	it("可选导入：只写勾选的字段（未勾选的不进落盘预设）", async () => {
		const stored: Record<string, unknown>[] = [];
		const { port, sent } = makePort({
			upsertPreset: (p) => stored.push(p as unknown as Record<string, unknown>),
		});
		await importPresetVia(port, {
			type: "preset_import",
			json: shareText(),
			fields: ["customSystemPrompt", "nope"],
		});
		expect(stored).toHaveLength(1);
		expect(stored[0].customSystemPrompt).toBe("be brief");
		expect("disabledSkills" in stored[0]).toBe(false);
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.dryRun).toBe(false);
		// 回执里的 fields = **实际写入**的子集（不是文档全部）。
		expect(msg.preview?.fields).toEqual(["customSystemPrompt"]);
	});

	it("可选导入：一个字段都没勾 → ok:false 且不落盘", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: shareText(), fields: [] });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.dryRun).toBe(false);
		expect(saved).toEqual([]);
	});

	it("解析失败：ok:false + 错误文案，不落盘", async () => {
		const { port, sent, saved } = makePort();
		await importPresetVia(port, { type: "preset_import", json: "{oops", requestId: "paste:3" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.requestId).toBe("paste:3");
		expect(saved).toEqual([]);
	});

	it("网址导入：抓取成功走同一套预览/落盘", async () => {
		const { port, sent, saved } = makePort();
		vi.stubGlobal("fetch", async () => new Response(shareText(), { status: 200 }));
		try {
			await importPresetFromUrlVia(port, {
				type: "preset_import_url",
				url: "https://example.com/p.json",
				dryRun: true,
				requestId: "url:1",
			});
		} finally {
			vi.unstubAllGlobals();
		}
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(true);
		expect(msg.preview?.name).toBe("My preset");
		expect(saved).toEqual([]);
	});

	it("网址导入：内网地址直接拒（不抓取）", async () => {
		const { port, sent } = makePort();
		await importPresetFromUrlVia(port, { type: "preset_import_url", url: "http://127.0.0.1/p.json" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("private hosts");
	});

	it("网址导入：非 http(s) 拒绝", async () => {
		const { port, sent } = makePort();
		await importPresetFromUrlVia(port, { type: "preset_import_url", url: "file:///tmp/p.json" });
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("http://");
	});

	it("网址导入：抓取失败（HTTP 500）回执带错误", async () => {
		const { port, sent } = makePort();
		vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
		try {
			await importPresetFromUrlVia(port, { type: "preset_import_url", url: "https://example.com/p.json" });
		} finally {
			vi.unstubAllGlobals();
		}
		const msg = sent[0] as Extract<ServerMessage, { type: "preset_import_result" }>;
		expect(msg.ok).toBe(false);
		expect(msg.error).toContain("500");
	});
});

describe("编排：分享与目录", () => {
	it("分享关闭（PI_WEB_PRESET_REPO=0）时明确回执", async () => {
		const saved = process.env["PI_WEB_PRESET_REPO"];
		process.env["PI_WEB_PRESET_REPO"] = "0";
		try {
			const { port, sent } = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(port, { type: "preset_share", name: "P" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(msg.ok).toBe(false);
			expect(msg.error).toContain("PI_WEB_PRESET_REPO");
			expect(msg.json).toBeTruthy();
		} finally {
			if (saved === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = saved;
		}
	});

	it("gh 不可用（PI_WEB_PRESET_GH 指向不存在的文件）时回落浏览器路径：method=browser + url + json", async () => {
		const savedRepo = process.env["PI_WEB_PRESET_REPO"];
		const savedGh = process.env["PI_WEB_PRESET_GH"];
		process.env["PI_WEB_PRESET_REPO"] = "o/r";
		process.env["PI_WEB_PRESET_GH"] = join(tmpdir(), "pi-web-ui-no-such-gh-binary");
		try {
			const { port, sent } = makePort({ presets: () => [{ ...SETTINGS, name: "P" } as never] });
			await sharePresetVia(port, { type: "preset_share", name: "P" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_share_result" }>;
			expect(msg.ok).toBe(false);
			expect(msg.method).toBe("browser");
			expect(msg.url).toContain("github.com/o/r/issues/new");
			expect(msg.json).toBeTruthy();
			expect(msg.name).toBe("P");
			expect(msg.error).toContain("GitHub CLI");
		} finally {
			if (savedRepo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = savedRepo;
			if (savedGh === undefined) delete process.env["PI_WEB_PRESET_GH"];
			else process.env["PI_WEB_PRESET_GH"] = savedGh;
		}
	});

	it("diagnoseShareFailure：缺少 gh 时提供安装与配置指引", () => {
		const zh = diagnoseShareFailure({
			ghError: "spawn gh ENOENT",
			ghErrorKey: "presets.share.ghMissing",
			lang: "zh",
		});
		expect(zh).toContain("未检测到 GitHub CLI (gh)");
		expect(zh).toContain("winget install --id GitHub.cli");
		expect(zh).toContain("PI_WEB_PRESET_TOKEN");

		const en = diagnoseShareFailure({
			ghError: "spawn gh ENOENT",
			ghErrorKey: "presets.share.ghMissing",
			lang: "en",
		});
		expect(en).toContain("GitHub CLI (gh) not found");
		expect(en).toContain("winget install --id GitHub.cli");
	});

	it("diagnoseShareFailure：gh 未登录时提供 gh auth login 指引", () => {
		const zh = diagnoseShareFailure({
			ghError: "To get started with GitHub CLI, please run: gh auth login",
			ghErrorKey: "presets.share.ghFailed",
			lang: "zh",
		});
		expect(zh).toContain("gh auth login");
		expect(zh).toContain("尚未登录");

		const en = diagnoseShareFailure({
			ghError: "authentication required",
			ghErrorKey: "presets.share.ghFailed",
			lang: "en",
		});
		expect(en).toContain("gh auth login");
		expect(en).toContain("not logged in");
	});

	it("diagnoseShareFailure：Token API 鉴权失败时给出友好提示", () => {
		const invalid = diagnoseShareFailure({
			apiError: "HTTP 401: Bad credentials",
			hasToken: true,
			lang: "zh",
		});
		expect(invalid).toContain("令牌无效或已过期");

		const perm = diagnoseShareFailure({
			apiError: "HTTP 403: Resource not accessible by personal access token",
			hasToken: true,
			lang: "en",
		});
		expect(perm).toContain("issues: write required");
	});

	it("PRESET_FIELD_META：51 个预设字段全部具有人类可读的中英文名称与说明", () => {
		expect(PRESET_FIELD_NAMES.length).toBe(51);
		for (const name of PRESET_FIELD_NAMES) {
			const meta = PRESET_FIELD_META[name];
			expect(meta, `meta for ${name}`).toBeDefined();
			expect(meta.labelZh.trim().length, `labelZh for ${name}`).toBeGreaterThan(0);
			expect(meta.labelEn.trim().length, `labelEn for ${name}`).toBeGreaterThan(0);
			expect(presetFieldLabel(name, "zh")).toBe(meta.labelZh);
			expect(presetFieldLabel(name, "en")).toBe(meta.labelEn);
		}
		expect(presetFieldLabel("unknownField" as never, "zh")).toBe("unknownField");
	});

	it("formatPresetFieldValue：工具类字段可清晰区分全开启与具体禁用明细", () => {
		// 全开启
		const allEnabledZh = formatPresetFieldValue("disabledAgentTools", [], "zh");
		expect(allEnabledZh.summary).toContain("全部启用");
		expect(allEnabledZh.detail).toContain("已启用可用工具");

		const allEnabledEn = formatPresetFieldValue("disabledAgentTools", [], "en");
		expect(allEnabledEn.summary).toContain("All enabled");

		// 部分禁用
		const disabledZh = formatPresetFieldValue("disabledAgentTools", ["bash", "write"], "zh");
		expect(disabledZh.summary).toContain("禁用 2 个");
		expect(disabledZh.summary).toContain("默认没开即关");
		expect(disabledZh.detail).toContain("已启用可用配置");
		expect(disabledZh.detail).toContain("bash");
		expect(disabledZh.detail).toContain("write");
	});

	it("formatPresetFieldValue：工具提示词覆盖可清晰列出覆盖的工具与具体修改内容", () => {
		const overridesZh = formatPresetFieldValue(
			"toolPromptOverrides",
			{
				bash: {
					description: "安全执行 bash 命令",
					promptGuidelines: ["严禁前台长期运行", "优先使用 head/tail 参数"],
				},
				edit: {
					description: "精准修改代码文件",
				},
			},
			"zh",
		);
		expect(overridesZh.summary).toContain("覆盖了 2 个工具的提示词");
		expect(overridesZh.summary).toContain("bash, edit");
		expect(overridesZh.detail).toContain("[bash]");
		expect(overridesZh.detail).toContain("安全执行 bash 命令");
		expect(overridesZh.detail).toContain("严禁前台长期运行");
		expect(overridesZh.detail).toContain("[edit]");
	});

	it("formatPresetFieldValue：提示词与模式类字段有清晰字符统计与文本详情", () => {
		const promptZh = formatPresetFieldValue("customSystemPrompt", "你是一个资深架构师，请给出严谨的代码方案。", "zh");
		expect(promptZh.summary).toContain("包含 21 字符");
		expect(promptZh.detail).toBe("你是一个资深架构师，请给出严谨的代码方案。");

		const modeAppend = formatPresetFieldValue("promptMode", "append", "zh");
		expect(modeAppend.summary).toContain("追加到系统提示词后");

		const modeReplace = formatPresetFieldValue("promptMode", "replace", "zh");
		expect(modeReplace.summary).toContain("替换内置系统提示词");
	});

	it("formatPresetFieldValue：开关与数值字段具备易读性", () => {
		expect(formatPresetFieldValue("terminalBash", true, "zh").summary).toContain("开启");
		expect(formatPresetFieldValue("terminalBash", false, "zh").summary).toContain("关闭");
		expect(formatPresetFieldValue("toolLazyLoading", true, "zh").summary).toContain("仅核心工具常驻");
		expect(formatPresetFieldValue("retryMaxAttempts", 6, "zh").summary).toBe("最大重试 6 次");
		expect(formatPresetFieldValue("softCapTokens", 50000, "zh").summary).toBe("50000 tokens");
	});

	it("默认没有开的工具就是关：声明 enabledTools 时未在名单中的工具自动收敛为禁用", () => {
		const res = sanitizePresetSettings(
			{
				disabledAgentTools: [],
			},
			{ enabledTools: ["bash", "read", "edit", "write"] },
		);
		const disabled = res.settings["disabledAgentTools"] as string[];
		expect(disabled).toBeDefined();
		// 四个明确开启的核心工具不应该在 disabled 列表中
		expect(disabled).not.toContain("bash");
		expect(disabled).not.toContain("read");
		expect(disabled).not.toContain("edit");
		expect(disabled).not.toContain("write");
		// 其余所有已知工具均应被自动归入 disabled（默认没开即关）
		expect(disabled).toContain("terminal_create");
		expect(disabled).toContain("eval");
		expect(disabled).toContain("patch");
		expect(disabled).toContain("lsp");
	});

	it("只取可用的配置：未知/不可用工具自动清洗并记录进 ignored，防后期漂移", () => {
		const res = sanitizePresetSettings({
			disabledAgentTools: ["bash", "unknown_legacy_tool_xyz"],
			toolPromptOverrides: {
				bash: { description: "安全执行 bash" },
				nonexistent_tool_abc: { description: "给不存在的工具配置提示词" },
			},
		});
		const disabled = res.settings["disabledAgentTools"] as string[];
		expect(disabled).toContain("bash");
		expect(disabled).not.toContain("unknown_legacy_tool_xyz");
		expect(res.ignored).toContain("disabledAgentTools.unknown_legacy_tool_xyz");

		const overrides = res.settings["toolPromptOverrides"] as Record<string, unknown>;
		expect(overrides["bash"]).toBeDefined();
		expect(overrides["nonexistent_tool_abc"]).toBeUndefined();
		expect(res.ignored).toContain("toolPromptOverrides.nonexistent_tool_abc");
	});

	it("buildShareDoc：导出的交换文档自动计算并携带 enabledTools 明确白名单", () => {
		const doc = buildShareDoc("Strict Preset", {
			disabledAgentTools: ["terminal_create", "eval"],
		});
		expect(doc.enabledTools).toBeDefined();
		expect(doc.enabledTools).toContain("bash");
		expect(doc.enabledTools).toContain("read");
		expect(doc.enabledTools).not.toContain("terminal_create");
		expect(doc.enabledTools).not.toContain("eval");
	});

	it("buildImportPreview：生成的预览对象携带 settings 供前端展示明细", () => {
		const preview = buildImportPreview(
			"Test",
			{
				format: PRESET_SHARE_FORMAT,
				version: PRESET_SHARE_VERSION,
				name: "Test",
				description: "desc",
				author: "author",
				tags: [],
				createdAt: "",
				appVersion: "",
				settings: { customSystemPrompt: "test prompt", disabledAgentTools: ["bash"] },
			},
			{
				settings: { customSystemPrompt: "test prompt", disabledAgentTools: ["bash"] },
				fields: ["customSystemPrompt", "disabledAgentTools"],
				ignored: [],
				rejected: [],
			},
			false,
		);
		expect(preview.settings).toBeDefined();
		expect(preview.settings?.["customSystemPrompt"]).toBe("test prompt");
		expect(preview.settings?.["disabledAgentTools"]).toEqual(["bash"]);
	});

	it("全面测试预设：3 套实战预设（全栈开发 / 学术写作 / 架构审查）均能 100% 成功解析且 UI 布局完整", () => {
		const presetFiles = ["fullstack-hacker.json", "academic-writer.json", "architect-reviewer.json"];
		for (const file of presetFiles) {
			const jsonText = readFileSync(join(__dirname, "..", "..", "docs", "examples", "presets", file), "utf8");
			const parsed = parseShareDoc(jsonText, "zh");
			expect(parsed.ok, `parse ${file}`).toBe(true);
			if (!parsed.ok) continue;

			// 验证元数据
			expect(parsed.doc.format).toBe(PRESET_SHARE_FORMAT);
			expect(parsed.doc.version).toBe(PRESET_SHARE_VERSION);
			expect(parsed.doc.name.length).toBeGreaterThan(0);
			expect(parsed.doc.tags.length).toBeGreaterThan(0);

			// 验证 UI 布局与偏好完整保留
			const s = parsed.doc.settings;
			expect(s["uiLayout"]).toBeDefined();
			expect(typeof s["uiLayout"]).toBe("object");
			expect(s["quickPhrases"]).toBeDefined();
			expect(Array.isArray(s["quickPhrases"])).toBe(true);
			expect((s["quickPhrases"] as unknown[]).length).toBeGreaterThan(0);
			expect(typeof s["thinkingWrap"]).toBe("boolean");
			expect(typeof s["toolsWrap"]).toBe("boolean");

			// 验证白名单收敛：无未知非法字段
			expect(parsed.sanitized.rejected.length, `rejected for ${file}`).toBe(0);
			expect(parsed.sanitized.fields.length, `fields for ${file}`).toBeGreaterThan(15);
		}
	});

	it("目录：抓取成功回执带 entries 与来源；关闭时 ok:false", async () => {
		const savedUrl = process.env["PI_WEB_PRESET_CATALOG_URL"];
		const savedRepo = process.env["PI_WEB_PRESET_REPO"];
		delete process.env["PI_WEB_PRESET_REPO"];
		process.env["PI_WEB_PRESET_CATALOG_URL"] = "https://example.com/main/index.json";
		clearPresetCatalogCache();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ version: 1, presets: [{ id: "a", name: "A", file: "presets/a.json" }] }), {
					status: 200,
				}),
		);
		try {
			const { port, sent } = makePort();
			await pushPresetCatalogVia(port, { type: "preset_catalog", requestId: "catalog:1" });
			const msg = sent[0] as Extract<ServerMessage, { type: "preset_catalog_result" }>;
			expect(msg.ok).toBe(true);
			expect(msg.entries).toHaveLength(1);
			expect(msg.entries[0]?.url).toBe("https://example.com/main/presets/a.json");
			expect(msg.source).toBe("https://example.com/main/index.json");
			expect(msg.requestId).toBe("catalog:1");
		} finally {
			vi.unstubAllGlobals();
			if (savedUrl === undefined) delete process.env["PI_WEB_PRESET_CATALOG_URL"];
			else process.env["PI_WEB_PRESET_CATALOG_URL"] = savedUrl;
			if (savedRepo === undefined) delete process.env["PI_WEB_PRESET_REPO"];
			else process.env["PI_WEB_PRESET_REPO"] = savedRepo;
			clearPresetCatalogCache();
		}
	});
});

describe("buildImportPreview", () => {
	it("截断长文本、带上 fields/ignored/rejected 与 replaces", () => {
		const doc = buildShareDoc("A", { customSystemPrompt: "y".repeat(1000), nope: 1 });
		const sanitized = sanitizePresetSettings(doc.settings);
		const preview = buildImportPreview("A", doc, sanitized, true);
		expect(preview.replaces).toBe(true);
		expect(preview.customSystemPrompt).toHaveLength(400);
		expect(preview.ignored).toEqual(["nope"]);
		expect(preview.fields).toEqual(sanitized.fields);
	});
});

describe("协议消息形状（前端依赖）", () => {
	it("ClientMessage 的预设分享消息可被 Extract 出来（类型级守卫）", () => {
		const msgs: ClientMessage[] = [
			{ type: "preset_export", name: "P" },
			{ type: "preset_import", json: "{}" },
			{ type: "preset_import_url", url: "https://x/y.json" },
			{ type: "preset_catalog", refresh: true },
			{ type: "preset_share", name: "P" },
		];
		expect(msgs.map((m) => m.type)).toEqual([
			"preset_export",
			"preset_import",
			"preset_import_url",
			"preset_catalog",
			"preset_share",
		]);
	});
});
