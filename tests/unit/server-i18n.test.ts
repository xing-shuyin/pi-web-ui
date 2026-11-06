import { describe, expect, it } from "vitest";
import {
	bilingual,
	extractServerStrings,
	getServerBlock,
	getServerString,
	isTraditionalLocale,
	isZh,
	pick,
	registerServerStrings,
	registeredServerLangs,
	resolveServerLang,
	unregisterServerStrings,
} from "../../server/i18n.js";

describe("Russian server pack (PR #846)", () => {
	it("renders runtime values and preserves actionable subagent guidance", async () => {
		const fs = await import("node:fs");
		const pack = JSON.parse(fs.readFileSync(new URL("../../locales/ru.json", import.meta.url), "utf8"));
		const extracted = extractServerStrings(pack);
		expect(extracted).not.toBeNull();
		if (!extracted) throw new Error("Russian server strings are missing");
		registerServerStrings("ru", extracted.table);
		try {
			const cases: [string, Record<string, unknown>, string[]][] = [
				[
					"worktree.create.success",
					{ path: "wt/task", branch: "feat/task", switched: ", switched" },
					["wt/task", "feat/task"],
				],
				[
					"mcp_manage.install.ok",
					{ name: "my-mcp", scope: "project", status: "running", toolHint: " tools: 3" },
					["my-mcp", "project", "running", "tools: 3"],
				],
				["plugincatalog.sync.http", { status: "503" }, ["503"]],
				[
					"plugins.manifest.invalid",
					{ name: "broken-plugin", path: "version", message: "must be a string" },
					["broken-plugin", "must be a string"],
				],
				[
					"subagents.get.done",
					{
						doneId: "c1",
						"r.type": "explore",
						modelTag: "",
						verdict: "done",
						doneDetail: "finished",
						doneOutput: "answer\nworktree: wt/task",
					},
					["answer", "wt/task"],
				],
			];
			for (const [key, vars, values] of cases) {
				const result = pick("ru", "", "", key, vars);
				for (const value of values) expect(result, key).toContain(value);
				expect(result, key).not.toMatch(/\{[\w.]+\}/);
			}
			const delegated = pick("ru", "", "", "delegate.started", {
				convId: "c1",
				agent: "explore",
				title: "Review",
				modelLineEn: "",
				toolsLineEn: "\nTools: read",
				securityLineEn: "\nSecurity: readonly",
			});
			expect(delegated).toContain('subagent(action="wait_all")');
			expect(delegated).toContain('subagent(action="steer")');
			const spawned = pick("ru", "", "", "subagents.spawn.started", {
				kindLabelEn: "Subagent",
				convId: "c1",
				subagentType: "explore",
				subagentTitleText: "Review",
				templateLineEn: "",
				modelLineEn: "",
				thinkingLineEn: "",
				notifyLineEn: "",
				isolationLineEn: "",
				addressLine: "\naddress: exec-test",
			});
			expect(spawned).toContain('subagent(action="wait_all")');
			expect(spawned).toContain("exec-test");
			expect(spawned).not.toMatch(/\{[\w.]+\}/);
			const limit = pick("ru", "", "", "agent.subagent.limit.reached", { limit: 3 });
			expect(limit).toContain('subagent(action="wait_all")');
			expect(limit).toContain('subagent(action="stop")');
			const wait = pick("ru", "", "", "terminals.wait.no.pending", { "p.terminalId": "term-test" });
			expect(wait).toContain("terminal(action='read', terminalId=\"term-test\"");
			expect(pick("ru", "", "", "subagents.notify.footer")).toMatch(/^\n/);
			expect(pick("ru", "", "", "subagents.get.worktree.cleaned")).toMatch(/^\n\n/);
			expect(pick("ru", "", "", "subagents.get.worktree.preserved")).toMatch(/^\n\n/);
		} finally {
			unregisterServerStrings("ru");
		}
	});
});

describe("resolveServerLang", () => {
	it("zh variants → zh", () => {
		expect(resolveServerLang("zh")).toBe("zh");
		expect(resolveServerLang("zh-CN")).toBe("zh");
		expect(resolveServerLang("zh_TW")).toBe("zh");
		expect(resolveServerLang("ZH-hk")).toBe("zh");
		expect(resolveServerLang("  zh  ")).toBe("zh");
	});
	it("other codes pass through normalized (v2: no longer collapsed to en)", () => {
		expect(resolveServerLang("en")).toBe("en");
		expect(resolveServerLang("en-US")).toBe("en");
		expect(resolveServerLang("ja")).toBe("ja");
		expect(resolveServerLang("pt-BR")).toBe("pt");
		expect(resolveServerLang("DE")).toBe("de");
	});
	it("missing/empty/unknown → en (English default)", () => {
		expect(resolveServerLang(undefined)).toBe("en");
		expect(resolveServerLang(null)).toBe("en");
		expect(resolveServerLang("")).toBe("en");
		expect(resolveServerLang("   ")).toBe("en");
		expect(resolveServerLang("zht")).toBe("zht");
	});
});

describe("isTraditionalLocale", () => {
	it("zh-TW / zh-HK / zh-MO / zh-Hant 系（含大小写与下划线写法）是繁体", () => {
		for (const l of ["zh-TW", "zh-tw", "zh_TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "  ZH-hk  "]) {
			expect(isTraditionalLocale(l), l).toBe(true);
		}
	});
	it("核心 zh / zh-CN / zh-SG / 带 Hans 的、以及非中文都不是繁体（script 子标签压过地区）", () => {
		for (const l of ["zh", "zh-CN", "zh_cn", "zh-SG", "zh-Hans", "zh-Hans-HK", "zh-Hans-TW", "en", "ja", "tw", "hk"]) {
			expect(isTraditionalLocale(l), l).toBe(false);
		}
	});
	it("未上报 / 空值 / 非字符串 → false", () => {
		expect(isTraditionalLocale(undefined)).toBe(false);
		expect(isTraditionalLocale(null)).toBe(false);
		expect(isTraditionalLocale("")).toBe(false);
		expect(isTraditionalLocale("   ")).toBe(false);
	});
	it("与 resolveServerLang 互补：繁中也折成 zh，必须靠原始 locale 才能区分", () => {
		for (const l of ["zh", "zh-TW", "zh-HK", "zh-Hant"]) expect(resolveServerLang(l)).toBe("zh");
		expect(isTraditionalLocale("zh-TW")).not.toBe(isTraditionalLocale("zh"));
	});
});

describe("pick / isZh / bilingual", () => {
	it("pick returns the matching variant", () => {
		expect(pick("zh", "甲", "A")).toBe("甲");
		expect(pick("en", "甲", "A")).toBe("A");
	});
	it("pick without key falls back to English for third languages", () => {
		expect(pick("ja", "甲", "A")).toBe("A");
	});
	it("pick interpolates {expr} slots from vars on table hits only", () => {
		registerServerStrings("xx", { "k.i": "残り{n}件（{m}）" });
		expect(pick("xx", "剩${1}个", "${1} left", "k.i", { n: 3, m: "x" })).toBe("残り3件（x）");
		expect(pick("zh", "剩3个", "3 left", "k.i", { n: 3, m: "x" })).toBe("剩3个");
		expect(pick("en", "剩3个", "3 left", "k.i", { n: 3, m: "x" })).toBe("3 left");
		registerServerStrings("xx", { "k.u": "a{b}c{d}" });
		expect(pick("xx", "甲", "A", "k.u", { b: null as unknown as string })).toBe("ac{d}");
		unregisterServerStrings("xx");
	});
	it("isZh", () => {
		expect(isZh("zh")).toBe(true);
		expect(isZh("en")).toBe(false);
		expect(isZh("ja")).toBe(false);
	});
	it("bilingual puts English first, dedupes", () => {
		expect(bilingual("A", "甲")).toBe("A\n甲");
		expect(bilingual("", "甲")).toBe("甲");
		expect(bilingual("A", "")).toBe("A");
		expect(bilingual("same", "same")).toBe("same");
	});
});

describe("translator tables", () => {
	it("hit → translation; miss → English; zh ignores table", () => {
		registerServerStrings("xx", { "demo.hello": "XX-HELLO" });
		expect(pick("xx", "甲", "A", "demo.hello")).toBe("XX-HELLO");
		expect(pick("xx", "甲", "A", "demo.missing")).toBe("A");
		expect(pick("zh", "甲", "A", "demo.hello")).toBe("甲");
		expect(pick("en", "甲", "A", "demo.hello")).toBe("A");
		expect(getServerString("xx", "demo.hello")).toBe("XX-HELLO");
		expect(registeredServerLangs()).toContain("xx");
		unregisterServerStrings("xx");
		expect(pick("xx", "甲", "A", "demo.hello")).toBe("A");
		expect(registeredServerLangs()).not.toContain("xx");
	});
	it("codes normalize (PT-br → pt)", () => {
		registerServerStrings("PT-br", { k: "v" });
		expect(getServerString("pt-BR", "k")).toBe("v");
		unregisterServerStrings("pt");
	});
	it("getServerBlock splits \\n-joined hits, passes through zh/en arrays", () => {
		registerServerStrings("xxb", { "blk.g": "l1\nl2\nl3" });
		expect(getServerBlock("xxb", "blk.g", ["甲"], ["A"])).toEqual(["l1", "l2", "l3"]);
		expect(getServerBlock("xxb", "blk.missing", ["甲"], ["A"])).toEqual(["A"]);
		expect(getServerBlock("zh", "blk.g", ["甲"], ["A"])).toEqual(["甲"]);
		unregisterServerStrings("xxb");
	});
});

describe("extractServerStrings", () => {
	it("pulls code + non-empty string table from a pack file", () => {
		expect(extractServerStrings({ code: "ja", serverStrings: { a: "ア", b: "" } })).toEqual({
			code: "ja",
			table: { a: "ア" },
		});
	});
	it("null when missing/unusable", () => {
		expect(extractServerStrings(null)).toBeNull();
		expect(extractServerStrings({ code: "ja" })).toBeNull();
		expect(extractServerStrings({ code: "ja", serverStrings: { a: 1 } })).toBeNull();
		expect(extractServerStrings({ code: "", serverStrings: { a: "b" } })).toBeNull();
		expect(extractServerStrings({ code: "ja", serverStrings: {} })).toBeNull();
	});
});

describe("issue #640: server pick() preserves computed values in translated packs", () => {
	it("replaces slots without leaving raw placeholders in pt pack", async () => {
		const fs = await import("node:fs");
		const ptRaw = JSON.parse(fs.readFileSync(new URL("../../locales/pt.json", import.meta.url), "utf8"));
		const extracted = extractServerStrings(ptRaw);
		expect(extracted).not.toBeNull();
		if (!extracted) return;
		registerServerStrings("pt", extracted.table);

		try {
			const wtCreate = pick("pt", "✅ 创建成功", "✅ Created", "worktree.create.success", {
				path: "wt/feat",
				branch: " (branch: feat)",
				switched: ", switched",
			});
			expect(wtCreate).toContain("wt/feat");
			expect(wtCreate).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const wtDirty = pick("pt", "未提交", "dirty", "worktree.remove.dirty", {
				targetPath: "wt/feat",
				count: 5,
			});
			expect(wtDirty).toContain("wt/feat");
			expect(wtDirty).toContain("5");
			expect(wtDirty).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const wtSwitch = pick("pt", "切换", "switched", "worktree.switch.success", { target: "wt/dev" });
			expect(wtSwitch).toContain("wt/dev");
			expect(wtSwitch).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const claimOk = pick("pt", "已认领", "Claimed", "claimfiles.claim.ok", {
				n: 3,
				paths: "a.ts, b.ts",
				ttl: "30m",
			});
			expect(claimOk).toContain("3");
			expect(claimOk).toContain("30m");
			expect(claimOk).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const convMore = pick("pt", "更多", "more", "convread.list.history.more", { n: 10, def: 20 });
			expect(convMore).toContain("10");
			expect(convMore).toContain("20");
			expect(convMore).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const convAll = pick("pt", "全部", "all", "convread.list.head.all", { running: 2, history: 5, scope: "project" });
			expect(convAll).toContain("2");
			expect(convAll).toContain("5");
			expect(convAll).toContain("project");
			expect(convAll).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const mcpFail = pick("pt", "失败", "fail", "mcp_manage.install.fail", { error: "bad package" });
			expect(mcpFail).toContain("bad package");
			expect(mcpFail).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const mcpEmpty = pick("pt", "空", "empty", "mcp_manage.list.empty", {
				projectPath: "/proj/.pi/mcp.json",
				globalPath: "~/.pi/mcp.json",
			});
			expect(mcpEmpty).toContain("/proj/.pi/mcp.json");
			expect(mcpEmpty).toContain("~/.pi/mcp.json");
			expect(mcpEmpty).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const piTimeout = pick("pt", "超时", "timeout", "plugininstaller.timeout", { min: 15 });
			expect(piTimeout).toContain("15");
			expect(piTimeout).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const scmTerm = pick("pt", "异常终止", "terminated", "scm.commitmsg.model.terminated", {
				stopReason: "tool_use",
			});
			expect(scmTerm).toContain("tool_use");
			expect(scmTerm).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const scmTimeout = pick("pt", "超时", "timeout", "scm.commitmsg.timeout", { secs: 30 });
			expect(scmTimeout).toContain("30");
			expect(scmTimeout).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const skillBad = pick("pt", "不可读", "unreadable", "skill.file.unreadable", { name: "my-skill", kb: 256 });
			expect(skillBad).toContain("my-skill");
			expect(skillBad).toContain("256");
			expect(skillBad).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const goalStart = pick("pt", "审查开始", "review started", "goal.role.card.start", { round: 1, rounds: " / 3" });
			expect(goalStart).toContain("1");
			expect(goalStart).toContain(" / 3");
			expect(goalStart).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const goalPass = pick("pt", "审查通过", "review passed", "goal.role.card.pass", {
				round: 2,
				rounds: " / 5",
				fb: ": all good",
			});
			expect(goalPass).toContain("2");
			expect(goalPass).toContain(": all good");
			expect(goalPass).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const goalFail = pick("pt", "审查未通过", "review failed", "goal.role.card.fail", {
				round: 2,
				rounds: " / 5",
				fb: ": missing tests",
			});
			expect(goalFail).toContain("2");
			expect(goalFail).toContain(": missing tests");
			expect(goalFail).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const presTitled = pick("pt", "展示", "presented", "present.files.result.head.titled", { n: 2, title: "Report" });
			expect(presTitled).toContain("2");
			expect(presTitled).toContain("Report");
			expect(presTitled).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);

			const presHead = pick("pt", "展示", "presented", "present.files.result.head", { n: 2, title: "" });
			expect(presHead).toContain("2");
			expect(presHead).not.toContain("()");
			expect(presHead).not.toMatch(/\{[a-zA-Z0-9_.]+\}/);
		} finally {
			unregisterServerStrings("pt");
		}
	});
});
