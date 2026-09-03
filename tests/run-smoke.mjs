#!/usr/bin/env node
/**
 * run-smoke.mjs — 零 token 协议冒烟测试聚合跑器（本地与 CI 共用）。
 *
 * 顺序执行一组自起 server 的 *-test.mjs 脚本（各自独立端口 + 临时 data-dir，
 * 结束时自行清理）。任何一个失败不中断后续，最后汇总并以非零码退出。
 *
 * 不收录的脚本及原因：
 *   - 浏览器 E2E（playwright/chromium，路径写死本机）：*-browser*、scm-test、
 *     freeze、goal-pill/ui/rounds、panel/left/sound/settings-ui 等 → 本地手动跑；
 *   - 真模型 live：goal-review-loop、live-test（需已运行 server）、update-test。
 *
 * 用法：node tests/run-smoke.mjs [name1 name2 …]   # 无参 = 全量
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Windows 本机已知失败（非逻辑问题，ubuntu CI 正常）：
//   - terminal-smoke-test：node-pty 在 ConPTY 下 shell 退出事件/控制台列表 agent
//     （AttachConsole failed）行为差异，导致退出检测类检查超时；
//   - restart-handoff-test：所有断言通过后 libuv 在命名管道关闭时触发
//     win\\async.c 断言崩溃（退出码 127），属 libuv 关闭时序问题。
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	"clear-provider-key-test",
	"conv-cross-project-test",
	"conv-cwd-test",
	"project-model-key-test",
	"provider-keys-test",
	"db-client-test",
	"dsh-smoke-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	"left-panel-delete-test",
	"plugin-bgtask-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	"preview-test",
	"quiesce-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"scm-features-test",
	"settings-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"switch-session-background-test",
	"terminal-smoke-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
];

// 不在默认清单里的脚本：
//   - 需外部已运行 server（attach 型，默认 8787）：ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test —— 本地先起 server 再单独跑；
//   - 需真模型（本地可跑，CI 无凭据必败）：goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
//     tool-status-test（需真模型执行 bash 工具，从仓库根或任意目录均可跑）；
//   - 平台相关：spawn-helper-test（macOS spawn-helper 二进制）；win32 下
//     terminal-smoke / restart-handoff 自动跳过（见 WIN32_KNOWN_ENV_FAIL）；
//   - title-jsonl-test：已修复（原 lsof/URL.pathname 的 Windows 兼容问题），本地可跑；
//   - 浏览器 E2E 见文件头注释（headless Chrome 路径写死本机）。

const targets = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const results = [];

for (const name of targets) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && process.argv.length <= 2) {
		results.push({ name, ok: true, skipped: true });
		console.log(`\n⏭ ${name} — Windows 环境已知噪音（node-pty/libuv），跳过；ubuntu CI 正常跑`);
		continue;
	}
	const file = join(here, `${name}.mjs`);
	process.stdout.write(`\n▶ ${name}\n`);
	const ok = await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file], {
			// 测试脚本内相对路径（如 dist/server/index.js）以仓库根为基准
			cwd: dirname(here),
			stdio: "inherit",
			env: process.env,
		});
		child.on("exit", (code) => resolveRun(code === 0));
		child.on("error", () => resolveRun(false));
	});
	results.push({ name, ok });
}

console.log("\n===== 冒烟汇总 =====");
let failures = 0;
for (const r of results) {
	console.log(`${r.skipped ? "⏭" : r.ok ? "✓" : "✗"} ${r.name}${r.skipped ? "（跳过）" : ""}`);
	if (!r.ok) failures++;
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
