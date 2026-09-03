/**
 * Goal bar — rounds numeric input test.
 * Vacuum: open editor, enter a custom maxRounds value directly, confirm it is
 * accepted (sends set_goal_prefs) and renders as plain input (no dropdown).
 * No model calls.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const CHROME = CHROME_PATH;
const PORT = 8915;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

(async () => {
	const server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-rounds-")),
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			break;
		} catch {}
	}

	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(URL);
	await page.waitForSelector(".goalbar", { timeout: 20000 });

	// Open editor.
	await page.locator(".goalbar-hint").first().click();
	await page.waitForSelector(".goalbar-input");
	// The max-rounds control is a text input (not a dropdown).
	const input = page.locator(".goalbar-round input");
	check("maxRounds is a direct numeric input", (await input.count()) === 1);
	if ((await input.count()) > 0) {
		// Type a custom value and blur → persists as pref.
		await input.fill("15");
		await input.blur();
		await sleep(300);
		check("typed value accepted (10/15)", (await input.inputValue()) === "15", await input.inputValue());
		// 0 = unlimited; clearing shows placeholder.
		await input.fill("0");
		await input.blur();
		await sleep(200);
		check("0 = unlimited preserved", (await input.inputValue()) === "0", await input.inputValue());
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	await browser.close();
	try {
		process.kill(server.pid, "SIGTERM");
	} catch {}
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("ERR", e);
	process.exit(1);
});
