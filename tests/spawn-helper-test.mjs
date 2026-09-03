/**
 * spawn-helper permission self-heal test:
 *
 * Break the +x bit on the local node-pty spawn-helper, start the server,
 * create a terminal over WS, and verify the file is repaired to 0755 and
 * the terminal actually outputs (no "启动终端失败").
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8898;
const PROJ = REPO_ROOT;
const HELPER = join(PROJ, "node_modules/node-pty/build/Release/spawn-helper");

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
// Break the helper's execute bits (the npm-tarball failure mode).
chmodSync(HELPER, 0o644);
check("helper broken (0644) before test", (statSync(HELPER).mode & 0o111) === 0);

try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT) },
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

// Wait for shell output (prompt) or failure.
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
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
