import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = mkdtempSync(join(tmpdir(), "pi-plugin-client-conv-"));
const dataDir = join(tmp, "data");
const work = join(tmp, "work");
const agentDir = join(tmp, "agent");
mkdirSync(work, { recursive: true });
mkdirSync(agentDir, { recursive: true });

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "dummy",
				models: [
					{ id: "mock-model", name: "Mock Model" },
					{ id: "other-model", name: "Other Model" },
				],
			},
		},
	}),
);

const plugDir = join(dataDir, "plugins", "convprobe");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({ name: "convprobe", version: "0.1.0", permissions: ["http"] }),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		const events = [];
		host.onClientModelChanged((s) => {
			events.push({
				clientId: s.clientId,
				conversationId: s.conversationId,
				sessionFile: s.sessionFile ?? null,
				model: s.model ?? null,
				isSubagent: s.isSubagent,
				totalMessages: s.stats?.totalMessages ?? -1,
			});
		});
		const pick = (clientId) => {
			const s = host.getActiveConversation(clientId ? { clientId } : undefined);
			if (!s) return null;
			return {
				clientId: s.clientId,
				conversationId: s.conversationId,
				sessionFile: s.sessionFile ?? null,
				isSubagent: s.isSubagent,
				model: s.model ?? null,
				totalMessages: s.stats?.totalMessages ?? -1,
				title: s.title,
			};
		};
		host.route("GET", "/active", (req, res) => {
			const cid = String(req.query?.clientId ?? "");
			res.json({ scoped: pick(cid), fallback: pick("") });
		});
		host.route("GET", "/events", (_req, res) => res.json({ events }));
	},
};`,
);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
const socks = [];

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

const getJson = async (path) => {
	try {
		const r = await fetch(`${BASE}${path}`);
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
};
const active = async (clientId) =>
	(await getJson(`/plugins-api/convprobe/active${clientId ? `?clientId=${clientId}` : ""}`)) ?? {};
const events = async () => (await getJson("/plugins-api/convprobe/events"))?.events ?? [];
const waitFor = async (fn, ms = 8000) => {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > ms) return null;
		await sleep(200);
	}
};

try {
	try {
		freePort(PORT);
	} catch {}
	await sleep(300);
	proc = spawn(realpathSync(process.execPath), [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: work,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));
	{
		const t0 = Date.now();
		while (!(await portUp(PORT))) {
			if (Date.now() - t0 > 25_000) throw new Error("server not ready");
			await sleep(250);
		}
	}
	await sleep(1000);

	const t1 = await connect("tab-1");
	const t2 = await connect("tab-2");
	socks.push(t1, t2);
	t1.send(JSON.stringify({ type: "new_chat" }));
	t2.send(JSON.stringify({ type: "new_chat" }));

	const a1 = await waitFor(async () => (await active("tab-1")).scoped);
	const a2 = await waitFor(async () => (await active("tab-2")).scoped);
	check("tab-1 能取到自己的快照", !!a1);
	check("tab-2 能取到自己的快照", !!a2);
	check("快照点名 clientId", a1?.clientId === "tab-1" && a2?.clientId === "tab-2");
	check(
		"两个标签页拿的是各自的对话（会话文件不同）",
		!!a1?.sessionFile && !!a2?.sessionFile && a1.sessionFile !== a2.sessionFile,
		`${a1?.conversationId}@${a1?.sessionFile?.split(/[\\/]/).pop()} vs ${a2?.conversationId}@${a2?.sessionFile?.split(/[\\/]/).pop()}`,
	);
	check("快照带 sessionFile（成本账本用）", typeof a1?.sessionFile === "string" && a1.sessionFile.length > 0);
	check("重复取同一个客户端结果稳定", (await active("tab-1")).scoped?.sessionFile === a1?.sessionFile);
	check("快照带 isSubagent（主对话 = false）", a1?.isSubagent === false && a2?.isSubagent === false);
	const fb = await active();
	check(
		"缺省取用 = 全局回落（不认识 clientId 也一样）",
		fb.fallback?.sessionFile === a1.sessionFile || fb.fallback?.sessionFile === a2.sessionFile,
	);
	const unknown = await active("no-such-tab");
	check(
		"clientId 不认识 → 回落全局",
		unknown.scoped?.sessionFile === unknown.fallback?.sessionFile,
		JSON.stringify({ scoped: unknown.scoped, fallback: unknown.fallback }),
	);

	const ofTab = (list, cid) => list.filter((e) => e.clientId === cid);
	check("切换前没有事件", (await events()).length === 0);
	t1.send(JSON.stringify({ type: "set_model", modelId: "mock/mock-model" }));
	const ev1 = await waitFor(async () => ofTab(await events(), "tab-1")[0]);
	check("切模型后不发消息也立即收到事件", !!ev1, JSON.stringify(ev1));
	check("事件归属发起切换的标签页与会话", ev1?.clientId === "tab-1" && ev1?.sessionFile === a1.sessionFile);
	check("另一个标签页没收到（不串台）", ofTab(await events(), "tab-2").length === 0);
	check("事件带 isSubagent 与消息数", ev1?.isSubagent === false && typeof ev1?.totalMessages === "number");

	t1.send(JSON.stringify({ type: "set_model", modelId: "mock/mock-model" }));
	await sleep(1200);
	check("重复切同一个模型不重复发事件", (await events()).length === 1, `events=${(await events()).length}`);

	t2.send(JSON.stringify({ type: "set_model", modelId: "mock/mock-model" }));
	const ev2 = await waitFor(async () => ofTab(await events(), "tab-2")[0]);
	check("另一个标签页切模型单独出事件", ev2?.sessionFile === a2?.sessionFile, JSON.stringify(ev2));
	const afterGood = (await events()).length;

	t1.send(JSON.stringify({ type: "set_model", modelId: "mock/nope-model" }));
	await sleep(1200);
	check("切换失败不产生事件", (await events()).length === afterGood, `events=${(await events()).length}`);

	t1.send(JSON.stringify({ type: "set_model", modelId: "mock/other-model" }));
	const ev3 = await waitFor(async () => (await events()).find((e) => e.model === "mock/other-model"));
	check("切到新模型再发事件", !!ev3, JSON.stringify(ev3));
	t1.send(JSON.stringify({ type: "set_model", modelId: "mock/mock-model" }));
	const ev4 = await waitFor(
		async () => ofTab(await events(), "tab-1").filter((e) => e.model === "mock/mock-model").length === 2,
	);
	check("切回原模型也再发一次（A→B→A 不被永久静音）", !!ev4);
} catch (err) {
	check(`未捕获异常：${err?.message ?? err}`, false);
	console.error(err?.stack ?? err);
} finally {
	for (const s of socks) {
		try {
			s.close();
		} catch {}
	}
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
