import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 8976;
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = mkdtempSync(join(tmpdir(), "pi-plugin-grants-"));
const dataDir = join(tmp, "data");
const work = join(tmp, "work");
const outside = join(tmp, "outside");
const outside2 = join(tmp, "outside2");
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(outside2, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "granted-content");
writeFileSync(join(outside2, "other.txt"), "other-content");

const plugDir = join(dataDir, "plugins", "grantprobe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "grantprobe", version: "0.1.0", permissions: ["fs"] }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		host.registerCommand({
			name: "probe-grant",
			description: "请求访问目录并读一个文件",
			descriptionEn: "Request directory access and read a file",
			run: async (args) => {
				const [dir, file] = args.trim().split("|");
				try {
					const ok = await host.fs.requestAccess(dir);
					if (!ok) return "DENY:用户拒绝或宿主未接线";
					const txt = await host.fs.readTextPath(file);
					return "OK:" + txt;
				} catch (err) {
					return "ERR:" + (err && err.message ? err.message : String(err));
				}
			},
		});
		host.registerCommand({
			name: "probe-dirs",
			description: "列出已授权目录",
			descriptionEn: "List authorized directories",
			run: () => "DIRS:" + JSON.stringify(host.fs.authorizedDirs()),
		});
	},
};`,
);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
let sock = null;
const notices = [];
const pathRequests = [];
const grantPushes = [];

const connect = (clientId) =>
	new Promise((res, rej) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => rej(new Error("connect timeout")), 20_000);
		s.on("error", rej);
		s.on("open", () => s.send(JSON.stringify({ type: "hello", clientId })));
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
			if (m.type === "notice") notices.push(m);
			else if (m.type === "plugin_path_request") pathRequests.push(m);
			else if (m.type === "plugin_grants") grantPushes.push(m);
		});
	});

const until = async (pred, label, timeoutMs = 15_000) => {
	const t0 = Date.now();
	for (;;) {
		const v = pred();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
		await sleep(120);
	}
};

const runCommand = async (text) => {
	notices.length = 0;
	sock.send(JSON.stringify({ type: "prompt", text }));
	return await until(() => {
		const hit = notices.find((n) => /^(OK|DENY|ERR|DIRS):/.test(String(n.text)));
		return hit ? String(hit.text) : null;
	}, `command echo (${text})`);
};

try {
	try {
		freePort(PORT);
	} catch {}
	await sleep(300);
	proc = spawn(realpathSync(process.execPath), [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: work },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	{
		const t0 = Date.now();
		while (!(await portUp(PORT))) {
			if (Date.now() - t0 > 25_000) throw new Error("server not ready");
			await sleep(250);
		}
	}
	await sleep(1200);

	sock = await connect(randomUUID());

	const insideFile = join(work, "inside.txt");
	writeFileSync(insideFile, "inside-content");
	const inside = await runCommand(`/probe-grant ${work}|${insideFile}`);
	check("工作区内的目录不需确认（requestAccess 直接 true）", inside === "OK:inside-content", inside.slice(0, 120));
	check("工作区内不产生授权弹窗", pathRequests.length === 0);

	const secret = join(outside, "secret.txt");
	const pending = runCommand(`/probe-grant ${outside}|${secret}`);
	const req = await until(() => pathRequests[0], "plugin_path_request");
	check(
		"插件请求工作区外目录 → 浏览器收到 plugin_path_request",
		!!req,
		JSON.stringify({ pluginId: req?.pluginId, path: req?.path }),
	);
	check("请求里带着插件 id 与目标目录", req?.pluginId === "grantprobe" && !!req?.path);
	sock.send(JSON.stringify({ type: "plugin_path_response", id: req.id, ok: true, remember: true }));
	const afterGrant = await pending;
	check("用户同意后插件读到该目录（授权链路打通）", afterGrant === "OK:granted-content", afterGrant.slice(0, 120));

	const pushed = await until(
		() => grantPushes.find((g) => (g.grants ?? []).some((x) => x.pluginId === "grantprobe")),
		"plugin_grants push",
	);
	const entry = (pushed.grants ?? []).find((g) => g.pluginId === "grantprobe");
	check(
		"plugin_grants 推给浏览器且含该目录",
		(entry?.paths ?? []).some((p) => p.toLowerCase().includes("outside")),
		JSON.stringify(entry),
	);

	const sock2 = await connect(randomUUID());
	const pushed2 = await until(
		() =>
			grantPushes
				.slice()
				.reverse()
				.find((g) => (g.grants ?? []).some((x) => x.pluginId === "grantprobe" && x.paths.length > 0)),
		"plugin_grants on attach",
	);
	check("新连接 attach 时也收到 plugin_grants（刷新不丢授权）", !!pushed2);
	sock2.close();

	pathRequests.length = 0;
	const second = await runCommand(`/probe-grant ${outside}|${secret}`);
	check(
		"已授权的目录不再弹窗（remember 生效）",
		second === "OK:granted-content" && pathRequests.length === 0,
		second.slice(0, 80),
	);
	const dirs = await runCommand("/probe-dirs");
	check("authorizedDirs() 列出该目录", /DIRS:\[".*outside.*"\]/.test(dirs), dirs.slice(0, 160));

	grantPushes.length = 0;
	sock.send(JSON.stringify({ type: "plugin_path_revoke", pluginId: "grantprobe" }));
	const revoked = await until(() => {
		const last = grantPushes[grantPushes.length - 1];
		if (!last) return null;
		const e = (last.grants ?? []).find((g) => g.pluginId === "grantprobe");
		return !e || e.paths.length === 0 ? last : null;
	}, "plugin_grants after revoke");
	check("撤销后推送的授权表里该插件为空", !!revoked);
	pathRequests.length = 0;
	const pending2 = runCommand(`/probe-grant ${outside}|${secret}`);
	const req2 = await until(() => pathRequests[0], "second plugin_path_request after revoke");
	check("撤销后再读该目录会重新弹窗确认", !!req2);
	if (req2) sock.send(JSON.stringify({ type: "plugin_path_response", id: req2.id, ok: false }));
	const denied = await pending2;
	check("这次选择拒绝 → 插件拿到 DENY（不静默放行）", denied.startsWith("DENY:"), denied.slice(0, 120));
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
		freePort(PORT);
	} catch {}
	rmSync(tmp, { recursive: true, force: true });
	await sleep(200);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
