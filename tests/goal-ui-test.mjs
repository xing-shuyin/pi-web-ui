import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const CHROME = CHROME_PATH;
const PORT = 8904;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-goal-ui-"));
let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return;
		} catch {}
	}
	throw new Error("server did not start");
}

async function run() {
	await startServer();
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage();
	await page.goto(URL);
	await page.waitForSelector(".goalbar", { timeout: 20000 });
	const hintVisible = await page.locator(".goalbar-hint").count();
	check("goal bar renders (idle hint)", hintVisible > 0 || (await page.locator(".goalbar-input").count()) > 0);

	const input = page.locator(".goalbar-input");
	if ((await input.count()) === 0) {
		await page.locator(".goalbar-hint").click();
		await page.waitForSelector(".goalbar-input");
	}
	await page.locator(".goalbar-input").fill("把页面标题改为 Goal UI 测试");
	await page.locator(".goalbar-btn:not(.wizard)").click();
	await page.waitForSelector(".goalbar-active", { timeout: 8000 });
	check("active goal bar shown after set", true);
	const text = await page
		.locator(".goalbar-text")
		.innerText()
		.catch(() => "");
	check("active goal shows the goal text", text.includes("Goal UI 测试"), text);

	await page.locator(".goalbar-x").click();
	await page.waitForSelector(".goalbar-active", { state: "detached", timeout: 8000 });
	const hintCount = await page.locator(".goalbar-hint").count();
	check("goal cleared (back to idle)", hintCount > 0 || (await page.locator(".goalbar-input").count()) > 0);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	await browser.close();
	try {
		server.kill("SIGTERM");
	} catch {}
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("test error:", err);
	try {
		server?.kill("SIGTERM");
	} catch {}
	process.exit(1);
});
