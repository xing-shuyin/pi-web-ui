import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIRRORS } from "../../scripts/lib/bin-mirrors.mjs";
import { renderBinMirror } from "../../scripts/lib/bin-mirror.mjs";
import { shellQuotePosix, shellQuotePowerShell } from "../../server/shell-quote.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * `bin/**` 是纯 .mjs，不能 import TS；但里面的行为必须是 server 侧单源实现的同一份。
 * 仓库存量做法是「构建期把编译产物搬到 bin/lib/ + 守卫逐字节比对」（见 bin/lib/atomic-file.mjs）。
 * 本守卫覆盖由 `scripts/lib/bin-mirrors.mjs` 登记的所有镜像件。
 */
describe("bin/lib 镜像件与 server 单源同源", () => {
	for (const spec of MIRRORS) {
		it(`${spec.targetPath} ← ${spec.source}（生成头 + 逐字节一致）`, async () => {
			const target = read(spec.targetPath);
			expect(target.startsWith("// AUTO-GENERATED FILE — 不要手改。"), "缺生成头：手改生成件会立刻被这条守卫抓住").toBe(
				true,
			);
			const distEntry = join(root, spec.distPath);
			if (!existsSync(distEntry)) return; // 没跑过 build:server 就只查生成头（CI 会跑完整构建）
			expect(target).toBe(await renderBinMirror(readFileSync(distEntry, "utf8"), spec));
		});
	}

	it("清单登记的两件镜像都不缺文件、且都带守卫指针", () => {
		expect(MIRRORS.length).toBeGreaterThanOrEqual(2);
		for (const spec of MIRRORS) {
			expect(existsSync(join(root, spec.targetPath)), `缺少 ${spec.targetPath}`).toBe(true);
			expect(spec.guard).toBe("tests/unit/bin-mirror.test.ts");
			expect(read(spec.targetPath)).toContain(`// 守卫：${spec.guard}`);
		}
	});

	it("CLI 用的是镜像件，而不是自己另写一套", () => {
		const cli = read("bin/pi-web-ui.mjs");
		expect(cli).toContain('import "./lib/hide-console-windows.mjs";');
		expect(cli).toContain('from "./lib/shell-quote.mjs"');
		expect(cli).not.toContain("function shQuote(");
		expect(cli).not.toContain("function psQuote(");
	});
});

describe("shell 引号单源（原来 bin 与 server 各一份）", () => {
	it("POSIX：单引号包裹 + '\\'' 转义", () => {
		expect(shellQuotePosix("/tmp/a b")).toBe("'/tmp/a b'");
		expect(shellQuotePosix("it's")).toBe("'it'\\''s'");
		expect(shellQuotePosix("")).toBe("''");
	});

	it("PowerShell：单引号包裹 + '' 转义", () => {
		expect(shellQuotePowerShell("C:\\Program Files")).toBe("'C:\\Program Files'");
		expect(shellQuotePowerShell("it's")).toBe("'it''s'");
	});

	it("镜像件里的实现与之逐字节等价（bin 侧不另写一套）", async () => {
		const mirror = (await import("../../bin/lib/shell-quote.mjs")) as {
			shellQuotePosix: (s: string) => string;
			shellQuotePowerShell: (s: string) => string;
		};
		for (const sample of ["", "plain", "it's", "a b", 'quo"te', "$HOME"]) {
			expect(mirror.shellQuotePosix(sample)).toBe(shellQuotePosix(sample));
			expect(mirror.shellQuotePowerShell(sample)).toBe(shellQuotePowerShell(sample));
		}
	});
});
