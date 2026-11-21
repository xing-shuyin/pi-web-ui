import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLI 的 `run()` 失败必须出声。
 *
 * 回归场景：Windows 上 `server install` 写 HKCU Run 键被安全软件拦下时，旧实现直接
 * `process.exit()`，用户在 GUI 里只看到「按钮点了没反应」。这里守住三条：
 * 1. 失败分支里必须先打印（console.error）再退出
 * 2. `spawn` 自身报错（res.error，如 EPERM/ENOENT）也要算失败
 * 3. 文案里给出可操作出路（重跑 / --print）
 */
const source = readFileSync(join(import.meta.dirname, "..", "..", "bin", "pi-web-ui.mjs"), "utf8");

function runBody(): string {
	const start = source.indexOf("function run(cmd, args, { ignoreError = false, silent = false } = {}) {");
	expect(start, "bin/pi-web-ui.mjs 里找不到 run()").toBeGreaterThan(-1);
	const end = source.indexOf("\n}\n", start);
	// 去掉注释行：注释里会提到 `process.exit()`，不能拿它当代码位置
	return source
		.slice(start, end)
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
}

describe("bin/pi-web-ui.mjs 的 run()", () => {
	it("失败分支先打印再退出", () => {
		const body = runBody();
		const printAt = body.indexOf("console.error");
		const exitAt = body.indexOf("process.exit");
		expect(printAt).toBeGreaterThan(-1);
		expect(exitAt).toBeGreaterThan(printAt);
	});

	it("spawn 报错（EPERM/ENOENT 等）也当失败，不只是退出码非零", () => {
		const body = runBody();
		expect(body).toMatch(/res\.status !== 0 \|\| res\.error/);
		expect(body).toMatch(/res\.error\.message|res\.error\.code/);
	});

	it("给出可操作出路（终端重跑 / --print）", () => {
		const body = runBody();
		expect(body).toContain("--print");
		expect(body).toMatch(/终端|terminal/);
	});

	it("不把整段参数打进日志（只留前三个 token）", () => {
		expect(runBody()).toContain("args.slice(0, 3)");
	});
});
