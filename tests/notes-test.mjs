import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 8914;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverPath = process.execPath;
const dataDir = mkdtempSync(join(tmpdir(), "pi-notes-e2e-"));
const cwd = join(dataDir, "work");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(dataDir, "plugins"), { recursive: true });
cpSync(join(repoRoot, "plugins", "notes"), join(dataDir, "plugins", "notes"), { recursive: true });

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

function ok(msg) {
	console.log(`✓ ${msg}`);
}

let proc = null;
let sock = null;

function startServer() {
	const p = spawn(serverPath, [join(repoRoot, "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd },
		stdio: ["ignore", "pipe", "pipe"],
	});
	p.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	return p;
}

async function waitReady() {
	const t0 = Date.now();
	for (;;) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) return;
		} catch {}
		if (Date.now() - t0 > 25_000) throw new Error("server not ready");
		await new Promise((r) => setTimeout(r, 300));
	}
}

function connectWs(collect) {
	return new Promise((resolve, reject) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
		s.on("open", () =>
			s.send(JSON.stringify({ type: "hello", clientId: `notes-e2e-${Math.random().toString(36).slice(2, 7)}` })),
		);
		s.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			collect?.(msg);
			if (msg.type === "ready") {
				clearTimeout(timer);
				resolve(s);
			}
		});
		s.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function api(path, init) {
	const res = await fetch(`${BASE}/plugins-api/notes${path}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body, headers: res.headers };
}

const post = (body) => api("/op", { method: "POST", body: JSON.stringify(body) });

try {
	proc = startServer();
	await waitReady();

	const messages = [];
	sock = await connectWs((m) => messages.push(m));
	await new Promise((r) => setTimeout(r, 1200));
	const plugins = messages.filter((m) => m.type === "plugins").at(-1)?.plugins ?? [];
	const info = plugins.find((p) => p.id === "notes");
	if (!info) fail("plugins 清单里没有 notes（插件没被激活？）");
	else if (info.error) fail(`插件激活报错：${info.error}`);
	else ok(`插件已激活：${info.name} v${info.version}`);
	if (info?.ui?.items?.some((i) => i.action === "notes:toggle" && i.slot === "topbar.primary")) {
		ok("顶栏动作 notes:toggle 已随清单下发");
	} else {
		fail(`顶栏动作没下发：${JSON.stringify(info?.ui?.items ?? null)}`);
	}
	const toolNames = (info?.agentTools ?? []).map((t) => t.name).sort();
	if (toolNames.length === 1 && toolNames[0] === "notes") {
		ok(`AI 工具 1 个：${toolNames.join(", ")}`);
	} else {
		fail(`AI 工具清单不对：${JSON.stringify(toolNames)}`);
	}
	const commands = messages.filter((m) => m.type === "slash_commands").at(-1)?.commands ?? [];
	const pluginCmds = commands.filter((c) => c.source === "plugin").map((c) => c.name);
	if (["note", "todo", "remind"].every((n) => pluginCmds.includes(n))) {
		ok(`斜杠命令已注册：${["note", "todo", "remind"].join(", ")}`);
	} else {
		fail(`斜杠命令没注册：${JSON.stringify(pluginCmds)}`);
	}

	let r = await api("/store");
	if (r.status !== 200 || r.body?.ok !== true || r.body.store.notes.length !== 0) fail(`GET /store 异常：${r.status}`);
	else ok("GET /plugins-api/notes/store → 空库");

	r = await post({ op: "note.save", item: { title: "会议要点", body: "1. 排期\n2. 风险", tags: ["工作"] } });
	if (r.body?.result?.ok !== true) fail(`note.save 失败：${JSON.stringify(r.body)}`);
	else ok(`记笔记成功（id ${r.body.result.item.id}）`);
	r = await post({ op: "todo.save", item: { text: "交周报", due: "2026-05-06 18:00", priority: 2 } });
	if (r.body?.result?.item?.due !== "2026-05-06T18:00") fail(`todo.save 归一化不对：${JSON.stringify(r.body?.result)}`);
	else ok("加待办成功（截止时间归一化为本地可排序串）");
	r = await post({ op: "reminder.save", item: { text: "吃药", schedule: { type: "daily", time: "09:00" } } });
	const reminderId = r.body?.result?.item?.id;
	if (!reminderId || !r.body.next?.[reminderId]) fail(`提醒没排上下次触发：${JSON.stringify(r.body?.next)}`);
	else ok(`设提醒成功，服务端算出的下次触发：${r.body.next[reminderId]}`);

	const rev = r.body.store.meta.rev;
	const waitStart = Date.now();
	const waiting = api(`/wait?rev=${rev}`);
	await new Promise((res) => setTimeout(res, 300));
	if (
		(await Promise.race([waiting.then(() => "done"), new Promise((res) => setTimeout(() => res("pending"), 50))])) !==
		"pending"
	) {
		fail("rev 相同的长轮询应挂住，实际立刻返回");
	}
	await post({ op: "todo.save", item: { text: "买牛奶" } });
	const woken = await waiting;
	const elapsed = Date.now() - waitStart;
	if (woken.body?.unchanged) fail("长轮询没有被改动唤醒（超时才返回）");
	else if (!woken.body.store.todos.some((t) => t.text === "买牛奶")) fail("唤醒后的快照没带新数据");
	else ok(`长轮询被唤醒（${elapsed}ms）并带回新快照`);

	const md = await api("/export?format=md");
	if (!md.headers.get("content-disposition")?.includes("notes-")) fail("导出没有 Content-Disposition");
	else if (!String(md.body).includes("交周报")) fail("Markdown 导出内容不对");
	else ok("GET /export?format=md → 带文件名的 Markdown");

	sock?.close();
	proc.kill("SIGTERM");
	await new Promise((res) => setTimeout(res, 800));
	if (!readFileSync(join(dataDir, "notes", "store.json"), "utf8").includes("交周报")) {
		fail("库文件里没有刚写的数据");
	}
	proc = startServer();
	await waitReady();
	sock = await connectWs(() => {});
	await new Promise((r) => setTimeout(r, 1200));
	const after = await api("/store");
	if (!after.body.store.todos.some((t) => t.text === "交周报")) fail("重启后数据丢了");
	else ok("服务重启后库仍在（数据在 <dataDir>/notes/）");
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	try {
		sock?.close();
	} catch {}
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 800));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
