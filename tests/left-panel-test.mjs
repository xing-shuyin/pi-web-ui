/**
 * Left-panel sections + per-project workspace switching (UI):
 *   fresh state shows only 历史对话 (no 运行的对话 — nothing has been
 *   displaced while streaming), new_chat keeps the running list empty by
 *   design, and switching workspace via the footer updates the file tree and
 *   fires the 已切换到工作目录 notice.
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

const A = mkdtempSync(join(tmpdir(), "pi-ui-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-ui-b-"));
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(B, "b.txt"), "b");

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

// Free the port from any straggler before spawning.
try {
	await freePort(PORT);
} catch {
	/* port free */
}
await sleep(500);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: A },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });

// Wait for the Chinese locale UI (conn label or section titles).
await sleep(800);

// 1. Fresh state: only 历史对话 title; no 运行的对话 section, no divider
//    (a single fresh conversation is never listed — it never ran in the
//    background).
let titles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"history title present in fresh state",
	titles.some((t) => t.includes("历史对话")),
	titles.join("|"),
);
check(
	"no 运行的对话 section yet (nothing running in background)",
	!titles.some((t) => t.includes("运行的对话")),
	titles.join("|"),
);

// 2. Start a second conversation (still project A) — the fresh chat is not
//    listed either, so the running section stays hidden by design.
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(1200);
titles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"running list still empty after new_chat (by design)",
	!titles.some((t) => t.includes("运行的对话")),
	titles.join("|"),
);
check("no divider without running list", (await page.locator(".panel-left .panel-section-divider").count()) === 0);

// 3. Switch workspace to project B (footer cwd input) → file tree + notice.
await page.locator(".status-cwd").click();
await page.locator(".status-cwd-input").fill(B);
await page.keyboard.press("Enter");
await sleep(1500);
const fileNames = await page.locator(".panel-right .file-name-text").allTextContents();
check(
	"file tree shows B's files after switch",
	fileNames.some((t) => t.includes("b.txt")),
	fileNames.join(" | "),
);
const notices = await page
	.locator(".notice")
	.allTextContents()
	.catch(() => []);
check(
	"workspace-switch notice fired",
	notices.some((n) => n.includes("已切换到工作目录") || n.includes(B)),
	notices.join(" | "),
);

// 4. Switch back to project A → file tree returns to A's files.
await page.locator(".status-cwd").click();
await page.locator(".status-cwd-input").fill(A);
await page.keyboard.press("Enter");
await sleep(1500);
const fileNamesA = await page.locator(".panel-right .file-name-text").allTextContents();
check(
	"file tree back to A's files",
	fileNamesA.some((t) => t.includes("a.txt")),
	fileNamesA.join(" | "),
);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
