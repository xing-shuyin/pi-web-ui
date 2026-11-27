/**
 * electron-builder afterPack 钩子：
 * 当 macOS 打包没有配置 Apple 开发者签名证书（CSC_LINK 为空）时，
 * Electron 预编译二进制自带的 linker-signed adhoc 签名会因为资源/Info.plist 被修改而损坏
 * （"code has no resources but signature indicates they must be present"）。
 * 这里补做一次完整的深度 ad-hoc 签名并校验，确保 .app 签名结构合法。
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	if (process.env.CSC_LINK && process.env.CSC_LINK.trim()) {
		console.log("[mac-after-pack] 检测到 CSC_LINK，跳过 ad-hoc 签名，交由 electron-builder 正式签名");
		return;
	}
	const appName = `${context.packager.appInfo.productFilename}.app`;
	const appPath = join(context.appOutDir, appName);
	console.log(`[mac-after-pack] 未配置 Apple 证书，对 ${appPath} 执行完整 ad-hoc 签名`);
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
	execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
	console.log("[mac-after-pack] ad-hoc 签名及严格校验通过");
}
