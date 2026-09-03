/**
 * Theme switching smoke test (pure `:root` palette override).
 *
 * Scenarios:
 *   1. /api/themes lists the builtin palette themes (white/md-preview/…)
 *   2. choosing a theme injects a <link> and applies its palette
 *   3. the choice persists across reload
 *   4. switching back to default removes the injected link
 *   5. a user-dropped theme in <dataDir>/themes shows up and is selectable
 *
 * Runs on a dedicated port (8937) with an isolated data dir.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8937;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-theme-test-"));
// Drop a user theme to prove user themes are listed and served.
mkdirSync(join(dataDir, "themes"));
writeFileSync(join(dataDir, "themes", "user-test.css"), ":root {\n\t--bg: #123456;\n\t--text: #ffffff;\n}\n");

let server = null;
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return true;
		} catch {
			/* not up yet */
		}
	}
	return false;
}
async function stopServer() {
	if (server) {
		try {
			server.kill("SIGKILL");
		} catch {
			/* noop */
		}
		server = null;
	}
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			return;
		}
	}
}

async function openThemeMenu(page) {
	// Open the theme dropdown (desktop toolbar, FiSun chip labeled "主题"/"Theme").
	await page.locator(".topbar-desktop .dropdown button.chip").filter({ hasText: "主题" }).click();
}

let browser;
try {
	if (!(await startServer())) throw new Error("server failed to start");
	browser = await chromium.launch({ executablePath: HEADLESS });
	const page = await browser.newPage();
	await page.goto(URL, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2500);

	// 1. /api/themes lists builtin + user themes.
	const themes = await page.evaluate(() => fetch("/api/themes").then((r) => r.json()));
	const ids = themes.themes.map((t) => t.id).sort();
	check(
		"/api/themes lists builtin + user themes",
		ids.includes("white") &&
			ids.includes("md-preview") &&
			ids.includes("cyberpunk") &&
			ids.includes("dazzle") &&
			!ids.includes("light") && // legacy full-copy theme removed
			ids.includes("user-test"),
		`got ${ids.join(", ")}`,
	);
	const whiteInfo = themes.themes.find((t) => t.id === "white");
	const mdPrevInfo = themes.themes.find((t) => t.id === "md-preview");
	check(
		"theme-name header gives display names",
		whiteInfo?.name === "白色" && mdPrevInfo?.name === "紫晕",
		`white=${whiteInfo?.name} md-preview=${mdPrevInfo?.name}`,
	);
	check("white is builtin", whiteInfo?.builtin === true);
	const userInfo = themes.themes.find((t) => t.id === "user-test");
	check("user-test is not builtin", userInfo?.builtin === false);

	// 2. Choosing white injects a <link> and applies the palette.
	await openThemeMenu(page);
	await page.locator(".dd-item", { hasText: "白色" }).first().click();
	await page.waitForTimeout(1500);
	const hasLink = await page.evaluate(() => document.getElementById("theme-stylesheet")?.getAttribute("href"));
	check("theme <link> injected for white", hasLink === "/themes/white.css", `href=${hasLink}`);
	const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	check("white palette applied", bg === "#ffffff", `--bg=${bg}`);

	// 3. Persists across reload.
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1500);
	const afterReload = await page.evaluate(() => {
		const href = document.getElementById("theme-stylesheet")?.getAttribute("href");
		const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
		return { href, bg };
	});
	check(
		"theme persists after reload",
		afterReload.href === "/themes/white.css" && afterReload.bg === "#ffffff",
		`href=${afterReload.href} bg=${afterReload.bg}`,
	);

	// 4. User theme is selectable and its CSS is served.
	await openThemeMenu(page);
	await page.locator(".dd-item", { hasText: "user-test" }).first().click();
	await page.waitForTimeout(1500);
	const userBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	check("user theme applied", userBg === "#123456", `--bg=${userBg}`);

	// 5. Switching back to default removes the injected link.
	await openThemeMenu(page);
	await page.locator(".dd-item", { hasText: "深色" }).first().click();
	await page.waitForTimeout(800);
	const linkGone = await page.evaluate(() => document.getElementById("theme-stylesheet") === null);
	const bg2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	check("back to default removes link + dark palette", linkGone && bg2 === "#0d0e12", `linkGone=${linkGone} bg=${bg2}`);
} catch (err) {
	console.error("ERROR", err);
	failures++;
} finally {
	if (browser) await browser.close();
	await stopServer();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
