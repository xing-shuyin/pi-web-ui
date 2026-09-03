/**
 * 补充 button test: while the agent is replying, typing + clicking 补充
 * queues the message (followUp); it appears in the chat the moment the
 * current reply finishes, and the agent answers it.
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

const WS = mkdtempSync(join(tmpdir(), "pi-supp-"));
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
} catch {
	/* port free */
}
await sleep(500);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WS },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error("server failed to start");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector("textarea", { timeout: 15000 });
await sleep(800);

// --- 1. send the first prompt; wait for streaming (stop button) ---
await page.locator("textarea").fill("只回复两个字：好的");
await page.keyboard.press("Enter");
await page
	.waitForSelector(".btn.stop", { timeout: 60000 })
	.then(() => check("first reply streaming", true))
	.catch(() => check("first reply streaming", false, "no stop button"));

// --- 2. type a supplement while streaming → 补充 button appears ---
await page.locator("textarea").fill("补充一句话：请再说一遍");
await sleep(400);
const supplementBtn = page.locator(".btn.supplement");
check(
	"补充 button visible while streaming",
	(await supplementBtn.count()) === 1,
	`count=${await supplementBtn.count()}`,
);

// --- 3. click 补充 → input clears + queue hint shows ---
await supplementBtn.click();
await sleep(600);
check("input cleared after 补充", (await page.locator("textarea").inputValue()) === "");
const hint = await page
	.locator(".queue-hint")
	.allTextContents()
	.catch(() => []);
check(
	"queue hint shows queued follow-up",
	hint.some((h) => h.includes("跟进消息排队中") || h.includes("queued")),
	hint.join(" | "),
);

// --- 4. wait for the first reply to finish, then the supplement fires ---
await page
	.waitForSelector(".btn.stop", { state: "detached", timeout: 120000 })
	.then(() => check("first reply finished", true))
	.catch(() => check("first reply finished", false, "still streaming"));

// The queued supplement delivers immediately after; its user message should
// The queued supplement delivers immediately after; its user message should
// appear in the chat, then a second reply streams.
const supplementSeen = await page
	.waitForFunction(() => document.body.innerText.includes("补充一句话：请再说一遍"), { timeout: 180000 })
	.then(() => true)
	.catch(() => false);
check("supplement message delivered right after reply", supplementSeen);
// The second assistant reply must follow the supplement (count is
// race-free even when the reply is fast).
const secondReply = await page
	.waitForFunction(() => document.querySelectorAll('.msg[data-role="assistant"]').length >= 2, { timeout: 90000 })
	.then(() => true)
	.catch(() => false);
check("agent answered the supplement", secondReply);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
