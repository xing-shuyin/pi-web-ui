import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 8915;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "pi-cron-overflow-"));
const pluginDir = join(dataDir, "plugins", "far");
mkdirSync(join(pluginDir, "client"), { recursive: true });
const logFile = join(pluginDir, "fires.log").replace(/\\/g, "\\\\");

writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ name: "far", version: "0.1.0" }));
writeFileSync(
	join(pluginDir, "index.mjs"),
	`import { appendFileSync } from "node:fs";
export default {
	activate(host) {
		const tally = (which) => () => {
			try { appendFileSync("${logFile}", which + "\\n"); } catch {}
		};
		host.schedule("0 9 1 1 *", tally("far"), { persistent: true, id: "far", label: "远期任务" });
		host.schedule("0 0 31 2 *", tally("never"), { persistent: true, id: "never", label: "永不发生" });
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}
const ok = (msg) => console.log(`✓ ${msg}`);

let proc = null;
let sock = null;

function fires() {
	if (!existsSync(logFile)) return [];
	return readFileSync(logFile, "utf8").split("\n").filter(Boolean);
}

async function waitReady() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("server not ready");
}

function connectWs(collect) {
	return new Promise((resolve, reject) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws timeout")), 15_000);
		s.on("open", () => s.send(JSON.stringify({ type: "hello", clientId: "cron-overflow" })));
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

try {
	proc = spawn(process.execPath, [join(repoRoot, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_TOOL_LAZY_LOADING: "0",
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: repoRoot,
			PI_WEB_PLUGIN_CATALOG_URL: process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	proc.stderr.on("data", (d) => {
		stderr += String(d);
	});
	await waitReady();

	const messages = [];
	sock = await connectWs((m) => messages.push(m));

	let info = null;
	for (let i = 0; i < 40 && !info; i++) {
		const plugins = messages.filter((m) => m.type === "plugins").at(-1)?.plugins ?? [];
		info = plugins.find((p) => p.id === "far") ?? null;
		if (!info) await new Promise((r) => setTimeout(r, 250));
	}
	if (!info) fail("测试插件没被激活");
	else if (info.error) fail(`插件激活报错：${info.error}`);
	else ok("测试插件已激活并排了两条 cron 任务");

	await new Promise((r) => setTimeout(r, 5_000));
	const hits = fires();
	if (hits.length > 0) {
		fail(`远期/永不发生的 cron 不该被触发，实测触发了 ${hits.length} 次（前几次：${hits.slice(0, 5).join(",")}）`);
	} else {
		ok("5 秒内远期（100 天开外）与永不发生（2/31）的 cron 都没被触发 —— 没有溢出死循环");
	}

	if (/TimeoutOverflowWarning/.test(stderr))
		fail("服务端出现了 TimeoutOverflowWarning（仍有超长延迟被喂给 setTimeout）");
	else ok("服务端没有 TimeoutOverflowWarning");

	const alive = await fetch(`${BASE}/api/health`)
		.then((r) => r.ok)
		.catch(() => false);
	if (!alive) fail("服务在 5 秒后不响应了");
	else ok("服务仍然健康（事件循环没被定时器占满）");

	let bg = [];
	for (let i = 0; i < 40 && !bg.length; i++) {
		bg = messages.filter((m) => m.type === "bg_servers").at(-1)?.servers ?? [];
		if (!bg.length) await new Promise((r) => setTimeout(r, 250));
	}
	const never = bg.find((t) => String(t.name ?? "").includes("永不发生"));
	const far = bg.find((t) => String(t.name ?? "").includes("远期任务"));
	if (!never) fail(`后台任务列表里没有「永不发生」那条：${JSON.stringify(bg.map((t) => t.name))}`);
	else if (!String(never.status ?? "").includes("不再触发"))
		fail(`「永不发生」的状态不对：${JSON.stringify(never.status)}`);
	else ok(`「永不发生」的后台任务状态：${never.status}`);
	if (far && !/\d{4}/.test(String(far.status ?? "")))
		fail(`远期任务应显示真实的下次时间：${JSON.stringify(far.status)}`);
	else if (far) ok(`远期任务显示真实的下次时间：${far.status}`);
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
	await new Promise((r) => setTimeout(r, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
