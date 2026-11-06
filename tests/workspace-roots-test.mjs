import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 8973;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = mkdtempSync(join(tmpdir(), "pi-ws-roots-"));
const dataDir = join(tmp, "data");
const main = join(tmp, "main");
const other = join(tmp, "other");
const extra = join(tmp, "extra");
const extra2 = join(tmp, "extra2");
mkdirSync(main, { recursive: true });
mkdirSync(other, { recursive: true });
mkdirSync(extra, { recursive: true });
mkdirSync(extra2, { recursive: true });
writeFileSync(join(extra, "hello.txt"), "from-extra");
writeFileSync(join(extra2, "hello2.txt"), "from-extra2");

const plugDir = join(dataDir, "plugins", "rootprobe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "rootprobe", version: "0.1.0", permissions: ["fs"] }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		host.registerCommand({
			name: "probe-read",
			description: "读一个绝对路径",
			descriptionEn: "Read an absolute path",
			run: async (args) => {
				try {
					const txt = await host.fs.readTextPath(args.trim());
					return "OK:" + txt;
				} catch (err) {
					return "DENY:" + (err && err.message ? err.message : String(err));
				}
			},
		});
	},
};`,
);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const samePath = (a, b) => {
	const na = resolve(String(a)).replace(/[/\\]+$/, "");
	const nb = resolve(String(b)).replace(/[/\\]+$/, "");
	return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};
const rootsOf = (msg) => (msg?.workspaceRoots ?? []).map((p) => String(p));

let proc = null;
let sock = null;
let lastRoots = null;
let lastReady = null;
const notices = [];

const connect = (clientId) =>
	new Promise((res, rej) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => rej(new Error("connect timeout")), 20_000);
		s.on("open", () => s.send(JSON.stringify({ type: "hello", clientId })));
		s.on("error", rej);
		s.on("message", (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (m.type === "ready") {
				clearTimeout(timer);
				res(s);
				return;
			}
			if ((m.type === "snapshot" || m.type === "snapshot_delta" || m.type === "state") && m.state) {
				const next = rootsOf(m.state);
				lastRoots = next;
			} else if (m.type === "notice") notices.push(m);
		});
	});

const until = async (pred, label, timeoutMs = 12_000) => {
	const t0 = Date.now();
	for (;;) {
		const v = pred();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
		await sleep(120);
	}
};

const runProbe = async (path) => {
	notices.length = 0;
	sock.send(JSON.stringify({ type: "prompt", text: `/probe-read ${path}` }));
	return await until(() => {
		const hit = notices.find((n) => /^(OK|DENY):/.test(String(n.text)));
		return hit ? String(hit.text) : null;
	}, `probe-read notice (${path})`);
};

try {
	try {
		await freePort(PORT);
	} catch {}
	await sleep(300);
	proc = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: main },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	{
		const t0 = Date.now();
		while (!(await portUp(PORT))) {
			if (Date.now() - t0 > 25_000) throw new Error("server not ready");
			await sleep(250);
		}
	}

	sock = await connect(randomUUID());
	lastReady = null;
	await until(() => lastRoots !== null, "first snapshot");

	check(
		"初始快照的 workspaceRoots 为空（单根）",
		lastRoots !== null && lastRoots.length === 0,
		JSON.stringify(lastRoots),
	);

	const helloExtra = join(extra, "hello.txt");
	const before = await runProbe(helloExtra);
	check("加根前读工作区外路径被拒（提示未授权）", before.startsWith("DENY:"), before.slice(0, 120));

	sock.send(JSON.stringify({ type: "set_workspace_roots", roots: [extra] }));
	await until(() => lastRoots && lastRoots.length === 1 && samePath(lastRoots[0], extra), "roots in snapshot");
	check("set_workspace_roots 落进快照", true, lastRoots.join(","));

	const after = await runProbe(helloExtra);
	check("加根后同一路径放行（插件阅读不必再授权）", after === "OK:from-extra", after.slice(0, 120));

	sock.send(JSON.stringify({ type: "set_workspace_roots", roots: ["relative/dir", 1, null, extra2] }));
	await until(() => lastRoots && lastRoots.length === 1 && samePath(lastRoots[0], extra2), "normalized roots");
	check("相对路径与非字符串被丢弃，绝对路径留下", true, lastRoots.join(","));
	const inExtra = await runProbe(helloExtra);
	check("被丢弃的根不再放行（列表是覆盖语义，不是并集）", inExtra.startsWith("DENY:"), inExtra.slice(0, 100));

	sock.send(JSON.stringify({ type: "set_workspace_roots", roots: [extra] }));
	await until(() => lastRoots && lastRoots.length === 1 && samePath(lastRoots[0], extra), "roots for main");
	sock.send(JSON.stringify({ type: "set_cwd", path: other }));
	await until(() => lastRoots && lastRoots.length === 0, "roots cleared after project switch");
	check("切到别的项目：该项目没有根（快照清空）", true);
	sock.send(JSON.stringify({ type: "set_workspace_roots", roots: [extra2] }));
	await until(() => lastRoots && lastRoots.length === 1 && samePath(lastRoots[0], extra2), "roots for other");
	sock.send(JSON.stringify({ type: "set_cwd", path: main }));
	await until(() => lastRoots && lastRoots.length === 1 && samePath(lastRoots[0], extra), "roots restored for main");
	check("切回原项目：原来的根还在（按项目持久化）", true, lastRoots.join(","));

	let persisted = "";
	try {
		persisted = readFileSync(join(dataDir, "client-state.json"), "utf8");
	} catch {}
	const norm = (p) => resolve(p).split(sep).join("/");
	const persistedNorm = persisted.split("\\\\").join("/").split("\\").join("/");
	check(
		"client-state.json 里按项目存了两个根",
		persistedNorm.includes(norm(extra)) && persistedNorm.includes(norm(extra2)),
		persisted ? `${persisted.length} bytes` : "file missing",
	);

	sock.send(JSON.stringify({ type: "set_workspace_roots", roots: [] }));
	await until(() => lastRoots && lastRoots.length === 0, "roots cleared");
	const cleared = await runProbe(helloExtra);
	check("空数组 = 回到单根（工作区外又需要授权）", cleared.startsWith("DENY:"), cleared.slice(0, 100));
} catch (err) {
	check(`未捕获异常：${err?.message ?? err}`, false);
	console.error(err?.stack ?? err);
} finally {
	try {
		sock?.close();
	} catch {}
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGKILL");
		} catch {}
	}
	try {
		await freePort(PORT);
	} catch {}
	rmSync(tmp, { recursive: true, force: true });
	await sleep(200);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
