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
 *   6. slash 命令拦截（/model 无匹配、/cwd 无效路径 → notice，不发模型；
 *      /new <首条提示> 把参数当新对话的首条投递）
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
import { join } from "node:path";
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

// 运行时树检测：无树/版本不兼容 → SKIP（CI / 未装全局 dsh 的环境不误报失败）。
let rtAvailable = false;
let skipReason = "未找到 dsh 运行时树（需 npm i -g @deepseek-ai/dsh@0.1.5-rc.3 或 PI_WEB_DSH_RUNTIME 指向运行时树根）";
try {
	const { resolveRuntimeBaseWithDetails } = await import(
		pathToFileURL(join(REPO, "server", "dsh", "runtime", "runtime-root.mjs")).href
	);
	const { base, compatibility } = await resolveRuntimeBaseWithDetails();
	if (base) {
		const ignoreVer = process.env.PI_WEB_DSH_IGNORE_VERSION === "1" || process.env.PI_WEB_DSH_IGNORE_VERSION === "true";
		if (compatibility?.compatible || ignoreVer) {
			rtAvailable = true;
		} else {
			skipReason = `dsh 运行时版本不兼容（期望族 ${compatibility?.expectedFamily}，当前 ${compatibility?.runtimeVersion}，需 npm i -g @deepseek-ai/dsh@${compatibility?.expectedVersion}）`;
		}
	}
} catch {
	rtAvailable = false;
}
if (!rtAvailable) {
	console.log(`⏭ SKIP：${skipReason}`);
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
		// 隔离 DSH 家目录：不读真实 ~/.dsh（里面有用户自建 agent-presets，会让
		// 「四预设 / 无 broken」两条断言取决于跑测试的机器上装了什么）。dsh-home-paths
		// 的优先级是 显式配置 > $DSH_HOME > ~/.dsh，所以这里设 env 即刻生效。
		DSH_HOME: mkdtempSync(join(tmpdir(), "dsh-smoke-home-")),
		// 预设分享：分享关掉（绝不真在共享仓库开 Issue），目录指向回环地址（被 SSRF 收口拦下）——
		// 两条都是确定性的离线断言（DSH 侧 sharePort 适配的回归，见 docs/preset-sharing.md）。
		PI_WEB_PRESET_REPO: "0",
		PI_WEB_PRESET_CATALOG_URL: "https://127.0.0.1/index.json",
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

	// --- 2.5 Agent 预设（dsh-web 四模式；零 key：只建会话不 prompt） ---
	c.send({ type: "dsh_preset_list" });
	// attach 时可能先推一次空名录（运行时未就绪），等 onStarted 后的實名单。
	// 若当前运行时无 shipped 四预设（如 0.2.x 升级或 legacy 环境），回落 legacy 模式（presets 为空）。
	let pr = await c.wait((m) => m.type === "dsh_presets");
	if (pr.presets.length === 0) {
		try {
			pr = await c.wait((m) => m.type === "dsh_presets" && m.presets.length > 0, 3000);
		} catch {
			/* 当前环境无 shipped 预设，保持 legacy 空名录 */
		}
	}
	if (pr.presets.length > 0) {
		const presetIds = pr.presets.map((p) => p.id).sort();
		// shipped 四预设（standard/ptc/minimal/cordis，由 preset-clones.ts 克隆改写）。
		// 不断言「恰好只有这四个」：$DSH_HOME/.agent-presets 里的自建预设也会一并上架
		// （设计如此，见 preset-clones.ts 的 roster 注释），那是机器状态不是仓库行为。
		const SHIPPED = ["cordis", "minimal", "ptc", "standard"];
		check(
			"dsh_presets 四预设",
			SHIPPED.every((id) => presetIds.includes(id)),
			presetIds.join(","),
		);
		check(
			"dsh_presets 无 broken（clone 改写生效）",
			// 只查 shipped：自建预设里的裸包名在 launcher 式 boot 下不可解析，是**已知限制**
			// （preset-clones.ts 只克隆 shipped；裸名需要官方 CLI 的安装锚点才能解析）。
			SHIPPED.every((id) => !pr.presets.find((p) => p.id === id)?.broken),
			pr.presets.map((p) => `${p.id}:${p.broken ?? "ok"}`).join(", "),
		);
		check("dsh_presets 默认 standard", pr.defaultPreset === "standard", pr.defaultPreset);
		// 快照断言要跳过 inbox 里旧快照：轮询到目标预设为止。
		const snapWithPreset = async (want) => {
			const t0 = Date.now();
			for (;;) {
				const m = await c.wait((x) => x.type === "snapshot" || x.type === "snapshot_delta");
				if (m.state?.agentPreset?.id === want) return m;
				if (Date.now() - t0 > 25000) throw new Error(`timeout waiting for preset ${want}`);
			}
		};
		check("快照 agentPreset=standard", (await snapWithPreset("standard")).state.agentPreset.locked === false);
		c.send({ type: "new_chat", preset: "minimal" });
		check("new_chat{preset:minimal} 生效", (await snapWithPreset("minimal")).state.agentPreset.id === "minimal");
		c.send({ type: "dsh_preset_select", preset: "standard" });
		check("空白切换回 standard", (await snapWithPreset("standard")).state.agentPreset.id === "standard");
		c.send({ type: "dsh_preset_default", preset: "ptc" });
		const pr2 = await c.wait((m) => m.type === "dsh_presets" && m.defaultPreset === "ptc");
		check("默认改 ptc", pr2.defaultPreset === "ptc");
		c.send({ type: "dsh_preset_default", preset: "no-such-preset" });
		const badNotice = await c.wait((m) => m.type === "notice" && m.text.includes("未知预设"));
		check("非法默认被拒绝", !!badNotice, badNotice?.text ?? "timeout");
	} else {
		check("dsh_presets legacy 兼容（无 shipped 预设时名录为空，进程存活）", Array.isArray(pr.presets));
	}

	// --- 2.6 权限预设三档（官方 /permission 弹窗；零 key：只切换不 prompt） ---
	const perm = await c.wait((m) => m.type === "dsh_permission" && m.options.length > 0);
	const permValues = perm.options.map((o) => o.value).sort();
	check(
		"dsh_permission 四选项（表）",
		JSON.stringify(permValues) ===
			JSON.stringify(["danger-full-access", "read-only", "workspace-write", "workspace-write-never"]),
		permValues.join(","),
	);
	check(
		"dsh_permission 默认 workspace-write-never",
		perm.defaultPreset === "workspace-write-never",
		perm.defaultPreset,
	);
	const snapWithPerm = async (want) => {
		const t0 = Date.now();
		for (;;) {
			const m = await c.wait((x) => x.type === "snapshot" || x.type === "snapshot_delta");
			if (m.state?.permission === want) return m;
			if (Date.now() - t0 > 25000) throw new Error(`timeout waiting for permission ${want}`);
		}
	};
	check(
		"快照 permission 默认档",
		(await snapWithPerm("workspace-write-never")).state.permission === "workspace-write-never",
	);
	c.send({ type: "dsh_permission_set", preset: "read-only" });
	check("切换 read-only", (await snapWithPerm("read-only")).state.permission === "read-only");
	c.send({ type: "dsh_permission_set", preset: "danger-full-access" });
	check(
		"切换 danger-full-access",
		(await snapWithPerm("danger-full-access")).state.permission === "danger-full-access",
	);
	c.send({ type: "dsh_permission_set", preset: "workspace-write-never" });
	check("切回默认档", (await snapWithPerm("workspace-write-never")).state.permission === "workspace-write-never");
	c.send({ type: "dsh_permission_default", preset: "read-only" });
	const perm2 = await c.wait((m) => m.type === "dsh_permission" && m.defaultPreset === "read-only");
	check("新会话默认改 read-only", perm2.defaultPreset === "read-only");
	c.send({ type: "dsh_permission_default", preset: "no-such-preset" });
	const badPermNotice = await c.wait((m) => m.type === "notice" && m.text.includes("未知权限预设"));
	check("非法权限默认被拒绝", !!badPermNotice, badPermNotice?.text ?? "timeout");
	// 默认恢复，避免污染后续用例与本地 client-state。
	c.send({ type: "dsh_permission_default", preset: "workspace-write-never" });
	await c.wait((m) => m.type === "dsh_permission" && m.defaultPreset === "workspace-write-never");

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
	const st1 = await (async () => {
		// 2.5 节的 setDefaultAgentPreset 推过 defaults 快照，跳到目标值。
		const t0 = Date.now();
		for (;;) {
			const m = await c.wait((x) => x.type === "settings_state");
			if (m.settings.customSystemPrompt === "你是 DSH 冒烟测试助手") return m;
			if (Date.now() - t0 > 25000) return m;
		}
	})();
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

	// --- 5.5 预设分享（DSH 侧的 PresetSharePort 适配；导入/导出/目录） ---
	c2.send({ type: "preset_export", source: "current", requestId: "dsh-ex1" });
	const dshEx = await c2.wait((m) => m.type === "preset_export_result" && m.requestId === "dsh-ex1", 10000);
	check(
		"DSH 导出当前设置为交换文档",
		dshEx.ok === true && JSON.parse(dshEx.json).format === "pi-web-ui-preset" && !!dshEx.fileName,
		String(dshEx.error ?? ""),
	);
	c2.send({ type: "preset_import", json: dshEx.json, dryRun: true, requestId: "dsh-im1" });
	const dshPre = await c2.wait((m) => m.type === "preset_import_result" && m.requestId === "dsh-im1", 10000);
	check("DSH 导入预览（dryRun 不落盘）", dshPre.ok === true && dshPre.dryRun === true && !!dshPre.preview);
	c2.send({ type: "preset_import", json: dshEx.json, name: "dsh-冒烟预设", requestId: "dsh-im2" });
	const dshImp = await c2.wait((m) => m.type === "preset_import_result" && m.requestId === "dsh-im2", 10000);
	check("DSH 导入落盘", dshImp.ok === true && dshImp.dryRun === false);
	// 导入成功会推一条 notice（与真实使用一致）——在这里消费掉，否则会污染后面
	// 「slash 命令 → notice」那几段的首条匹配。
	await c2.wait((m) => m.type === "notice" && m.text.includes("预设已导入"), 10000).catch(() => null);
	c2.send({ type: "apply_preset", name: "dsh-冒烟预设" });
	const dshApplied = await c2.wait(
		(m) => m.type === "settings_state" && m.settings.presets?.some((p) => p.name === "dsh-冒烟预设"),
		10000,
	);
	check("DSH 导入的预设出现在预设列表", !!dshApplied);
	c2.send({ type: "preset_import_url", url: "http://127.0.0.1/p.json", requestId: "dsh-im3" });
	const dshUrl = await c2.wait((m) => m.type === "preset_import_result" && m.requestId === "dsh-im3", 10000);
	check("DSH 网址导入拦回环地址", dshUrl.ok === false && typeof dshUrl.error === "string");
	c2.send({ type: "preset_catalog", requestId: "dsh-ct1" });
	const dshCat = await c2.wait((m) => m.type === "preset_catalog_result" && m.requestId === "dsh-ct1", 15000);
	check("DSH 目录回执形状完整", Array.isArray(dshCat.entries) && typeof dshCat.source === "string");
	c2.send({ type: "delete_preset", name: "dsh-冒烟预设" });
	await c2.wait(
		(m) => m.type === "settings_state" && !m.settings.presets?.some((p) => p.name === "dsh-冒烟预设"),
		10000,
	);

	// --- 6. slash 命令拦截（不发模型） ---
	c2.send({ type: "prompt", text: "/model 这个模型必然不存在xyz" });
	const modelBad = await c2.wait((m) => m.type === "notice", 10000);
	check("slash /model 无匹配 → notice", modelBad.text.includes("没有匹配到模型"), modelBad.text);
	c2.send({ type: "prompt", text: "/cwd /nonexistent-zzz" });
	const cwdBad = await c2.wait((m) => m.type === "notice", 10000);
	check("slash /cwd 无效路径 → notice", cwdBad.text.includes("切换工作目录失败"), cwdBad.text);

	// /new <prompt>：首条提示必须落进新对话（NATIVE_COMMANDS 是两个引擎共用的，
	// 行为必须一致）。探针用「/cwd」无参数形态——只回显、不发模型。
	c2.send({ type: "prompt", text: "/new /cwd" });
	const firstNotice = await c2
		.wait((m) => m.type === "notice" && m.text.includes("当前工作目录"), 10000)
		.catch(() => null);
	check("slash /new <首条提示> 投递到新对话", !!firstNotice, firstNotice?.text ?? "timeout");

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
