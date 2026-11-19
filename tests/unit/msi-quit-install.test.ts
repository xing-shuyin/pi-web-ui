import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	buildMsiQuitInstallScript,
	escapePsSingleQuoted,
	MSI_QUIT_INSTALL_MAX_PATH_LENGTH,
	validateMsiPath,
} from "../../desktop/msi-quit-install.js";

const MSI_CHANNEL = "pi-desktop:update-install-local-msi";

describe("msi-quit-install 看门狗脚本", () => {
	it("等待逻辑：按 pid 轮询，500ms 一次，最多 120 秒", () => {
		const script = buildMsiQuitInstallScript("C:\\pkg\\app.msi", 1234);
		expect(script).toContain("Get-Process -Id");
		expect(script).toContain("1234");
		expect(script).toContain("Start-Sleep -Milliseconds 500");
		expect(script).toContain("AddSeconds(120)");
	});

	it("进程消失后跑 msiexec，参数顺序为 /i <msi> /passive", () => {
		const script = buildMsiQuitInstallScript("C:\\pkg\\app.msi", 1234);
		expect(script).toContain("msiexec.exe");
		const argLine = script.split("\n").find((line) => line.includes("msiexec.exe")) ?? "";
		expect(argLine.indexOf("'/i'")).toBeLessThan(argLine.indexOf("app.msi"));
		expect(argLine.indexOf("app.msi")).toBeLessThan(argLine.indexOf("'/passive'"));
	});

	it("结尾自删 ps1，包在 try/catch 里（删不掉不报错）", () => {
		const script = buildMsiQuitInstallScript("C:\\pkg\\app.msi", 1234);
		expect(script).toContain("Remove-Item");
		expect(script).toContain("$MyInvocation.MyCommand.Path");
		const tail = script.split("\n").filter((line) => line.includes("Remove-Item"));
		expect(tail.length).toBe(1);
		expect(tail[0].trim().startsWith("try")).toBe(true);
		expect(tail[0]).toContain("catch");
	});

	it("powershell 单引号转义：' → ''", () => {
		expect(escapePsSingleQuoted("a'b")).toBe("a''b");
		const script = buildMsiQuitInstallScript("C:\\it's\\app.msi", 42);
		expect(script).toContain("it''s");
		expect(script).not.toContain("it's");
	});

	it("非法 pid 直接抛错", () => {
		for (const pid of [0, -1, 1.5, Number.NaN]) {
			expect(() => buildMsiQuitInstallScript("C:\\pkg\\app.msi", pid)).toThrow();
		}
	});
});

describe("validateMsiPath", () => {
	it("真实存在的 .msi 返回规范化绝对路径", () => {
		const dir = mkdtempSync(join(tmpdir(), "msi-test-"));
		try {
			const file = join(dir, "app.msi");
			writeFileSync(file, "fake-msi");
			expect(validateMsiPath(file)).toBe(file);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("拒绝：非 .msi 后缀 / 不存在 / 空 / 控制字符 / 超长", () => {
		const dir = mkdtempSync(join(tmpdir(), "msi-test-"));
		try {
			const exe = join(dir, "app.exe");
			writeFileSync(exe, "x");
			expect(() => validateMsiPath(exe)).toThrow();
			expect(() => validateMsiPath(join(dir, "missing.msi"))).toThrow();
			expect(() => validateMsiPath("")).toThrow();
			expect(() => validateMsiPath("   ")).toThrow();
			expect(() => validateMsiPath("C:\\pkg\\bad\u0007.msi")).toThrow();
			expect(() => validateMsiPath(`${"a".repeat(MSI_QUIT_INSTALL_MAX_PATH_LENGTH + 1)}.msi`)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("msi-quit-install 三面对齐（main / preload / desktop-updater.ts）", () => {
	const root = cwd();
	const mainSource = readFileSync(join(root, "desktop/main.ts"), "utf8");
	const preloadSource = readFileSync(join(root, "desktop/preload.cts"), "utf8");
	const webSource = readFileSync(join(root, "web/src/desktop-updater.ts"), "utf8");

	it("主进程注册了本地 MSI 安装通道，且先过可信桌面请求校验", () => {
		const at = mainSource.indexOf(`ipcMain.handle("${MSI_CHANNEL}"`);
		expect(at).toBeGreaterThan(-1);
		const block = mainSource.slice(at, at + 3000);
		expect(block.indexOf("assertTrustedDesktopRequest(event)")).toBeLessThan(block.indexOf("showOpenDialog"));
	});

	it("选包只认 msi；取消返回 cancelled；非 win32 直接返回不支持", () => {
		const at = mainSource.indexOf(`ipcMain.handle("${MSI_CHANNEL}"`);
		const block = mainSource.slice(at, at + 3000);
		expect(block).toContain('extensions: ["msi"]');
		expect(block).toContain("cancelled");
		expect(block).toContain("unsupported-platform");
	});

	it("原子写 ps1（tmp+rename）→ detached powershell → unref → 成功才 app.quit", () => {
		const at = mainSource.indexOf(`ipcMain.handle("${MSI_CHANNEL}"`);
		const block = mainSource.slice(at, at + 3000);
		expect(block).toContain("writeFileSync(tmp");
		expect(block).toContain("renameSync(tmp, ps1)");
		expect(block).toContain('"powershell.exe"');
		expect(block).toContain('"-File", ps1');
		expect(block).toContain("detached: true");
		expect(block).toContain('stdio: "ignore"');
		expect(block).toContain("windowsHide: true");
		expect(block.indexOf(".unref()")).toBeLessThan(block.indexOf("app.quit()"));
	});

	it("preload 与渲染层桥都暴露 installLocalMsi，同名通道", () => {
		expect(preloadSource).toContain(`ipcRenderer.invoke("${MSI_CHANNEL}")`);
		expect(preloadSource).toContain("installLocalMsi:");
		expect(webSource).toContain("installLocalMsi");
	});
});
