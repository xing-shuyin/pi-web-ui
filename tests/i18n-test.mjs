/* i18n smoke test: boots the compiled server, opens the built UI, verifies the
 * language switcher defaults to Chinese and switches to English.
 * Run:  npm run build && node i18n-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(process.execPath, [join(new URL("..", import.meta.url).pathname, "dist", "server", "index.js")], {
	cwd: new URL("..", import.meta.url).pathname,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	// -- default language is Chinese -----------------------------------------
	await page.waitForSelector(".brand", { timeout: 5000 });
	const zhNewChat = await page.locator(".topbar .newchat span").textContent();
	check(`default UI is Chinese ("新对话")`, zhNewChat?.includes("新对话"));
	const zhLangChip = await page.locator(".topbar-actions .chip-sub").last().textContent();
	check(`language chip shows 中文`, zhLangChip?.includes("中文"));

	// -- switch to English ----------------------------------------------------
	await page.locator(".topbar-actions .dropdown").last().locator("button.chip").click();
	await page.waitForSelector(".dd-item:has-text('English')", { timeout: 3000 });
	await page.locator(".dd-item:has-text('English')").click();
	await sleep(400);

	const enNewChat = await page.locator(".topbar .newchat span").textContent();
	check(`UI switched to English ("New chat")`, enNewChat?.includes("New chat"));
	const enTab = await page.locator(".view-switch button span").first().textContent();
	check(`view tab shows "Chat"`, enTab?.includes("Chat"));

	// model dropdown header translated
	await page.locator(".topbar-actions .dropdown").first().locator("button.chip").click();
	await page.waitForSelector(".dd-header", { timeout: 3000 });
	const ddHeader = await page.locator(".dd-header").first().textContent();
	check(`model dropdown header is "Available models"`, ddHeader?.includes("Available models"));
	await page.keyboard.press("Escape");

	// -- persistence: reload keeps English ------------------------------------
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await sleep(500);
	const enAfterReload = await page.locator(".topbar .newchat span").textContent();
	check(`English persists across reload`, enAfterReload?.includes("New chat"));

	// -- switch back to Chinese -----------------------------------------------
	await page.locator(".topbar-actions .dropdown").last().locator("button.chip").click();
	await page.waitForSelector(".dd-item:has-text('中文')", { timeout: 3000 });
	await page.locator(".dd-item:has-text('中文')").first().click();
	await sleep(400);
	const zhAgain = await page.locator(".topbar .newchat span").textContent();
	check(`switched back to Chinese`, zhAgain?.includes("新对话"));

	const errs = consoleErrors.filter((e) => !e.includes("favicon") && !e.includes("ResizeObserver"));
	check(`no console errors (${errs.length})`, errs.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
