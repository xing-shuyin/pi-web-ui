/**
 * MSI 本地安装的看门狗脚本（desktop/main.ts 的 `pi-desktop:update-install-local-msi` 用）。
 *
 * 背景：MSI（WiX）安装器不会主动关闭正在运行的旧版应用，用户手动装 MSI 会被 FilesInUse 卡住。
 * 修法：应用内提供「退出并安装本地 MSI」——选包 → 起一个 detached 看门狗等本进程退出 →
 * 跑 msiexec → 应用自己退出。
 *
 * 纯函数模块：只用 node:fs / node:path，不 import electron，单测可直接跑。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** 看门狗最长等 120 秒：给应用留出退出时间，又不让 msiexec 永远不跑。 */
export const MSI_QUIT_INSTALL_WAIT_SECONDS = 120;
/** 轮询间隔 500ms：退出瞬间尽快跟上，又不空转 CPU。 */
export const MSI_QUIT_INSTALL_POLL_MS = 500;
/** 路径超长直接拒绝：Windows 上限 32767，这里收紧到 4096，超了基本是注入或拼错。 */
export const MSI_QUIT_INSTALL_MAX_PATH_LENGTH = 4096;

/** PowerShell 单引号字符串转义：`'` → `''`（双写）。 */
export function escapePsSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
}

function fail(reason: string): never {
	throw new Error(`invalid msi path: ${reason}`);
}

/**
 * 校验用户选的 .msi 路径，返回规范化绝对路径。
 * 拒绝：空 / 超长 / 控制字符 / 非 .msi 后缀 / 不存在的文件。
 */
export function validateMsiPath(p: string): string {
	if (typeof p !== "string" || !p.trim()) fail("empty path");
	if (p.length > MSI_QUIT_INSTALL_MAX_PATH_LENGTH) fail("path too long");
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1F\x7F]/.test(p)) fail("control characters");
	const abs = resolve(p);
	if (abs.length > MSI_QUIT_INSTALL_MAX_PATH_LENGTH) fail("path too long");
	if (!abs.toLowerCase().endsWith(".msi")) fail("not a .msi file");
	if (!existsSync(abs)) fail("file does not exist");
	return abs;
}

/**
 * 生成看门狗 ps1：循环 `Get-Process -Id <pid>`（500ms 一次，最多 120 秒）→ 进程消失后
 * `Start-Process msiexec.exe -ArgumentList '/i', <msi>, '/passive'` → 最后自删 ps1
 *（自删包在 try/catch 里，删不掉不报错）。
 */
export function buildMsiQuitInstallScript(msiPath: string, appPid: number): string {
	if (!Number.isInteger(appPid) || appPid <= 0) throw new Error("invalid app pid");
	const msi = escapePsSingleQuoted(msiPath);
	const lines = [
		"# pi-web-ui: wait for the app to quit, then install the local MSI (FilesInUse bypass).",
		`$appPid = ${appPid}`,
		`$deadline = (Get-Date).AddSeconds(${MSI_QUIT_INSTALL_WAIT_SECONDS})`,
		"while ($true) {",
		"  try {",
		"    $null = Get-Process -Id $appPid -ErrorAction Stop",
		"  } catch {",
		"    break",
		"  }",
		"  if ((Get-Date) -ge $deadline) { break }",
		`  Start-Sleep -Milliseconds ${MSI_QUIT_INSTALL_POLL_MS}`,
		"}",
		`Start-Process -FilePath msiexec.exe -ArgumentList '/i', '${msi}', '/passive'`,
		"try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction Stop } catch { }",
		"",
	];
	return lines.join("\n");
}
