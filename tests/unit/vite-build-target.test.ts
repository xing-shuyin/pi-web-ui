import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = join(process.cwd(), "web/vite.config.ts");
const DIST_ASSETS = join(process.cwd(), "web/dist/assets");
const LOWERING_TARGETS = /^(es5|es6|es2015|es2016|es2017|es2018|es2019|es2020|modules)$/;

describe("web 构建目标", () => {
	it("显式设置了 build.target", () => {
		const src = readFileSync(CONFIG, "utf8");
		expect(src).toMatch(/\btarget:\s*"[^"]+"/);
	});

	it("target ≥ es2021，避免 ||= 被降级（xterm requestMode 会因此崩）", () => {
		const src = readFileSync(CONFIG, "utf8");
		const target = /\btarget:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
		expect(target).not.toMatch(LOWERING_TARGETS);
		const year = /^es(\d{4})$/.exec(target)?.[1];
		if (year) expect(Number(year)).toBeGreaterThanOrEqual(2021);
	});

	it("构建产物里没有丢声明的 `))(void 0||(x=` 形态", () => {
		if (!existsSync(DIST_ASSETS)) return;
		const offenders: string[] = [];
		for (const file of readdirSync(DIST_ASSETS).filter((f) => f.endsWith(".js"))) {
			const code = readFileSync(join(DIST_ASSETS, file), "utf8");
			if (/\)\)\(void 0\|\|\(/.test(code)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
