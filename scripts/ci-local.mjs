#!/usr/bin/env node
// ci-local：在本地按 `.github/workflows/ci.yml` 的步骤与顺序复刻 CI 门禁。
//
// 它解决的是「本地绿、远程红」里唯一能根治的那一类：**本地根本没跑 CI 跑的东西**。
// 典型漏跑项（都在 CI 必跑、本地文档里却写「交给 CI」）：
//   format:check / lint / check:protocol / i18n:check / 插件 bundle 重建 diff /
//   browser extension 打包 / vitest 两池 / 分层 smoke。
//
// 环境差异（OS、Node 大版本、`npm ci` 依赖树、Linux 大小写敏感）它治不了——
// 跑完会在结尾明确列出「本次本地门禁覆盖不到的部分」，别把本地绿当成万无一失。
//
// 用法：
//   npm run ci:local                     # = --profile full（复刻 push main 的完整门禁）
//   npm run ci:local -- --profile pr     # = PR 门禁（smoke 只跑 --core 快检子集）
//   npm run ci:local -- --profile static # 只跑静态门禁（pre-push 钩子的默认档）
//   npm run ci:local -- --list           # 列出步骤与归属档位
//   npm run ci:local -- --only unit,i18n # 只跑指定步骤
//   npm run ci:local -- --from build     # 从某步开始跑到最后
//   npm run ci:local -- --install        # 先 npm ci + mobile ci（会重装 node_modules，慢）
//
// 每一步都经 scripts/safe-exec.mjs 执行：硬超时 + 杀进程树 + 原始日志落盘 `.safe-exec/`，
// 卡住的 watch/等 stdin 类命令不会把门禁永久挂死。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_EXEC = join(ROOT, "scripts", "safe-exec.mjs");
const CI_NODE_MAJOR = 22; // .github/workflows/ci.yml: node-version: 22

/** @typedef {{ id: string; title: string; cmd: string; cwd?: string; timeout?: number; tier: string[] }} Step */

/** @type {Step[]} */
const STEPS = [
	{
		id: "install",
		title: "npm ci（含 mobile 子包）",
		cmd: "npm ci && npm --prefix mobile ci --no-audit --no-fund",
		timeout: 1800,
		tier: ["install"],
	},
	{
		id: "format",
		title: "格式（CI: Check formatting）",
		cmd: "npm run format:check",
		timeout: 600,
		tier: ["static", "pr", "full"],
	},
	{ id: "lint", title: "Lint（oxlint）", cmd: "npm run lint", timeout: 600, tier: ["static", "pr", "full"] },
	{
		id: "protocol",
		title: "协议单源（check-protocol-sync）",
		cmd: "npm run check:protocol",
		timeout: 300,
		tier: ["static", "pr", "full"],
	},
	{
		id: "i18n",
		title: "语言包对齐（i18n:check）",
		cmd: "npm run i18n:check",
		timeout: 600,
		tier: ["static", "pr", "full"],
	},
	{
		id: "typecheck",
		title: "类型检查（5 个 tsconfig + mobile）",
		cmd: "npm run typecheck && npm --prefix mobile run typecheck",
		timeout: 1800,
		tier: ["static", "pr", "full"],
	},
	{ id: "build", title: "构建（web + server + vendor）", cmd: "npm run build", timeout: 2400, tier: ["pr", "full"] },
	{
		id: "bundle:db-client",
		title: "重建 db-client 客户端 bundle",
		cmd: "node build.mjs",
		cwd: join(ROOT, "plugins", "db-client"),
		timeout: 600,
		tier: ["pr", "full"],
	},
	{
		id: "bundle:vscode-editor",
		title: "重建 vscode-editor 客户端 bundle",
		cmd: "node build.mjs",
		cwd: join(ROOT, "plugins", "vscode-editor"),
		timeout: 900,
		tier: ["pr", "full"],
	},
	{
		id: "bundle:diff",
		title: "生成物已提交（git diff --exit-code，等价 CI 那步）",
		cmd:
			"git diff --exit-code -- plugins/db-client/client/entry.mjs plugins/vscode-editor/client/entry.mjs " +
			"plugins/mermaid/client/vendor plugins/run-trace/client/vendor",
		timeout: 300,
		tier: ["pr", "full"],
	},
	{
		id: "extension:build",
		title: "构建浏览器扩展",
		cmd: "npm run build:extension",
		timeout: 900,
		tier: ["pr", "full"],
	},
	{
		id: "extension:pack",
		title: "打包浏览器扩展（自校验 zip）",
		cmd: "npm run pack:extension",
		timeout: 900,
		tier: ["pr", "full"],
	},
	{ id: "unit", title: "单测（vitest 默认池）", cmd: "npx vitest run", timeout: 3600, tier: ["pr", "full"] },
	{
		id: "integration",
		title: "集成测试（真 git / 真子进程 / 真 Hub）",
		cmd: "npm run test:integration",
		timeout: 3600,
		tier: ["pr", "full"],
	},
	{
		id: "smoke:core",
		title: "协议冒烟 --core（PR 快检子集）",
		cmd: "node tests/run-smoke.mjs --core --retry-once --jobs=4 --no-build",
		timeout: 1800,
		tier: ["pr"],
	},
	{
		id: "smoke:full",
		title: "协议冒烟 全量（push main 才跑，本地最容易漏的一步）",
		cmd: "node tests/run-smoke.mjs --retry-once --jobs=4 --no-build",
		timeout: 3600,
		tier: ["full"],
	},
];

const PROFILES = new Set(["static", "pr", "full"]);

function usage(exitCode = 0) {
	console.log(`[ci-local] 本地复刻 CI 门禁（步骤定义见 scripts/ci-local.mjs，对照 .github/workflows/ci.yml）

用法:
  node scripts/ci-local.mjs [--profile static|pr|full] [--only id,id] [--from id] [--install] [--list]

档位:
  static  格式 + lint + 协议 + 语言包 + 类型（pre-push 钩子默认档，约 1-3 分钟）
  pr      上面全部 + 构建 + 生成物 diff + 扩展打包 + 单测 + 集成 + smoke --core（≈ PR CI）
  full    上面全部 + smoke 全量（≈ push main CI，默认档）

退出码: 0 全绿 · 1 有步骤失败 · 124 某步骤被硬超时 · 2 用法错误`);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const opts = { profile: "full", only: null, from: null, install: false, list: false };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		const [flag, inline] = token.includes("=")
			? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
			: [token, null];
		const value = () => inline ?? argv[++i];
		switch (flag) {
			case "--profile":
				opts.profile = value();
				break;
			case "--only":
				opts.only = (value() ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				break;
			case "--from":
				opts.from = value();
				break;
			case "--install":
				opts.install = true;
				break;
			case "--list":
				opts.list = true;
				break;
			case "-h":
			case "--help":
				usage(0);
				break;
			default:
				console.error(`[ci-local] 未知参数：${token}`);
				usage(2);
		}
	}
	if (!PROFILES.has(opts.profile)) {
		console.error(`[ci-local] --profile 只能是 ${[...PROFILES].join(" / ")}，收到：${opts.profile}`);
		usage(2);
	}
	return opts;
}

/** 选定本次要跑的步骤：档位 → --only → --from / --install。 */
function selectSteps(opts) {
	let list = STEPS.filter((s) => s.tier.includes(opts.profile));
	if (opts.install) {
		const install = STEPS.find((s) => s.id === "install");
		if (install) list = [install, ...list];
	}
	if (opts.only) {
		const wanted = new Set(opts.only);
		const unknown = opts.only.filter((id) => !STEPS.some((s) => s.id === id));
		if (unknown.length) {
			console.error(`[ci-local] --only 里有不存在的步骤：${unknown.join(", ")}（--list 看全部 id）`);
			process.exit(2);
		}
		list = STEPS.filter((s) => wanted.has(s.id));
	}
	if (opts.from) {
		const idx = list.findIndex((s) => s.id === opts.from);
		if (idx === -1) {
			console.error(`[ci-local] --from ${opts.from} 不在本次档位 ${opts.profile} 的步骤里（--list 看全部 id）`);
			process.exit(2);
		}
		list = list.slice(idx);
	}
	return list;
}

function git(args) {
	try {
		return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

/** 开跑前的「对不齐」清单：CI 能看见而本地看不见 / 反之。 */
function printParityWarnings() {
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
	const warns = [];

	if (nodeMajor !== CI_NODE_MAJOR) {
		warns.push(
			`Node 版本：本地 v${process.versions.node}，CI 用 Node ${CI_NODE_MAJOR}。新语法/新 API 在 22 上不存在时只有 CI 会红 —— 建议 fnm use ${CI_NODE_MAJOR} 复跑一次。`,
		);
	}
	if (process.platform !== "linux") {
		warns.push(
			`平台：${process.platform}。Linux 大小写敏感 import、chmod/权限、PTY、/dev/null 语义、长路径等差异本地无法自证；要彻底对齐用容器跑同一档位（见 docs/development.md 的「本地复刻 CI」一节）。`,
		);
	}
	if (dirty.length > 0) {
		warns.push(
			`工作区有 ${dirty.length} 个未提交改动：CI 只看「提交内容 + 干净检出」，本地测试读的是工作区。推之前确认该 add 的都 add 了（尤其 locales/*.json、插件 bundle、dist 之外的生成物）。`,
		);
		const syncSensitive = dirty.filter((l) => /locales\/|web\/src\/i18n\/messages\//.test(l));
		if (syncSensitive.length > 0) {
			warns.push(
				`其中 ${syncSensitive.length} 处是语言包相关改动 —— 改了 messages 源就必须 i18n:sync 生成 12 个语言包，否则 CI 的 locales/sync-locales 单测必红。`,
			);
		}
	}
	if (!existsSync(join(ROOT, "node_modules")) && !existsSync(join(ROOT, "mobile", "node_modules"))) {
		warns.push("没看到 node_modules：本次本地门禁与 CI 的 `npm ci` 依赖树不是同一份（--install 可先重装）。");
	}
	if (warns.length === 0) {
		console.log("[ci-local] 环境对齐检查：Node/平台/工作区都没发现已知偏差。\n");
		return;
	}
	console.log("[ci-local] 已知本地 ≠ CI 的偏差（本地绿不等于远程绿的地方）：");
	for (const w of warns) console.log(`  · ${w}`);
	console.log("");
}

function runStep(step) {
	const args = [
		SAFE_EXEC,
		"--stream",
		"--timeout",
		String(step.timeout ?? 1200),
		"--label",
		`ci-${step.id}`,
		"--shell",
		step.cmd,
	];
	if (step.cwd) args.push("--cwd", step.cwd);
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
		child.on("error", (error) => resolve({ code: 127, ms: Date.now() - startedAt, error }));
		child.on("exit", (code) => resolve({ code: code ?? 1, ms: Date.now() - startedAt }));
	});
}

function fmtMs(ms) {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const steps = selectSteps(opts);

	if (opts.list) {
		for (const s of STEPS) console.log(`${s.id.padEnd(18)} ${s.tier.join("/").padEnd(20)} ${s.title}`);
		return 0;
	}

	console.log(`[ci-local] 档位 ${opts.profile} · ${steps.length} 步 · 对照 .github/workflows/ci.yml`);
	console.log(`[ci-local] 步骤：${steps.map((s) => s.id).join(" → ")}\n`);
	printParityWarnings();

	// smoke 步骤按 CI 的口径把插件市场外部源拔掉（CI: PI_WEB_PLUGIN_CATALOG_URL: ""）。
	process.env.PI_WEB_PLUGIN_CATALOG_URL = process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "";

	const results = [];
	for (const [i, step] of steps.entries()) {
		console.log(`\n──────── [${i + 1}/${steps.length}] ${step.id} · ${step.title} ────────`);
		const r = await runStep(step);
		results.push({ step, ...r });
		if (r.code !== 0) {
			console.log(
				`\n[ci-local] ✗ ${step.id} 失败（退出码 ${r.code}${r.code === 124 ? " = 硬超时" : ""}，日志见 .safe-exec/）`,
			);
			break;
		}
		console.log(`[ci-local] ✓ ${step.id}（${fmtMs(r.ms)}）`);
	}

	const failed = results.filter((r) => r.code !== 0);
	console.log("\n──── ci-local 汇总 ────");
	for (const r of results) {
		const mark = r.code === 0 ? "✓" : r.code === 124 ? "⏱" : "✗";
		console.log(`${mark} ${r.step.id.padEnd(18)} ${fmtMs(r.ms).padStart(6)}  ${r.step.title}`);
	}
	const skipped = steps.filter((s) => !results.some((r) => r.step.id === s.id));
	if (skipped.length) console.log(`（未跑到：${skipped.map((s) => s.id).join(", ")}）`);

	if (failed.length === 0) {
		console.log("\n[ci-local] 全部通过。注意：这只覆盖了本档位能覆盖的部分，OS/Node 差异仍需 CI 兜底。");
		return 0;
	}

	console.log(`\n[ci-local] 重跑失败步骤：npm run ci:local -- --profile ${opts.profile} --only ${failed[0].step.id}`);
	return failed[0].code === 124 ? 124 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error("[ci-local] 内部错误：", error);
		process.exit(1);
	});
