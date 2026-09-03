/**
 * Left-panel layout: the running-conversations list is pinned above the
 * scrolling history; both section titles live OUTSIDE the scroll container.
 * (Without a background run the running list stays hidden — new chats are
 * only listed once displaced while streaming — so the layout asserts the
 * section stays absent and the history structure stays intact.)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;
const WS = mkdtempSync(join(tmpdir(), "pi-layout-"));
writeFileSync(join(WS, "a.txt"), "a");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WS },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });
await sleep(800);

// 1. Single conversation → history title exists, no convs section.
const histTitles = await page.locator(".panel-sessions .panel-section-title").allTextContents();
check(
	"history title present",
	histTitles.some((t) => t.includes("历史对话")),
);
check("no convs section yet", (await page.locator(".panel-left .panel-convs").count()) === 0);

// 2. Two more new chats (still never ran, never displaced while streaming):
//    the running-conversations section must STAY hidden by design.
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(900);
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(900);

check("convs section still absent (no background run)", (await page.locator(".panel-left .panel-convs").count()) === 0);
const convTitles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"no 运行的对话 title without listed conversations",
	!convTitles.some((t) => t.includes("运行的对话")),
	convTitles.join("|"),
);

// 3. Structure: history title must be OUTSIDE the scroll container.
const historyTitleInsideScroll = await page.locator(".panel-sessions .sessions-scroll .panel-section-title").count();
check(
	"history title NOT inside the scroll container",
	historyTitleInsideScroll === 0,
	`inside=${historyTitleInsideScroll}`,
);

// 4. Scroll behavior: sessions-scroll is the scrolling area.
const styles = await page.evaluate(() => {
	const ss = document.querySelector(".sessions-scroll");
	const gs = getComputedStyle;
	return {
		sessionsScrollOverflow: ss ? gs(ss).overflowY : "missing",
		sessionsFlex: document.querySelector(".panel-sessions")
			? gs(document.querySelector(".panel-sessions")).flex
			: "missing",
	};
});
check("sessions-scroll is the scrolling area", styles.sessionsScrollOverflow === "auto");

// 5. Titles must not move when the sessions list scrolls.
const before = await page.evaluate(() => {
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
const after = await page.evaluate(async () => {
	const sc = document.querySelector(".sessions-scroll");
	if (sc) sc.scrollTop = 300;
	await new Promise((r) => setTimeout(r, 200));
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
check("history title stays fixed after scroll", before !== null && before === after, `top=${before}→${after}`);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
