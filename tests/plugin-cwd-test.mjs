/**
 * 插件工作区跟随（cwd-follow）协议测试（零 token、自包含）。
 *
 * 覆盖整条链路：WS set_cwd → ClientSession.onCwdChanged →
 * AgentService.onClientCwdChanged → PluginManager.notifyCwd →
 * 插件 onCwdChange 钩子 → plugin_data {kind:"workspace"} 广播。
 * 这是编辑器插件（vscode-editor）「目录随项目切换」的服务端事实源。
 *
 * 运行：先 npm run build:server，再 node tests/plugin-cwd-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const PORT = 8989;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-cwd-plugin-"));
// 两个真实存在的项目目录：启动工作区 + 切换目标
const dirA = mkdtempSync(join(tmpdir(), "cwd-proj-a-"));
const dirB = mkdtempSync(join(tmpdir(), "cwd-proj-b-"));

// ---- 探针插件：记录激活时的 cwd，注册 onCwdChange 广播 workspace ----------
const plugDir = join(dataDir, "plugins", "probe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "cwd-probe", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`globalThis.__cwdProbe = { activatedCwd: null, seen: [] };
export default {
	activate(host) {
		globalThis.__cwdProbe.activatedCwd = host.cwd;
		host.broadcast({ kind: "workspace", root: host.cwd }); // 激活时即推当前根
		return host.onCwdChange((cwd) => {
			globalThis.__cwdProbe.seen.push(cwd);
			host.broadcast({ kind: "workspace", root: cwd });
		});
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// 从第一个消息起持续收集 workspace 广播——初始广播在 ready/plugins 之间到达，
// 不能按消息类型分段等待（会漏掉早到的）。
const workspaces = []; // resolve() 过的根路径，按到达顺序

function handleMessage(raw) {
	const msg = JSON.parse(raw.toString());
	if (msg.type === "plugin_data" && msg.pluginId === "probe" && msg.payload?.kind === "workspace") {
		workspaces.push(resolve(String(msg.payload.root)));
	}
	return msg;
}

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (handleMessage(raw).type === "ready") {
				clearTimeout(timer);
				resolve2(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** 等到收集到第 i 个（0 起）workspace 广播。 */
function nextWorkspace(i, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const poll = () => {
			if (workspaces.length > i) return resolve2(workspaces[i]);
			if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
			setTimeout(poll, 50);
		};
		poll();
	});
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: dirA,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	// -- attach：插件激活时广播服务端启动目录 ----------------------------------
	const sock = await connect("cwd-test");
	const first = await nextWorkspace(0, "initial workspace broadcast");
	if (first !== resolve(dirA)) {
		fail(`激活广播的根错误：${first} ≠ ${resolve(dirA)}`);
	} else {
		console.log(`✓ attach 时插件拿到服务端工作区 ${first}`);
	}

	// -- set_cwd → workspace 广播跟随 -----------------------------------------
	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	const second = await nextWorkspace(1, "workspace after set_cwd");
	if (second !== resolve(dirB)) {
		fail(`切换项目后插件根未跟随：${second} ≠ ${resolve(dirB)}`);
	} else {
		console.log(`✓ set_cwd 后插件收到新根 ${second}`);
	}

	// 同路径重复 set_cwd 不应再广播（幂等）
	const countBefore = workspaces.length;
	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	await new Promise((r) => setTimeout(r, 1200));
	if (workspaces.length > countBefore) {
		fail(`同路径重复 set_cwd 触发了多余广播：${workspaces.slice(countBefore).join(", ")}`);
	} else {
		console.log("✓ 同路径重复 set_cwd 幂等（无多余广播）");
	}

	// 激活钩子记录的 seen 应与广播一致（内证）
	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	// 等端口释放再删临时目录（win 文件句柄释放稍慢）
	await new Promise((r) => setTimeout(r, 600));
	for (const d of [dataDir, dirA, dirB]) rmSync(d, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
