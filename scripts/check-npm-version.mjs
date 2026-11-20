// scripts/check-npm-version.mjs
// npm 版本自检：仓库里的版本号是否真的发到 registry 了（issue #949）。
//
// 存在的原因：发布流程里「发 npm」（docs/release.md 第 8 步）是唯一必须本地带 OTP 手动跑的一步，
// 而 tag 一推就自动出 Release 说明、桌面包、浏览器扩展，手机包另有 release:check 盯着 ——
// 于是「tag 打完了、Release 资产也齐、唯独 npm 落后两个版本」这种漂移全绿通过，没人发现，
// 直到用户 `npm i -g pi-web-ui` 拿到几周前的包。
//
// 口径：
//   · registry 上必须有 package.json 的当前版本；
//   · `latest` dist-tag 必须就是这一版（否则全局安装仍装到旧版）；
//   · registry 比本地新 = 本地落后（多半忘了拉代码就发版）。
//
// 用法：
//   npm run release:check:npm                 # 对比 package.json 与 registry
//   node scripts/check-npm-version.mjs --tag v0.121.3   # 指定要比对的版本（发版流程里用 tag）
//   node scripts/check-npm-version.mjs --quiet          # 正常时不打印（嵌入别的检查用）
//
// 只读 registry，不需要 npm 登录态。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateNpmVersion } from "./lib/npm-version.mjs";

const REGISTRY = "https://registry.npmjs.org";

function parseArgs(argv) {
	const out = { tag: undefined, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--quiet") out.quiet = true;
		else if (a === "--tag") out.tag = argv[++i];
		else if (a.startsWith("--tag=")) out.tag = a.slice(6);
	}
	return out;
}

async function fetchRegistryDoc(name) {
	const url = `${REGISTRY}/${name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name)}`;
	const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
	if (response.status === 404) return { doc: null, networkError: null };
	if (!response.ok) return { doc: null, networkError: `registry 返回 HTTP ${response.status}` };
	return { doc: await response.json(), networkError: null };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = args.tag ? String(args.tag).replace(/^v/, "") : pkg.version;

if (!args.quiet) console.log(`==> 校验 ${pkg.name}@${version} 是否已发布到 npm`);

let fetched;
try {
	fetched = await fetchRegistryDoc(pkg.name);
} catch (error) {
	console.error(`✗ 访问 registry 失败：${error instanceof Error ? error.message : String(error)}`);
	console.error("  （网络问题不代表发版失败；稍后重跑或手动 npm view 确认）");
	process.exit(1);
}
if (fetched.networkError) {
	console.error(`✗ ${fetched.networkError}（不代表发版失败；稍后重跑或手动 npm view 确认）`);
	process.exit(1);
}

const result = evaluateNpmVersion({ name: pkg.name, version, doc: fetched.doc });
if (result.ok) {
	if (!args.quiet) console.log(`✓ npm 已是最新（${pkg.name}@${version}，latest = ${result.latest}）`);
	process.exit(0);
}

console.error("✗ npm 上缺少当前版本：");
for (const problem of result.problems) console.error(`  · ${problem}`);
console.error("\n  发布（需要账号 2FA 的 6 位验证码）：");
console.error("    NPM_OTP=<验证码> npm run release:npm");
console.error("  细节见 docs/release.md 第 8 步。");
process.exit(1);
