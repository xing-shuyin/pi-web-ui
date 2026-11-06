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
const dirA = mkdtempSync(join(tmpdir(), "cwd-proj-a-"));
const dirB = mkdtempSync(join(tmpdir(), "cwd-proj-b-"));

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

const workspaces = [];

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
			PI_WEB_PLUGIN_CATALOG_URL: process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "",
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

	const sock = await connect("cwd-test");
	const first = await nextWorkspace(0, "initial workspace broadcast");
	if (first !== resolve(dirA)) {
		fail(`激活广播的根错误：${first} ≠ ${resolve(dirA)}`);
	} else {
		console.log(`✓ attach 时插件拿到服务端工作区 ${first}`);
	}

	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	const second = await nextWorkspace(1, "workspace after set_cwd");
	if (second !== resolve(dirB)) {
		fail(`切换项目后插件根未跟随：${second} ≠ ${resolve(dirB)}`);
	} else {
		console.log(`✓ set_cwd 后插件收到新根 ${second}`);
	}

	const countBefore = workspaces.length;
	sock.send(JSON.stringify({ type: "set_cwd", path: dirB }));
	await new Promise((r) => setTimeout(r, 1200));
	if (workspaces.length > countBefore) {
		fail(`同路径重复 set_cwd 触发了多余广播：${workspaces.slice(countBefore).join(", ")}`);
	} else {
		console.log("✓ 同路径重复 set_cwd 幂等（无多余广播）");
	}

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 600));
	for (const d of [dataDir, dirA, dirB]) rmSync(d, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
