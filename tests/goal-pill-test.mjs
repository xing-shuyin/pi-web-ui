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
		} catch {}
	}
	throw new Error("server did not start");
}

async function run() {
	await startServer();
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(URL);
	await page.waitForSelector(".goalbar", { timeout: 20000 });

	const pill = page.locator(".goalbar.collapsed, .goalbar-collapsed");
	const pillCount = await pill.count();
	check("idle shows compact pill (not panel)", pillCount > 0, `pillCount=${pillCount}`);
	if (pillCount > 0) {
		const hasBorder = await page.locator(".goalbar-collapsed").evaluate((el) => getComputedStyle(el).borderTopStyle);
		check("collapsed pill has no heavy border", hasBorder === "none", hasBorder);
	}

	await page.locator(".goalbar-hint").first().click();
	await page.waitForSelector(".goalbar-input", { timeout: 8000 });
	check("clicking pill opens editor", true);

	await page.locator(".goalbar-input").fill("做一个小工具");
	const modelOpt = page.locator(".goalbar-opt").first();
	await modelOpt.click();
	await page.waitForSelector(".dd-menu", { timeout: 8000 });
	const ddUp = await page.locator(".goalbar .dropdown.dd-up .dd-menu").count();
	check("model dropdown opens upward (dd-up)", ddUp > 0, `ddUp=${ddUp}`);
	if (ddUp > 0) {
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
	await page.keyboard.press("Escape");
	await sleep(200);

	await page.locator(".goalbar-btn:not(.wizard)").click();
	await page.waitForSelector(".goalbar-active", { timeout: 8000 });
	check("active goal bar shown", true);

	await page.locator(".goalbar-x").click();
	await page.waitForSelector(".goalbar-active", { state: "detached", timeout: 8000 });
	const pillBack = await page.locator(".goalbar-collapsed").count();
	check("idle pill returns after clearing", pillBack > 0);

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
