import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeWebBuild,
	missingWebBuildLabel,
	resolveWebBuild,
	WEB_BUILD_REPAIR_COMMAND,
	webBuildDiagnosticHtml,
	webBuildHealth,
} from "../../server/web-build.js";

/**
 * 「这份安装能不能提供界面」的守卫（`docs/architecture-kernel.md` §界面资源缺失）。
 *
 * 实机故障：新桌面端连着旧的/装了一半的全局 npm 包内核，`web/dist` 目录在、`index.html` 不在，
 * 内核照常起、`/api/health` 照常 ok，然后每个页面请求都回 503「正在更新 pi-web-ui，请稍后刷新…」——
 * 没有在更新、不会自愈、没有进度，壳还把这张错误页当成界面就绪。判定必须只认入口文件。
 */
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-build-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveWebBuild", () => {
	it("有 index.html 才算可用", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "web", "dist"), { recursive: true });
		writeFileSync(join(dir, "web", "dist", "index.html"), "<!doctype html>");
		const state = resolveWebBuild(join(dir, "web", "dist"));
		expect(state.ok).toBe(true);
		expect(describeWebBuild(state)).toContain("可用");
		expect(missingWebBuildLabel(state)).toBeNull();
	});

	it("只有目录、没有入口 → 不可用（这是实机踩到的那一种）", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "web", "dist"), { recursive: true });
		writeFileSync(join(dir, "web", "dist", "favicon.svg"), "<svg/>");
		const state = resolveWebBuild(join(dir, "web", "dist"));
		expect(state.ok).toBe(false);
		expect(missingWebBuildLabel(state)).toBe("web/dist/index.html");
		expect(webBuildHealth(state)).toEqual({ ok: false, missing: "web/dist/index.html" });
	});

	it("目录整个不在 → 单独分类（区分“没装”和“装到一半”）", () => {
		const state = resolveWebBuild(join(tempDir(), "web", "dist"));
		expect(state.ok).toBe(false);
		expect(missingWebBuildLabel(state)).toBe("web/dist");
		expect(webBuildHealth(state)).toEqual({ ok: false, missing: "web/dist" });
	});
});

describe("webBuildDiagnosticHtml", () => {
	const html = webBuildDiagnosticHtml(
		{ ok: false, dir: "/data/web/dist", entry: "/data/web/dist/index.html", reason: "missing-entry" },
		{ version: "0.122.0", installKind: "全局 npm 包", now: 0 },
	);

	it("说清缺什么、怎么修，而不是谎报“正在更新”", () => {
		expect(html).toContain("web/dist/index.html");
		expect(html).toContain(WEB_BUILD_REPAIR_COMMAND);
		expect(html).toContain("v0.122.0");
		expect(html).toContain("全局 npm 包");
		expect(html).not.toContain("正在更新");
	});

	it("自包含 + 自动重试：不引用 web/dist 里的任何资源，装好后自己恢复", () => {
		expect(html).toContain('http-equiv="refresh"');
		expect(html).not.toMatch(/<(script|link)\b/i);
	});

	it("不把本机绝对路径写进页面", () => {
		expect(html).not.toContain("/data/web/dist");
	});
});

describe("内核与服务端接线（源码守卫）", () => {
	const index = readFileSync(join(cwd(), "server/index.ts"), "utf8");
	const shell = readFileSync(join(cwd(), "browser/renderer/shell.ts"), "utf8");
	const host = readFileSync(join(cwd(), "desktop/browser-host.ts"), "utf8");

	it("服务端不再用「正在更新」这句话回答打不开的页面", () => {
		expect(index).not.toContain("正在更新 pi-web-ui");
		expect(index).toContain("webBuildDiagnosticHtml");
		expect(index).toContain("resolveWebBuild(webDist)");
	});

	it("/api/health 上报界面资源完整性（壳靠它区分“活着”和“能提供界面”）", () => {
		expect(index).toContain("web: webBuildHealth(resolveWebBuild(webDist))");
	});

	it("壳在页面加载完之后再核一次装包完整性", () => {
		expect(host).toContain("probeAgentBuild");
		expect(host).toContain("setKernelRepair");
	});

	it("失败态不许把覆盖层收起：agentReady 也可能是错误页加载完成", () => {
		expect(shell).toMatch(/const broken = Boolean\(next\.agentError \|\| repair\)/);
		expect(shell).toMatch(/!next\.agentReady \|\| broken/);
		expect(shell).toContain("kernelRepairTitle");
	});

	it("失败态必须有退出出口，并把壳的窗口按钮放回来（Agent 模式下 chrome 本来整条隐藏）", () => {
		expect(shell).toContain("bootExit");
		expect(shell).toMatch(/next\.mode === "browser" \|\| agentBroken/);
	});
});
