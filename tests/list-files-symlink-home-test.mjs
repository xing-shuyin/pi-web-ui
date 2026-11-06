import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8923;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(REPO_ROOT, "list-files-symlink-home-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

const WS = join(homedir(), `.pi-web-ui-symtest-${randomUUID().slice(0, 8)}`);
const dataDir = mkdtempSync(join(tmpdir(), "pi-symlink-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-symlink-agent-"));
const REAL = join(WS, "real");
mkdirSync(REAL, { recursive: true });
writeFileSync(join(WS, "top.txt"), "hello");
writeFileSync(join(REAL, "inner.txt"), "x");
try {
	symlinkSync("real", join(WS, "link"));
} catch (err) {
	console.log(`skip: cannot create a directory symlink on this platform (${err.code ?? err.message})`);
	rmSync(WS, { recursive: true, force: true });
	process.exit(0);
}

try {
	try {
		await freePort(PORT);
	} catch {}
	await sleep(400);
	const server = spawn("node", ["dist/server/index.js"], {
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
	server.stderr.on("data", (d) => (serverErr += d.toString()));
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) {
		console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
		process.exit(1);
	}

	const clientId = randomUUID();
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const listResponses = [];
	const completionResponses = [];
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m.type === "files") listResponses.push(m);
		else if (m.type === "path_completions") completionResponses.push(m);
	});
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
	await sleep(800);

	const listAndWait = async (path, match) => {
		ws.send(JSON.stringify({ type: "list_files", path }));
		const t0 = Date.now();
		while (Date.now() - t0 < 8000 && !listResponses.some(match)) await sleep(150);
		return listResponses.filter(match).pop();
	};

	const root = await listAndWait("", (m) => m.path === "");
	const link = root?.entries.find((e) => e.name === "link");
	check("directory symlink is listed as dir", link?.type === "dir", `type=${link?.type}`);

	const entered = await listAndWait("link", (m) => m.path === "link");
	check(
		"symlinked directory is navigable",
		entered !== undefined && entered.entries.some((e) => e.name === "inner.txt"),
		`entries=${entered ? JSON.stringify(entered.entries) : "none"}`,
	);

	const wsBase = WS.split("/").pop();
	const viaTilde = await listAndWait(`~/${wsBase}`, (m) => m.absolute === true && m.path.endsWith(wsBase));
	check(
		'path bar "~/" input expands to the home directory',
		viaTilde !== undefined && viaTilde.entries.some((e) => e.name === "top.txt"),
		`entries=${viaTilde ? viaTilde.entries.map((e) => e.name).join(",") : "none"}`,
	);

	ws.send(JSON.stringify({ type: "complete_path", path: WS + "/" }));
	const t1 = Date.now();
	while (Date.now() - t1 < 8000 && completionResponses.length < 1) await sleep(150);
	const comp = completionResponses.pop();
	const compLink = comp?.completions.find((e) => e.name === "link");
	check("cwd picker classifies directory symlink as dir", compLink?.type === "dir", `type=${compLink?.type}`);

	const alive = server.exitCode === null && (await portUp(PORT));
	check("server stays alive", alive);

	ws.close();
	server.kill("SIGKILL");
} finally {
	try {
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	} catch {}
	rmSync(WS, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
