/**
 * Goal bar — UI smoke test (no model call).
 * Boots the built server, loads the page, verifies the goal bar renders,
 * a goal can be set (active bar + status), and cleared. Only UI state changes —
 * no prompt, so no LLM tokens.
 */
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* eslint-env node */

const CHROME =
	"/Users/c/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PORT = 8904;
const URL = `http://localhost:${PORT}`;
const PROJ = "/Volumes/P/project/pi-web-ui";

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
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
			return;
		} catch {
			// retry
		}
	}
	throw new Error("server did not start");
}

async function run() {
	await startServer();
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage();
	await page.goto(URL);
	// The goal bar hint (idle, collapsed) should appear near the chat input.
	await page.waitForSelector(".goalbar", { timeout: 20000 });
	const hintVisible = await page.locator(".goalbar-hint").count();
	check("goal bar renders (idle hint)", hintVisible > 0 || (await page.locator(".goalbar-input").count()) > 0);

	// If collapsed, expand it; then type a goal and click 开始.
	const input = page.locator(".goalbar-input");
	if ((await input.count()) === 0) {
		await page.locator(".goalbar-hint").click();
		await page.waitForSelector(".goalbar-input");
	}
	await page.locator(".goalbar-input").fill("把页面标题改为 Goal UI 测试");
	// 开始 (Set) button — not the AI-提炼 (wizard) button.
	await page.locator(".goalbar-btn:not(.wizard)").click();
	// Active goal bar replaces the edit row.
	await page.waitForSelector(".goalbar-active", { timeout: 8000 });
	check("active goal bar shown after set", true);
	const text = await page.locator(".goalbar-text").innerText().catch(() => "");
	check("active goal shows the goal text", text.includes("Goal UI 测试"), text);

	// Clear it.
	await page.locator(".goalbar-x").click();
	await page.waitForSelector(".goalbar-active", { state: "detached", timeout: 8000 });
	const hintCount = await page.locator(".goalbar-hint").count();
	check("goal cleared (back to idle)", hintCount > 0 || (await page.locator(".goalbar-input").count()) > 0);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	await browser.close();
	try {
		server.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("test error:", err);
	try {
		server?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	process.exit(1);
});
