import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPack } from "../../scripts/zh-tw-locale/build-pack.mjs";

const sandboxes: string[] = [];
afterEach(() => {
	for (const repo of sandboxes.splice(0)) rmSync(repo, { recursive: true, force: true });
});
function setup() {
	const repo = mkdtempSync(join(tmpdir(), "pi-zh-tw-locale-"));
	sandboxes.push(repo);
	for (const name of ["core", "example"]) mkdirSync(join(repo, "web/src/i18n/messages", name), { recursive: true });
	const sources = {
		"core/zh": { title: "标题" },
		"core/en": { title: "Title" },
		"example/zh": { "example.label": "示例 {count}" },
		"example/en": { "example.label": "Example {count}" },
		"example/zh-TW": { "example.label": "範例 {count}" },
	};
	for (const [name, messages] of Object.entries(sources))
		writeFileSync(join(repo, "web/src/i18n/messages", `${name}.json`), JSON.stringify(messages));
	writeFileSync(join(repo, "package.json"), '{"version":"1.2.3"}');
	mkdirSync(join(repo, "locales"));
	return repo;
}

describe("zh-tw module tooling", () => {
	it("dump 可由纯 node 运行；从模块读全部 zh/en 并保留顺序，不执行 i18n.tsx", () => {
		const repo = setup();
		writeFileSync(join(repo, "web/src/i18n.tsx"), 'throw new Error("must not evaluate React runtime")');
		const zhPath = join(repo, "zh.json"),
			enPath = join(repo, "en.json");
		execFileSync(process.execPath, [resolve("scripts/zh-tw-locale/dump-zh.mjs"), repo, zhPath, enPath], {
			timeout: 15_000,
		});
		expect(JSON.parse(readFileSync(zhPath, "utf8"))).toEqual({ title: "标题", "example.label": "示例 {count}" });
		expect(Object.keys(JSON.parse(readFileSync(enPath, "utf8")))).toEqual(["title", "example.label"]);
	});

	it("build-pack 采用合并键序及模块繁中源，保留现有 serverStrings 和自定义元数据", () => {
		const repo = setup();
		writeFileSync(
			join(repo, "locales/zh-TW.json"),
			JSON.stringify({
				code: "zh-TW",
				nativeName: "繁體中文",
				version: "old",
				strings: {},
				serverStrings: { greeting: "你好" },
				custom: true,
			}),
		);
		const result = buildPack({ repoRoot: repo, strings: { "example.label": "轉換值 {count}", title: "標題" } });
		expect(result.strings).toEqual({ title: "標題", "example.label": "範例 {count}" });
		expect(Object.keys(result.strings)).toEqual(["title", "example.label"]);
		expect(result.serverStrings).toEqual({ greeting: "你好" });
		expect(result.custom).toBe(true);
		expect(result.version).toBe("1.2.3");
		expect(JSON.parse(readFileSync(join(repo, "locales/zh-TW.json"), "utf8"))).toEqual(result);
	});

	it("没有模块译文时保留转换结果；占位符不符时拒绝写包", () => {
		const repo = setup();
		expect(() =>
			buildPack({ repoRoot: repo, code: "zh-HK", strings: { title: "標題", "example.label": "範例 {wrong}" } }),
		).toThrow(/placeholder mismatch.*example.label/);
		const result = buildPack({
			repoRoot: repo,
			code: "zh-HK",
			strings: { title: "標題", "example.label": "範例 {count}" },
		});
		expect(result.strings["example.label"]).toBe("範例 {count}");
	});
});
