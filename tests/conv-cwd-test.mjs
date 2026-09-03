/**
 * Per-project conversation isolation + unlisted-idle dismissal:
 *
 *   conv1 (A, startup) → new_chat REUSES it while it is blank (ac5a4c8) →
 *   set_cwd(B) creates B's own conversation → set_cwd(A) creates a NEW A
 *   conversation (the old one was dismissed) → conversation ids never leak
 *   between projects, the running-conversation list stays empty (nothing was
 *   ever displaced while streaming), and the file tree follows the project.
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8898;
const PROJ = REPO_ROOT;
const A = mkdtempSync(join(tmpdir(), "pi-proj-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-proj-b-"));
writeFileSync(join(A, "only-in-A.txt"), "A\n");
writeFileSync(join(B, "only-in-B.txt"), "B\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: A },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

// State mirrors
let snapshot = null;
let conversations = [];
let files = null;
const notices = [];

ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return; // malformed frame — ignore
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		// Incremental checkpoint — merge like the frontend does (rev-chained,
		// appended messages extend the array; light fields replace wholesale).
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = {
				...snapshot,
				...m.state,
				messages: [...(snapshot.messages ?? []), ...m.appended],
			};
		}
	} else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "files") files = m;
	else if (m.type === "notice") notices.push(m.text);
	else if (m.type === "ready") {
		console.log("ready");
		send({ type: "list_files", path: undefined });
	}
});

const waitFor = async (pred, what, timeout = 8000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};

ws.on("open", () => {
	ws.send(JSON.stringify({ type: "hello", clientId }));
});
await waitFor(() => snapshot !== null, "initial snapshot");

// --- conv1 in A (server cwd) ---
check("conv1 cwd = A", snapshot?.cwd === A, snapshot?.cwd);
const conv1 = snapshot.conversationId;

// --- new_chat: conv1 is BLANK → reused in place (ac5a4c8 semantics: the
// active blank chat IS the new chat; clicking 新对话 must not pile up ids) ---
send({ type: "new_chat" });
await sleep(600); // any snapshot/delta would have arrived by now
const conv2 = snapshot.conversationId;
check("new_chat reuses the blank active conversation (same id)", conv2 === conv1, `${conv1} → ${conv2}`);
check("conv2 cwd = A", snapshot?.cwd === A);
await sleep(300);
check(
	"no running conversations listed (nothing was displaced while streaming)",
	conversations.length === 0,
	`${conversations.length} listed`,
);

// --- set_cwd(B): A's conv2 is dismissed (never ran); B gets its own conversation ---
send({ type: "set_cwd", path: B });
await waitFor(() => snapshot?.cwd === B, "cwd=B");
const convB = snapshot.conversationId;
check("set_cwd(B) → B gets its OWN conversation id", convB && convB !== conv2, `${conv2} → ${convB}`);
check("convB cwd = B", snapshot?.cwd === B);
await waitFor(() => files?.entries?.some((e) => e.name === "only-in-B.txt"), "B file tree");
check(
	"file tree shows B's files",
	files?.entries?.some((e) => e.name === "only-in-B.txt"),
);

// --- set_cwd(A): B's conv (never ran) is dismissed; A gets a NEW conversation ---
send({ type: "set_cwd", path: A });
await waitFor(() => snapshot?.cwd === A, "cwd=A");
const convA2 = snapshot.conversationId;
check(
	"set_cwd(A) → fresh A conversation (old A conv was dismissed)",
	convA2 && convA2 !== convB && convA2 !== conv2,
	`${convB} → ${convA2}`,
);
await waitFor(() => files?.entries?.some((e) => e.name === "only-in-A.txt"), "A file tree");
check(
	"file tree shows A's files",
	files?.entries?.some((e) => e.name === "only-in-A.txt"),
);

// --- set_cwd(B) again: B's previous conv was dismissed; a new one is created ---
send({ type: "set_cwd", path: B });
await waitFor(() => snapshot?.cwd === B && snapshot?.conversationId !== convB, "cwd=B again");
check(
	"set_cwd(B) again → new B conversation (previous B conv was dismissed)",
	snapshot?.conversationId !== convB,
	`${convB} → ${snapshot?.conversationId}`,
);

// --- conversations summary: only current project, and nothing listed ---
await sleep(300);
check(
	"conversations list stays empty (per-project + only listed)",
	conversations.length === 0,
	`${conversations.length} listed`,
);
check(
	"workspace-switch notices fired",
	notices.some((n) => n.includes("已切换到工作目录")),
	notices.join(" | "),
);

console.log("--- conversation summaries ---");
for (const c of conversations) console.log(`  ${c.id} title="${c.title}" cwd=${c.cwd}`);
console.log("--- notices ---");
for (const n of notices) console.log("  ", n);

ws.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
