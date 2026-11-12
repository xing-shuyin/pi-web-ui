// scripts/release-local.mjs
// 本地一键发版：桌面安装包（当前平台）+ 手机 arm64 APK，产物直接挂到同名 GitHub Release。
//
// 为什么本地为主：手机 APK 里带 280 MB 引擎运行时，CI 那份 qemu 构建又慢又每次换 debug 签名
// （新包装不上旧包）；桌面 Windows 安装包本地几分钟就出。
// macOS / Linux 安装包只能在对应系统上打，仍交给 .github/workflows/desktop-release.yml。
//
// 用法：
//   npm run release:local -- v0.120.0                          # 桌面 + 手机，打包并上传
//   npm run release:local -- v0.120.0 --skip-mobile             # 只打桌面
//   npm run release:local -- v0.120.0 --skip-desktop --reuse-runtime  # 只打手机，复用现有运行时（服务端代码没变时才能用）
//   npm run release:local -- v0.120.0 --no-upload               # 只打包，不碰 Release
//   npm run release:local -- v0.120.0 --portable                # 额外出便携版 zip（要内置 Git/Node，较慢）
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const args = process.argv.slice(2);

const tagArg = args.find((a) => !a.startsWith("--"));
const flags = new Set(args.filter((a) => a.startsWith("--")));
const skipMobile = flags.has("--skip-mobile");
const skipDesktop = flags.has("--skip-desktop");
const noUpload = flags.has("--no-upload");
const withPortable = flags.has("--portable");

/**
 * 现有运行时清单，给 --reuse-runtime 用。
 *
 * 注意 `piWebUi`：运行时里装的就是本仓库当前的服务端包（build-runtime.sh 把 `npm pack` 的
 * tgz 装进 rootfs），所以复用的运行时版本与本版不一致时，手机跑的是旧服务端代码——
 * 外壳是新的、后端是旧的，最坑的那种错位。
 */
function readRuntimeManifest() {
	for (const path of [
		join(repoRoot, "mobile/local-engine/runtime/out/arm64/runtime.json"),
		join(repoRoot, "mobile/native/local-engine/android/src/main/assets/localengine/runtime.json"),
	]) {
		if (!existsSync(path)) continue;
		try {
			const json = JSON.parse(readFileSync(path, "utf8"));
			if (typeof json?.version === "string" && json.version.trim()) {
				return { revision: json.version, piWebUi: String(json.piWebUi ?? "(未知)") };
			}
		} catch {}
	}
	return fail(
		"--reuse-runtime 找不到可用的运行时（mobile/local-engine/runtime/out/arm64/runtime.json）。先跑一次 npm run apk:all:runtime。",
	);
}

function fail(message) {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}

function step(title) {
	console.log(`\n==> ${title}`);
}

function run(command, commandArgs, options = {}) {
	return new Promise((done, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: options.cwd ?? repoRoot,
			stdio: "inherit",
			shell: options.shell ?? IS_WIN,
			env: { ...process.env, ...(options.env ?? {}) },
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) done();
			else reject(new Error(`${command} ${commandArgs.join(" ")} 失败（code=${code} signal=${signal}）`));
		});
	});
}

function capture(command, commandArgs, cwd = repoRoot) {
	return new Promise((done, reject) => {
		const child = spawn(command, commandArgs, { cwd, shell: IS_WIN });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk));
		child.stderr?.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? done(out.trim()) : reject(new Error(`${command} 失败：${out.trim()}`))));
	});
}

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

let tag = tagArg;
if (!tag) {
	try {
		tag = await capture("git", ["describe", "--tags", "--exact-match", "HEAD"]);
	} catch {
		fail("没给版本 tag，HEAD 也不在 tag 上。用法：npm run release:local -- vX.Y.Z");
	}
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag 必须形如 vX.Y.Z，收到：${tag}`);
if (tag.slice(1) !== version) {
	fail(`tag ${tag} 与 package.json 版本 ${version} 不一致：先改版本号（package.json + package-lock.json）再发。`);
}
const [major, minor, patch] = version.split(".").map(Number);
const versionCode = major * 10000 + minor * 100 + patch;

step(`发版 ${tag}（桌面${skipDesktop ? "：跳过" : ""}${skipMobile ? "，手机：跳过" : " + 手机 arm64"}）`);

step("构建 web + server");
await run("npm", ["run", "build"]);

const assets = [];

if (!skipDesktop) {
	step("构建桌面外壳并打包");
	await run("npm", ["run", "build:desktop"]);
	if (IS_WIN) {
		// NSIS 安装包在本机出不来：electron-builder 打完要执行刚生成的 setup.exe 去生成卸载器，
		// 这台机器上被系统直接拦掉（ERR_ELECTRON_BUILDER_CANNOT_EXECUTE，exit code null）。
		// 本地因此出免安装 zip；NSIS 安装版仍由 CI 的 windows job 产出。
		await run("npx", [
			"electron-builder",
			"-c",
			"desktop/electron-builder.yml",
			"--win",
			"--dir",
			"--publish",
			"never",
		]);
		// 相对路径：Git Bash 的 GNU tar 会把 "E:..." 当成远程主机名。
		const zipName = `pi-web-ui-desktop-${version}-win-x64-portable.zip`;
		await run("tar", ["-a", "-c", "-f", `release/${zipName}`, "-C", "release/win-unpacked", "."]);
		console.log(`  → release/${zipName}`);
	} else {
		const target = process.platform === "darwin" ? ["--mac"] : ["--linux", "AppImage"];
		await run("npx", ["electron-builder", "-c", "desktop/electron-builder.yml", ...target, "--publish", "never"]);
	}
	if (withPortable) {
		step("打包便携版（内置 Git/Node，较慢）");
		await run("node", ["scripts/make-portable.mjs", "--skip-pack", "--zip", "--with-git", "--with-node"]);
	}
	const releaseDir = join(repoRoot, "release");
	if (existsSync(releaseDir)) {
		for (const name of readdirSync(releaseDir)) {
			// 只收本次版本自己的产物：release/ 里还堆着历史扩展包，别一起发。
			// Windows 上本地只出免安装 zip：NSIS 那步在本机执行不了，残留的 setup.exe 是坏壳，不能发。
			const mine =
				name.includes(`-${version}-`) || name.includes(`-${version}.`) || /^latest(-mac|-linux)?\.yml$/.test(name);
			if (!mine) continue;
			if (IS_WIN && /setup\.exe$/.test(name)) continue;
			if (/\.(exe|dmg|AppImage|zip|blockmap)$/.test(name) || /^latest(-mac|-linux)?\.yml$/.test(name)) {
				assets.push(join(releaseDir, name));
			}
		}
	}
}

if (!skipMobile) {
	// 引擎没变时没必要重建运行时（qemu 那步 15–25 分钟，而且会换 revision → 手机重装引擎）。
	// --reuse-runtime 直接用 mobile/local-engine/runtime/out/arm64 里现成的那份。
	const reuseRuntime = flags.has("--reuse-runtime");
	const runtimeManifest = reuseRuntime ? readRuntimeManifest() : undefined;
	if (runtimeManifest && runtimeManifest.piWebUi !== version && !flags.has("--allow-stale-engine")) {
		// 运行时里嵌的是服务端包：版本对不上就是「新外壳 + 旧后端」，必须先重建。
		fail(
			`复用的运行时装的是 pi-web-ui@${runtimeManifest.piWebUi}，本版是 ${version}——` +
				`手机上会跑旧服务端代码。去掉 --reuse-runtime 重建运行时（15–25 分钟）；` +
				`若确定本版只改了外壳/插件、服务端未变，加 --allow-stale-engine。`,
		);
	}
	const mobileRevision = runtimeManifest?.revision ?? version;
	step(
		reuseRuntime
			? `复用现有运行时（${mobileRevision}）打 arm64 APK`
			: "构建 arm64 运行时并打 APK（qemu 构建约 15–25 分钟）",
	);
	const mobileArgs = ["mobile/scripts/package-all.mjs", "--abis", "arm64"];
	if (!reuseRuntime) mobileArgs.push("--with-runtime");
	await run("node", mobileArgs, {
		env: {
			RUNTIME_REVISION: mobileRevision,
			PI_MOBILE_VERSION: version,
			PI_MOBILE_VERSION_CODE: String(versionCode),
		},
	});
	// 只收刚打出的那一个：按「运行时 revision」算名字（package-all 就是这么命名的），
	// 而不是扫前缀——仓库根目录堆着旧 revision 的 APK，扫前缀会把别人一起传上去。
	const apkName = `pi-web-ui-mobile-arm64-${mobileRevision}-debug.apk`;
	if (!existsSync(join(repoRoot, apkName))) fail(`没有找到刚打出的 ${apkName}（看上面的 package-all 输出）`);
	assets.push(join(repoRoot, apkName));
}

if (assets.length === 0) fail("没有产出任何可发布的文件。");

// 校验和：和资产一起发，下载后能自查。
const sums = assets
	.map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.split(/[\\/]/).pop()}`)
	.join("\n");
const sumsPath = join(repoRoot, "SHA256SUMS.txt");
writeFileSync(sumsPath, sums + "\n");
assets.push(sumsPath);

console.log("\n===== 产物 =====");
for (const path of assets) {
	const mb = (statSync(path).size / 1024 / 1024).toFixed(0);
	console.log(`✓ ${String(mb).padStart(4)} MB  ${path.slice(repoRoot.length + 1)}`);
}

if (noUpload) {
	console.log("\n（--no-upload：没有上传到 GitHub Release）");
	process.exit(0);
}

step(`挂到 GitHub Release ${tag}`);
try {
	await capture("gh", ["release", "view", tag]);
} catch {
	console.log("  Release 还不存在，先创建一个（说明后续可由 release-notes 覆盖）");
	await run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);
}
await run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
console.log(
	`\n✓ 已上传：${await capture("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"])}`,
);
