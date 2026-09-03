/* Image Q&A E2E test: boots the compiled server, opens the built UI in
 * headless Chrome, and drives paste / drag-drop / upload of images:
 *
 *   1. paste a PNG into the textarea -> 🖼 attach chip appears
 *   2. drag a PNG onto the input bar -> second chip appears
 *   3. pick a PNG via the upload button -> third chip appears
 *   4. send -> the attachment card with the image preview renders in chat
 *
 * Works with system Chrome; no pi model auth needed (the image aside renders
 * even when the model call fails).
 * Run:  npm run build && node image-paste-browser-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-img-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

// 1x1 transparent PNG (base64)
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
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

	// 1) Paste image into the textarea.
	await page.evaluate(
		({ b64, name }) => {
			const ta = document.querySelector(".inputbox textarea");
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], name, { type: "image/png" }));
			const ev = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			ta.dispatchEvent(ev);
		},
		{ b64: PNG_B64, name: "paste-me.png" },
	);
	await page.waitForSelector(".attach-chip.image", { timeout: 8000 });
	check("paste: 🖼 chip appeared", (await page.locator(".attach-chip.image").count()) === 1);

	// 2) Drag & drop a LARGE image (4000x3000) onto the input bar — the
	//    client must downscale it to MAX_DIMENSION (1568) before sending.
	await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 4000;
		c.height = 3000;
		const cx = c.getContext("2d");
		const grad = cx.createLinearGradient(0, 0, 4000, 3000);
		grad.addColorStop(0, "#ff0000");
		grad.addColorStop(1, "#0000ff");
		cx.fillStyle = grad;
		cx.fillRect(0, 0, 4000, 3000);
		const blob = await new Promise((res) => c.toBlob(res, "image/png"));
		const dt = new DataTransfer();
		dt.items.add(new File([blob], "drop-big.png", { type: "image/png" }));
		const bar = document.querySelector(".inputbar");
		bar.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	});
	await page.waitForTimeout(800);
	check("drop: two 🖼 chips (big image accepted)", (await page.locator(".attach-chip.image").count()) === 2);

	// 3) Upload via the hidden file input (the button opens it).
	const upFile = join(workdir, "upload-me.png");
	writeFileSync(upFile, Buffer.from(PNG_B64, "base64"));
	await page.locator('input[type="file"]').setInputFiles(upFile);
	await page.waitForTimeout(500);
	check("upload: three 🖼 chips", (await page.locator(".attach-chip.image").count()) === 3);

	// Remove one chip and confirm it's gone.
	await page.locator(".attach-chip.image").first().locator(".attach-remove").click();
	await page.waitForTimeout(300);
	check("remove: back to two 🖼 chips", (await page.locator(".attach-chip.image").count()) === 2);

	// 4) Image-only send (no text) — the send button must enable, submit
	//    clears the chips, and the attachment card renders.
	check("send button enabled with image-only attachments", !(await page.locator(".btn.send").isDisabled()));
	await page.locator(".inputbox textarea").focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector(".attachcard", { timeout: 20000 });
	// The card starts collapsed — click its head to reveal the image preview.
	await page.locator(".attachcard-head").first().click();
	await page.waitForSelector(".attachcard-image img", { timeout: 8000 });
	check("chat: attachment card rendered with image preview", true);
	// The dropped 4000px image must have been downscaled to ≤1568. drop-big.png
	// is the FIRST card and was already expanded above — clicking its head again
	// would collapse it, so only click when the image isn't visible yet.
	const bigCard = page.locator(".attachcard", { hasText: "drop-big.png" });
	if ((await bigCard.locator("img").count()) === 0) {
		await bigCard.locator(".attachcard-head").click();
	}
	const bigImg = bigCard.locator(".attachcard-image img");
	await bigImg.waitFor({ timeout: 8000 });
	const naturalWidth = await bigImg.evaluate((el) => el.naturalWidth);
	check(`chat: 4000px image downscaled to ${naturalWidth}px (≤1568)`, naturalWidth > 100 && naturalWidth <= 1568);
	check("chips cleared after send", (await page.locator(".attach-chip").count()) === 0);

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
