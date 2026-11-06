import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

if (!CHROME_PATH) {
	console.log("SKIP context usage browser: Chrome unavailable");
	process.exit(0);
}
const repo = fileURLToPath(new URL("../", import.meta.url));
ensureBuild(repo, "context-usage-browser-test");
const port = Number(process.argv[2] || 23942);
const base = mkdtempSync(join(tmpdir(), "context-usage-browser-"));
const cwd = join(base, "project");
const agentDir = join(base, "agent");
mkdirSync(cwd);
mkdirSync(agentDir);
writeFileSync(join(cwd, "AGENTS.md"), "Project memory for context usage regression.");
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			"context-local": {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "offline-test",
				models: [
					{
						id: "context-test",
						name: "Context test",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repo,
	env: {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_CWD: cwd,
		PI_WEB_DATA_DIR: join(base, "data"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_SDK: "bundled",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (b) => (logs += b));
server.stderr.on("data", (b) => (logs += b));
let browser;
const evidence = process.env.PI_ISSUE_EVIDENCE_DIR;
try {
	let ready = false;
	for (let i = 0; i < 150; i++) {
		try {
			ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
		} catch {}
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(ready, `Server failed to start: ${logs}`);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
	const errors = [];
	const snapshots = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("websocket", (ws) =>
		ws.on("framereceived", (frame) => {
			try {
				const msg = JSON.parse(String(frame.payload));
				if (msg.type === "snapshot" || msg.type === "snapshot_delta") snapshots.push(msg);
			} catch {}
		}),
	);
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "zh"));
	await page.goto(`http://127.0.0.1:${port}/`);
	const badge = page.locator('button[data-bar-item="host:ctx"]').first();
	await badge.waitFor({ timeout: 30000 });
	await badge.click();
	const panel = page.locator(".context-usage-panel");
	await panel.waitFor();
	await page.waitForFunction(() => document.querySelector('.context-usage-panel li[data-category="systemPrompt"]'));
	assert((await panel.textContent()).includes("分类按会话内容估算"));
	const usage = snapshots
		.map((m) => m.state?.stats?.contextUsage)
		.filter((u) => u?.categories?.length)
		.at(-1);
	assert(usage, "Server did not supply categories");
	assert.equal(
		usage.categories.reduce((n, row) => n + row.tokens, 0),
		usage.tokens,
	);
	assert(
		usage.categories.some((row) => row.category === "memoryFiles"),
		"Project memory missing from real snapshot",
	);
	assert(await panel.evaluate((el) => el.parentElement === document.body));
	await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
	assert(await panel.isVisible(), "Scroll closed the panel");
	if (evidence) {
		mkdirSync(evidence, { recursive: true });
		await page.screenshot({ path: join(evidence, "context-dark.png") });
	}
	await page.keyboard.press("Escape");
	await panel.waitFor({ state: "detached" });
	await page.evaluate(() => localStorage.setItem("pi-web-ui:theme", "flow-light"));
	await page.reload();
	await badge.waitFor();
	await page.waitForFunction(
		() => document.documentElement.dataset.theme === "flow-light" && document.getElementById("theme-stylesheet")?.sheet,
	);
	await badge.click();
	await panel.waitFor();
	if (evidence) await page.screenshot({ path: join(evidence, "context-light.png") });
	await page.keyboard.press("Escape");
	await panel.waitFor({ state: "detached" });
	await page.setViewportSize({ width: 320, height: 740 });
	await badge.click();
	await panel.waitFor();
	const box = await panel.boundingBox();
	assert(box && box.x >= 0 && box.x + box.width <= 321 && box.y >= 0 && box.y + box.height <= 741, JSON.stringify(box));
	if (evidence) await page.screenshot({ path: join(evidence, "context-narrow.png") });
	await badge.click();
	await panel.waitFor({ state: "detached" });
	assert.deepEqual(errors, []);
	if (evidence) writeFileSync(join(evidence, "browser-evidence.json"), JSON.stringify({ usage, box, errors }, null, 2));
	console.log(
		"PASS actual server context categories, integer total, memory, estimate disclosure, Portal, Escape, scroll, repeat click and 320px placement",
	);
} finally {
	await browser?.close();
	const exited = new Promise((resolve) => server.once("exit", resolve));
	server.kill();
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
	await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
