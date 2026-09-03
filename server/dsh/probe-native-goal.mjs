// Temp probe: DSH native goal via goal-rpc wrapper — verify goal/set works,
// goal/change events flow, round-driver auto-continues, model completes.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname ?? ".");
const KEY = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).deepseek.key;
const JSONRPC_ENTRY = resolve(
	HERE,
	"..",
	"..",
	"node_modules",
	"@deepseek-ai",
	"dsh-sdk-jsonrpc-server",
	"lib",
	"index.js",
);

const tmp = join(HERE, "..", "..", ".tmp-goal-probe");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		DEEPSEEK_API_KEY: KEY,
		PI_WEB_DSH_JSONRPC_ENTRY: JSONRPC_ENTRY,
		DSH_SESSION_ROOT: join(tmp, "sessions"),
		DSH_CWD: HERE,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write("[rt] " + d));

let buf = "";
const pending = new Map();
let nextId = 1;
const goalEvents = [];
const goalRounds = [];
let completed = false;
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id !== undefined && pending.has(m.id)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
		} else if (m.method) {
			onNotify(m.method, m.params);
		}
	}
});
proc.on("exit", (code) => {
	for (const p of pending.values()) p.reject(new Error(`launcher exited early (code=${code})`));
	pending.clear();
});
const req = (method, params) =>
	new Promise((resolve2, reject) => {
		const id = nextId++;
		pending.set(id, { resolve: resolve2, reject });
		proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});

const onNotify = (method, params) => {
	if (method !== "session.event") return;
	const ev = params?.event;
	if (ev?.type === "goal/change") {
		goalEvents.push(ev.data);
		if (ev.data?.operation === "complete") completed = true;
		console.log(
			"goal/change:",
			ev.data?.operation,
			"phase:",
			ev.data?.goal?.phase,
			"rounds:",
			ev.data?.roundsStarted,
			ev.data?.cleared ? "(cleared)" : "",
		);
	}
	if (ev?.type === "user/message") {
		const src = ev.data?.source;
		if (src?.kind === "goal") {
			goalRounds.push(src.round);
			console.log(
				"goal round admitted:",
				src.round,
				"objective:",
				(ev.data.content ?? [])
					.map((c) => c.text ?? "")
					.join("")
					.slice(0, 60),
			);
		}
	}
};

try {
	await req("initialize", { cwd: HERE, provider: "deepseek-official", model: "deepseek-v4-flash" });
	console.log("initialize OK");
	const sessionId = "goal-probe-session";

	const setRes = await req("goal/set", {
		sessionId,
		objective: "用一句话回答 2+2 等于几，然后调用 update_goal complete 结束这个目标。",
		maxGoalRounds: 3,
	});
	console.log("goal/set ->", JSON.stringify(setRes));
	if (!setRes?.goal || setRes.goal.phase !== "active") throw new Error("goal not created");

	const getRes = await req("goal/get", { sessionId });
	console.log("goal/get ->", JSON.stringify(getRes));

	// Wait up to 90s for completion (round-driver auto-runs rounds).
	const t0 = Date.now();
	while (Date.now() - t0 < 90_000 && !completed) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	await new Promise((r) => setTimeout(r, 2000));
	const final = await req("goal/get", { sessionId });
	console.log("final goal ->", JSON.stringify(final));

	const clearRes = await req("goal/clear", { sessionId });
	console.log("goal/clear ->", JSON.stringify(clearRes));
	await new Promise((r) => setTimeout(r, 1000));
	await req("shutdown", {});

	const ok = setRes.goal.phase === "active" && goalEvents.length > 0 && completed && goalRounds.length >= 1;
	console.log("goal events:", goalEvents.length, "rounds admitted:", goalRounds.length, "completed:", completed);
	console.log(ok ? "NATIVE GOAL OK" : "NATIVE GOAL FAILED");
	proc.stdin.end();
	process.exit(ok ? 0 : 1);
} catch (err) {
	console.error("PROBE FAILED:", err.message);
	proc.kill();
	process.exit(1);
}
