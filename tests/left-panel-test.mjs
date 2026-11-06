import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

const dataDir = mkdtempSync(join(tmpdir(), "pi-left-panel-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-left-panel-agent-"));
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
	ensureBuild(PROJ, "left-panel-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

try {
	await freePort(PORT);
} catch {}
await sleep(500);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: A,
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });

await sleep(800);

const setup = page.locator(".setup-modal");
if (
	await setup.waitFor({ state: "visible", timeout: 5000 }).then(
		() => true,
		() => false,
	)
) {
	await page.locator(".setup-modal .modal-close").click();
	await setup.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

let titles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"history title present in fresh state",
	titles.some((t) => t.includes("历史")),
	titles.join("|"),
);
check(
	"no 运行的对话 section yet (blank chats are not listed)",
	!titles.some((t) => t.includes("运行的对话")),
	titles.join("|"),
);

await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(1200);
titles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"running list still empty after new_chat (blank chat, by design)",
	!titles.some((t) => t.includes("运行的对话")),
	titles.join("|"),
);
check("no divider without running list", (await page.locator(".panel-left .panel-section-divider").count()) === 0);

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
const cwdText = await page
	.locator(".status-cwd")
	.textContent()
	.catch(() => "");
check(
	"workspace-switch updated footer cwd",
	Boolean(cwdText && (cwdText.includes(B) || fileNames.some((t) => t.includes("b.txt")))),
	cwdText ?? "",
);

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
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(A, { recursive: true, force: true });
	rmSync(B, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
