// scripts/publish-npm.mjs
// npm 发布包装器：把「带 OTP 的发布」和「staged 发布自愈」收进一条命令。
//
// 为什么需要它：账号开了 2FA 后，CLI 用「绕过 2FA 的 granular token」发版会被 registry
// 降级成 staged 发布 —— 版本几分钟后才落库，期间重试只会拿到
// 409 Cannot publish over previously staged version；unpublish / 改 dist-tag 更直接 403。
// 带上 --otp（证明确实是本人）才是干净路径。
//
// 用法：
//   NPM_OTP=123456 npm run release:npm            # 推荐：OTP 走环境变量
//   npm run release:npm -- --otp=123456           # 等价的手工写法
//   npm run release:npm -- --dry-run              # 只看会打出哪些文件
//   npm run release:npm -- --allow-dirty          # 明知工作区脏也要发（默认拦下）
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const otpArg = args.find((a) => a.startsWith("--otp="));
const otp = otpArg ? otpArg.slice("--otp=".length) : (process.env.NPM_OTP ?? "");
const dryRun = args.includes("--dry-run");
const allowDirty = args.includes("--allow-dirty");
const STAGED_WAIT_MS = Number(process.env.NPM_STAGED_WAIT_MS ?? 6 * 60 * 1000);

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const name = pkg.name;
const version = pkg.version;
const tag = `v${version}`;

// Windows 上 npm 是 npm.cmd，Node 22+ 不允许直接 spawn .cmd；走 npm 自己给的
// npm_execpath（npm-cli.js）用 node 拉起，既不需要 shell 也没有参数拼接的注入面。
// 直接用 node 跑本脚本时没有 npm_execpath，退回 shell（此路径只接受纯数字 OTP）。
const npmCli = process.env.npm_execpath;

class PublishError extends Error {}

function step(title) {
	console.log(`\n==> ${title}`);
}

/** 业务性失败：打印后以 1 退出（由 main 统一收口，别在子进程还活着时 process.exit）。 */
function fail(message) {
	throw new PublishError(message);
}

function npmCall(argv) {
	if (npmCli && /\.js$/.test(npmCli)) return { command: process.execPath, argv: [npmCli, ...argv], shell: false };
	return { command: ["npm", ...argv].join(" "), shell: process.platform === "win32" };
}

function spawnCall({ command, argv, shell }, onData) {
	const child = shell
		? spawn(command, { cwd: repoRoot, shell: true, stdio: ["ignore", "pipe", "pipe"] })
		: spawn(command, argv ?? [], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.on("data", (chunk) => onData?.(chunk.toString()));
	child.stderr?.on("data", (chunk) => onData?.(chunk.toString()));
	return child;
}

/** 跑一条命令，同时回显并收集输出（要按 registry 的响应内容分流，不能只继承 stdio）。 */
function runCollect(call) {
	return new Promise((done) => {
		let out = "";
		const child = spawnCall(call, (text) => {
			out += text;
			process.stdout.write(text);
		});
		child.on("error", (err) => done({ code: 1, out: out + String(err) }));
		child.on("exit", (code) => done({ code: code ?? 1, out }));
	});
}

function capture(call) {
	return new Promise((done) => {
		let out = "";
		const child = spawnCall(call, (text) => (out += text));
		child.on("error", () => done(""));
		child.on("exit", () => done(out.trim()));
	});
}

const git = (argv) => ({ command: "git", argv, shell: false });

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
		await new Promise((r) => setTimeout(r, 15_000));
	}
	console.error(`\n✗ 等了 ${Math.round(STAGED_WAIT_MS / 60000)} 分钟仍未落库。`);
	console.error(`  去 https://www.npmjs.com/package/${name} 用 2FA 批准这次 staged 发布，`);
	console.error("  或者等它自己完成后再发下一版（期间重试只会 409）。");
	return false;
}

async function main() {
	if (otp && !/^\d{6,8}$/.test(otp)) fail("OTP 应该只是一串 6–8 位数字。");

	step(`${name}@${version} 发布前检查`);
	const who = await capture(npmCall(["whoami"]));
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

	step(`npm publish${dryRun ? "（dry-run）" : ""}`);
	const publishArgs = ["publish"];
	if (dryRun) publishArgs.push("--dry-run");
	if (otp) publishArgs.push(`--otp=${otp}`);
	const result = await runCollect(npmCall(publishArgs));

	if (result.code === 0) {
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

const code = await main().catch((err) => {
	if (err instanceof PublishError) console.error(`\n✗ ${err.message}`);
	else console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
	return 1;
});
process.exitCode = code;
