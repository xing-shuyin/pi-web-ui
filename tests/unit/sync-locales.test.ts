/** Module source -> flat language pack synchronization, including metadata/token safety. */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPlaceholders, syncLocales } from "../../scripts/sync-locales.mjs";

function moduleSource(repo: string, name: string, locale: string, strings: Record<string, string>) {
	const dir = join(repo, "web/src/i18n/messages", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${locale}.json`), JSON.stringify(strings));
}

function pack(repo: string, code: string, strings: Record<string, unknown>, extra = {}) {
	mkdirSync(join(repo, "locales"), { recursive: true });
	writeFileSync(
		join(repo, `locales/${code}.json`),
		JSON.stringify({ code, nativeName: code, version: "1.0.0", strings, ...extra }, null, "\t") + "\n",
	);
}

function readPack(repo: string, code: string) {
	return JSON.parse(readFileSync(join(repo, `locales/${code}.json`), "utf8"));
}

async function sandbox(run: (repo: string) => Promise<void>) {
	const repo = mkdtempSync(join(tmpdir(), "pi-sync-locales-"));
	try {
		await run(repo);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

function core(repo: string) {
	moduleSource(repo, "core", "zh", { apple: "苹果", banana: "香蕉 {count} 根", cherry: "樱桃" });
	moduleSource(repo, "core", "en", { apple: "Apple", banana: "Banana {count} pcs", cherry: "Cherry" });
}

describe("sync-locales", () => {
	it("extractPlaceholders 提取嵌套、数字、下划线和重复 token", () => {
		const s = "Hello {name}, {count}, ${pwd}, [[marker:test]], {{token}}.";
		expect(extractPlaceholders(s)).toEqual(["${pwd}", "[[marker", "{count}", "{name}", "{{token}}"]);
		expect(extractPlaceholders("{node_id} {node_id} {{auth2}} ${path_2}")).toEqual([
			"${path_2}",
			"{node_id}",
			"{node_id}",
			"{{auth2}}",
		]);
	});

	it("当前工作区的 12 个语言包已与模块源完全对齐", async () => {
		const res = await syncLocales({ dryRun: true, checkOnly: true });
		expect(res.ok).toBe(true);
		expect(res.hasChanges).toBe(false);
		expect(res.totalAdded).toBe(0);
		expect(res.totalPruned).toBe(0);
		expect(res.totalUpdated).toBe(0);
	});

	it("补缺失 key、删除死 key、保留译文并以 core -> 模块顺序重排；dry-run 不写文件", async () => {
		await sandbox(async (repo) => {
			core(repo);
			moduleSource(repo, "canvas", "zh", { "canvas.example": "画布 {name}" });
			moduleSource(repo, "canvas", "en", { "canvas.example": "Canvas {name}" });
			pack(repo, "de", { banana: "Banane {count} Stk", apple: "Apfel", deadKey: "Soll weg" });
			pack(repo, "zh-TW", { apple: "蘋果" });
			const dry = await syncLocales({ repoRoot: repo, dryRun: true });
			expect(dry.totalAdded).toBe(5);
			expect(dry.totalPruned).toBe(1);
			expect(readPack(repo, "de").strings.deadKey).toBe("Soll weg");
			const res = await syncLocales({ repoRoot: repo });
			expect(res.hasChanges).toBe(true);
			const de = readPack(repo, "de").strings;
			expect(Object.keys(de)).toEqual(["apple", "banana", "cherry", "canvas.example"]);
			expect(de).toEqual({
				apple: "Apfel",
				banana: "Banane {count} Stk",
				cherry: "Cherry",
				"canvas.example": "Canvas {name}",
			});
			expect(readPack(repo, "zh-TW").strings.apple).toBe("蘋果");
			expect(readPack(repo, "zh-TW").strings.banana).toContain("{count}");
			const check = await syncLocales({ repoRoot: repo, checkOnly: true });
			expect(check.ok).toBe(true);
			expect(check.hasChanges).toBe(false);
		});
	});

	it("额外模块译文覆盖既有 fallback，缺少模块译文的语言仍使用 en", async () => {
		await sandbox(async (repo) => {
			core(repo);
			moduleSource(repo, "canvas", "zh", { "canvas.example": "画布 {name}" });
			moduleSource(repo, "canvas", "en", { "canvas.example": "Canvas {name}" });
			moduleSource(repo, "canvas", "de", { "canvas.example": "Leinwand {name}" });
			moduleSource(repo, "canvas", "zh-TW", { "canvas.example": "畫布 {name}" });
			const base = {
				apple: "Apple",
				banana: "Banana {count} pcs",
				cherry: "Cherry",
				"canvas.example": "Canvas {name}",
			};
			pack(repo, "de", base, { serverStrings: { "agent.example": "Server" }, custom: true });
			pack(repo, "fr", base);
			pack(repo, "zh-TW", base);
			const before = readFileSync(join(repo, "locales/de.json"), "utf8");
			const check = await syncLocales({ repoRoot: repo, checkOnly: true });
			expect(check.ok).toBe(false);
			expect(check.totalAdded).toBe(0);
			expect(check.totalUpdated).toBe(2);
			expect(readFileSync(join(repo, "locales/de.json"), "utf8")).toBe(before);
			await syncLocales({ repoRoot: repo });
			expect(readPack(repo, "de").strings["canvas.example"]).toBe("Leinwand {name}");
			expect(readPack(repo, "zh-TW").strings["canvas.example"]).toBe("畫布 {name}");
			expect(readPack(repo, "fr").strings["canvas.example"]).toBe("Canvas {name}");
			expect(readPack(repo, "de").serverStrings).toEqual({ "agent.example": "Server" });
			expect(readPack(repo, "de").custom).toBe(true);
			expect((await syncLocales({ repoRoot: repo, checkOnly: true })).hasChanges).toBe(false);
		});
	});

	it("仅占位符错误也应触发 check 失败和写回，不能保留损坏或非字符串译文", async () => {
		await sandbox(async (repo) => {
			core(repo);
			pack(repo, "de", { apple: "", banana: "Banane {wrong}", cherry: null });
			const check = await syncLocales({ repoRoot: repo, checkOnly: true });
			expect(check.ok).toBe(false);
			expect(check.totalUpdated).toBe(3);
			expect(check.totalAdded).toBe(0);
			expect(check.totalReordered).toBe(0);
			await syncLocales({ repoRoot: repo });
			expect(readPack(repo, "de").strings).toEqual({ apple: "Apple", banana: "Banana {count} pcs", cherry: "Cherry" });
			expect((await syncLocales({ repoRoot: repo, checkOnly: true })).ok).toBe(true);
		});
	});

	it("错误的模块译文在写包前失败，禁止静默覆盖或修复源码", async () => {
		await sandbox(async (repo) => {
			core(repo);
			moduleSource(repo, "canvas", "zh", { "canvas.example": "画布 {name}" });
			moduleSource(repo, "canvas", "en", { "canvas.example": "Canvas {name}" });
			moduleSource(repo, "canvas", "de", { "canvas.example": "Leinwand {wrong}" });
			pack(repo, "de", { apple: "Apfel" });
			const path = join(repo, "locales/de.json");
			const before = readFileSync(path, "utf8");
			await expect(syncLocales({ repoRoot: repo })).rejects.toThrow(/canvas\/de.*placeholder.*canvas.example/);
			expect(readFileSync(path, "utf8")).toBe(before);
		});
	});

	it("重写语言包不得吞掉 serverStrings 和顶层字段顺序", async () => {
		await sandbox(async (repo) => {
			core(repo);
			pack(repo, "pt", { apple: "Maçã" }, { serverStrings: { "agent.role.stop": "Encerrado" } });
			await syncLocales({ repoRoot: repo });
			const synced = readPack(repo, "pt");
			expect(synced.strings.apple).toBe("Maçã");
			expect(synced.serverStrings).toEqual({ "agent.role.stop": "Encerrado" });
			expect(Object.keys(synced)).toEqual(["code", "nativeName", "version", "strings", "serverStrings"]);
		});
	});
});
