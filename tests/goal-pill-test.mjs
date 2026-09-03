/**
 * Goal bar — collapsed pill + upward dropdown UI test.
 * Verifies the idle state is a compact left-aligned pill, expanding opens the
 * editor, the model/rounds dropdowns open UPWARD (dd-up) without overflowing,
 * then setting a goal works. No model calls.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const CHROME = CHROME_PATH;
const PORT = 8907;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-goalpill-")),
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return;
		} catch {
			/* retry */
		}
	}
	throw new Error("server did not start");
}

async function run() {
	await startServer();
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(URL);
	await page.waitForSelector(".goalbar", { timeout: 20000 });

	// 1. Idle collapsed = compact pill, no bordered panel.
	const pill = page.locator(".goalbar.collapsed, .goalbar-collapsed");
	const pillCount = await pill.count();
	check("idle shows compact pill (not panel)", pillCount > 0, `pillCount=${pillCount}`);
	if (pillCount > 0) {
		const hasBorder = await page.locator(".goalbar-collapsed").evaluate((el) => getComputedStyle(el).borderTopStyle);
		check("collapsed pill has no heavy border", hasBorder === "none", hasBorder);
	}

	// 2. Expand the editor.
	await page.locator(".goalbar-hint").first().click();
	await page.waitForSelector(".goalbar-input", { timeout: 8000 });
	check("clicking pill opens editor", true);

	// 3. Type a goal, then open the model dropdown; assert dd-up + upward anchored.
	await page.locator(".goalbar-input").fill("做一个小工具");
	const modelOpt = page.locator(".goalbar-opt").first(); // "审查模型" dropdown trigger
	await modelOpt.click();
	await page.waitForSelector(".dd-menu", { timeout: 8000 });
	const ddUp = await page.locator(".goalbar .dropdown.dd-up .dd-menu").count();
	check("model dropdown opens upward (dd-up)", ddUp > 0, `ddUp=${ddUp}`);
	if (ddUp > 0) {
		// The menu's bottom should be above the trigger (bottom > trigger's viewport top).
		const pos = await page
			.locator(".goalbar .dropdown.dd-up")
			.first()
			.evaluate((root) => {
				const menu = root.querySelector(".dd-menu");
				const rect = menu.getBoundingClientRect();
				const vh = window.innerHeight;
				return { menuBottom: rect.bottom, menuTop: rect.top, vh };
			});
		check(
			"menu stays on-screen (doesn't overflow bottom)",
			pos.menuBottom <= pos.vh,
			`bottom=${Math.round(pos.menuBottom)} vh=${pos.vh}`,
		);
	}
	// Close the menu (Esc).
	await page.keyboard.press("Escape");
	await sleep(200);

	// 4. Set the goal → active bar.
	await page.locator(".goalbar-btn:not(.wizard)").click();
	await page.waitForSelector(".goalbar-active", { timeout: 8000 });
	check("active goal bar shown", true);

	// 5. Collapse back via the chevron (idle pill returns).
	await page.locator(".goalbar-x").click();
	await page.waitForSelector(".goalbar-active", { state: "detached", timeout: 8000 });
	const pillBack = await page.locator(".goalbar-collapsed").count();
	check("idle pill returns after clearing", pillBack > 0);

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
