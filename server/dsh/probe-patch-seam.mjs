// Temp probe: user patch seam (<dataDir>/dsh-patches) — verify a user patch
// overriding session persistence root actually redirects session JSONL.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const tmp = join(HERE, "..", "..", ".tmp-patch-probe");
const PATCHED_ROOT = join(tmp, "patched-sessions");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, "dsh-patches"), { recursive: true });
writeFileSync(
	join(tmp, "dsh-patches", "01-persona.yml"),
	[
		"# user patch: override persona",
		"- id: system-prompt",
		"  name: '@deepseek-ai/dsh-system-prompt'",
		"  config:",
		"    persona: 'PATCH_MARKER_9f3d'",
		"",
	].join("\n"),
);
writeFileSync(
	join(tmp, "dsh-patches", "02-persistence.yml"),
	[
		"# user patch: redirect session persistence root to a marker dir",
		"- id: session-persistence-jsonl",
		"  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
		"  config:",
		`    root: '${PATCHED_ROOT}'`,
		"",
	].join("\n"),
);

const proc = spawn(process.execPath, [join(HERE, "runtime", "launcher.mjs")], {
	cwd: HERE,
	env: {
		...process.env,
		DEEPSEEK_API_KEY: KEY,
		PI_WEB_DSH_JSONRPC_ENTRY: JSONRPC_ENTRY,
		DSH_SESSION_ROOT: join(tmp, "sessions"),
		DSH_CWD: HERE,
		PI_WEB_DSH_DATA_DIR: tmp,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write("[rt] " + d));

let buf = "";
const pending = new Map();
let nextId = 1;
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

let turnDone = false;
const onNotify = (method, params) => {
	if (method !== "session.event") return;
	const ev = params?.event;
	if (ev?.type === "turn/end") {
		const reason = ev.data?.reason;
		console.log("turn/end kind:", reason?.kind, reason?.error?.message ?? "");
		turnDone = true;
	}
};

try {
	await req("initialize", {
		cwd: HERE,
		provider: "deepseek-official",
		model: "deepseek-v4-flash",
	});
	console.log("initialize OK");
	const sessionId = "patch-probe-session";
	await req("session/prompt", {
		sessionId,
		contentBlocks: [{ type: "text", text: "reply with OK only" }],
	});
	// Wait for the turn to complete (sessions land on disk at turn end).
	for (let i = 0; i < 60 && !turnDone; i++) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	await new Promise((r) => setTimeout(r, 2000));
	await req("shutdown", {});
	// The marker dir must contain the persisted session JSONL if the user
	// patch layer is actually applied (root was redirected by patch 02).
	const { readdirSync, existsSync } = await import("node:fs");
	const walk = (dir) => {
		let found = [];
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return found;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) found = found.concat(walk(p));
			else if (e.isFile() && /\.(jsonl|zstd)$/u.test(e.name)) found.push(p);
		}
		return found;
	};
	const files = walk(PATCHED_ROOT);
	const ok = files.length > 0;
	console.log("patched session root exists:", existsSync(PATCHED_ROOT));
	console.log("persisted files under marker root:", files.length, files.slice(0, 3));
	if (!ok) console.log("hint: user patch 02 (persistence root redirect) was NOT applied");
	proc.stdin.end();
	process.exit(ok ? 0 : 1);
} catch (err) {
	console.error("PROBE FAILED:", err.message);
	proc.kill();
	process.exit(1);
}
