import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = realpathSync(process.execPath);
/**
 * 按 PID 杀进程树：Windows 上 process.kill(-pid) 无效（没有进程组语义），必须 taskkill /T。
 * 只认 PID，不碰任何别的进程（禁 pkill -f / killall）。
 */
function killTree(pid) {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {}
}
function portFree(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.once("listening", () => srv.close(() => resolve(true)));
		srv.listen(port, "127.0.0.1");
	});
}
async function pickPort() {
	for (let i = 0; i < 60; i++) {
		const port = 8900 + Math.floor(Math.random() * 30000);
		if (port >= 8900 && (await portFree(port))) return port;
	}
	throw new Error("no free port");
}
const PORT = await pickPort();
const workdir = mkdtempSync(join(tmpdir(), "piweb-scmfeat-"));
const repo = join(workdir, "repo");
process.env.PI_WEB_CWD = repo;
process.env.PI_WEB_DATA_DIR = join(workdir, "data");
process.env.PI_CODING_AGENT_DIR = join(workdir, "agent");
process.env.PI_WEB_PORT = String(PORT);

let pass = 0;
let fail = 0;
function check(name, cond) {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ FAIL: ${name}`);
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execSync(`mkdir repo`, { cwd: workdir, stdio: "ignore" });
execSync("git init -b main", { cwd: repo, stdio: "ignore" });
execSync("git config user.name t", { cwd: repo, stdio: "ignore" });
execSync("git config user.email t@t.local", { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "a.txt"), "one\n");
execSync("git add -A && git commit -m init", { cwd: repo, stdio: "ignore" });
const remotePath = join(workdir, "remote.git");
execSync(`git init --bare ${JSON.stringify(remotePath)}`, { stdio: "ignore" });
execSync(`git remote add origin ${remotePath}`, { cwd: repo, stdio: "ignore" });
execSync("git checkout -b feature", { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "a.txt"), "two\n");
execSync("git add -A && git commit -m feature-work", { cwd: repo, stdio: "ignore" });
execSync("git push -u origin feature", { cwd: repo, stdio: "ignore", env: process.env });
execSync("git checkout main", { cwd: repo, stdio: "ignore" });

const server = spawn(NODE, [join(here, "dist", "server", "index.js")], {
	cwd: here,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv]", e.message));
let cleaned = false;
/** 杀服务（按进程组 PID）+ 删临时目录；Windows 句柄释放是异步的，删要重试。 */
async function cleanup() {
	if (cleaned) return;
	cleaned = true;
	killTree(server.pid);
	for (let i = 0; i < 12; i++) {
		try {
			rmSync(workdir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
			if (!existsSync(workdir)) return;
		} catch {}
		await sleep(300);
	}
	console.log("[cleanup] 临时目录没删干净：", workdir);
}
process.on("exit", () => {
	killTree(server.pid);
});

async function waitServer() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	console.log("server up");

	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	let reqId = 0;
	const pending = new Map();
	ws.on("message", (d) => {
		const msg = JSON.parse(d.toString());
		if (msg.type === "scm_data" && pending.has(msg.reqId)) {
			pending.get(msg.reqId)(msg);
			pending.delete(msg.reqId);
		}
	});
	const send = (msg) =>
		new Promise((resolve) => {
			const id = ++reqId;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ ...msg, reqId: id }));
		});

	await new Promise((r) => ws.on("open", r));
	ws.send(JSON.stringify({ type: "hello", clientId: "scmfeat-test" }));
	await sleep(600);

	const st = await send({ type: "scm_status" });
	check("status ok", st.ok && !st.notRepo);
	check("current branch is main", st.branch === "main");
	const feat = (st.branches ?? []).find((b) => b.name === "feature");
	const remFeat = (st.branches ?? []).find((b) => b.name === "origin/feature");
	check("local branch listed", !!feat);
	check("remote branch listed with remote=origin", !!remFeat && remFeat.remote === "origin");
	check("history absent from status payload", !Array.isArray(st.history));

	const hist = await send({ type: "scm_history" });
	check("history ok", hist.ok);
	check(
		"history has both commits",
		(hist.history ?? []).length >= 2 && (hist.history ?? []).some((c) => c.subject === "feature-work"),
	);

	const dirtyPromise = new Promise((resolve) => {
		const onMsg = (d) => {
			const msg = JSON.parse(d.toString());
			if (msg.type === "scm_changed") {
				ws.off("message", onMsg);
				resolve(true);
			}
		};
		ws.on("message", onMsg);
	});
	writeFileSync(join(repo, "b.txt"), "new\n");
	execSync("git add -A && git commit -m external", { cwd: repo, stdio: "ignore" });
	const gotDirty = await Promise.race([dirtyPromise, sleep(8000).then(() => false)]);
	check("external commit pushed scm_changed", gotDirty);

	const st2 = await send({ type: "scm_status" });
	check("status sees the new commit's parent state (clean tree)", st2.ok && (st2.files ?? []).length === 0);

	// 分组暂存（已暂存 / 更改）全靠 x/y 两位：这里钉死服务端吐出来的真实取值。
	writeFileSync(join(repo, "staged.txt"), "s1\n");
	writeFileSync(join(repo, "unstaged.txt"), "u1\n");
	writeFileSync(join(repo, "both.txt"), "b1\n");
	execSync("git add -A && git commit -m mixed-base", { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "staged.txt"), "s1\ns2\n");
	execSync("git add staged.txt", { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "unstaged.txt"), "u1\nu2\n");
	writeFileSync(join(repo, "both.txt"), "b1\nb2\n");
	execSync("git add both.txt", { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "both.txt"), "b1\nb2\nb3\n");
	writeFileSync(join(repo, "untracked.txt"), "n1\n");

	const st3 = await send({ type: "scm_status" });
	const byPath = (name) => (st3.files ?? []).find((f) => f.path === name) ?? {};
	check(
		"x/y: 仅暂存 = (M, space)",
		byPath("staged.txt").x === "M" && byPath("staged.txt").y === " ",
		JSON.stringify(byPath("staged.txt")),
	);
	check(
		"x/y: 仅工作区 = (space, M)",
		byPath("unstaged.txt").x === " " && byPath("unstaged.txt").y === "M",
		JSON.stringify(byPath("unstaged.txt")),
	);
	check(
		"x/y: both = (M, M)",
		byPath("both.txt").x === "M" && byPath("both.txt").y === "M",
		JSON.stringify(byPath("both.txt")),
	);
	check(
		"x/y: 未跟踪 = (?, ?)",
		byPath("untracked.txt").x === "?" && byPath("untracked.txt").y === "?",
		JSON.stringify(byPath("untracked.txt")),
	);
	check(
		"stats 同时累加已暂存与工作区（both.txt 新增 2 行）",
		(st3.stats?.["both.txt"]?.[0] ?? 0) === 2 && (st3.stats?.["both.txt"]?.[1] ?? 0) === 0,
		JSON.stringify(st3.stats?.["both.txt"]),
	);
	check("staged.txt 也出现在 files 里（供新 UI 分组用）", !!byPath("staged.txt").path);

	const gen = await Promise.race([send({ type: "scm_commitmsg" }), sleep(20_000).then(() => null)]);
	check("scm_commitmsg answered", gen !== null);
	check("scm_commitmsg kind echo", gen?.kind === "commitmsg");
	check("scm_commitmsg fails without credentials (ok:false)", gen !== null && gen.ok === false);
	check("scm_commitmsg carries an error message", typeof gen?.error === "string" && gen.error.length > 0);

	ws.close();
	await cleanup();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
	console.error("E2E FAILED:", e.message);
	await cleanup();
	process.exit(1);
});
