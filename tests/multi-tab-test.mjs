import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8977;
const base = mkdtempSync(join(tmpdir(), "pi-web-multitab-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const server = spawn(NODE, ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "inherit", "inherit"],
	windowsHide: true,
});
server.on("error", (e) => console.error("[spawn error]", e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) return;
		} catch {}
		await sleep(300);
	}
	throw new Error("server did not start");
}

const readClientId = (page) => page.evaluate(() => sessionStorage.getItem("pi-web-client-id"));
const waitChatReady = (page) =>
	page.waitForFunction(() => document.querySelector("textarea") !== null, {
		timeout: 20000,
	});

try {
	await waitReady();
	if (!CHROME_PATH) throw new Error("no Chrome found (set PI_WEB_CHROME)");
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
	});
	const ctx = await browser.newContext();
	const a = await ctx.newPage();
	const b = await ctx.newPage();

	await a.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(a);
	await b.goto(`http://127.0.0.1:${PORT}`);
	await waitChatReady(b);

	const idA = await readClientId(a);
	const idB = await readClientId(b);
	check(
		"two tabs have DIFFERENT clientIds",
		!!idA && !!idB && idA !== idB,
		`${idA?.slice(0, 8)} vs ${idB?.slice(0, 8)}`,
	);

	const markerA = await a.evaluate(() => document.body.innerHTML.length);
	await b.reload();
	await b.waitForLoadState("domcontentloaded");
	await sleep(800);
	const markerA2 = await a.evaluate(() => document.body.innerHTML.length);
	check("tab B reload does not disturb tab A", markerA > 0 && markerA === markerA2);

	const idA2 = await readClientId(a);
	check("tab A keeps its clientId across reload", idA2 === idA);

	await browser.close();
	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	if (server.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
