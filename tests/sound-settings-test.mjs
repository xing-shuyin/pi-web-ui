import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-snd-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {}
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
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function openSoundMenu(page) {
	await page.locator('.topbar button[data-tip="设置"], .topbar .chip:has-text("设置")').first().click();
	await page.waitForSelector(".settings-modal", {
		state: "visible",
		timeout: 5000,
	});
	await page.locator(".settings-tab", { hasText: "声音与语音" }).click();
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

	await openSoundMenu(page);
	const soundPanel = page.locator(".sound-menu").first();
	const rows = await soundPanel.locator(".sound-row").count();
	check("sound panel shows master + event rows", rows >= 5);
	check(
		"event rows labelled",
		(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("问卷弹出") &&
			(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("回复结束") &&
			(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("出错"),
	);
	check("volume slider present", (await page.locator(".sound-volume input[type=range]").count()) === 1);
	check("default volume is 100", (await page.locator(".sound-vol-num").textContent())?.includes("100"));

	const soundMaster = page.locator(".sound-menu").first().locator(".sound-master input[type=checkbox]");
	const startRow = page.locator(".sound-row", { hasText: "回复开始" });
	const startCheckbox = startRow.locator('input[type="checkbox"]');
	check("start cue default off", (await startCheckbox.isChecked()) === false);
	await soundMaster.uncheck();
	check(
		"rows disabled when master off",
		(await startCheckbox.isDisabled()) === true && (await page.locator(".sound-preview").first().isDisabled()) === true,
	);
	await soundMaster.check();

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

	await startRow.locator(".sound-preview").click();
	await sleep(300);
	check("preview plays without errors", consoleErrors.length === 0);

	const notifyBox = page.locator(".notify-menu .sound-row input[type=checkbox]");
	check("notify block rendered in the dropdown", (await notifyBox.count()) === 1);
	check("notify block explains itself", (await page.locator(".notify-menu .sound-hint").count()) >= 1);
	const notifyApi = await page.evaluate(() => "Notification" in window);
	check("notify switch disabled iff the browser withholds the API", (await notifyBox.isDisabled()) === !notifyApi);

	let notifyOn = false;
	if (notifyApi) {
		await notifyBox.check();
		await sleep(200);
		notifyOn = await notifyBox.isChecked();
		const stored = await page.evaluate(() => {
			const raw = localStorage.getItem("pi-web-notify");
			return { enabled: raw ? JSON.parse(raw).enabled === true : false, permission: Notification.permission };
		});
		check("notify switch state matches what it persisted", notifyOn === stored.enabled);
		check("notify switch on ⇒ permission granted", !notifyOn || stored.permission === "granted");

		check("diagnostic test panel is hidden by default", (await page.locator(".notify-actions").count()) === 0);
	}

	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await openSoundMenu(page);
	check(
		"start cue persisted after reload",
		await page.locator(".sound-row", { hasText: "回复开始" }).locator('input[type="checkbox"]').isChecked(),
	);
	check("volume persisted after reload", (await page.locator(".sound-vol-num").textContent())?.includes("30"));
	check("notify switch persisted after reload", (await notifyBox.isChecked()) === notifyOn);

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
