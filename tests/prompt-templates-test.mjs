import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { realpathSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

function resolveNodePath() {
	if (process.env.PI_WEB_NODE) return process.env.PI_WEB_NODE;
	try {
		return realpathSync(process.execPath);
	} catch {}
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const fnn = join(home, "AppData", "Roaming", "fnm", "node-versions");
	if (existsSync(fnn)) {
		const v = readdirSync(fnn)
			.map((d) => join(fnn, d, "installation", "node.exe"))
			.find((p) => existsSync(p));
		if (v) return v;
	}
	return process.execPath;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = resolveNodePath();

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-tpl-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(NODE, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
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
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({ executablePath: CHROME_PATH });
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

	await page.waitForSelector(".empty-state", { timeout: 10000 });
	const cardTexts = await page.locator(".empty-template").allTextContents();
	check(`all 8 core workflows + "new template" card shown (got ${cardTexts.length})`, cardTexts.length === 9);
	check(
		`card titles are engineering workflows (has 需求对齐 or 系统化排错)`,
		cardTexts.some((t) => t.includes("需求对齐") || t.includes("系统化排错")),
	);
	check(
		`has 新建模板 card`,
		cardTexts.some((t) => t.includes("新建模板")),
	);

	const cardTitle =
		(await page.locator(".empty-template").first().locator(".empty-template-title").textContent()) ?? "";
	await page.locator(".empty-template").first().click();
	const inputVal = await page.locator(".inputbox textarea").inputValue();
	check(
		`clicking a card fills the input with a prompt longer than the title (${inputVal.length} vs ${cardTitle.length})`,
		inputVal.length > cardTitle.length * 3,
	);

	await page.locator(".empty-template").first().locator(".template-card-ops").click();
	await page.waitForSelector(".template-modal", { timeout: 3000 });
	const promptVal = await page.locator(".template-field-prompt").inputValue();
	const titleVal = await page.locator(".template-field:nth-of-type(2) .template-field-input").inputValue();
	check(
		`edit modal prompt is much longer than the card title (${promptVal.length} vs ${titleVal.length})`,
		promptVal.length > titleVal.length * 3,
	);
	await page.keyboard.press("Escape");
	await page.waitForSelector(".template-modal", { state: "hidden", timeout: 3000 });
	check(`Esc closes the edit modal`, true);

	await page.locator(".empty-template.add").click();
	await page.waitForSelector(".template-modal", { timeout: 3000 });
	await page.locator(".template-field:nth-of-type(2) .template-field-input").fill("冒烟模板");
	await page.locator(".template-field:nth-of-type(3) .template-field-input").fill("一句冒烟说明");
	await page.locator(".template-field-prompt").fill("这是一条冒烟测试提示词，第一行\n第二行");
	await page.locator(".template-modal-actions-right .btn").first().click();
	await page.waitForSelector(".template-modal", { state: "hidden", timeout: 3000 });
	const afterSave = await page.locator(".empty-template").allTextContents();
	check(
		`custom template card appears (got ${afterSave.length} cards)`,
		afterSave.length === 27 && afterSave.some((t) => t.includes("冒烟模板")),
	);
	const stored = await page.evaluate(() => localStorage.getItem("pi-web-ui:prompt-templates"));
	check(`custom template persisted to localStorage`, (stored ?? "").includes("冒烟模板"));

	await page.reload();
	await page.waitForSelector(".empty-template", { timeout: 15000 });
	const afterReload = await page.locator(".empty-template").allTextContents();
	check(
		`custom template survives reload`,
		afterReload.length === 27 && afterReload.some((t) => t.includes("冒烟模板")),
	);

	await page.locator(".inputbox .btn.tpl-open").click();
	await page.waitForSelector(".template-picker", { timeout: 3000 });
	check(`template picker opens from the input toolbar`, true);
	const pickerCards = await page.locator(".template-picker .empty-template").allTextContents();
	check(
		`picker lists all templates (${pickerCards.length})`,
		pickerCards.length >= 26 && pickerCards.some((t) => t.includes("冒烟模板")),
	);
	await page.locator(".template-picker .empty-template").first().click();
	await page.waitForSelector(".template-picker", { state: "hidden", timeout: 3000 });
	const pickerFilled = await page.locator(".inputbox textarea").inputValue();
	check(`picking a card in the picker fills the input`, pickerFilled.length > 10);
	await page.locator(".inputbox .btn.tpl-open").click();
	await page.waitForSelector(".template-picker", { timeout: 3000 });
	await page.locator(".template-picker .empty-template").first().locator(".template-card-ops").click();
	await page.waitForSelector(".template-modal", { timeout: 3000 });
	check(`picker ✏️ opens the edit modal`, true);
	await page.keyboard.press("Escape");
	await page.waitForSelector(".template-modal", { state: "hidden", timeout: 3000 });
	check(`Esc closes the edit modal opened from the picker`, true);

	check(`no console/page errors (${consoleErrors.length})`, consoleErrors.length === 0);

	await browser.close();
	console.log(`\npassed: ${passed}`);
	if (passed === 0 || process.exitCode) process.exitCode = 1;
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
