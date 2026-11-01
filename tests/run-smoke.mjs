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
 *       node tests/run-smoke.mjs --core          # PR 快检子集（CORE，见下）
 *       node tests/run-smoke.mjs --jobs=4         # 并行（默认 4 worker；--jobs=1 串行）
 *       node tests/run-smoke.mjs --retry-once     # 首轮失败重跑一次（标 FLAKY）
 *       node tests/run-smoke.mjs --no-build       # 不构建（dist/ 已就绪，如 CI 刚跑过 npm run build）
 *
 * dist/ 由本跑器在开跑前构建**一次**（串行，见 tests/lib/ensure-build.mjs）：用例自己构建会在
 * 并行下互相踩（一个在重写 dist/、另一个在 spawn dist/server/index.js → 假红）。
 *
 * 分层策略（CI 提速：PR 只跑 CORE，push main + nightly 跑全量）：
 * - CORE = 协议/快照/安全/审批/插件接线/并发代表，~20 个，2~4 分钟；
 * - 全量 = CORE + 慢/重插件（ssh 现场 npm 装、vscode 大插件等）+ 各家回归，~9 分钟；
 * - 新测试默认进 ALL；只有「零 token、自包含、跑得快（<20s）、稳」才进 CORE。
 */
import "./lib/hide-windows.mjs";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREBUILT_ENV } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 冒烟测试离线确定性运行：禁用服务启动时的远程插件市场拉取（避免污染测试临时 dataDir 并消除外网依赖与时序竞态）
process.env.PI_WEB_PLUGIN_CATALOG_URL = process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "";
// 测试内自建 upstream/mock 书源站监听 127.0.0.1，SSRF 防护对回环地址放行
process.env.LEGADO_ALLOW_PRIVATE_HOSTS = process.env.LEGADO_ALLOW_PRIVATE_HOSTS ?? "127.0.0.1,localhost";

// Windows 本机已知失败（非逻辑问题，ubuntu CI 正常）：
//   - terminal-smoke-test：node-pty 在 ConPTY 下 shell 退出事件/控制台列表 agent
//     （AttachConsole failed）行为差异，导致退出检测类检查超时；
//   - restart-handoff-test：所有断言通过后 libuv 在命名管道关闭时触发
//     win\\async.c 断言崩溃（退出码 127），属 libuv 关闭时序问题。
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	// 两独立设备服务、真实 Git 交付/返工/验收；模型 HTTP 使用本地确定性响应。
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
	// 插件目录授权的**接线**（request → 浏览器确认 → 落表 → 插件读得到 → 撤销）。
	"plugin-grants-test",
	// 注册面目录的 WS 往返（P2-7：plugin_api_catalog → 22 slot+别名+工具表+方法表+占用者）。
	"plugin-api-catalog-test",
	// #542：插件会话快照按 clientId 取用（两个标签页互不串台）+ 模型切换事件（不发消息即到、失败/重复不发）。
	"plugin-client-conversation-test",
	// #546：plugin create 生成的骨架四个模板都要真能用（SDK 两处拷贝 + 客户端 import 落在 client/ 内
	// + manifest 合法 + 浏览器口径拓客户端 import 图）。
	"plugin-scaffold-test",
	"provider-oauth-test",
	"provider-keys-test",
	"db-client-test",
	"chat-abort-attachments-rollback-test",
	// 临时对话（issue #285）：inMemory 不落盘 + 左栏 isEphemeral 标记 + 转正落盘（对照组验普通对话真落盘）。
	"ephemeral-chat-test",
	// issue #381 回归：助手气泡上的 fork/rollback 必须解析成功（mock LLM，tsx 起源码）。
	"fork-assistant-bubble-test",
	"dsh-smoke-test",
	"dsh-stats-test",
	"fetch-models-test",
	"global-search-test",
	"goal-prefs-test",
	"goal-test",
	// 目标模式 2.0「委托执行」（Plan A）：角色对话接线（拉起/左栏可见/清目标收回，零 token）。
	"goal-delegated-test",
	// 计划模式（只规划不实施）：开关快照 + 写类/非常规 bash 硬闸门 + 关闭后恢复（零 token）。
	"plan-mode-test",
	// 审查者模式（自动委派）：开关快照 + prompt 自动转给常驻执行对话 + 关闭后恢复（零 token）。
	"delegate-mode-test",
	"left-panel-delete-test",
	"legado-web-engine-test",
	"legado-web-test",
	"list-files-missing-dir-test",
	// #262 regression: directory symlinks classify as dir on all platforms + "~/" expansion in the panel path bar (Android/Termux).
	"list-files-symlink-home-test",
	// 宿主 cron 引爆的溢出回归（远期 / 永不发生的表达式不能把服务打成死循环）。
	"plugin-cron-overflow-test",
	// 笔记插件（notes）：清单/HTTP 通道/长轮询推送/持久化（零 token，浏览器 E2E 另见 notes-ui-test）。
	"notes-test",
	"plugin-bgtask-test",
	// 左栏「运行的对话」插件运行条目（P3）：登记推送 / attach 补发 / clear / 心跳过期整组清空。
	"plugin-leftpanel-running-test",
	// 后台任务「自动清理」的协议面（阈值落库/归一化、钉住、立即清理反馈）。
	"bg-cleanup-test",
	// pm2 进程管家：manifest 被宿主接受 + tasks.panel 占位 + 真激活 + 三个路由（零 token）。
	"pm2-manager-plugin-test",
	"plugin-command-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"plugin-proxy-test",
	"mcp-bridge-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	// --build 自动推断 + --no-build + install --catalog（issue #165，零网络本地目录源）。
	"plugin-catalog-cli-test",
	"preview-test",
	// Express 5 *splat 多段数组回归（issue #225）：嵌套文件 HTTP 预览（__abs__/相对）。
	"preview-http-test",
	"quiesce-test",
	// 审批三档放行的协议面（全局开关持久化 / 本对话策略 / 垃圾消息 no-op；门禁纯函数见单测）。
	"approval-policy-test",
	// 自定义审批规则协议面（规则增删改查 / 批量重排 / 内置规则重置 / 持久化播种）。
	"approval-rules-test",
	"question-bridge-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"restart-service-test",
	"running-list-test",
	"scm-features-test",
	"settings-test",
	// SFTP 插件（项目级 .pi/sftp.json）：差异计划 / dry-run / 删除保护 / 凭据引用 / 变更迁移。
	// 用 tests/lib/mock-ssh.mjs 的内嵌 SFTP 服务，首次需 ssh2（离线拷不到就现场装，故不进 CORE）。
	"sftp-plugin-test",
	"shutdown-test",
	"slash-commands-test",
	"snapshot-delta-test",
	// 历史消息服务端按需加载（窗口化）：首份快照只带尾部窗口 + 往前翻页 + get_state 不回退。
	"message-window-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"subagent-template-test",
	// 子代理接管（#652 变体）：被接管页面已加载子代理工具但不再活跃时，
	// 目录里不能再出现「已加载却永不激活」的死路条目（见 PATCH-B1 门控）。
	"subagent-takeover-test",
	"subagent-thinking-test",
	"subagent-ui-context-test",
	"switch-session-background-test",
	"cross-client-session-test",
	// 浏览器关闭重开后残留会话认领（无在线浏览器时新标签整体接管，有在线时不抢）。
	"orphan-adopt-test",
	// 手动过户：右键「另一处」行把对话（含等答复问卷）搬到本页，问卷可直接回答。
	"takeover-test",
	// 过户夭折回滚（#556）：源侧已摘、目标侧接入失败时把对话原样搬回，绝不留幽灵会话。
	"takeover-rollback-test",
	// 已结束对话的过户：run 跑完后 elsewhere 仍保留空闲行可过户；新页面不自动恢复别处持有的会话。
	"idle-takeover-test",
	// 离线持有方：手机 run 途中关页面 → run 跑完 → 另一台设备仍能看到「另一处（离线）」行并过户。
	"offline-takeover-test",
	// 跨设备打开历史会话（#567）：别处已持有自动过户（单 runtime）＋陈旧元数据侧枝纠偏。
	"cross-device-switch-session-test",
	// 跨页作答：点 elsewhere 行的 `?` 把问卷拉到本页回答，不搬迁对话。
	"remote-answer-test",
	// elsewhere 生命周期（#291）：断连残骸不入列表、删定时任务回收伪客户端。
	"elsewhere-lifecycle-test",
	"terminal-smoke-test",
	// 全局主机采样经心跳推送，不调用模型。
	"host-metrics-test",
	"token-auth-test",
	// Express 5 sendFile 隐藏目录 404 回归（issue #223）：data-dir 在点号目录下时主题 CSS 仍可达。
	"theme-dotfile-test",
	// 工具定义说明（工具卡右键 → 显示工具详细信息）：get_tool_info → tool_info 的归一化回归（零 token）。
	"tool-info-test",
	// 逐工具文案覆盖（设置页「工具」区编辑文案）：默认值回读 + 生效 + 清空复原（零 token）。
	"tool-prompt-test",
	// 工具延迟加载（load_tools）：默认只常驻核心工具 + 目录在提示词里；加载后 schema 追加，
	// 且**系统提示词逐字节不变、tools 只追加**（前缀缓存不被我们打坏）。
	"lazy-tools-test",
	"vision-bridge-test",
	"vscode-editor-plugin-test",
	// 额外工作区根（宿主侧多根，issue #146）：set_workspace_roots 落快照 + 插件受支持路径跨根。
	"workspace-roots-test",
];

// PR 快检子集：信号密度最高的协议/安全/插件接线代表。push main + nightly 跑全量。
// 选入标准：零 token、自包含、单测 <20s、历史稳定；慢机（ssh 现场装包）与
// 超重插件（vscode 全链路 ~40s）放全量，由 main/nightly 覆盖。
const CORE = [
	"snapshot-delta-test", // 快照增量 rev 链（v0.95.0 回归过）
	"message-window-test", // 历史窗口化（服务端按需加载，与快照/rev 链同一块）
	"token-auth-test", // 鉴权
	"quiesce-test", // 排空门禁 + 4403（v0.95.0 回归过）
	"settings-test",
	"slash-commands-test",
	"approval-policy-test",
	"approval-rules-test",
	"plugin-test", // 插件基线（激活/命令/推送）
	"plugin-command-test",
	"plugin-grants-test", // 目录授权接线（v0.95.0 回归过）
	"plugin-api-catalog-test", // 注册面目录（v0.95.0 回归过）
	"plugin-scaffold-test", // 脚手架四个模板真能用（#546：客户端 import 越界 / SDK 拷贝缺半）
	"plugin-settings-test",
	"plugin-cwd-test", // cwd 安全
	"running-list-test", // 并发列表口径
	"takeover-test", // 过户代表（6 合 1 前先留这一个）
	"switch-session-background-test",
	"cross-client-session-test",
	"preview-test", // 附件/预览
	"ephemeral-chat-test", // v0.95 新特性
	"shutdown-test",
	"restart-service-test",
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

const rawArgs = process.argv.slice(2);
// --core = PR 快检子集；--retry-once = 首轮失败的用例最后重跑一次（慢机偶发红自愈，
// 重跑过的标 FLAKY，重跑还挂的才算真失败）；其余位置参数 = 指定测试名。
const wantCore = rawArgs.includes("--core");
const wantRetry = rawArgs.includes("--retry-once");
const named = rawArgs.filter((a) => !a.startsWith("--"));
const targets = named.length > 0 ? named : wantCore ? [...CORE] : ALL;
if (wantCore && named.length === 0)
	console.log(`ℹ 快检模式：${CORE.length} 个核心测试（全量 ${ALL.length} 个走 main push / nightly）`);
// CORE 与 ALL 同步守卫：改名/删测试忘了同步 CORE 时响亮失败，而不是静默少跑。
for (const c of CORE) {
	if (!ALL.includes(c)) {
		console.error(`✗ CORE 里有 ALL 不认识的测试：${c}（改名/删除后请同步 CORE）`);
		process.exit(1);
	}
}
const results = [];

async function runOne(name, port) {
	// 并行时每个 worker 拿固定分配端口（argv[2] 契约：读 argv[2] 的测试用它，
	// 不读的走各自默认固定端口——全仓已扫过，ALL 内默认端口两两不撞）。
	const args = port === undefined ? [] : [String(port)];
	return await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [join(here, `${name}.mjs`), ...args], {
			// 测试脚本内相对路径（如 dist/server/index.js）以仓库根为基准
			cwd: dirname(here),
			env: process.env,
		});
		// 并行时输出各自缓存，结束后再整段打印，否则多进程日志搅成一团。
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("exit", (code) => resolveRun({ ok: code === 0, out }));
		child.on("error", (err) => resolveRun({ ok: false, out: out + String(err) }));
	});
}

// 并行 worker 槽位端口：9100 + 槽位*20（+1..+9 留给 mock/第二 server；
// 随机端口测试用 20000+/30000+ 段，固定端口测试用 87xx~89xx，均不撞）。
const slotPort = (slot) => 9100 + slot * 20;

const jobsArg = rawArgs.find((a) => a.startsWith("--jobs="));
const jobs = Math.max(1, Number((jobsArg ?? "").split("=")[1] ?? 4) || 4);
if (jobs > 1) console.log(`ℹ 并行模式：${jobs} worker（串行用 --jobs=1；各 worker 端口见 ▶ 行）`);

// win32 跳过名单先落定（不占 worker）。
const queue = [];
for (const name of targets) {
	if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && named.length === 0) {
		results.push({ name, ok: true, skipped: true });
		console.log(`\n⏭ ${name} — Windows 环境已知噪音（node-pty/libuv），跳过；ubuntu CI 正常跑`);
		continue;
	}
	queue.push(name);
}

// dist/ 只在开跑前构建**一次**（串行）。用例侧的构建已改为 tests/lib/ensure-build.mjs：
// 见到 PREBUILT_ENV 就直接用现成产物。为什么必须挪到这里：并行下用例各自 `npm run build`
// 时，一个进程正在重写 dist/、另一个进程同时 spawn dist/server/index.js，会出现与被测
// 逻辑无关的假红（“测试插件没被激活”之类），而且整棵 vite+tsc+vendor 被重复构建 N 遍。
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
// 子进程据此跳过用例内的构建（单跑某个 *-test.mjs 时没有这个标记，仍会自己构建）。
process.env[PREBUILT_ENV] = "1";

if (jobs <= 1) {
	for (const name of queue) {
		process.stdout.write(`\n▶ ${name}\n`);
		const r = await runOne(name);
		process.stdout.write(r.out);
		results.push({ name, ok: r.ok });
	}
} else {
	// 定长 worker 池：每个 worker 跑完一个立刻领下一个（慢测试不堵快测试）。
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
	// 并行完成顺序不定，汇总前按 targets 原序排回来。
	results.sort((a, b) => targets.indexOf(a.name) - targets.indexOf(b.name));
}

// 失败重跑一次：只救「偶发红」（慢机时序），真回归重跑也挂，不掩盖。
if (wantRetry) {
	const failed = results.filter((r) => !r.ok && !r.skipped);
	if (failed.length > 0) {
		console.log(`\n↻ 首轮 ${failed.length} 个失败，重跑一次确认是否为偶发：${failed.map((r) => r.name).join(", ")}`);
		for (const r of failed) {
			// 重跑串行逐个来（并行已证过有问题，再并行没有意义），端口用槽位 0。
			const r2 = await runOne(r.name, slotPort(0));
			process.stdout.write(r2.out);
			r.flaky = r2.ok; // 重跑过 = 偶发（标 FLAKY）；还挂 = 真失败
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
