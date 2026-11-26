import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 系统服务看门狗的 Windows 实现（`bin/keel.mjs` 的 `installWindows` / `buildWinStartPs1`）。
 *
 * 实机踩出来的两条（2026-11-21）：
 * 1. 重复 install 会留下**两个**看门狗抢同一份数据目录 —— 被拒的那个每 10s 重启一次，
 *    而且它退出时把活着的那个的 pid 文件一起删了，`server status` / `stop` 从此找不到服务。
 * 2. 所以 pid 文件只能由写它的那个进程删（与 `shared/instance-lock.ts` 的 `releaseKernelLock` 同语义）。
 *
 * 这里用文本断言守这两条：它们是生成出来的 ps1 内容，跑真服务不在单测范围内。
 */
const cli = readFileSync(join(import.meta.dirname, "..", "..", "bin", "keel.mjs"), "utf8");

function slice(start: string, end: string): string {
	const from = cli.indexOf(start);
	expect(from, `找不到 ${start}`).toBeGreaterThan(-1);
	const to = cli.indexOf(end, from);
	return to === -1 ? cli.slice(from) : cli.slice(from, to);
}

describe("Windows 服务看门狗", () => {
	it("install 幂等：先停旧看门狗再起新的（不留两个抢数据目录）", () => {
		const body = slice("function installWindows(", "function uninstallWindows(");
		expect(body).toContain("stopWinInstance(name)");
		expect(body.indexOf("stopWinInstance(name)")).toBeLessThan(body.indexOf("launchWinService(vbsPath)"));
	});

	it("看门狗只删自己的 pid 文件（多实例并存不互相抹记录）", () => {
		const body = slice("function buildWinStartPs1(", "function esc(");
		expect(body).toContain("Get-Content");
		expect(body).toContain("[string]$PID");
		// 无条件 Remove-Item 就是那个 bug 的写法
		expect(body).not.toMatch(/`\s*Remove-Item \$\{psQuote\(pidPath\)\}/);
	});
});
