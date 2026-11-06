import { portUp } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
	ensureBuild(PROJ, "title-jsonl-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: A,
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

ws.send(JSON.stringify({ type: "read_file", path: "data.jsonl" }));
await waitFor(() => fileContent !== null, "file_content for jsonl", 8000);
check(
	"jsonl previews as text",
	fileContent?.path === "data.jsonl" && fileContent.text.includes('{"a":1}') && fileContent.kind === "text",
	fileContent ? `kind=${fileContent.kind}` : "no file_content",
);

ws.send(JSON.stringify({ type: "prompt", text: "只回复两个字：好的" }));
const titled = await waitFor(
	() => sessions.some((s) => s.firstMessage?.includes("只回复")),
	"session persisted with title",
);
check("session persisted with project A title", titled, sessions.map((s) => s.firstMessage).join(" | "));
const done = await waitFor(() => snapshot?.messages?.some((m) => m.role === "assistant"), "assistant reply completes");
check("turn completes with a reply", done);

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
