import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const CHROME = CHROME_PATH;
const PORT = 8944;
const URL = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-dsh-ui-"));
const patchDir = join(dataDir, "dsh-patches");
mkdirSync(patchDir, { recursive: true });
writeFileSync(
	join(patchDir, "00-ui.patch.yml"),
	[
		"# dsh UI e2e patch (harmless persona override)",
		"- id: system-prompt",
		"  name: '@deepseek-ai/dsh-system-prompt'",
		"  config:",
		"    persona: 'DSH_UI_PATCH_MARKER'",
		"",
	].join("\n"),
);

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: REPO_ROOT,
			PI_WEB_ENGINE: "dsh",
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

async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openSettings(page) {
	const btn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) > 0) return true;
		await tap(page, btn).catch(() => {});
		for (let i = 0; i < 15; i++) {
			if ((await page.locator(".settings-modal").count()) > 0) return true;
			await sleep(200);
		}
	}
	return false;
}

async function run() {
	if (!CHROME) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		process.exit(0);
	}
	await startServer();
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage();
	await page.goto(URL);

	await page.locator(".engine-badge.engine-dsh").waitFor({ timeout: 20000 });
	const badge = await page.locator(".engine-badge.engine-dsh").innerText();
	check("DSH 引擎徽标显示", /DSH/i.test(badge.trim()), badge.trim());

	await page.locator(".goalbar, .goalbar-collapsed").first().waitFor({ timeout: 15000 });
	const goalbarCount = await page.locator(".goalbar, .goalbar-collapsed").count();
	check("目标条（GoalBar）渲染", goalbarCount > 0, `count=${goalbarCount}`);

	check("设置面板打开", await openSettings(page));
	await page.waitForSelector(".settings-tab", { timeout: 10000 });
	await tap(page, page.locator('.settings-tab[data-tab="extensions"]').first());
	await tap(page, page.locator(".dsh-market-tab").nth(1));
	await page.locator("text=00-ui.patch.yml").first().waitFor({ timeout: 10000 });
	check("补丁文件 00-ui.patch.yml 展示", (await page.locator("text=00-ui.patch.yml").count()) > 0);

	await tap(page, page.locator('.settings-tab[data-tab="dsh-presets"]').first());
	const presetSection = await page
		.getByText(/新对话使用的预设|Preset for new chats|默认预设|Default preset/i)
		.first()
		.waitFor({ timeout: 10000 })
		.then(() => true)
		.catch(() => false);
	check("DSH 专属预设与权限页签展示", presetSection);

	await browser.close().catch(() => {});
	if (server) server.kill();
	console.log(`\n===== dsh-ui ${failures === 0 ? "PASS" : `FAIL (${failures})`} =====`);
	process.exit(failures ? 1 : 0);
}

run().catch((err) => {
	console.error("✗ dsh-ui crashed:", err.message);
	if (server) server.kill();
	process.exit(1);
});
