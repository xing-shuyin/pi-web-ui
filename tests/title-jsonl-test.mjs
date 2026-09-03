/**
 * Per-project session recovery after a real turn:
 *
 *   prompt in A → session persisted with its title (visible via the history
 *   list); set_cwd(B) dismisses the unlisted foreground conversation and gives
 *   B its OWN conversation; set_cwd(A) back resumes the SAME persisted
 *   session — nothing is lost when a conversation leaves the running list,
 *   and titles never leak between projects.
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8898;
const PROJ = REPO_ROOT;
const A = mkdtempSync(join(tmpdir(), "pi-tit-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-tit-b-"));
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(A, "data.jsonl"), '{"a":1}\n{"a":2}\n');
writeFileSync(join(B, "b.txt"), "b");

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
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: A,
		// 隔离 client-state：不污染真实 ~/.pi-web（agent 目录保留 —— 需要真模型凭据）
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "piweb-titlejsonl-")),
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let snapshot = null;
let conversations = [];
let sessions = [];
let fileContent = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "sessions") sessions = m.sessions;
	else if (m.type === "file_content") fileContent = m;
});
ws.on("open", () => {
	ws.send(JSON.stringify({ type: "hello", clientId }));
	// sessions 推送是懒加载 opt-in：必须显式请求，否则服务端永不推 `sessions`
	ws.send(JSON.stringify({ type: "list_sessions" }));
});

const waitFor = async (pred, what, timeout = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(200);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};

await waitFor(() => snapshot !== null, "snapshot");
const conv1 = snapshot.conversationId;

// 0. jsonl must preview as text (read_file works).
ws.send(JSON.stringify({ type: "read_file", path: "data.jsonl" }));
await waitFor(() => fileContent !== null, "file_content for jsonl", 8000);
check(
	"jsonl previews as text",
	fileContent?.path === "data.jsonl" && fileContent.text.includes('{"a":1}') && fileContent.kind === "text",
	fileContent ? `kind=${fileContent.kind}` : "no file_content",
);

// 1. Prompt in A, wait for the turn to complete and the session to be
//    persisted with its title (the ACTIVE conversation is not in the running
//    list — it only enters when displaced while streaming — so the title is
//    observed via the history list instead).
ws.send(JSON.stringify({ type: "prompt", text: "只回复两个字：好的" }));
const titled = await waitFor(
	() => sessions.some((s) => s.firstMessage?.includes("只回复")),
	"session persisted with title",
);
check("session persisted with project A title", titled, sessions.map((s) => s.firstMessage).join(" | "));
const done = await waitFor(() => snapshot?.messages?.some((m) => m.role === "assistant"), "assistant reply completes");
check("turn completes with a reply", done);

// 2. Switch project to B: the unlisted foreground conversation is dismissed;
//    B gets its own conversation id, and B has no history.
ws.send(JSON.stringify({ type: "set_cwd", path: B }));
const moved = await waitFor(
	() => snapshot?.conversationId && snapshot.conversationId !== conv1 && snapshot?.cwd === B,
	"B conversation active",
	15000,
);
check("B gets its OWN conversation id", moved, snapshot?.conversationId);
await sleep(800);
check("no running conversations listed", conversations.length === 0, `${conversations.length} listed`);
check("project B has no history", sessions.length === 0, sessions.map((s) => s.firstMessage).join(" | "));

// 3. Back to A: a new conversation resumes the persisted session — title and
//    messages are intact (nothing was lost when the foreground chat left).
ws.send(JSON.stringify({ type: "set_cwd", path: A }));
const back = await waitFor(
	() => snapshot?.cwd === A && sessions.some((s) => s.firstMessage?.includes("只回复")),
	"A session resumable again",
	15000,
);
check("A's persisted session is still there (recoverable)", back, sessions.map((s) => s.firstMessage).join(" | "));
check(
	"no title leak between projects (B conv is a different id)",
	snapshot?.conversationId !== conv1,
	`${conv1} → ${snapshot?.conversationId}`,
);

ws.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
