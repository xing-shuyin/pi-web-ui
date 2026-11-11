// mobile/scripts/package-all.mjs
// 一键出全套手机产物：按运行时 ABI 各打一个 debug APK（真机 arm64 + 模拟器 x86_64），
// 产物落到仓库根目录：pi-web-ui-mobile-<abi>-<revision>-debug.apk。
//
// 用法：
//   npm --prefix mobile run apk:all                  # 用 runtime/out/<abi>/ 里现成的运行时打包
//   npm --prefix mobile run apk:all:runtime          # 先用 Docker 重建全部运行时（RUNTIME_REVISION=rN）
//   node scripts/package-all.mjs --abis arm64        # 只打某个 ABI
//
// 说明：APK 的 assets/localengine 只能放一套运行时，所以这里是"换一次 assets 打一次包"，
// 结束后把 assets 恢复成默认 ABI（arm64），保证工作区与真机包一致。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mobileRoot, "..");
const androidRoot = join(mobileRoot, "android");
const runtimeRoot = join(mobileRoot, "local-engine", "runtime");
const outRoot = join(runtimeRoot, "out");
const assetsRoot = join(mobileRoot, "native", "local-engine", "android", "src", "main", "assets", "localengine");
const apkPath = join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const ALL_ABIS = ["arm64", "x86_64"];
const IS_WIN = process.platform === "win32";
const npm = IS_WIN ? "npm.cmd" : "npm";
const gradlew = IS_WIN ? "gradlew.bat" : "./gradlew";
const cap = join(mobileRoot, "node_modules", ".bin", IS_WIN ? "cap.cmd" : "cap");

// ---- 参数 ----
const argv = process.argv.slice(2);
const withRuntime = argv.includes("--with-runtime");
const abisArg = argv.indexOf("--abis");
const abis =
	abisArg >= 0
		? String(argv[abisArg + 1] ?? "")
				.split(",")
				.filter(Boolean)
		: ALL_ABIS;

const repoVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

// 重建运行时会把 revision 写进 runtime.json 并让手机端触发重装，所以必须先由人指定，
// 别在跑完一整轮构建后才报错。
if (withRuntime && !process.env.RUNTIME_REVISION) {
	console.error("✗ 重建运行时需要 RUNTIME_REVISION（如 r8）：RUNTIME_REVISION=r8 npm run apk:all:runtime");
	process.exit(1);
}

function fail(message) {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}

function step(title) {
	console.log(`\n==> ${title}`);
}

function run(command, args, cwd, options = {}) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			// Windows 上 .bat / .cmd 必须经 shell 才能拉起；docker 是 .exe，不经 shell
			// （否则 cmd.exe 会把 bash -c 里的 ; > 当自己的语法解释）。
			shell: options.shell ?? IS_WIN,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) done();
			else reject(new Error(`${command} ${args.join(" ")} 失败（code=${code} signal=${signal}）`));
		});
	});
}

function capture(command, args, cwd) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd, shell: IS_WIN });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk));
		child.stderr?.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? done(out.trim()) : reject(new Error(`${command} 失败（code=${code}）：${out.trim()}`)),
		);
	});
}

/** arm64-v8a → arm64，x86_64 → x86_64（文件名里一眼能看出是哪个 flavor）。 */
function abiLabel(abi) {
	return abi === "x86_64" ? "x86_64" : abi.replace(/-v8a$/, "");
}

function readManifest(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
	} catch {
		return null;
	}
}

/** 把 runtime/out/<abi>/ 的清单与分卷同步到插件 assets（覆盖上一套，保留目录里的 .gitignore）。 */
function syncAssets(abi) {
	const source = join(outRoot, abi);
	mkdirSync(assetsRoot, { recursive: true });
	// 只清运行时产物本身：与 build-runtime.sh 的 --sync-assets 保持一致，别把 .gitignore 一起删掉。
	for (const entry of readdirSync(assetsRoot)) {
		if (entry === "runtime.json" || entry.startsWith("rootfs.tgz.part-")) {
			rmSync(join(assetsRoot, entry), { force: true });
		}
	}
	for (const entry of readdirSync(source)) {
		if (entry === "runtime.json" || entry.startsWith("rootfs.tgz.part-")) {
			cpSync(join(source, entry), join(assetsRoot, entry));
		}
	}
}

async function buildRuntime(abi, tgz) {
	step(`构建运行时 ${abi}（Docker + qemu，约 3-15 分钟）`);
	const revision = process.env.RUNTIME_REVISION;
	if (!revision) {
		fail("重建运行时需要 RUNTIME_REVISION（如 r8）：它会写进 runtime.json 并触发手机端重装。");
	}
	// 本地 base rootfs 是 docker export 的 ubuntu:24.04（省一次镜像源下载）；没有就让脚本自己拉。
	const baseName = abi === "x86_64" ? "ubuntu-rootfs-amd64.tar" : "ubuntu-rootfs-arm64.tar";
	const baseTar = join(outRoot, baseName);
	if (!existsSync(baseTar)) console.warn(`! 缺少本地 base rootfs ${baseTar}，改为从镜像源下载（更慢）。`);
	const env = [`RUNTIME_REVISION=${revision}`, `PI_WEB_UI_VERSION=${repoVersion}`, `PI_WEB_UI_TGZ=/repo/${tgz}`];
	if (existsSync(baseTar)) env.push(`UBUNTU_BASE_TAR=/repo/mobile/local-engine/runtime/out/${baseName}`);
	const inner = [
		"set -e",
		"apt-get update -qq",
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qemu-user-static curl ca-certificates python3 xz-utils >/dev/null 2>&1",
		`export ${env.join(" ")}`,
		`./build-runtime.sh ${abi}`,
	].join("; ");
	const mount = repoRoot.replace(/\\/g, "/");
	await run(
		"docker",
		[
			"run",
			"--rm",
			"--privileged",
			"-v",
			`${mount}:/repo`,
			"-w",
			"/repo/mobile/local-engine/runtime",
			"ubuntu:24.04",
			"bash",
			"-c",
			inner,
		],
		repoRoot,
		{ shell: false },
	);
}

// ---- 主流程 ----
if (!existsSync(join(androidRoot, "local.properties")) && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
	fail(
		`缺少 Android SDK 配置：在 ${join(androidRoot, "local.properties")} 写入 sdk.dir=<SDK 路径>` +
			"（Windows 反斜杠写成 \\\\），或设置 ANDROID_HOME。",
	);
}

const targets = abis.filter((abi) => ALL_ABIS.includes(abi));
if (targets.length !== abis.length) {
	fail(`未知 ABI：${abis.filter((abi) => !ALL_ABIS.includes(abi)).join(", ")}；可用：${ALL_ABIS.join(", ")}`);
}

if (withRuntime) {
	step("打包前端并与运行时同源（npm run build + npm pack）");
	await run(npm, ["run", "build"], repoRoot);
	const tgz = await capture(npm, ["pack", "--silent"], repoRoot);
	if (!existsSync(join(repoRoot, tgz))) fail(`npm pack 未产出 ${tgz}`);
	console.log(`  包：${tgz}`);
	for (const abi of targets) await buildRuntime(abi, tgz);
	rmSync(join(repoRoot, tgz), { force: true });
}

step("编译手机前端");
await run(npm, ["run", "build"], mobileRoot);

const produced = [];
for (const abi of targets) {
	const manifest = readManifest(join(outRoot, abi));
	if (!manifest) {
		console.warn(`! 跳过 ${abi}：${join(outRoot, abi)} 没有 runtime.json（先跑 npm run apk:all:runtime）。`);
		continue;
	}
	step(`打包 ${abi}（运行时 ${manifest.version} / ${manifest.abi}）`);
	syncAssets(abi);
	await run(cap, ["sync", "android"], mobileRoot);
	await run(gradlew, ["assembleDebug", "--console=plain"], androidRoot);
	if (!existsSync(apkPath)) fail(`Gradle 返回成功但没有产物：${apkPath}`);
	const label = `${abiLabel(manifest.abi)}-${manifest.version}`;
	const target = join(repoRoot, `pi-web-ui-mobile-${label}-debug.apk`);
	cpSync(apkPath, target);
	produced.push({ label, target, mb: (statSync(target).size / 1024 / 1024).toFixed(0) });
}

// 恢复默认 ABI，避免工作区停在"上一个 flavor"上。
const fallback = targets.includes("arm64") ? "arm64" : targets[0];
if (fallback && readManifest(join(outRoot, fallback))) {
	step(`恢复默认运行时 assets（${fallback}）`);
	syncAssets(fallback);
	await run(cap, ["sync", "android"], mobileRoot);
}

console.log("\n===== 产物 =====");
if (produced.length === 0) console.log("（没有产出：运行时目录为空或被跳过）");
for (const item of produced) console.log(`✓ ${item.label.padEnd(12)} ${item.mb.padStart(4)} MB  ${item.target}`);
