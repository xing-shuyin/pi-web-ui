import { portUp } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = Number(process.argv[2] || 8898);
const PROJ = REPO_ROOT;
const dataDir = mkdtempSync(join(tmpdir(), "pi-conv-cwd-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-conv-cwd-agent-"));
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
	ensureBuild(PROJ, "conv-cwd-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: A,
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
let conversations = [];
let files = null;
const notices = [];

ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = {
				...snapshot,
				...m.state,
				messages: [...(snapshot.messages ?? []), ...m.appended],
			};
		}
	} else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "files") files = m;
	else if (m.type === "notice" || m.type === "transition_progress") notices.push(m.text);
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

check("conv1 cwd = A", snapshot?.cwd === A, snapshot?.cwd);
const conv1 = snapshot.conversationId;

send({ type: "new_chat" });
await sleep(600);
const conv2 = snapshot.conversationId;
check("new_chat reuses the blank active conversation (same id)", conv2 === conv1, `${conv1} → ${conv2}`);
check("conv2 cwd = A", snapshot?.cwd === A);
await sleep(300);
check(
	"no running conversations listed (nothing was displaced while streaming)",
	conversations.length === 0,
	`${conversations.length} listed`,
);

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

send({ type: "set_cwd", path: B });
await waitFor(() => snapshot?.cwd === B && snapshot?.conversationId !== convB, "cwd=B again");
check(
	"set_cwd(B) again → new B conversation (previous B conv was dismissed)",
	snapshot?.conversationId !== convB,
	`${convB} → ${snapshot?.conversationId}`,
);

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
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(A, { recursive: true, force: true });
	rmSync(B, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
