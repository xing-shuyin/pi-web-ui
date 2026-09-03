/**
 * 全局搜索 UI 冒烟（真实 Chrome headless，零 token）：
 * 顶栏「搜索」按钮打开弹窗 → 输入关键词 → 文件分区出现命中；
 * Ctrl+K 可开关弹窗；模型下拉出现搜索框并可过滤。
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8963;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const workDir = join(mkdtempSync(join(tmpdir(), "pi-web-gsui-")), "proj");
mkdirSync(join(workDir, "src"), { recursive: true });
writeFileSync(join(workDir, "src", "alpha-util.ts"), "export {};");
writeFileSync(join(workDir, "README.md"), "hi");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-gsui-data-"));
let server = null;

async function run() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await portUp(PORT)) break;
	}

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	await page.goto(BASE);
	await page.waitForSelector(".topbar", { timeout: 15000 });

	// 1) 顶栏搜索按钮存在且点击打开弹窗
	const searchBtn = page.locator(".topbar .chip", { hasText: "搜索" }).first();
	check("顶栏有搜索按钮", (await searchBtn.count()) > 0);
	await searchBtn.click();
	await page.waitForSelector(".gs-modal", { timeout: 5000 });
	check("点击按钮打开全局搜索弹窗", true);

	// 2) 输入关键词 → 文件分区命中
	await page.fill(".gs-input-row input", "util");
	await page.waitForSelector(".gs-item", { timeout: 8000 });
	const fileHit = await page.locator(".gs-item-title", { hasText: "alpha-util.ts" }).count();
	check("文件命中显示 alpha-util.ts", fileHit > 0);

	// 3) 点击文件 → 打开文件预览
	await page.locator(".gs-item", { hasText: "alpha-util.ts" }).first().click();
	await page.waitForSelector(".fp-modal, .file-preview, [class*=fp-]", { timeout: 5000 }).catch(() => {});
	const previewVisible = await page.locator("text=alpha-util.ts").count();
	check("点击后打开文件预览", previewVisible > 0);
	await page.keyboard.press("Escape");
	await sleep(300);

	// 4) Ctrl+K 开关
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 3000 }).catch(() => {});
	check("Ctrl+K 打开弹窗", (await page.locator(".gs-modal").count()) > 0);
	await page.keyboard.press("Control+k");
	await sleep(300);
	check("再次 Ctrl+K 关闭弹窗", (await page.locator(".gs-modal").count()) === 0);

	// 5) 模型下拉搜索框
	await page.locator(".topbar .dropdown .chip").first().click();
	await page.waitForSelector(".dd-search", { timeout: 3000 }).catch(() => {});
	check("模型下拉出现搜索框", (await page.locator(".dd-search").count()) > 0);

	await browser.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
