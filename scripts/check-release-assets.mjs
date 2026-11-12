// scripts/check-release-assets.mjs
// 发版自检：某个 tag 的 GitHub Release 资产是否齐全（桌面包 3 平台 + 浏览器扩展 + 手机 APK + 校验和）。
//
// 存在的原因：打 tag 只会自动出桌面 / 扩展 / Release 说明，手机 APK 必须本地跑一次
// `npm run release:local -- vX.Y.Z --skip-desktop` 才会上传（mobile-release 是手动 workflow）。
// 这一步最容易在发完 tag 后忘掉，忘了就是「Release 里没手机包」，肉眼很难立刻发现。
// 所以把它做成一条命令：任何会话 / 任何人跑一下就知道缺什么。
//
// 用法：
//   npm run release:check                 # 检查最新 tag
//   npm run release:check -- v0.120.0     # 检查指定 tag
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const tagArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const tag = tagArg ?? `v${version}`;

/** 资产分组：每组至少命中一条；手机包额外要求版本号对得上。 */
const REQUIRED = [
	{ key: "Windows 安装包", test: (n) => /setup\.exe$/.test(n) },
	{ key: "macOS 安装包", test: (n) => /\.dmg$/.test(n) || /-mac\.zip$/.test(n) },
	{ key: "Linux 安装包", test: (n) => /\.AppImage$/.test(n) },
	{ key: "浏览器扩展", test: (n) => /^page-picker-extension.*\.zip$/.test(n) },
	{ key: "手机 APK", test: (n) => /\.apk$/.test(n) },
	{ key: "校验和", test: (n) => /^SHA256SUMS\.txt$/.test(n) },
];

function gh(args) {
	const result = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		console.error(`✗ gh ${args.join(" ")} 失败：${(result.stderr || result.stdout || "").trim()}`);
		process.exit(1);
	}
	return result.stdout;
}

console.log(`==> 检查 ${tag} 的 Release 资产`);

let assets = gh(["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"])
	.split("\n")
	.map((line) => line.trim().replace(/^"|"$/g, ""))
	.filter(Boolean);

if (assets.length === 0) {
	console.error(`✗ ${tag} 没有 Release，或者 Release 里没有任何资产（tag 推了吗？）`);
	process.exit(1);
}

const tagVersion = tag.replace(/^v/, "");
const missing = [];
for (const group of REQUIRED) {
	const hits = assets.filter((name) => group.test(name));
	if (hits.length === 0) {
		missing.push(group.key);
		continue;
	}
	console.log(`✓ ${group.key.padEnd(12)} ${hits.join(", ")}`);
}

// 手机包点名要本版那个：旧 revision 的 APK 混在里面同样算错。
const apks = assets.filter((name) => /\.apk$/.test(name));
const apkForTag = apks.filter((name) => name.includes(`-${tagVersion}-`));
if (apks.length > 0 && apkForTag.length === 0) {
	missing.push(`手机 APK 版本不符（有 ${apks.join(", ")}，没有含 ${tagVersion} 的）`);
}

if (missing.length > 0) {
	console.error(`\n✗ ${tag} 还缺：${missing.join("、")}`);
	if (missing.some((m) => m.includes("APK"))) {
		console.error("  补手机包：npm run release:local -- " + tag + " --skip-desktop --reuse-runtime");
		console.error("  （服务端代码有改动就去掉 --reuse-runtime 重建运行时；详见 docs/release.md 8.6）");
	}
	process.exit(1);
}

console.log(`\n✓ ${tag} 资产齐全（${assets.length} 个）`);
