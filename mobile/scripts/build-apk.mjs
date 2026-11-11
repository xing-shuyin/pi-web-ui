// mobile/scripts/build-apk.mjs
// 打 Android debug APK：跑 gradle assembleDebug，成功后把产物复制成仓库根目录的
// pi-web-ui-mobile-<abi>-<revision>-debug.apk（abi / revision 取自内置引擎清单 runtime.json）。
//
// 用法：npm --prefix mobile run apk   （= npm run sync && node scripts/build-apk.mjs）
// 前置：JAVA_HOME、mobile/android/local.properties 的 sdk.dir，以及 assets/localengine 下的运行时分卷。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mobileRoot, "..");
const androidRoot = join(mobileRoot, "android");
const apkPath = join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const manifestPath = join(
	mobileRoot,
	"native",
	"local-engine",
	"android",
	"src",
	"main",
	"assets",
	"localengine",
	"runtime.json",
);

function fail(message) {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}

// Gradle 只在 local.properties / ANDROID_HOME 里找 SDK，缺了会抛一句很难读的
// "SDK location not found" —— 提前说清楚怎么补，别让人去翻 Gradle 日志。
if (!existsSync(join(androidRoot, "local.properties")) && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
	fail(
		`缺少 Android SDK 配置：在 ${join(androidRoot, "local.properties")} 写入 sdk.dir=<SDK 路径>` +
			"（Windows 路径的反斜杠要写成 \\\\），或设置 ANDROID_HOME 环境变量。",
	);
}

// 产物名带上运行时 ABI 与 revision：手机上装的是哪套引擎一眼可辨（真机 arm64 / 模拟器 x86_64）。
let label = "no-runtime";
try {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const abi = String(manifest.abi ?? "").replace(/-v8a$/, "");
	label = `${abi || "unknown"}-${manifest.version ?? "unknown"}`;
} catch {
	console.warn(`! 读不到内置引擎清单 ${manifestPath}：此 APK 不含本机运行环境（本机运行会提示运行环境缺失）。`);
}

const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
console.log(`==> gradle assembleDebug（${androidRoot}）`);
await new Promise((done, reject) => {
	const child = spawn(gradlew, ["assembleDebug", "--console=plain"], {
		cwd: androidRoot,
		stdio: "inherit",
		// Windows 上 .bat 必须经 shell 才能拉起。
		shell: process.platform === "win32",
	});
	child.on("error", reject);
	child.on("exit", (code, signal) => {
		if (code === 0) done();
		else reject(new Error(`gradle assembleDebug 失败（code=${code} signal=${signal}）`));
	});
}).catch((cause) => fail(cause.message));

if (!existsSync(apkPath)) fail(`Gradle 返回成功但没有产物：${apkPath}`);

const target = join(repoRoot, `pi-web-ui-mobile-${label}-debug.apk`);
copyFileSync(apkPath, target);
const sizeMB = (statSync(target).size / 1024 / 1024).toFixed(0);
console.log(`\n✓ ${apkPath}\n  → ${target}（${sizeMB} MB）`);
