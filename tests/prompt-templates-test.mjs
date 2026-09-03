/* 提示词模板 UI 测试：boots the compiled server, opens the built UI, and
 * exercises the new-conversation prompt-template cards:
 *
 *   1. empty state shows 6 built-in template cards + a "new template" card
 *   2. clicking a card opens a modal with a full prompt much longer than the
 *      card title (template ≠ button text)
 *   3. "填入输入框" fills the main input with the full prompt
 *   4. creating a custom template persists to localStorage and survives reload
 *   5. Esc closes the modal
 *
 * No model calls needed — pure UI + localStorage persistence.
 * Run:  npm run build && node prompt-templates-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { realpathSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// fnm/shims 之类的 shell 包装会把 process.execPath 指到临时软链，脱离 shell 后失效。
// 探测真实 node 可执行文件：realpath 优先，逐候选位置兼底。
function resolveNodePath() {
	if (process.env.PI_WEB_NODE) return process.env.PI_WEB_NODE;
	try {
		return realpathSync(process.execPath);
	} catch {
		/* fall through */
	}
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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tests/ 的上一级 = 仓库根
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

	// -- 1. built-in template cards render in the empty state ---------------
	await page.waitForSelector(".empty-state", { timeout: 10000 });
	const cardTexts = await page.locator(".empty-template").allTextContents();
	check(`all 25 aihero skills + "new template" card shown (got ${cardTexts.length})`, cardTexts.length === 26);
	check(
		`card titles are engineering workflows (has 需求拷问)`,
		cardTexts.some((t) => t.includes("需求拷问")),
	);
	check(
		`has 新建模板 card`,
		cardTexts.some((t) => t.includes("新建模板")),
	);

	// -- 2. clicking a card FILLS the input; ✏️ opens edit ------------------
	const cardTitle =
		(await page.locator(".empty-template").first().locator(".empty-template-title").textContent()) ?? "";
	await page.locator(".empty-template").first().click();
	const inputVal = await page.locator(".inputbox textarea").inputValue();
	check(
		`clicking a card fills the input with a prompt longer than the title (${inputVal.length} vs ${cardTitle.length})`,
		inputVal.length > cardTitle.length * 3,
	);

	// -- 3. ✏️ opens the edit modal with the full prompt; Esc closes it -------
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

	// -- 4. create a custom template -> persists to localStorage + reload ----
	await page.locator(".empty-template.add").click();
	await page.waitForSelector(".template-modal", { timeout: 3000 });
	await page.locator(".template-field:nth-of-type(2) .template-field-input").fill("冒烟模板");
	await page.locator(".template-field:nth-of-type(3) .template-field-input").fill("一句冒烟说明");
	await page.locator(".template-field-prompt").fill("这是一条冒烟测试提示词，第一行\n第二行");
	await page.locator(".template-modal-actions-right .btn").first().click(); // 保存
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

	// -- 5. input-toolbar button opens the template picker (usable mid-chat) --
	await page.locator(".inputbox .btn.tpl-open").click();
	await page.waitForSelector(".template-picker", { timeout: 3000 });
	check(`template picker opens from the input toolbar`, true);
	const pickerCards = await page.locator(".template-picker .empty-template").allTextContents();
	check(
		`picker lists all templates (${pickerCards.length})`,
		pickerCards.length >= 26 && pickerCards.some((t) => t.includes("冒烟模板")),
	);
	// 选择器里点卡片 -> 填输入框
	await page.locator(".template-picker .empty-template").first().click();
	await page.waitForSelector(".template-picker", { state: "hidden", timeout: 3000 });
	const pickerFilled = await page.locator(".inputbox textarea").inputValue();
	check(`picking a card in the picker fills the input`, pickerFilled.length > 10);
	// 选择器里点 ✏️ -> 编辑弹窗
	await page.locator(".inputbox .btn.tpl-open").click();
	await page.waitForSelector(".template-picker", { timeout: 3000 });
	await page.locator(".template-picker .empty-template").first().locator(".template-card-ops").click();
	await page.waitForSelector(".template-modal", { timeout: 3000 });
	check(`picker ✏️ opens the edit modal`, true);
	await page.keyboard.press("Escape");
	await page.waitForSelector(".template-modal", { state: "hidden", timeout: 3000 });
	check(`Esc closes the edit modal opened from the picker`, true);

	// -- no uncaught page errors during the whole flow -----------------------
	check(`no console/page errors (${consoleErrors.length})`, consoleErrors.length === 0);

	await browser.close();
	console.log(`\npassed: ${passed}`);
	if (passed === 0 || process.exitCode) process.exitCode = 1;
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
