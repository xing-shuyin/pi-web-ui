import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

/**
 * NSIS 安装前清场（FilesInUse 绕行）的三处对齐：
 * `desktop/electron-builder.yml` 的 `nsis.include` → `desktop/installer.nsh` →
 * 关旧版主进程 + 命令行指向安装目录的 node 侧车（docs/architecture-desktop-update.md §十二）。
 *
 * 背景：server 侧车在全局 npm 内核下是系统 node.exe（镜像在安装目录外），
 * electron-builder 自带的 CHECK_APP_RUNNING 两边都匹配不到，覆盖安装就会
 * “Error opening file for writing”卡在进度条。MSI 同类问题见 msi-quit-install。
 */
const root = cwd();
const yml = readFileSync(join(root, "desktop/electron-builder.yml"), "utf8");
const NSH_PATH = "desktop/installer.nsh";

function readNsh(): string {
	const p = join(root, NSH_PATH);
	expect(existsSync(p), `${NSH_PATH} 不存在，yml 的 nsis.include 悬空`).toBe(true);
	return readFileSync(p, "utf8");
}

describe("nsis.include 接线", () => {
	it("yml 把 desktop/installer.nsh 编进 NSIS（相对项目根，getResource 可解）", () => {
		const at = yml.indexOf("include:");
		expect(at).toBeGreaterThan(-1);
		const line = yml.slice(at, yml.indexOf("\n", at));
		expect(line).toContain(NSH_PATH);
	});
});

describe("installer.nsh 清场逻辑", () => {
	it("安装（customInit）与卸载（customUnInstall）都走同一清场宏", () => {
		const nsh = readNsh();
		expect(nsh).toContain("!macro customInit");
		expect(nsh).toContain("!macro customUnInstall");
		const sweep = nsh.match(/!macro (PI_\w+)[\s\S]*?!macroend/);
		expect(sweep, "需要一个共享的清场宏").not.toBeNull();
		const name = sweep![1];
		const inits = nsh.match(/!macro customInit[\s\S]*?!macroend/)![0];
		const uninst = nsh.match(/!macro customUnInstall[\s\S]*?!macroend/)![0];
		expect(inits).toContain(`!insertmacro ${name}`);
		expect(uninst).toContain(`!insertmacro ${name}`);
	});

	it("覆盖两类进程：目录下镜像 + 命令行指向目录的 node 侧车", () => {
		const nsh = readNsh();
		expect(nsh).toContain("ExecutablePath");
		expect(nsh).toContain("$INSTDIR");
		// node 必须带 CommandLine 约束，禁裸杀 node.exe（会误伤用户开发服务）。
		// 用规则写法锚定（name='node.exe'），别命中头注释里的散文。
		const nodeAt = nsh.indexOf("name='node.exe'");
		expect(nodeAt).toBeGreaterThan(-1);
		expect(nsh.slice(Math.max(0, nodeAt - 400), nodeAt + 200)).toContain("CommandLine");
		expect(nsh).not.toContain('taskkill /F /IM "node.exe"');
		expect(nsh).not.toContain("taskkill /F /IM node.exe");
	});

	it("先礼后兵：优雅关闭 → 等待 → 强制，且 PowerShell 被禁时有兜底", () => {
		const nsh = readNsh();
		// 从清场宏体开始找，别命中头注释里的散文（注释里也提了 -Force）。
		const body = nsh.slice(nsh.indexOf("!macro PI_"));
		const graceful = body.indexOf("Stop-Process -Id");
		const force = body.indexOf("-Force");
		expect(graceful).toBeGreaterThan(-1);
		expect(force).toBeGreaterThan(graceful);
		expect(nsh).toContain("Sleep");
		// Restricted 执行策略 / 无 PowerShell 时不静默跳过主流程：有 wmic 兜底。
		expect(nsh).toContain("Restricted");
		expect(nsh).toContain("wmic");
	});
});
