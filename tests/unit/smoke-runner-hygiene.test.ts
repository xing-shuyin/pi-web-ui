import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeTestProcess } from "../lib/process-cleanup.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/**
 * 冒烟 runner 的进程卫生守卫。
 *
 * 历史教训（两次都真的踩过）：用例 spawn 的 server 没被收干净，下一轮在同一端口撞上「上轮残留的
 * 旧构建」，`waitForPort` 认为服务已就绪，于是拿旧产物跑出假绿/假红 —— 改了代码却一直连到旧 server。
 * 修在 runner 一处（而不是 237 个用例各写一遍 `freePort`），所以这里守住那几行不能掉。
 */
describe("冒烟 runner 的进程卫生", () => {
	it("跑之前清端口、跑完/中断时杀进程树", () => {
		const src = read("tests/run-smoke.mjs");
		expect(src).toContain('from "./lib/process-cleanup.mjs"');
		expect(src).toContain("freeTestPort(port)");
		expect(src).toContain("killTree(child.pid)");
	});

	it("被中断（Ctrl-C / SIGTERM）时不留孤儿 server", () => {
		const src = read("tests/run-smoke.mjs");
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(src).toContain(`"${signal}"`);
		expect(src).toContain("killLiveChildren()");
	});

	it("用例卡死时有看门狗（可调，不会是无限等）", () => {
		const src = read("tests/run-smoke.mjs");
		expect(src).toContain("--timeout=");
		expect(src).toContain("TEST_TIMEOUT_MS");
		expect(src).toContain("killTree(child.pid);");
	});

	it("留了一条手工清场命令（默认 dry-run）", () => {
		const src = read("scripts/kill-test-servers.mjs");
		expect(src).toContain("sweepTestResidue");
		expect(src).toContain("--kill");
		expect(src).toContain("dry-run");
	});
});

describe("残留判定只认仓库里的测试进程", () => {
	it("仓库里的用例脚本 / 产物入口算残留", () => {
		expect(looksLikeTestProcess("node D:/pi-web-ui/tests/running-list-test.mjs 8918")).toBe(true);
		expect(looksLikeTestProcess("node D:/pi-web-ui/tests/run-smoke.mjs")).toBe(true);
		expect(looksLikeTestProcess('node "D:\\pi-web-ui\\dist\\server\\index.js"')).toBe(true);
	});

	it("全局安装的 pi-web-ui 服务不算（那是常驻的正式进程）", () => {
		expect(
			looksLikeTestProcess(
				"C:/Users/c/AppData/Roaming/fnm/node-versions/v26.13.1/node_modules/pi-web-ui/dist/server/index.js",
			),
		).toBe(false);
	});

	it("无关的 node 进程不算", () => {
		expect(looksLikeTestProcess("node scripts/lan-dns.mjs --domain player.home")).toBe(false);
		expect(looksLikeTestProcess("node -e setInterval(()=>{},1000)")).toBe(false);
		expect(looksLikeTestProcess("")).toBe(false);
	});
});
