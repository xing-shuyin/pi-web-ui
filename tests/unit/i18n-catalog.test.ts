import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog, en, zh, type MessageKey } from "../../web/src/i18n/catalog.js";
import type { Translate, useT } from "../../web/src/i18n.js";
import { readCatalog } from "../../scripts/lib/i18n-catalog.mjs";
import { diffWorktreeVsBase, parseLocaleMaps } from "../../scripts/i18n-diff.mjs";

const sandboxes: string[] = [];
function sandbox() {
	const repo = mkdtempSync(join(tmpdir(), "pi-i18n-catalog-"));
	sandboxes.push(repo);
	return repo;
}
afterEach(() => {
	for (const repo of sandboxes.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function source(repo: string, name: string, locale: string, messages: Record<string, string> | string) {
	const dir = join(repo, "web/src/i18n/messages", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${locale}.json`), typeof messages === "string" ? messages : JSON.stringify(messages));
}
function core(repo: string) {
	source(repo, "core", "zh", { title: "标题", count: "{count} 项" });
	source(repo, "core", "en", { title: "Title", count: "{count} items" });
}
function git(repo: string, ...args: string[]) {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
// A tree is a valid git ref for ls-tree/show; no fixture commits or user config needed.
function snapshot(repo: string) {
	git(repo, "add", "--all");
	return git(repo, "write-tree");
}

describe("i18n catalog", () => {
	it("runtime 与工具入口合并同一组来源，core 在先且保留全部文案", () => {
		const catalog = readCatalog({ includeTranslations: false });
		expect(catalog.modules.map((module: { name: string }) => module.name)).toEqual([
			"core",
			"canvas",
			"canvas-runtime",
			"desktop",
			"native-cli-session",
		]);
		expect(Object.entries(zh)).toEqual([...catalog.zh.map]);
		expect(Object.entries(en)).toEqual([...catalog.en.map]);
		for (const key of ["save", "cancel", "close"] as const) {
			expect(zh[key]).toBeTruthy();
			expect(en[key]).toBeTruthy();
		}
	});

	it("Translate/useT key 仍是 core 与所有模块的精确联合，不能退化为 string", () => {
		// Compare finite key sets without expect-type's quadratic equality expansion on thousands of literals.
		expectTypeOf<Exclude<Parameters<Translate>[0], MessageKey>>().toEqualTypeOf<never>();
		expectTypeOf<Exclude<MessageKey, Parameters<Translate>[0]>>().toEqualTypeOf<never>();
		expectTypeOf<ReturnType<typeof useT> extends Translate ? true : false>().toEqualTypeOf<true>();
		expectTypeOf<string extends MessageKey ? true : false>().toEqualTypeOf<false>();
		const catalog = createCatalog([
			{ name: "core", zh: { title: "标题" }, en: { title: "Title" } },
			{ name: "example", zh: { "example.label": "示例" }, en: { "example.label": "Example" } },
		]);
		expectTypeOf<keyof typeof catalog.zh>().toEqualTypeOf<"title" | "example.label">();
		expectTypeOf<keyof typeof catalog.en>().toEqualTypeOf<"title" | "example.label">();
		function typecheckOnly(t: Translate) {
			t("save");
			t("canvas.aiBar.cancel");
			t("nativeCliSession.lastActivity", { time: "12:00" });
			// @ts-expect-error Unknown keys must fail compilation even after merging modules.
			t("__unknown_i18n_key__");
		}
		void typecheckOnly;
	});

	it("多模块重复 key 在 runtime 和 tooling 中均拒绝，不能被后者覆盖", () => {
		expect(() =>
			createCatalog([
				{ name: "core", zh: { same: "甲" }, en: { same: "A" } },
				{ name: "example", zh: { same: "乙" }, en: { same: "B" } },
			]),
		).toThrow(/duplicate key same.*core.*example/);
		const repo = sandbox();
		core(repo);
		source(repo, "example", "zh", { title: "覆盖" });
		source(repo, "example", "en", { title: "Override" });
		expect(() => readCatalog({ repoRoot: repo })).toThrow(/duplicate key title.*core.*example/);
	});

	it("JSON 内部重复 key（含转义写法）也必须报错", () => {
		const repo = sandbox();
		core(repo);
		source(repo, "core", "zh", '{"title":"甲", "\\u0074itle":"乙"}');
		expect(() => readCatalog({ repoRoot: repo })).toThrow(/duplicate key title/);
	});

	it.each([
		["missing", { title: "Title" }, /missing keys.*count/],
		["extra", { title: "Title", count: "{count} items", ghost: "Extra" }, /extra keys.*ghost/],
		["order", { count: "{count} items", title: "Title" }, /key order/],
		["placeholder", { title: "Title", count: "{wrong} items" }, /placeholder mismatch.*count/],
	] as const)("拒绝模块 %s 错误", (_kind, messages, error) => {
		const repo = sandbox();
		core(repo);
		source(repo, "core", "en", messages);
		expect(() => readCatalog({ repoRoot: repo })).toThrow(error);
		expect(() => createCatalog([{ name: "core", zh: { title: "标题", count: "{count} 项" }, en: messages }])).toThrow();
	});

	it("缺少模块 en/zh 文件、非字符串文案和不完整额外语言均拒绝", () => {
		const repo = sandbox();
		core(repo);
		source(repo, "example", "zh", { "example.label": "示例" });
		expect(() => readCatalog({ repoRoot: repo })).toThrow(/example.*missing zh\/en/);
		source(repo, "example", "en", '{"example.label":12}');
		expect(() => readCatalog({ repoRoot: repo })).toThrow(/example.label.*nonempty string/);
		source(repo, "example", "en", { "example.label": "Example" });
		source(repo, "example", "de", {});
		expect(() => readCatalog({ repoRoot: repo })).toThrow(/example\/de.*missing keys.*example.label/);
		expect(readCatalog({ repoRoot: repo, includeTranslations: false }).zh.order).toContain("example.label");
	});

	it("自动发现额外模块/语言、稳定排序，并允许额外语言以不同键序完整翻译", () => {
		const repo = sandbox();
		source(repo, "zeta", "zh", { "zeta.label": "末尾" });
		source(repo, "zeta", "en", { "zeta.label": "Last" });
		core(repo);
		source(repo, "alpha", "zh", { "alpha.one": "一", "alpha.two": "二" });
		source(repo, "alpha", "en", { "alpha.one": "One", "alpha.two": "Two" });
		source(repo, "alpha", "de", { "alpha.two": "Zwei", "alpha.one": "Eins" });
		const catalog = readCatalog({ repoRoot: repo });
		expect(catalog.zh.order).toEqual(["title", "count", "alpha.one", "alpha.two", "zeta.label"]);
		expect([...catalog.translations.get("de")!]).toEqual([
			["alpha.one", "Eins"],
			["alpha.two", "Zwei"],
		]);
	});

	it("历史 TSX 解析使用语法树，支持注释/引号 key/续行/转义而不执行代码", () => {
		const maps = parseLocaleMaps(
			'export const zh = { /* brace } */ "example.key": "第一行\\n" + "第二行", tick: `静态` } as const; export const en: Record<keyof typeof zh,string> = { "example.key": "First\\n" + "Second", tick: `Static` };',
		);
		expect([...maps.zh.map]).toEqual([
			["example.key", "第一行\n第二行"],
			["tick", "静态"],
		]);
		expect(() => parseLocaleMaps('export const zh = { a: globalThis.mutate() }; const en = { a: "A" };')).toThrow(
			/static string literals/,
		);
	});

	it("旧单文件 git 基准 -> 工作区模块：移动不报增删，能发现增删和双语改字", () => {
		const repo = sandbox();
		git(repo, "init", "--quiet");
		mkdirSync(join(repo, "web/src"), { recursive: true });
		writeFileSync(
			join(repo, "web/src/i18n.tsx"),
			'export const zh = { title: "旧标题", removed: "删除", moved: "移动" }; const en = { title: "Old title", removed: "Removed", moved: "Moved" };',
		);
		const base = snapshot(repo);
		writeFileSync(join(repo, "web/src/i18n.tsx"), 'export { zh, en } from "./i18n/catalog.js";');
		source(repo, "core", "zh", { title: "新标题" });
		source(repo, "core", "en", { title: "New title" });
		source(repo, "example", "zh", { moved: "移动", "example.added": "新增" });
		source(repo, "example", "en", { moved: "Moved", "example.added": "Added" });
		const diff = diffWorktreeVsBase(base, { repoRoot: repo });
		expect(diff.frontend.added).toEqual(["example.added"]);
		expect(diff.frontend.removed).toEqual(["removed"]);
		expect(diff.frontend.changedZh).toEqual([{ key: "title", old: "旧标题", new: "新标题" }]);
		expect(diff.frontend.changedEn).toEqual([{ key: "title", old: "Old title", new: "New title" }]);
		expect(diff.server).toEqual({ added: [], removed: [], changed: [] });
	});

	it("新模块 git 基准独立读取该 ref；只改已翻译额外语言不算 zh/en 源变动", () => {
		const repo = sandbox();
		git(repo, "init", "--quiet");
		core(repo);
		source(repo, "example", "zh", { "example.label": "示例" });
		source(repo, "example", "en", { "example.label": "Example" });
		source(repo, "example", "de", { "example.label": "Alt" });
		const base = snapshot(repo);
		source(repo, "example", "de", { "example.label": "Neu" });
		expect(diffWorktreeVsBase(base, { repoRoot: repo }).frontend).toEqual({
			added: [],
			removed: [],
			changedZh: [],
			changedEn: [],
		});
		source(repo, "example", "zh", { "example.label": "更新" });
		source(repo, "example", "en", { "example.label": "Updated" });
		expect(diffWorktreeVsBase(base, { repoRoot: repo }).frontend.changedEn).toEqual([
			{ key: "example.label", old: "Example", new: "Updated" },
		]);
		expect(readCatalog({ repoRoot: repo, ref: base }).zh.map.get("example.label")).toBe("示例");
		expect(() => readCatalog({ repoRoot: repo, ref: "missing-ref" })).toThrow();
	});
});
