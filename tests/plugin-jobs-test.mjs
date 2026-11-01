/* Smoke test（issue #152 / #148）：起真服务，用 WebSocket 验证插件后台作业与
 * 市场目录同步协议 —— 不联网、不开浏览器。
 *
 * 覆盖：
 *   - plugin_job 参数非法 → 立即回 done(ok:false, 原因)
 *   - plugin_job uninstall 真实存在的插件目录 → 跑 CLI 删掉 → done(ok:true) + 列表更新
 *   - plugin_job uninstall 不存在的插件 → done(ok:false)（完整 spawn→失败路径）
 *   - plugin_catalog_sync 本地 JSON → result(ok) + 原子写盘 + 条目出现在推送的 plugin_catalog 里
 *   - plugin_catalog_sync 坏 JSON → result(ok:false) 且旧目录文件原样保留
 *
 * Run:  npm run build:server && node tests/plugin-jobs-test.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 20000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-pjob-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-pjob-data-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_PLUGIN_CATALOG_URL = process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "";

const NODE = process.execPath;
const REPO = fileURLToPath(new URL("../", import.meta.url));

const server = spawn(NODE, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.on("exit", (code) => console.error(`[srv exited early: ${code}]`));
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 8000, step = 100) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await sleep(step);
	}
	return pred();
}

let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

/** 每个 jobId 的进度消息 + 最终结果。 */
const jobs = new Map();
const syncResults = new Map();
let catalogEntries = null;

function cleanup() {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		try {
			server.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	rmSync(workdir, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
	await waitServer();
	console.log("server up");

	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const open = new Promise((res, rej) => {
		ws.on("open", res);
		ws.on("error", rej);
	});
	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (msg.type === "plugin_job") {
			const entry = jobs.get(msg.jobId) ?? [];
			entry.push(msg);
			jobs.set(msg.jobId, entry);
		}
		if (msg.type === "plugin_catalog_sync_result") syncResults.set(msg.requestId, msg);
		if (msg.type === "plugin_catalog") catalogEntries = msg.entries;
	});
	const send = (m) => ws.send(JSON.stringify(m));
	await open;
	console.log("ws connected");
	send({ type: "hello", clientId: "plugin-jobs-test" });
	await new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error("timed out waiting for ready")), 30000);
		ws.on("message", (d) => {
			try {
				if (JSON.parse(d.toString()).type === "ready") {
					clearTimeout(timer);
					res();
				}
			} catch {
				/* ignore */
			}
		});
	});
	console.log("ready received");

	const done = (jobId) => jobs.get(jobId)?.find((m) => m.phase === "done");

	// -- 1) 参数非法：本地路径不被服务端作业接受 --------------------------------
	const badJob = "bad-source";
	send({ type: "plugin_job", jobId: badJob, action: "install", id: "nope", source: "/etc/passwd" });
	await waitFor(() => done(badJob), 5000, 50);
	check("非法来源被拒（就回一条 done，不让面板等超时）", done(badJob)?.ok === false);
	check("拒绝原因可读", typeof done(badJob)?.error === "string" && done(badJob).error.length > 0);

	// -- 2) 卸载一个真实存在的插件目录：完整 spawn → 成功 → 列表更新 --------------
	const pluginsDir = join(dataDir, "plugins");
	mkdirSync(join(pluginsDir, "faked"), { recursive: true });
	writeFileSync(join(pluginsDir, "faked", "manifest.json"), JSON.stringify({ name: "faked" }));
	catalogEntries = null;
	send({ type: "plugin_job", jobId: "uninstall-ok", action: "uninstall", id: "faked" });
	await waitFor(() => done("uninstall-ok"), 60000, 100);
	check("卸载成功作业回 done(ok)", done("uninstall-ok")?.ok === true);
	check("插件目录已被 CLI 删掉", !existsSync(join(pluginsDir, "faked")));
	await waitFor(() => catalogEntries !== null, 5000, 50);
	check("成功后服务端重推了插件列表", Array.isArray(catalogEntries));

	// -- 3) 卸载不存在的插件：CLI 报错 → done(ok:false, 带输出尾部) --------------
	send({ type: "plugin_job", jobId: "uninstall-missing", action: "uninstall", id: "does-not-exist" });
	await waitFor(() => done("uninstall-missing"), 60000, 100);
	check("卸载不存在的插件失败并回 done(ok:false)", done("uninstall-missing")?.ok === false);
	check("失败回执带输出尾部", (done("uninstall-missing")?.output ?? "").length > 0);

	// -- 4) 目录同步：本地 JSON → 原子写盘 + 条目推送 ----------------------------
	const src = join(workdir, "catalog.json");
	writeFileSync(src, JSON.stringify({ entries: [{ id: "third-party", source: "someone/repo", name: "第三方" }] }));
	send({ type: "plugin_catalog_sync", requestId: "sync-1", source: src });
	await waitFor(() => syncResults.has("sync-1"), 10000, 50);
	const r1 = syncResults.get("sync-1");
	check("目录同步成功回执 ok", r1?.ok === true);
	check("回执带合并后的列表", Array.isArray(r1?.entries) && r1.entries.some((e) => e.id === "third-party"));
	const customFile = join(dataDir, "plugin-catalog.json");
	check("自定义目录已原子写盘", existsSync(customFile));
	const written = JSON.parse(readFileSync(customFile, "utf8"));
	check(
		"写盘内容为白名单字段",
		written.entries?.[0]?.id === "third-party" && written.entries[0].source === "someone/repo",
	);
	await waitFor(() => (catalogEntries ?? []).some((e) => e.id === "third-party"), 5000, 50);
	check(
		"新条目已推给客户端（plugin_catalog）",
		(catalogEntries ?? []).some((e) => e.id === "third-party"),
	);

	// -- 5) 坏 JSON：不写盘（旧目录保持有效） ------------------------------------
	const before = readFileSync(customFile, "utf8");
	const bad = join(workdir, "bad.json");
	writeFileSync(bad, "{ not json");
	send({ type: "plugin_catalog_sync", requestId: "sync-2", source: bad });
	await waitFor(() => syncResults.has("sync-2"), 10000, 50);
	check("坏 JSON 回执 ok:false", syncResults.get("sync-2")?.ok === false);
	check("坏文档不覆盖已有目录", readFileSync(customFile, "utf8") === before);

	ws.close();
	console.log(`\n${passed} checks passed`);
}

main()
	.catch((err) => {
		console.error("test error:", err);
		process.exitCode = 1;
	})
	.finally(async () => {
		cleanup();
		await sleep(300);
		process.exit(process.exitCode ?? 0);
	});
