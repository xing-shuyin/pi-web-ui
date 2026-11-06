import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8985;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-leftpanel-running-"));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

function writePlugin(id, manifestName, source) {
	const dir = join(dataDir, "plugins", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: manifestName, version: "0.1.0" }));
	writeFileSync(join(dir, "index.mjs"), source);
}

writePlugin(
	"runner",
	"运行器",
	`export default {
	activate(host) {
		host.leftPanel.setRunning([
			{ id: "job-1", title: "同步收件箱", hint: "1/3", icon: "📬", action: "runner:open" },
			{ id: "job-x", title: "", status: "bogus" },
		]);
		host.registerCommand({ name: "lp-clear", run: () => { host.leftPanel.clear(); return "cleared"; } });
		host.registerCommand({
			name: "lp-set",
			run: () => { host.leftPanel.setRunning([{ id: "job-2", title: "第二个", status: "done" }]); return "set"; },
		});
	},
};`,
);
writePlugin(
	"ticker",
	"心跳插件",
	`export default {
	activate(host) {
		host.leftPanel.setRunning([{ id: "tick", title: "心跳测试" }], { ttlMs: 5000 });
	},
};`,
);

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
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

function trackPanel(sock) {
	const state = { groups: null, count: 0 };
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugin_panel_items") {
			state.groups = m.groups;
			state.count++;
		}
	});
	return state;
}

const byId = (groups, pluginId) => (groups ?? []).find((g) => g.pluginId === pluginId);

async function until(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	await (async () => {
		const t0 = Date.now();
		for (;;) {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return;
			} catch {}
			if (Date.now() - t0 > 20_000) throw new Error("server not ready");
			await new Promise((r) => setTimeout(r, 300));
		}
	})();

	const sock = await connect("leftpanel-running-test");
	const panel = trackPanel(sock);

	const both = await until(
		() => byId(panel.groups, "runner") && byId(panel.groups, "ticker") && panel.groups,
		20_000,
		"runner + ticker groups",
	).catch(() => null);
	const runner = byId(both, "runner");
	check(
		"激活后条目经 plugin_panel_items 推给客户端（分组带插件显示名）",
		Boolean(runner) && runner.pluginName === "运行器",
		JSON.stringify(runner ?? null),
	);
	const job1 = runner?.items.find((i) => i.id === "job-1");
	check(
		"条目字段完整（title/hint/icon/action 保留，缺省 status=running）",
		job1?.title === "同步收件箱" &&
			job1?.hint === "1/3" &&
			job1?.icon === "📬" &&
			job1?.action === "runner:open" &&
			job1?.status === "running",
		JSON.stringify(job1 ?? null),
	);
	const job2 = runner?.items.find((i) => i.id === "job-x");
	check(
		"非法条目被清洗：空 title 回落 id、非法 status 回落 running，不影响其它条目",
		job2?.title === "job-x" && job2?.status === "running",
		JSON.stringify(job2 ?? null),
	);

	const sock2 = await connect("leftpanel-running-test-2");
	const panel2 = trackPanel(sock2);
	const replay = await until(
		() => panel2.groups && byId(panel2.groups, "runner") && panel2.groups,
		10_000,
		"attach replay",
	).catch(() => null);
	check("新客户端 attach 时补发全量分组（无需主动拉取）", Boolean(replay), `groups=${replay?.length ?? 0}`);

	sock.send(JSON.stringify({ type: "prompt", text: "/lp-clear" }));
	const cleared = await until(
		() => panel.groups && !byId(panel.groups, "runner") && panel.groups,
		10_000,
		"runner cleared",
	).catch(() => null);
	check("clear() 立即清空本插件分组并广播", Boolean(cleared) && !byId(cleared, "runner"));
	sock.send(JSON.stringify({ type: "prompt", text: "/lp-set" }));
	const reset = await until(
		() => panel.groups && byId(panel.groups, "runner")?.items[0]?.id === "job-2" && panel.groups,
		10_000,
		"runner re-set",
	).catch(() => null);
	const r2 = byId(reset, "runner");
	check(
		"清空后可再次 setRunning（状态 done 保留）",
		r2?.items[0]?.status === "done",
		JSON.stringify(r2?.items ?? null),
	);

	const expired = await until(
		() => panel.groups && !byId(panel.groups, "ticker") && panel.groups,
		25_000,
		"ticker expired",
	).catch(() => null);
	check("心跳过期：未再调用 setRunning 的插件整组自动清空并广播", Boolean(expired) && !byId(expired, "ticker"));
	check("未过期的插件（TTL 更长）不受影响", Boolean(byId(expired, "runner")));

	sock.close();
	sock2.close();
} catch (err) {
	console.error(`✗ ${err?.message ?? err}`);
	failures++;
} finally {
	proc?.kill("SIGKILL");
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
