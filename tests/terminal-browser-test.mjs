import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-ui-data-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;

const server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {}
	try {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	{
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(workdir, "subdir"), { recursive: true });
		await page.waitForSelector(".panel-right .file-item.dir", { timeout: 5000 });
		await sleep(300);
		const dirRow = page.locator(".file-item.dir", { hasText: "subdir" });
		check("folder row visible in file panel", (await dirRow.count()) === 1);
		await dirRow.hover();
		await dirRow.locator(".file-attach.ref").click();
		await sleep(400);
		const chip = page.locator(".attach-chip", { hasText: "subdir" });
		check("folder chip added to the input bar", (await chip.count()) === 1);
		check("folder chip shows the folder icon", (await chip.textContent())?.includes("📁"));
		await chip.locator(".attach-remove").click();
	}

	await page.click('.topbar-flow [role="tab"]:has-text("终端")');
	await page.waitForSelector(".terminal-view", { timeout: 5000 });
	check("terminal view renders", true);
	const initialShell = page.locator(".term-tab", { hasText: "终端 1" });
	if (await initialShell.count()) await initialShell.locator(".term-tab-close").click();
	await sleep(300);

	await page.click(".term-commands .panel-new");
	await page.fill("#cmd-name", "hello-test");
	await page.fill("#cmd-command", "echo BROWSER_PTY_OK");
	await page.fill("#cmd-cwd", "${pwd}");
	await page.click(".cmd-form-actions .btn.primary");
	await sleep(500);
	check("command saved into the list", (await page.textContent(".term-commands"))?.includes("hello-test"));

	const { existsSync, readFileSync } = await import("node:fs");
	check("commands.json on disk", existsSync(join(workdir, ".pi", "commands.json")));
	let onDisk = null;
	try {
		onDisk = JSON.parse(readFileSync(join(workdir, ".pi", "commands.json"), "utf8"));
	} catch {
		onDisk = null;
	}
	check("disk commands[0].cwd is ${pwd}", onDisk?.commands?.[0]?.cwd === "${pwd}");

	await page.click(".cmd-run");
	await page.waitForSelector(".term-tab", { timeout: 5000 });
	check("terminal tab appears", true);
	await sleep(2500);
	const termText = await page.textContent(".term-main");
	check("command ran in terminal", termText?.includes("BROWSER_PTY_OK"));
	check("banner shows command", termText?.includes("> echo BROWSER_PTY_OK"));
	const termTextarea = page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first();
	await termTextarea.click();
	await page.keyboard.type("echo SH1=$$");
	await page.keyboard.press("Enter");
	await sleep(800);
	const before = await page.textContent(".term-main");
	const sh1 = (before.match(/SH1=(\d+)/) ?? [])[1];
	check("first shell pid captured", !!sh1);

	await page.click(".cmd-run");
	await sleep(1500);
	check("same command reuses the running tab", (await page.locator(".term-tab").count()) === 1);
	const afterRun = await page.textContent(".term-main");
	check("terminal cleared for the re-run", !afterRun.includes("SH1="));
	await page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first().click();
	await page.keyboard.type("echo SH2=$$");
	await page.keyboard.press("Enter");
	await sleep(800);
	const after = await page.textContent(".term-main");
	const sh2 = (after.match(/SH2=(\d+)/) ?? [])[1];
	check("re-run spawns a fresh shell (old one interrupted)", !!sh1 && !!sh2 && sh1 !== sh2);

	await page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first().click();
	await page.keyboard.type("exit");
	await page.keyboard.press("Enter");
	await sleep(1200);
	check("tab marked exited", (await page.locator(".term-tab-exit").count()) === 1);
	await page.click(".cmd-run");
	await sleep(1500);
	check("exited tab reused (still one tab)", (await page.locator(".term-tab").count()) === 1);
	check("tab running again after re-run", (await page.locator(".term-tab-dot.run").count()) === 1);

	const textarea = page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first();
	await textarea.click();
	await page.keyboard.type("pwd");
	await page.keyboard.press("Enter");
	await sleep(1200);
	const termText2 = await page.textContent(".term-main");
	check("typing reaches the PTY", termText2?.includes(workdir));

	await page.click(".term-tabs-block .panel-new");
	await page.waitForSelector(".term-tab >> nth=1", { timeout: 5000 });
	await sleep(1500);
	check("second tab + shell prompt", true);

	await page.click('.topbar-flow [role="tab"]:has-text("对话")');
	await sleep(800);
	await page.click('.topbar-flow [role="tab"]:has-text("终端")');
	await sleep(800);
	check("terminals survive view switch", (await page.locator(".term-tab").count()) === 2);

	await page.locator(".term-tab-close").first().click();
	await sleep(800);
	check("tab close removes one tab", (await page.locator(".term-tab").count()) === 1);

	await page.click(".newchat");
	await sleep(1800);
	await page.click('.topbar-flow [role="tab"]:has-text("对话")');
	await page.waitForSelector(".panel-convs .session-item", { timeout: 5000 });
	check("conversation with terminal remains listed", (await page.locator(".panel-convs .session-item").count()) >= 1);
	await page.locator(".panel-convs .session-item").first().click();
	await sleep(900);
	await page.click('.topbar-flow [role="tab"]:has-text("终端")');
	await sleep(900);
	check("switching back restores conversation terminal", (await page.locator(".term-tab").count()) === 1);

	check("no console errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) {
		console.log("    console errors:", consoleErrors.slice(0, 5));
	}

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exit(1);
});
