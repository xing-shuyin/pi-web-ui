import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8898;
const PROJ = REPO_ROOT;
const dataDir = mkdtempSync(join(tmpdir(), "pi-spawn-helper-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-spawn-helper-agent-"));
const HELPER = join(PROJ, "node_modules/node-pty/build/Release/spawn-helper");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(PROJ, "spawn-helper-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
chmodSync(HELPER, 0o644);
check("helper broken (0644) before test", (statSync(HELPER).mode & 0o111) === 0);

try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let output = "";
let failed = false;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "terminal_output") output += m.data;
	else if (m.type === "notice" && m.text.includes("启动终端失败")) failed = true;
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));

await sleep(1200);
ws.send(
	JSON.stringify({
		type: "terminal_create",
		terminalId: "t1",
		cwd: PROJ,
	}),
);

const t0 = Date.now();
while (Date.now() - t0 < 15000) {
	if (failed || output.length > 0) break;
	await sleep(250);
}

check("terminal not failed", !failed);
check("terminal produced output", output.length > 0, output.slice(0, 60).replace(/\n/g, "␤"));
check(
	"spawn-helper repaired to executable",
	(statSync(HELPER).mode & 0o111) !== 0,
	`mode=${(statSync(HELPER).mode & 0o777).toString(8)}`,
);

ws.close();
server.kill("SIGKILL");
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
