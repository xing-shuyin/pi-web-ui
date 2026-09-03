/* SCM v2 features protocol test: lazy history, remote branches, and the
 * git-dir watcher (external change → scm_changed push).
 * Run: npm run build && node scm-features-test.mjs */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(dirname(fileURLToPath(import.meta.url))); // tests/ → repo root
const NODE = realpathSync(process.execPath);
const PORT = 31200 + Math.floor(Math.random() * 5000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-scmfeat-"));
const repo = join(workdir, "repo");
process.env.PI_WEB_CWD = repo;
process.env.PI_WEB_DATA_DIR = join(workdir, "data");
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

// ---- throwaway repo with a local commit + a fake remote ----
execSync(`mkdir repo`, { cwd: workdir, stdio: "ignore" });
execSync("git init -b main", { cwd: repo, stdio: "ignore" });
execSync("git config user.name t", { cwd: repo, stdio: "ignore" });
execSync("git config user.email t@t.local", { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "a.txt"), "one\n");
execSync("git add -A && git commit -m init", { cwd: repo, stdio: "ignore" });
// bare "remote" + a pushed branch so refs/remotes/origin/feature exists
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
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
	try {
		rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
	} catch {
		/* temp cleanup later */
	}
});

async function waitServer() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
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

	// -- status: local branch current, remote branch listed with flag ----
	const st = await send({ type: "scm_status" });
	check("status ok", st.ok && !st.notRepo);
	check("current branch is main", st.branch === "main");
	const feat = (st.branches ?? []).find((b) => b.name === "feature");
	const remFeat = (st.branches ?? []).find((b) => b.name === "origin/feature");
	check("local branch listed", !!feat);
	check("remote branch listed with remote=origin", !!remFeat && remFeat.remote === "origin");
	check("history absent from status payload", !Array.isArray(st.history));

	// -- lazy history ----
	const hist = await send({ type: "scm_history" });
	check("history ok", hist.ok);
	check(
		"history has both commits",
		(hist.history ?? []).length >= 2 && (hist.history ?? []).some((c) => c.subject === "feature-work"),
	);

	// -- external CLI commit → watcher pushes scm_changed ----
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

	// status after external change reflects it
	const st2 = await send({ type: "scm_status" });
	check("status sees the new commit's parent state (clean tree)", st2.ok && (st2.files ?? []).length === 0);

	ws.close();
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("E2E FAILED:", e.message);
	process.exit(1);
});
