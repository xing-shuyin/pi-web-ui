/* Sound settings UI test: boots the compiled server, opens the built UI, and
 * exercises the sound notification configuration dropdown:
 *
 *   1. the dropdown opens with master + per-event toggles + volume
 *   2. toggling an event and changing volume persists to localStorage
 *   3. a reload restores the persisted settings
 *   4. "试听" plays a cue without throwing (no page errors)
 *
 * No model calls needed — this is pure UI + persistence.
 * Run:  npm run build && node sound-settings-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-snd-"));
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
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function openSoundMenu(page) {
	await page.locator(".topbar-actions .chip", { hasText: "声音" }).click();
	await page.waitForSelector(".sound-menu", {
		state: "visible",
		timeout: 5000,
	});
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

	// -- dropdown structure ---------------------------------------------------
	await openSoundMenu(page);
	const rows = await page.locator(".sound-row").count();
	check("sound panel shows master + 4 event rows", rows === 5);
	check(
		"event rows labelled",
		(await page.locator(".sound-menu").textContent())?.includes("问卷弹出") &&
			(await page.locator(".sound-menu").textContent())?.includes("回复结束") &&
			(await page.locator(".sound-menu").textContent())?.includes("出错"),
	);
	check("volume slider present", (await page.locator(".sound-volume input[type=range]").count()) === 1);
	check("default volume is 100", (await page.locator(".sound-vol-num").textContent())?.includes("100"));

	// -- master switch gates the rows ----------------------------------------
	const startRow = page.locator(".sound-row", { hasText: "回复开始" });
	const startCheckbox = startRow.locator('input[type="checkbox"]');
	check("start cue default off", (await startCheckbox.isChecked()) === false);
	await page.locator(".sound-master input[type=checkbox]").uncheck();
	check(
		"rows disabled when master off",
		(await startCheckbox.isDisabled()) === true && (await page.locator(".sound-preview").first().isDisabled()) === true,
	);
	await page.locator(".sound-master input[type=checkbox]").check();

	// -- toggle an event + set volume ----------------------------------------
	await startCheckbox.check();
	check("start cue enabled", await startCheckbox.isChecked());

	const range = page.locator(".sound-volume input[type=range]");
	await range.evaluate((el) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(el, "30");
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await sleep(200);
	check("volume label updates", (await page.locator(".sound-vol-num").textContent())?.includes("30"));

	// -- 试听 must not throw --------------------------------------------------
	await startRow.locator(".sound-preview").click();
	await sleep(300);
	check("preview plays without errors", consoleErrors.length === 0);

	// -- persistence across reload -------------------------------------------
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await openSoundMenu(page);
	check(
		"start cue persisted after reload",
		await page.locator(".sound-row", { hasText: "回复开始" }).locator('input[type="checkbox"]').isChecked(),
	);
	check("volume persisted after reload", (await page.locator(".sound-vol-num").textContent())?.includes("30"));

	if (consoleErrors.length > 0) {
		console.log("console errors:", consoleErrors.slice(0, 5));
	}
	console.log(`\n${passed} checks passed`);
	await browser.close();
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("test crashed:", err);
	process.exit(1);
});
