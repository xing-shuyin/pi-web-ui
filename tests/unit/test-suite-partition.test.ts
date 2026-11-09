import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HEAVY_MAX_WORKERS, HEAVY_SUITE, HEAVY_TIMEOUT_MS } from "../lib/suite-partition.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

function listUnitTestFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".test.ts"))
				out.push(`tests/unit/${full.slice(join(root, "tests/unit").length + 1).replace(/\\/g, "/")}`);
		}
	};
	walk(join(root, "tests", "unit"));
	return out;
}

describe("单测分层（快池 / 重型集成池）", () => {
	const all = listUnitTestFiles();

	it("清单里的重型文件都真实存在，且不重复", () => {
		expect(new Set(HEAVY_SUITE).size).toBe(HEAVY_SUITE.length);
		const missing = HEAVY_SUITE.filter((file) => !existsSync(join(root, file)));
		expect(missing).toEqual([]);
	});

	it("快池 = 全部单测 − 重型：没有任何文件两边都不跑", () => {
		const fast = all.filter((file) => !HEAVY_SUITE.includes(file));
		// 缺一个都算漏跑：快池按 glob 收集，只靠 exclude 去掉重型，所以两者必须刚好拼成全集。
		expect([...new Set([...fast, ...HEAVY_SUITE])].sort()).toEqual([...all].sort());
		expect(fast.length).toBeGreaterThan(0);
	});

	it("快配置靠 exclude 排除重型，且留了 PI_TEST_ALL 一次性跑全量", () => {
		const config = read("vitest.config.ts");
		expect(config).toContain("HEAVY_SUITE");
		expect(config).toMatch(/exclude:\s*\[\.\.\.configDefaults\.exclude/);
		expect(config).toContain("PI_TEST_ALL");
	});

	it("重型配置只收清单里的文件，且不吃快池的预算", () => {
		const config = read("vitest.integration.config.ts");
		expect(config).toContain("include: HEAVY_SUITE");
		expect(config).toContain("HEAVY_MAX_WORKERS");
		expect(config).toContain("HEAVY_TIMEOUT_MS");
		// 预算写死 60s 会把这批真子进程用例打回假红（单跑最慢 52s）。
		expect(HEAVY_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
		expect(HEAVY_MAX_WORKERS).toBeLessThanOrEqual(4);
	});

	it("package.json 有进池的入口，CI 两个池都跑（排除不等于不跑）", () => {
		const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
		expect(pkg.scripts["test:integration"]).toContain("vitest.integration.config.ts");
		expect(pkg.scripts["test:all"]).toContain("test:integration");
		const ci = read(".github/workflows/ci.yml");
		expect(ci).toMatch(/npx vitest run/);
		expect(ci).toContain("npm run test:integration");
	});
});
