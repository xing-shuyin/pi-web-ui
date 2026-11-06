import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8902;
const dataDir = mkdtempSync(join(tmpdir(), "pi-missingdir-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-missingdir-agent-"));
const WS = mkdtempSync(join(tmpdir(), "pi-missingdir-"));
const GONE_DIR = join(WS, "documents", "review");
mkdirSync(GONE_DIR, { recursive: true });
writeFileSync(join(GONE_DIR, "keep.txt"), "x");
writeFileSync(join(WS, "top.txt"), "hello");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(REPO_ROOT, "list-files-missing-dir-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
let server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: WS,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
const attachErr = () => (server.stderr.on("data", (d) => (serverErr += d.toString())), void 0);
attachErr();
for (let attempt = 0; attempt < 2 && !(await portUp(PORT)); attempt++) {
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (await portUp(PORT)) break;
	server.kill("SIGKILL");
	await sleep(300);
	try {
		await freePort(PORT);
	} catch {}
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: WS,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	attachErr();
}
if (!(await portUp(PORT))) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	process.exit(1);
}

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const listResponses = [];
const notices = [];
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "files") listResponses.push(m);
	else if (m.type === "notice") notices.push(m);
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
await sleep(800);

ws.send(JSON.stringify({ type: "list_files", path: "documents/review" }));
let t0 = Date.now();
while (Date.now() - t0 < 8000 && listResponses.filter((m) => m.path === "documents/review").length < 1)
	await sleep(150);
const first = listResponses.filter((m) => m.path === "documents/review").pop();
check("initial listing returns the file", first && first.entries.length === 1 && first.entries[0].name === "keep.txt");

rmSync(GONE_DIR, { recursive: true, force: true });
ws.send(JSON.stringify({ type: "list_files", path: "documents/review" }));
t0 = Date.now();
while (Date.now() - t0 < 8000 && !listResponses.some((m) => m.path === "documents/review" && m.entries.length === 0))
	await sleep(150);
const empty = listResponses.filter((m) => m.path === "documents/review" && m.entries.length === 0).pop();

check(
	"refresh after deletion returns an empty listing",
	empty !== undefined,
	empty ? `entries=${empty.entries.length}` : "no empty response (server may have died)",
);
check(
	"server emits 目录不存在/Directory not found notice",
	notices.some((n) => n.text?.includes("目录不存在") || n.textEn?.includes("Directory not found")),
	JSON.stringify(notices.map((n) => n.textEn ?? n.text)),
);

const alive = server.exitCode === null && (await portUp(PORT));
ws.send(JSON.stringify({ type: "list_files", path: undefined }));
t0 = Date.now();
while (Date.now() - t0 < 8000 && listResponses.filter((m) => m.path === "").length < 1) await sleep(150);
const root = listResponses.filter((m) => m.path === "").pop();
check(
	"server stays alive and lists the workspace root afterwards",
	alive && root !== undefined && root.entries.some((e) => e.name === "top.txt"),
	`alive=${server.exitCode === null} root=${root ? root.entries.map((e) => e.name).join(",") : "none"}`,
);

ws.close();
server.kill("SIGKILL");
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(WS, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
