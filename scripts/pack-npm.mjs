// scripts/pack-npm.mjs
// 打包 CLI：npm pack → 归一化 bin 可执行位（tarball 头里的 mode）→ 复查。
// 为什么需要它：Windows 打包机上 fs 没有 x 位，npm pack 只能写 0644；而 npm 的 bin 链接
// 只在新建符号链接时补权限，链接已存在、目标被重新解压时跳过 —— 用户拿到 644 直接
// `Permission denied`。把可执行位写进产物本身，任何安装路径都能自愈（详见 lib/npm-tarball.mjs）。
//
// 用法：
//   node scripts/pack-npm.mjs                          # 在仓库根目录打出 tarball
//   node scripts/pack-npm.mjs --pack-destination out/  # 指定输出目录（不存在会创建）
//   node scripts/pack-npm.mjs --verify-only <tarball>  # 只复查已有产物（含线上包）
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packAndNormalize, PackageError } from "./lib/npm-pack.mjs";
import { describeNpmTarball, inspectNpmTarball } from "./lib/npm-tarball.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const destinationArg = args.find((arg) => arg.startsWith("--pack-destination="))?.slice("--pack-destination=".length);
const destinationFlag = args.indexOf("--pack-destination");
const destination = destinationArg ?? (destinationFlag === -1 ? undefined : args[destinationFlag + 1]) ?? undefined;
const verifyIndex = args.indexOf("--verify-only");
const verifyTarget = verifyIndex === -1 ? undefined : args[verifyIndex + 1];

const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
};

function report({ changes, inspection }) {
	for (const line of describeNpmTarball({ changes, inspection })) console.log(line);
}

if (verifyIndex !== -1 && !verifyTarget) {
	fail("--verify-only 需要一个 tarball 路径");
} else if (verifyTarget) {
	const inspection = inspectNpmTarball(readFileSync(resolve(verifyTarget)));
	report({ inspection });
	if (inspection.problems.length) fail(`${verifyTarget} 不满足发布要求`);
	else console.log(`✓ ${verifyTarget}`);
} else {
	try {
		const packed = await packAndNormalize({ root: repoRoot, destination });
		report(packed);
		console.log(`\n${packed.file}（${(packed.size / 1024 / 1024).toFixed(1)} MB）`);
		if (packed.inspection.problems.length) fail("打出的 tarball 不满足发布要求");
		else console.log(`✓ ${packed.filename}`);
	} catch (error) {
		fail(error instanceof PackageError ? error.message : String(error));
	}
}
