// scripts/publish-npm.mjs
// npm 发布包装器：把「构建 → 归一化打包 → 带 OTP 的发布 → staged 自愈」收进一条命令。
//
// 为什么需要它：
//   1) 账号开了 2FA 后，CLI 用「绕过 2FA 的 granular token」发版会被 registry 降级成
//      staged 发布 —— 版本几分钟后才落库，期间重试只会拿到
//      409 Cannot publish over previously staged version；unpublish / 改 dist-tag 更直接 403。
//      带上 --otp（证明确实是本人）才是干净路径。
//   2) npm publish <目录> 内部会重新 pack，tarball 里的 bin 权限位又回到平台默认值（Windows
//      上是 0644），用户会 `Permission denied`。所以这里先 pack 成文件、归一化、复查，再发布文件。
//
// 用法：
//   NPM_OTP=123456 npm run release:npm            # 推荐：OTP 走环境变量
//   npm run release:npm -- --otp=123456           # 等价的手工写法
//   npm run release:npm -- --dry-run              # 构建 + 打包 + 复查，只看会发什么（不上传）
//   npm run release:npm -- --skip-build           # 复用现有 dist/ 重新打包（发布重试场景）
//   npm run release:npm -- --out=release/npm      # 把待发布 tarball 留在指定目录
//   npm run release:npm -- --allow-dirty          # 明知工作区脏也要发（默认拦下）
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, npmCall, publishArgv, runCollect } from "./lib/npm-cli.mjs";
import { packAndNormalize, PackageError } from "./lib/npm-pack.mjs";
import { describeNpmTarball } from "./lib/npm-tarball.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => {
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const otp = value("--otp") ?? process.env.NPM_OTP ?? "";
const dryRun = args.includes("--dry-run");
const allowDirty = args.includes("--allow-dirty");
const skipBuild = args.includes("--skip-build");
const outDir = value("--out");
const STAGED_WAIT_MS = Number(process.env.NPM_STAGED_WAIT_MS ?? 6 * 60 * 1000);

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const name = pkg.name;
const version = pkg.version;
const tag = `v${version}`;

class PublishError extends Error {}

function step(title) {
	console.log(`\n==> ${title}`);
}

/** 业务性失败：打印后以 1 退出（由 main 统一收口，别在子进程还活着时 process.exit）。 */
function fail(message) {
	throw new PublishError(message);
}

const git = (argv) => ({ command: "git", argv, shell: false, cwd: repoRoot });

/** 线上是否已经有这个版本（发布成功的唯一硬证据）。 */
async function publishedOnRegistry() {
	try {
		const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
			headers: { "cache-control": "no-cache" },
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForStagedPublish() {
	const started = Date.now();
	while (Date.now() - started < STAGED_WAIT_MS) {
		if (await publishedOnRegistry()) return true;
		process.stdout.write(".");
		await new Promise((done) => setTimeout(done, 15_000));
	}
	console.error(`\n✗ 等了 ${Math.round(STAGED_WAIT_MS / 60000)} 分钟仍未落库。`);
	console.error(`  去 https://www.npmjs.com/package/${name} 用 2FA 批准这次 staged 发布，`);
	console.error("  或者等它自己完成后再发下一版（期间重试只会 409）。");
	return false;
}

async function main() {
	if (otp && !/^\d{6,8}$/.test(otp)) fail("OTP 应该只是一串 6–8 位数字。");

	step(`${name}@${version} 发布前检查`);
	const who = await capture(npmCall(["whoami"], { cwd: repoRoot }));
	if (!who) fail("npm whoami 没有返回账号，先确认已登录（npm login）。");
	console.log(`  账号：${who}`);

	const dirty = await capture(git(["status", "--porcelain"]));
	if (dirty && !allowDirty && !dryRun) {
		console.error(dirty.split("\n").slice(0, 15).join("\n"));
		fail("工作区有未提交改动：npm 包打的是工作区，会和 tag / 提交对不上。先提交，或加 --allow-dirty。");
	}

	const tagSha = await capture(git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]));
	if (!tagSha) console.warn(`  ! 本地没有 ${tag} 这个 tag：确认版本号是否已经升过、要不要先打 tag。`);
	else console.log(`  tag ${tag} → ${tagSha.slice(0, 9)}`);

	if (await publishedOnRegistry()) {
		console.log(`\n✓ registry 上已经有 ${name}@${version}，无需重复发布。`);
		return 0;
	}

	if (!otp && !dryRun) {
		console.log(
			"\n  ! 没有提供 OTP（NPM_OTP 或 --otp=）：用「绕过 2FA 的 token」时 registry 会把这次发布\n" +
				"    降级成 staged，等几分钟才落库。想干净发布就把 6 位验证码放进来。",
		);
	}

	step(skipBuild ? "构建（--skip-build：复用现有 dist/）" : "构建发布产物");
	if (!skipBuild) {
		const build = await runCollect(npmCall(["run", "build:release"], { cwd: repoRoot }));
		if (build.code !== 0) fail("构建失败，先修好再用 --skip-build 跳过重复构建。");
	}

	step("打包并归一化 bin 可执行位");
	const destination = outDir ? resolve(repoRoot, outDir) : mkdtempSync(join(tmpdir(), "pi-npm-pack-"));
	let packed;
	try {
		packed = await packAndNormalize({ root: repoRoot, destination });
	} catch (error) {
		fail(error instanceof PackageError ? error.message : String(error));
	}
	for (const line of describeNpmTarball(packed)) console.log(line);
	console.log(`  → ${packed.file}`);
	if (packed.inspection.problems.length) fail("打出的 tarball 不满足发布要求，见上面的 ✗ 行。");

	step(`npm publish ${packed.filename}${dryRun ? "（dry-run）" : ""}`);
	const result = await runCollect(npmCall(publishArgv(packed.file, { otp, dryRun }), { cwd: repoRoot }));

	if (result.code === 0) {
		if (dryRun) {
			console.log(`\n✓ dry-run 完成：发布时会传 ${packed.file}（${(packed.size / 1024 / 1024).toFixed(1)} MB）`);
			return 0;
		}
		console.log(`\n✓ 已发布 ${name}@${version}`);
		return 0;
	}

	// staged：registry 收下了但还在等身份确认。别急着重试（重试只会 409）。
	if (/previously staged version/i.test(result.out)) {
		step("这次发布被 registry 暂存（staged），等待落库");
		console.log(`  期间重试只会拿到 409；批准入口：https://www.npmjs.com/package/${name}`);
		if (await waitForStagedPublish()) {
			console.log(`\n✓ ${name}@${version} 已落库`);
			return 0;
		}
		return 1;
	}

	if (/cannot publish over the previously published versions/i.test(result.out)) {
		fail(`${name}@${version} 已经发布过了；要么升版本号，要么确认线上版本。`);
	}

	fail("npm publish 失败，看上面的输出定位原因。");
}

const code = await main().catch((error) => {
	if (error instanceof PublishError) console.error(`\n✗ ${error.message}`);
	else console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
	return 1;
});
process.exitCode = code;
