import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 30000 + Math.floor(Math.random() * 10000);

const tmp = mkdtempSync(join(tmpdir(), "pi-plugin-api-catalog-"));
const dataDir = join(tmp, "data");
const work = join(tmp, "work");
mkdirSync(work, { recursive: true });

const plugDir = join(dataDir, "plugins", "catprobe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "catprobe",
		version: "0.1.0",
		permissions: ["ui"],
		ui: { topbar: [{ id: "m", label: "M" }] },
	}),
);
writeFileSync(join(plugDir, "index.mjs"), `export default { activate() {} };`);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
let sock = null;

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
			}
		});
	});

const queryCatalog = () =>
	new Promise((res, rej) => {
		const requestId = randomUUID();
		const timer = setTimeout(() => rej(new Error("catalog timeout")), 15_000);
		const onMsg = (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (m.type === "plugin_api_catalog_result" && m.requestId === requestId) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				res(m.catalog);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_api_catalog", requestId }));
	});

try {
	try {
		freePort(PORT);
	} catch {}
	await sleep(300);
	proc = spawn(realpathSync(process.execPath), [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: work },
		stdio: ["ignore", "pipe", "pipe"],
	});
	{
		const t0 = Date.now();
		while (!(await portUp(PORT))) {
			if (Date.now() - t0 > 25_000) throw new Error("server not ready");
			await sleep(250);
		}
	}
	await sleep(1200);
	sock = await connect(randomUUID());

	const catalog = await queryCatalog();
	check("回包带 catalog", !!catalog && catalog.version === 1);
	check("34 个 slot", catalog?.slots?.length === 34, String(catalog?.slots?.length));
	const top = catalog?.slots?.find((s) => s.slot === "topbar.primary");
	check("topbar.primary 别名含 topbar", top?.aliases?.includes("topbar") ?? false, JSON.stringify(top?.aliases));
	check("例子可抄（非空）", (top?.example ?? "").includes("topbar"));
	const occ = top?.occupants?.find((o) => o.pluginId === "catprobe");
	check("占用者点名探针插件（manifest 基线 1 条）", occ?.items === 1, JSON.stringify(top?.occupants));
	check("工具表非空", (catalog?.agentTools?.length ?? 0) > 20, String(catalog?.agentTools?.length));
	const methods = new Map((catalog?.hostMethods ?? []).map((m) => [m.name, m]));
	check("方法表含 onToolPre/onToolPost", methods.has("onToolPre") && methods.has("onToolPost"));
	check(
		"方法表行行有例子",
		(catalog?.hostMethods ?? []).every((m) => (m.example ?? "").trim().length > 0),
	);
	check("registerAgentTool 标 tools 族", methods.get("registerAgentTool")?.needs === "tools");
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
