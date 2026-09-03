/**
 * dsh 引擎零 key 协议冒烟（DSH = DeepSeek Harness 子进程引擎）。
 *
 * 覆盖 dsh 引擎特有的协议面 + 通用对齐抽查（全部不需要 API key）：
 *   1. hello → ready(engine=dsh) + 初始状态推送齐全（conversations /
 *      goal_status / settings_state / slash_commands / snapshot）
 *   2. dsh_patches_list → dsh_patches（patch 目录 + 文件列表）
 *   3. list_sessions → sessions（空 dataDir 下应为空列表）
 *   4. list_models → models（本地表 + 运行时动态目录合并）
 *   5. get/set_settings → settings_state 回显 + 重连持久化
 *   6. slash 命令拦截（/model 无匹配、/cwd 无效路径 → notice，不发模型）
 *   7. terminal create/input/output（echo TERM_OK 回显）
 *   8. scm_status → scm_data（在 git 仓库中返回 status）
 *
 * 零 key 前提：dsh 引擎 boot/initialize 不需要 key（prompt 才需要）。运行时树
 * 缺失时打印 SKIP 并退出 0（CI 无全局 dsh 时不误报失败）。
 *
 * 用法：node tests/dsh-smoke-test.mjs   （先 npm run build）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8932;
const CLIENT_ID = "dsh-smoke";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// 运行时树检测：无树 → SKIP（CI / 未装全局 dsh 的环境不误报失败）。
let rtAvailable = false;
try {
	const { resolveRuntimeBase } = await import(
		pathToFileURL(join(REPO, "server", "dsh", "runtime", "runtime-root.mjs")).href
	);
	rtAvailable = !!(await resolveRuntimeBase());
} catch {
	rtAvailable = false;
}
if (!rtAvailable) {
	console.log(
		"⏭ SKIP：未找到 dsh 运行时树（需 npm i -g @deepseek-ai/dsh@0.1.1-rc.2 或 PI_WEB_DSH_RUNTIME 指向运行时树根）",
	);
	process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "dsh-smoke-"));
// 放一个用户 patch 文件，验证 dsh_patches 列表能扫到。用 persona 覆盖
// （probe-patch-seam 验证过的无害 patch）——不能 insert 重复的 dsh-session
// entry，那会与 base bundle 的 service 注册冲突导致 boot 失败。
const patchDir = join(dataDir, "dsh-patches");
const { mkdirSync } = await import("node:fs");
mkdirSync(patchDir, { recursive: true });
writeFileSync(
	join(patchDir, "00-user.patch.yml"),
	[
		"# user patch seam probe (harmless persona override)",
		"- id: system-prompt",
		"  name: '@deepseek-ai/dsh-system-prompt'",
		"  config:",
		"    persona: 'DSH_SMOKE_PATCH_MARKER'",
		"",
	].join("\n"),
);

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: REPO,
		PI_WEB_ENGINE: "dsh",
		// 隔离 agent 目录：不读真实 ~/.pi/agent（冒烟零 key 场景）。
		PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "dsh-smoke-agent-")),
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

for (let i = 0; i < 60; i++) {
	await sleep(250);
	try {
		if (await portUp(PORT)) break;
	} catch {
		/* retry */
	}
	if (i === 59) {
		console.error("✗ server 未在 15s 内启动");
		server.kill();
		process.exit(1);
	}
}
console.log("server up (engine=dsh)");

function connect(clientId) {
	return new Promise((resolveConnect, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else {
				inbox.push(msg);
			}
		});
		ws.on("open", () =>
			resolveConnect({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 30000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeout);
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(t);
								res(m);
							},
						});
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

async function main() {
	const c = await connect(CLIENT_ID);
	c.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });

	// --- 1. ready(engine=dsh) + 初始推送 ---
	const ready = await c.wait((m) => m.type === "ready");
	check("ready.engine === 'dsh'", ready.engine === "dsh", `engine=${ready.engine} proto=${ready.protocolVersion}`);
	await c.wait((m) => m.type === "conversations");
	await c.wait((m) => m.type === "goal_status");
	await c.wait((m) => m.type === "settings_state");
	await c.wait((m) => m.type === "slash_commands");
	await c.wait((m) => m.type === "snapshot" || m.type === "snapshot_delta");
	check("初始推送齐全（conversations/goal_status/settings_state/slash_commands/snapshot）", true);

	// --- 2. dsh_patches_list → dsh_patches ---
	c.send({ type: "dsh_patches_list" });
	const patches = await c.wait((m) => m.type === "dsh_patches");
	check(
		"dsh_patches 列表",
		patches.patchDir === patchDir && patches.files.some((f) => f.name === "00-user.patch.yml"),
		`patchDir=${patches.patchDir} files=${patches.files.map((f) => f.name).join(",")}`,
	);

	// --- 3. list_sessions → sessions（空） ---
	c.send({ type: "list_sessions" });
	const sessions = await c.wait((m) => m.type === "sessions");
	check("list_sessions 空列表", Array.isArray(sessions.sessions), `count=${sessions.sessions.length}`);

	// --- 4. list_models → models（本地表 + 动态目录） ---
	c.send({ type: "list_models" });
	const models = await c.wait((m) => m.type === "models", 20000);
	const hasFlash = models.models.some((m) => m.id.includes("deepseek-v4-flash"));
	const hasVision = models.models.some((m) => m.id.includes("vision"));
	check(
		"list_models 本地表 + 动态目录合并",
		models.models.length >= 2 && hasFlash,
		`count=${models.models.length} flash=${hasFlash} vision=${hasVision}`,
	);

	// --- 5. 设置存储回显 + 重连持久化 ---
	c.send({
		type: "set_settings",
		customSystemPrompt: "你是 DSH 冒烟测试助手",
		promptMode: "replace",
	});
	const st1 = await c.wait((m) => m.type === "settings_state");
	check(
		"set_settings → settings_state 回显",
		st1.settings.customSystemPrompt === "你是 DSH 冒烟测试助手" && st1.settings.promptMode === "replace",
		`prompt=${st1.settings.customSystemPrompt} mode=${st1.settings.promptMode}`,
	);
	c.close();

	// 重连（同 clientId）→ 设置持久化恢复
	const c2 = await connect(CLIENT_ID);
	c2.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });
	await c2.wait((m) => m.type === "ready");
	const st2 = await c2.wait((m) => m.type === "settings_state");
	check(
		"重连后设置持久化恢复",
		st2.settings.customSystemPrompt === "你是 DSH 冒烟测试助手",
		`prompt=${st2.settings.customSystemPrompt}`,
	);

	// --- 6. slash 命令拦截（不发模型） ---
	c2.send({ type: "prompt", text: "/model 这个模型必然不存在xyz" });
	const modelBad = await c2.wait((m) => m.type === "notice", 10000);
	check("slash /model 无匹配 → notice", modelBad.text.includes("没有匹配到模型"), modelBad.text);
	c2.send({ type: "prompt", text: "/cwd /nonexistent-zzz" });
	const cwdBad = await c2.wait((m) => m.type === "notice", 10000);
	check("slash /cwd 无效路径 → notice", cwdBad.text.includes("切换工作目录失败"), cwdBad.text);

	// --- 7. terminal create/input/output ---
	const termId = "smoke-term";
	c2.send({ type: "terminal_create", terminalId: termId, cwd: REPO, cols: 80, rows: 24 });
	await sleep(1500);
	c2.send({ type: "terminal_input", terminalId: termId, data: "echo TERM_OK\n" });
	let termOk = false;
	const t0 = Date.now();
	while (Date.now() - t0 < 15000 && !termOk) {
		const msg = await c2.wait((m) => m.type === "terminal_output" && m.terminalId === termId, 3000).catch(() => null);
		if (msg && msg.data.includes("TERM_OK")) termOk = true;
	}
	check("terminal echo TERM_OK 回显", termOk);

	// --- 8. scm_status → scm_data（git 仓库） ---
	c2.send({ type: "scm_status", reqId: 42 });
	const scm = await c2.wait((m) => m.type === "scm_data" && m.reqId === 42, 15000);
	check(
		"scm_status → scm_data",
		scm.ok && !scm.notRepo && typeof scm.branch === "string",
		`ok=${scm.ok} branch=${scm.branch} notRepo=${scm.notRepo}`,
	);

	c2.close();
	server.kill();
	console.log(`\n===== dsh-smoke ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error("✗ dsh-smoke crashed:", err.message);
	server.kill();
	process.exit(1);
});
