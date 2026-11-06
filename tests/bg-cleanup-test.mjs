import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;

const root = mkdtempSync(join(tmpdir(), "pi-bg-cleanup-"));
const dataDir = join(root, "data");
const work = join(root, "work");
mkdirSync(work, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
let sock = null;
const messages = [];

const waitMsg = (pred, label, timeoutMs = 20_000) => {
	const hit = messages.find(pred);
	if (hit) return Promise.resolve(hit);
	return new Promise((res, rej) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			rej(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (pred(m)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				res(m);
			}
		};
		sock.on("message", onMsg);
	});
};

async function main() {
	proc = spawn(process.execPath, [resolve(__dirname, "../dist/server/index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: work },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", () => {});

	const t0 = Date.now();
	for (;;) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) break;
		} catch {}
		if (Date.now() - t0 > 30_000) throw new Error("server not ready");
		await new Promise((r) => setTimeout(r, 300));
	}
	check("服务器起来了", true, `:${PORT}`);

	sock = await new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((res, rej) => {
		sock.on("error", rej);
		sock.on("open", () => {
			sock.send(JSON.stringify({ type: "hello", clientId: "bg-cleanup-test" }));
			res();
		});
	});
	sock.on("message", (raw) => {
		try {
			messages.push(JSON.parse(raw.toString()));
		} catch {}
	});
	await waitMsg((m) => m.type === "ready", "ready");

	const settingsOf = (m) => m?.settings ?? m?.state?.settings ?? null;
	const before = settingsOf(messages.find((m) => settingsOf(m)));
	check("默认关（0）", (before?.bgAutoCleanupMin ?? 0) === 0, `bgAutoCleanupMin=${before?.bgAutoCleanupMin}`);

	sock.send(JSON.stringify({ type: "set_settings", bgAutoCleanupMin: 30 }));
	const set = await waitMsg((m) => settingsOf(m)?.bgAutoCleanupMin === 30, "settings 回显 30").catch(() => null);
	check("设 30 分钟 → 快照回显", Boolean(set), JSON.stringify(settingsOf(set)?.bgAutoCleanupMin ?? null));

	sock.send(JSON.stringify({ type: "set_settings", bgAutoCleanupMin: 7 }));
	const norm = await waitMsg((m) => settingsOf(m)?.bgAutoCleanupMin === 0, "脏值归一为 0").catch(() => null);
	check("脏值 7 → 归一为 0（只认档位表）", Boolean(norm), JSON.stringify(settingsOf(norm)?.bgAutoCleanupMin ?? null));

	sock.send(JSON.stringify({ type: "set_settings", bgAutoCleanupMin: 15 }));
	await waitMsg((m) => settingsOf(m)?.bgAutoCleanupMin === 15, "settings 回显 15").catch(() => null);

	sock.send(JSON.stringify({ type: "set_bg_keep", port: 65000, keep: true }));
	const keepNotice = await waitMsg(
		(m) => m.type === "notice" && String(m.text ?? "").includes("65000"),
		"set_bg_keep 通知",
	).catch(() => null);
	check("set_bg_keep 对不在列表的端口给通知", Boolean(keepNotice), String(keepNotice?.text ?? "").slice(0, 60));

	sock.send(JSON.stringify({ type: "clean_bg_leftovers" }));
	const cleanNotice = await waitMsg(
		(m) => m.type === "notice" && String(m.text ?? "").includes("没有需要清理"),
		"clean_bg_leftovers 通知",
	).catch(() => null);
	check("立即清理给「没有需要清理」反馈", Boolean(cleanNotice), String(cleanNotice?.text ?? "").slice(0, 70));

	sock.send(JSON.stringify({ type: "list_bg_servers" }));
	const bg = await waitMsg((m) => m.type === "bg_servers", "bg_servers").catch(() => null);
	check("bg_servers 可拉取", Array.isArray(bg?.servers), `count=${bg?.servers?.length ?? "-"}`);

	await new Promise((r) => setTimeout(r, 400));
	const stateFile = join(dataDir, "client-state.json");
	const raw = await (await import("node:fs/promises")).readFile(stateFile, "utf8").catch(() => "");
	check("阈值落盘 client-state.json", raw.includes("bgAutoCleanupMin"), raw ? "" : "(读不到 state 文件)");
}

main()
	.catch((err) => {
		failures++;
		console.error(`✗ ${err?.stack ?? err}`);
	})
	.finally(async () => {
		try {
			sock?.close();
		} catch {}
		try {
			proc?.kill();
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
		console.log(failures === 0 ? "\n后台任务自动清理协议面全过" : `\n后台任务自动清理协议面失败 ${failures} 项`);
		process.exit(failures === 0 ? 0 : 1);
	});
