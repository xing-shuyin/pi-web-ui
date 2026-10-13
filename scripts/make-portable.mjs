#!/usr/bin/env node
/**
 * 便携版组装脚本。
 *
 * 作用：
 * 1. 将打包好的 win-unpacked 桌面主程序组装为完整的 PiWebUI-Portable 目录；
 * 2. 注入启动器脚本（PiPortable.bat / 启动Pi.bat）、多语言提示文件（checks/）、便携标记（Portable.flag）；
 * 3. 初始化自包含 data/ 目录与 runtime/git 占位结构；
 * 4. 可选生成便于分发的 zip 压缩包。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(repoRoot, "release");
const unpackedDir = join(releaseDir, "win-unpacked");
const portableDir = join(releaseDir, "PiWebUI-Portable");
const launcherDir = join(repoRoot, "launcher");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version || "latest";

const args = process.argv.slice(2);
const skipPack = args.includes("--skip-pack");
const createZip = args.includes("--zip");
const withGit = args.includes("--with-git") || process.env.PI_BUNDLE_PORTABLE_GIT === "1";

const PORTABLE_GIT_URL =
	"https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/PortableGit-2.48.1-64-bit.7z.exe";
const PORTABLE_GIT_FILE = "PortableGit-2.48.1-64-bit.7z.exe";

function run(cmd) {
	console.log(`[make-portable] 执行: ${cmd}`);
	execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

async function main() {
	console.log("=== 开始制作 Pi Web UI 便携版 ===");

	// 1. 调用 electron-builder 打包最新代码到 win-unpacked（除非显式传入 --skip-pack）
	if (!skipPack) {
		console.log("[make-portable] 正在调用 electron-builder 打包最新构建到 win-unpacked...");
		try {
			run("npx electron-builder -c desktop/electron-builder.yml --win dir");
		} catch (err) {
			if (existsSync(unpackedDir)) {
				console.warn(`⚠ electron-builder 打包遇到网络波动（如 504 超时），回落复用已有的 win-unpacked: ${err.message}`);
			} else {
				throw err;
			}
		}
	}

	if (!existsSync(unpackedDir)) {
		console.error(`✖ 找不到 ${unpackedDir}，请先运行打包命令或移除 --skip-pack`);
		process.exit(1);
	}

	// 2. 准备输出目录
	console.log(`[make-portable] 目标便携目录: ${portableDir}`);
	mkdirSync(portableDir, { recursive: true });

	// 3. 复制 app 主程序（先清理旧版本，避免残留旧文件）
	const targetAppDir = join(portableDir, "app");
	console.log(`[make-portable] 正在同步桌面程序到 app/...`);
	if (existsSync(targetAppDir)) {
		rmSync(targetAppDir, { recursive: true, force: true });
	}
	mkdirSync(targetAppDir, { recursive: true });
	cpSync(unpackedDir, targetAppDir, { recursive: true });

	// 4. 复制启动器与说明文件
	console.log(`[make-portable] 正在同步启动脚本与提示文件...`);
	cpSync(join(launcherDir, "PiPortable.bat"), join(portableDir, "PiPortable.bat"));
	cpSync(join(launcherDir, "启动Pi.bat"), join(portableDir, "启动Pi.bat"));
	cpSync(join(launcherDir, "创建桌面快捷方式.bat"), join(portableDir, "创建桌面快捷方式.bat"));
	cpSync(join(launcherDir, "CreateDesktopShortcut.bat"), join(portableDir, "CreateDesktopShortcut.bat"));
	cpSync(join(launcherDir, "README.md"), join(portableDir, "README.md"));
	cpSync(join(launcherDir, "checks"), join(portableDir, "checks"), { recursive: true });

	// 5. 创建便携标记
	writeFileSync(
		join(portableDir, "Portable.flag"),
		"# Pi Web UI Portable Mode Marker\n# This file signals the app to redirect all data paths locally.\n",
		"utf8",
	);

	// 6. 初始化便携数据目录骨架（保持纯净空白，绝不夹带任何本机个人数据）
	console.log(`[make-portable] 正在创建纯净数据隔离目录骨架...`);
	const dataSubdirs = ["agent", "web", "git", "home", "workspace", "electron"];
	for (const sub of dataSubdirs) {
		const targetDir = join(portableDir, "data", sub);
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });
	}

	// 7. 处理 PortableGit
	const runtimeGitDir = join(portableDir, "runtime", "git");
	mkdirSync(runtimeGitDir, { recursive: true });

	if (withGit) {
		const gitExe = join(runtimeGitDir, "cmd", "git.exe");
		if (existsSync(gitExe)) {
			console.log(`[make-portable] 检测到已有内置 PortableGit，跳过下载与解压: ${runtimeGitDir}`);
		} else {
			const cacheDir = join(releaseDir, ".cache");
			mkdirSync(cacheDir, { recursive: true });
			const cacheArchive = join(cacheDir, PORTABLE_GIT_FILE);

			// (1) 下载 PortableGit
			if (!existsSync(cacheArchive) || readFileSync(cacheArchive).length < 50_000_000) {
				console.log(`[make-portable] 正在下载 PortableGit (~60MB): ${PORTABLE_GIT_URL}`);
				try {
					execSync(`curl -fSL -o "${cacheArchive}" "${PORTABLE_GIT_URL}"`, {
						cwd: repoRoot,
						stdio: "inherit",
					});
				} catch (err) {
					console.error(`✖ 下载 PortableGit 失败: ${err.message}`);
					throw err;
				}
			} else {
				console.log(`[make-portable] 复用已缓存的 PortableGit 安装包: ${cacheArchive}`);
			}

			// (2) 解压 PortableGit 到 runtime/git
			console.log(`[make-portable] 正在解压 PortableGit 到 ${runtimeGitDir}...`);
			let extractOk = false;
			if (process.platform === "win32") {
				try {
					execSync(`"${cacheArchive}" -y -o"${runtimeGitDir}"`, {
						cwd: repoRoot,
						stdio: "inherit",
					});
					extractOk = existsSync(gitExe);
				} catch {
					/* try 7z */
				}
			}
			if (!extractOk) {
				try {
					execSync(`7z x "${cacheArchive}" -o"${runtimeGitDir}" -y`, {
						cwd: repoRoot,
						stdio: "inherit",
					});
					extractOk = existsSync(gitExe);
				} catch {
					/* ignore */
				}
			}

			if (extractOk) {
				console.log(`✔ PortableGit 已成功内置打包到: ${runtimeGitDir}`);
			} else {
				console.warn(`⚠ PortableGit 解压未确认成功，请检查目标目录。`);
			}
		}
	} else {
		writeFileSync(
			join(runtimeGitDir, "README.txt"),
			"请将解压后的 PortableGit 文件（如 bin/, cmd/, usr/ 等）放置在本目录下。\n" +
				"启动脚本将自动检测并挂载该便携 Git 环境，无需宿主机安装 Git。\n" +
				"下载地址: https://github.com/git-for-windows/git/releases\n",
			"utf8",
		);
	}

	console.log(`✔ 便携版制作完成: ${portableDir}`);

	// 8. 可选压缩成 zip
	if (createZip) {
		const zipTarget = join(releaseDir, `pi-web-ui-desktop-${version}-portable.zip`);
		console.log(`[make-portable] 正在压缩便携包到 ${zipTarget}...`);
		try {
			if (existsSync(zipTarget)) {
				rmSync(zipTarget, { force: true });
			}
			// 在 Windows 上尝试优先调用 tar，若失败回落 powershell Compress-Archive
			if (process.platform === "win32") {
				try {
					execSync(`tar -a -c -f "${zipTarget}" "PiWebUI-Portable"`, {
						cwd: releaseDir,
						stdio: "inherit",
					});
				} catch {
					execSync(
						`powershell -NoProfile -Command "Compress-Archive -Path '${portableDir}' -DestinationPath '${zipTarget}' -Force"`,
						{ cwd: repoRoot, stdio: "inherit" },
					);
				}
			} else {
				execSync(`zip -r "${zipTarget}" "PiWebUI-Portable"`, { cwd: releaseDir, stdio: "inherit" });
			}
			console.log(`✔ 便携压缩包制作完成: ${zipTarget}`);
		} catch (err) {
			console.warn(`[make-portable] 压缩 zip 失败（不影响目录生成）：${err.message}`);
		}
	}

	console.log("\n便携版使用提示：");
	console.log("1. 直接将 release/PiWebUI-Portable 目录拷贝至 U 盘；");
	console.log("2. 在 U 盘根目录下双击 启动Pi.bat 即可随身运行；");
	console.log("3. 如需完全脱离系统环境，可下载 PortableGit 解压至 runtime/git 目录。");
}

main().catch((err) => {
	console.error("✖ 制作便携版出错：", err);
	process.exit(1);
});
