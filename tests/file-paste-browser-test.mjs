/* Paste-file E2E: boots the compiled server, opens the built UI in
 * headless Chrome, and pastes a NON-image file into the composer:
 *
 *   1. paste a .txt + a .md from the clipboard (DataTransfer) -> file chips
 *      appear (`.attach-chip.file`, not the image kind)
 *   2. send -> the file attachment card renders with the file name
 *   3. a plain-text paste still inserts text (no chip, no swallow)
 *
 * Mirror of image-paste-browser-test.mjs; the paste path now shares
 * handleFiles with drag-drop, so the upload pipeline is the same one.
 * Run:  npm run build && node file-paste-browser-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-paste-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const HERE = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(process.execPath, [join(HERE, "dist", "server", "index.js")], {
	cwd: HERE,
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

async function paste(page, file) {
	await page.evaluate((f) => {
		const ta = document.querySelector(".inputbox textarea");
		const dt = new DataTransfer();
		dt.items.add(new File([f.bytes], f.name, { type: f.type }));
		ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, file);
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH ?? CHROME_PATH ?? undefined,
	});
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	// 1) Paste two non-image files into the textarea.
	await paste(page, { name: "paste-me.txt", type: "text/plain", bytes: "hello world\n" });
	await paste(page, { name: "paste-me.md", type: "text/markdown", bytes: "# title\n" });
	await page.waitForSelector(".attach-chip.file", { timeout: 8000 });
	check("paste: two file chips appeared", (await page.locator(".attach-chip.file").count()) === 2);
	check(
		"paste: chip names match",
		(await page.locator(".attach-chip.file").allTextContents()).join("|").includes("paste-me.txt"),
	);

	// 2) Remove one, confirm removal works on the pasted chips too.
	await page.locator(".attach-chip.file").first().locator(".attach-remove").click();
	await page.waitForTimeout(300);
	check("remove: one chip left", (await page.locator(".attach-chip.file").count()) === 1);

	// 3) File-only send (no text) — send must enable and the card must render.
	check("send enabled with file-only attachments", !(await page.locator(".btn.send").isDisabled()));
	await page.locator(".inputbox textarea").focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector(".attachcard", { timeout: 20000 });
	const cardText = (await page.locator(".attachcard").first().textContent()) ?? "";
	check("chat: attachment card rendered with file name", cardText.includes("paste-me.md"));
	check("chips cleared after send", (await page.locator(".attach-chip").count()) === 0);

	// 4) Plain-text paste is untouched (no preventDefault when no files).
	await page.locator(".inputbox textarea").focus();
	const swallowed = await page.evaluate(() => {
		const ta = document.querySelector(".inputbox textarea");
		const dt = new DataTransfer();
		dt.setData("text/plain", "just typing");
		const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
		ta.dispatchEvent(ev);
		return ev.defaultPrevented;
	});
	check("plain-text paste not swallowed (defaultPrevented=false)", swallowed === false);
	check("no stray chip after text paste", (await page.locator(".attach-chip").count()) === 0);

	check("no console errors", consoleErrors.length === 0);
	if (consoleErrors.length) console.log(consoleErrors.slice(0, 5));

	console.log(`DONE — ${passed} checks passed`);
	await browser.close();
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("test error:", e);
	process.exit(1);
});
