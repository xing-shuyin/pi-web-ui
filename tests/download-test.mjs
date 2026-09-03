/**
 * Download-button regression test.
 *
 * The right-panel download button fetches the file as a blob (fetch →
 * objectURL) instead of a plain anchor navigation, so Chrome Safe Browsing
 * can't block "no-reputation" file types and server errors surface as
 * readable toasts. This test clicks the real button and verifies the
 * browser download completes with the right name and content.
 *
 * Runs on a dedicated port (8899) to avoid stray processes.
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

// Workspace with a "no-reputation" binary-ish file with a Chinese name —
// the worst case for Chrome's Safe Browsing block.
const WS = mkdtempSync(join(tmpdir(), "pi-dl-test-"));
const CONTENT = "zipcontent-测试内容";
writeFileSync(join(WS, "报告.zip"), CONTENT);
writeFileSync(join(WS, "notes.txt"), "hello blob download\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch (err) {
	console.error("build failed:", err.message);
	process.exit(1);
}
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
const page = await browser.newPage({ acceptDownloads: true });
// The picker path (showSaveFilePicker) opens a native dialog headless
// Chromium can't drive — disable it so the test exercises the blob-anchor
// fallback, which is what the download event asserts.
await page.addInitScript(() => {
	Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
});
await page.goto(URL);
await page.waitForSelector(".panel-right .file-item.file", { timeout: 15000 });

const row = page.locator(".panel-right .file-item.file", {
	hasText: "报告.zip",
});
await row.hover();
await sleep(300);
const dlPromise = page.waitForEvent("download", { timeout: 8000 });
await row.locator("button.file-attach.download").click();
const dl = await dlPromise.catch(() => null);

check("click fires a browser download", dl !== null, dl?.suggestedFilename());
if (dl) {
	const failure = await dl.failure();
	check("download completed", failure === null, `failure=${failure}`);
	check("downloaded filename preserved", (dl.suggestedFilename() ?? "").includes("报告.zip"), dl.suggestedFilename());
	const saved = await dl.path();
	if (saved) {
		const fs = await import("node:fs");
		const content = fs.readFileSync(saved, "utf8");
		check("content intact", content === CONTENT, content);
	}
}

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
