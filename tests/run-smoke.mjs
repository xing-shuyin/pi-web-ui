#!/usr/bin/env node
import "./lib/hide-windows.mjs";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREBUILT_ENV } from "./lib/ensure-build.mjs";
import { freeTestPort, killTree } from "./lib/process-cleanup.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

process.env.PI_WEB_PLUGIN_CATALOG_URL = process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "";
process.env.LEGADO_ALLOW_PRIVATE_HOSTS = process.env.LEGADO_ALLOW_PRIVATE_HOSTS ?? "127.0.0.1,localhost";

const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	"bot-chat-reopen-test",
	"device-project-collaboration-test",
	"theme-buttons-test",
	"stream-stability-ui-test",
	"universal-stream-ui-test",
	"context-usage-browser-test",
	"clear-provider-key-test",
	"conv-cross-project-test",
	"conv-cwd-test",
	"project-model-key-test",
	"plugin-jobs-test",
	"plugin-grants-test",
	"plugin-client-conversation-test",
	"plugin-scaffold-test",
	"provider-oauth-test",
	"provider-keys-test",
	"db-client-test",
	"chat-abort-attachments-rollback-test",
	"ephemeral-chat-test",
	"fork-assistant-bubble-test",
	"dsh-smoke-test",
	"dsh-stats-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	"goal-delegated-test",
	"plan-mode-test",
	"composer-pressed-state-test",
	"delegate-mode-test",
	"left-panel-delete-test",
	"legado-web-engine-test",
	"legado-web-test",
	"list-files-missing-dir-test",
	"list-files-symlink-home-test",
	"plugin-cron-overflow-test",
	"notes-test",
	"plugin-bgtask-test",
	"plugin-leftpanel-running-test",
	"bg-cleanup-test",
	"pm2-manager-plugin-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"plugin-proxy-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	"plugin-upgrade-data-preserve-test",
	"plugin-catalog-cli-test",
	"preview-test",
	"preview-http-test",
	"quiesce-test",
	"approval-policy-test",
	"approval-rules-test",
	"question-bridge-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"restart-service-test",
	"running-list-test",
	"scm-features-test",
	"settings-test",
	"settings-prompt-save-test",
	"sftp-plugin-test",
	"shutdown-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"snapshot-frame-budget-test",
	"message-window-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"subagent-template-test",
	"subagent-takeover-test",
	"subagent-thinking-test",
	"subagent-ui-context-test",
	"switch-session-background-test",
	"cross-client-session-test",
	"orphan-adopt-test",
	"takeover-test",
	"takeover-rollback-test",
	"idle-takeover-test",
	"offline-takeover-test",
	"cross-device-switch-session-test",
	"remote-answer-test",
	"elsewhere-lifecycle-test",
	"terminal-smoke-test",
	"native-cli-smoke-test",
	"host-metrics-test",
	"token-auth-test",
	"theme-dotfile-test",
	"tool-info-test",
	"tool-prompt-test",
	"lazy-tools-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
	"workspace-roots-test",
];

const CORE = [
	"snapshot-delta-test",
	"message-window-test",
	"token-auth-test",
	"quiesce-test",
	"settings-test",
	"slash-commands-test",
	"approval-policy-test",
	"approval-rules-test",
	"plugin-test",
	"plugin-command-test",
	"plugin-grants-test",
	"plugin-scaffold-test",
	"plugin-settings-test",
	"plugin-cwd-test",
	"running-list-test",
	"takeover-test",
	"switch-session-background-test",
	"cross-client-session-test",
	"preview-test",
	"ephemeral-chat-test",
	"shutdown-test",
	"restart-service-test",
];

const rawArgs = process.argv.slice(2);
const wantCore = rawArgs.includes("--core");
const wantRetry = rawArgs.includes("--retry-once");
const named = rawArgs.filter((a) => !a.startsWith("--"));
const targets = named.length > 0 ? named : wantCore ? [...CORE] : ALL;
if (wantCore && named.length === 0)
	console.log(`ℹ 快检模式：${CORE.length} 个核心测试（全量 ${ALL.length} 个走 main push / nightly）`);
for (const c of CORE) {
	if (!ALL.includes(c)) {
		console.error(`✗ CORE 里有 ALL 不认识的测试：${c}（改名/删除后请同步 CORE）`);
		process.exit(1);
	}
}
const results = [];

async function runOne(name, port) {
	const args = port === undefined ? [] : [String(port)];
	// 出口先收干净：上一轮被中断留下的 server 会把端口装成「已就绪」，
	// 于是拿旧产物跑出假绿/假红（本仓库踩过）。不是测试进程的占用者不动，直接失败。
	if (port !== undefined) {
		const freed = freeTestPort(port);
		if (freed.killed.length > 0) {
			console.log(`⚠ :${port} 清掉了上轮残留的测试进程 ${freed.killed.join(",")}`);
		}
		if (freed.foreign.length > 0) {
			return {
				ok: false,
				out: `✗ :${port} 被非测试进程占着（pid ${freed.foreign.join(",")}）——先自己能开它再跑。\n`,
			};
		}
	}
	return await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [join(here, `${name}.mjs`), ...args], {
			cwd: dirname(here),
			env: process.env,
		});
		liveChildren.add(child);
		let out = "";
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			liveChildren.delete(child);
			resolveRun(result);
		};
		// 看门狗：用例自己卡住（例如等一个永远不来的帧）时 runner 不能一起挂死，
		// 也不能只因子进程超时就把残骸留在进程表里——杀整棵树后再判红。
		const watchdog = setTimeout(() => {
			killTree(child.pid);
			finish({ ok: false, out: `${out}\n✗ 超过 ${TEST_TIMEOUT_MS / 1000}s 未结束，已杀进程树\n` });
		}, TEST_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("exit", (code) => finish({ ok: code === 0, out }));
		child.on("error", (err) => finish({ ok: false, out: out + String(err) }));
	});
}

/** 正在跑的用例；Ctrl-C / 异常退出时连树杀掉，不留孤儿 server。 */
const liveChildren = new Set();
function killLiveChildren() {
	for (const child of liveChildren) killTree(child.pid);
	liveChildren.clear();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		console.log(`\n✗ 收到 ${signal}：清掉正在跑的测试进程`);
		killLiveChildren();
		process.exit(130);
	});
}
process.on("exit", killLiveChildren);

const timeoutArg = rawArgs.find((a) => a.startsWith("--timeout="));
const TEST_TIMEOUT_MS = Math.max(30, Number((timeoutArg ?? "").split("=")[1] ?? 600) || 600) * 1000;

const slotPort = (slot) => 9100 + slot * 20;

const jobsArg = rawArgs.find((a) => a.startsWith("--jobs="));
const jobs = Math.max(1, Number((jobsArg ?? "").split("=")[1] ?? 4) || 4);
if (jobs > 1) console.log(`ℹ 并行模式：${jobs} worker（串行用 --jobs=1；各 worker 端口见 ▶ 行）`);

const queue = [];
for (const name of targets) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && named.length === 0) {
		results.push({ name, ok: true, skipped: true });
		console.log(`\n⏭ ${name} — Windows 环境已知噪音（node-pty/libuv），跳过；ubuntu CI 正常跑`);
		continue;
	}
	queue.push(name);
}

const repoRoot = dirname(here);
const distEntryPath = join(repoRoot, "dist", "server", "index.js");
const wantNoBuild = rawArgs.includes("--no-build");
if (wantNoBuild) {
	if (!existsSync(distEntryPath)) {
		console.error(`✗ --no-build 但产物不存在：${distEntryPath}（先跑 npm run build）`);
		process.exit(1);
	}
	console.log("ℹ 跳过构建（--no-build）：直接用现有 dist/");
} else {
	process.stdout.write("ℹ 构建 dist/（npm run build，整套只构建这一次）…");
	const t0 = Date.now();
	try {
		execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
	} catch {
		console.error("\n✗ npm run build 失败 —— 先手动跑一次看完整输出；已终止冒烟（免得拿半份产物跑出假红）");
		process.exit(1);
	}
	console.log(` 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}
process.env[PREBUILT_ENV] = "1";

if (jobs <= 1) {
	for (const name of queue) {
		process.stdout.write(`\n▶ ${name}\n`);
		const r = await runOne(name);
		process.stdout.write(r.out);
		results.push({ name, ok: r.ok });
	}
} else {
	let next = 0;
	const worker = async (slot) => {
		for (;;) {
			const i = next++;
			if (i >= queue.length) return;
			const name = queue[i];
			const port = slotPort(slot);
			process.stdout.write(`\n▶ ${name}（worker${slot} :${port}）\n`);
			const r = await runOne(name, port);
			process.stdout.write(`\n----- ${name} 输出开始 -----\n${r.out}----- ${name} 输出结束 -----\n`);
			results.push({ name, ok: r.ok });
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, (_, s) => worker(s)));
	results.sort((a, b) => targets.indexOf(a.name) - targets.indexOf(b.name));
}

if (wantRetry) {
	const failed = results.filter((r) => !r.ok && !r.skipped);
	if (failed.length > 0) {
		console.log(`\n↻ 首轮 ${failed.length} 个失败，重跑一次确认是否为偶发：${failed.map((r) => r.name).join(", ")}`);
		for (const r of failed) {
			const r2 = await runOne(r.name, slotPort(0));
			process.stdout.write(r2.out);
			r.flaky = r2.ok;
			r.ok = r2.ok;
		}
	}
}

console.log("\n===== 冒烟汇总 =====");
let failures = 0;
for (const r of results) {
	console.log(
		`${r.skipped ? "⏭" : r.ok ? (r.flaky ? "✓~" : "✓") : "✗"} ${r.name}${r.skipped ? "（跳过）" : r.flaky ? "（FLAKY：首轮挂、重跑过，慢机时序嫌疑，值得看一眼）" : ""}`,
	);
	if (!r.ok) failures++;
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
