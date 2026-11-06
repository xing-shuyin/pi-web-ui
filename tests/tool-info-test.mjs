import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8922;
const WS_DIR = mkdtempSync(join(tmpdir(), "pi-toolinfo-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-toolinfo-data-"));

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(REPO_ROOT, "tool-info-test");
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
		PI_WEB_CWD: WS_DIR,
		PI_WEB_DATA_DIR: DATA_DIR,
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
			PI_WEB_CWD: WS_DIR,
			PI_WEB_DATA_DIR: DATA_DIR,
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
const infos = new Map();
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "tool_info") infos.set(m.name, m);
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
await sleep(1200);

async function ask(name) {
	infos.delete(name);
	ws.send(JSON.stringify({ type: "get_tool_info", name }));
	const t0 = Date.now();
	while (Date.now() - t0 < 8000 && !infos.has(name)) await sleep(100);
	return infos.get(name);
}

const bash = await ask("bash");
check("bash 有定义（found: true）", bash?.found === true, JSON.stringify(bash && { found: bash.found }));
check(
	"bash 带回说明文字",
	typeof bash?.description === "string" && bash.description.trim().length > 20,
	`len=${bash?.description?.length ?? 0}`,
);
check(
	"bash 带回参数 JSON Schema（command 等属性）",
	bash?.parameters !== undefined &&
		typeof bash.parameters === "object" &&
		bash.parameters !== null &&
		typeof bash.parameters.properties === "object" &&
		bash.parameters.properties !== null &&
		"command" in bash.parameters.properties,
	Object.keys(bash?.parameters?.properties ?? {}).join(","),
);
check("bash 标了「当前启用」", bash?.active === true, `active=${bash?.active}`);
check(
	"bash 带回来源信息（source 非空）",
	typeof bash?.source === "string" && bash.source.length > 0,
	`source=${bash?.source} scope=${bash?.scope}`,
);
check("参数 schema 没被当成超限丢掉", bash?.parametersDropped !== true, `parametersDropped=${bash?.parametersDropped}`);

const read = await ask("read");
check("被覆盖的 read 也能取到定义", read?.found === true, JSON.stringify(read && { found: read.found }));

const missing = await ask("definitely_not_a_real_tool_zzz");
check("不存在的工具名回 found:false", missing?.found === false, JSON.stringify(missing));
check("「没找到」不会被报成「引擎不支持」", missing?.unsupported !== true, `unsupported=${missing?.unsupported}`);
check("应答里的工具名原样回显", missing?.name === "definitely_not_a_real_tool_zzz", missing?.name);

const again = await ask("bash");
check(
	"连问两次都能拿到定义（服务没被这次请求搞挂）",
	again?.found === true,
	JSON.stringify(again && { found: again.found }),
);
check("服务进程仍然存活", server.exitCode === null, `exitCode=${server.exitCode}`);

ws.close();
server.kill("SIGKILL");
rmSync(WS_DIR, { recursive: true, force: true });
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
