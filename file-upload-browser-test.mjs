/* File-chat E2E test: boots the compiled server, opens the built UI in
 * headless Chrome, and drives drag-drop / upload of non-image files:
 *
 *   1. drag a small text file onto the input bar -> 📄 chip
 *   2. upload a binary file via the attach button -> second 📄 chip
 *   3. send -> small text renders as an inline card (content visible),
 *      binary renders as a reference card (size hint)
 *
 * Works with system Chrome; no pi model auth needed (the file aside renders
 * even when the model call fails).
 * Run:  npm run build && node file-upload-browser-test.mjs */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-fup-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const HERE = fileURLToPath(new URL(".", import.meta.url));
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

	// 1) Drag a small text file onto the input bar.
	await page.evaluate(
		async ({ name, text }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([text], name, { type: "text/plain" }));
			const bar = document.querySelector(".inputbar");
			bar.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
		},
		{ name: "note.txt", text: "拖拽的文本文件 hello" },
	);
	await page.waitForSelector(".attach-chip.file", { timeout: 8000 });
	check("drag: 📄 text chip appeared", true);

	// 2) Upload a binary file via the hidden file input.
	const binFile = join(workdir, "data.bin");
	writeFileSync(binFile, Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
	await page.locator('input[type="file"]').setInputFiles(binFile);
	await page.waitForTimeout(800);
	check("upload: two 📄 chips", (await page.locator(".attach-chip.file").count()) === 2);

	// 3) SVG must NOT go through the image pipeline (createImageBitmap can't
	//    decode it) — it attaches as a plain file (📄 chip, not 🖼).
	const svgFile = join(workdir, "logo.svg");
	writeFileSync(
		svgFile,
		'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
	);
	await page.locator('input[type="file"]').setInputFiles(svgFile);
	await page.waitForTimeout(800);
	check(
		"svg: attached as file chip (📄), not image (🖼)",
		(await page.locator(".attach-chip.file").count()) === 3 &&
			(await page.locator(".attach-chip.image").count()) === 0 &&
			(await page.locator(".attach-chip.file").allTextContents()).some((t) => t.includes("logo.svg")),
	);

	// 4) Send; the text file must inline (content visible), binary referenced.
	await page.fill(".inputbox textarea", "看看这两个文件");
	await page.keyboard.press("Enter");
	await page.waitForSelector(".attachcard", { timeout: 20000 });
	await page.waitForTimeout(500);

	const first = page.locator(".attachcard").first();
	const firstName = (await first.locator(".attachcard-name").textContent()).trim();
	const firstMode = (await first.locator(".attachcard-mode").textContent()).trim();
	await first.locator(".attachcard-head").click();
	await page.waitForTimeout(400);
	const inlineContent = (
		await first
			.locator(".attachcard-content")
			.textContent()
			.catch(() => "")
	).trim();
	check(
		`text card inline: "${firstName}" / ${firstMode} / contains content`,
		firstName === "note.txt" && inlineContent.includes("拖拽的文本文件"),
	);

	const second = page.locator(".attachcard").nth(1);
	const secondName = (await second.locator(".attachcard-name").textContent()).trim();
	const secondMode = (await second.locator(".attachcard-mode").textContent()).trim();
	check(
		`binary card reference: "${secondName}" / ${secondMode}`,
		secondName === "data.bin" && /引用|reference/i.test(secondMode),
	);

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
