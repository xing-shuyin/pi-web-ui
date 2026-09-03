/**
 * DSH 引擎浏览器 UI E2E（零 key、不起运行时 prompt）——验证 DSH 专属界面：
 *   1. 引擎徽标（engine=dsh → 「DSH」badge）
 *   2. 目标条（GoalBar）渲染
 *   3. 设置面板「界面插件」页签下的「DSH 用户补丁」区块（扫描 <dataDir>/dsh-patches）
 *   4. 设置面板「技能」页签下的 DSH 说明文案
 * 不调模型 → 无 token；运行时 boot 不需要 key（prompt 才需要）。
 *
 * 用法：node tests/dsh-ui-test.mjs   （先 npm run build）
 */
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
// 放一个无害 user patch（persona 覆盖），验证「DSH 用户补丁」区块能扫到并展示。
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
		} catch {
			/* retry */
		}
	}
	throw new Error("server did not start");
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

	// 1. DSH 引擎徽标（ready(engine=dsh) 到达后 FooterBar 渲染）。
	await page.locator(".engine-badge.engine-dsh").waitFor({ timeout: 20000 });
	const badge = await page.locator(".engine-badge.engine-dsh").innerText();
	check("DSH 引擎徽标显示", /DSH/i.test(badge.trim()), badge.trim());

	// 2. 目标条渲染。
	await page.locator(".goalbar").waitFor({ timeout: 15000 });
	const goalbarCount = await page.locator(".goalbar").count();
	check("目标条（GoalBar）渲染", goalbarCount > 0, `count=${goalbarCount}`);

	// 3. 设置面板「界面插件」→ 「DSH 用户补丁」区块。
	await page.locator('button.chip[title="设置"]').first().click();
	await page.locator(".settings-tab", { hasText: "界面插件" }).first().click();
	await page.locator("text=DSH 用户补丁").first().waitFor({ timeout: 10000 });
	check("设置面板显示「DSH 用户补丁」区块", (await page.locator("text=DSH 用户补丁").count()) > 0);
	// 补丁文件应在列表里展示（扫到 00-ui.patch.yml）。
	await page.locator("text=00-ui.patch.yml").first().waitFor({ timeout: 10000 });
	check("补丁文件 00-ui.patch.yml 展示", (await page.locator("text=00-ui.patch.yml").count()) > 0);

	// 4. 设置面板「技能」页签 → DSH 说明文案。
	await page.locator(".settings-tab", { hasText: "技能" }).first().click();
	const skillsNote = await page
		.locator("text=DSH 引擎使用运行时内置技能")
		.first()
		.waitFor({ timeout: 10000 })
		.then(() => true)
		.catch(() => false);
	check("技能页签显示 DSH 说明文案", skillsNote);

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
