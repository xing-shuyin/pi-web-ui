import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const port = 8997;
const probe = createServer();
await new Promise((ok, fail) => {
	probe.once("error", fail);
	probe.listen(port, "127.0.0.1", ok);
});
await new Promise((ok) => probe.close(ok));
const root = await mkdtemp(join(tmpdir(), "pi-hidden-files-ui-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "visible.txt"), "visible");
await writeFile(join(workspace, ".secret.txt"), "hidden");
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repo,
	env: {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_DATA_DIR: join(root, "data"),
		PI_WEB_CWD: workspace,
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
server.stderr.on("data", (chunk) => {
	log = (log + chunk).slice(-8000);
});
let browser;
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
				ready = true;
				break;
			}
		} catch {}
		if (server.exitCode !== null) throw new Error(`Server exited: ${log}`);
		await sleep(200);
	}
	assert(ready, `Server did not start: ${log}`);
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "zh");
	});
	await page.goto(`http://127.0.0.1:${port}`);
	const row = (name) =>
		page
			.locator(".file-item")
			.filter({
				has: page.locator(".file-name-text, .file-dir-main .file-name", {
					hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
				}),
			})
			.first();
	const showBtn = page.getByRole("button", { name: "显示以 . 开头的隐藏文件" });
	const hideBtn = page.getByRole("button", { name: "隐藏以 . 开头的文件" });

	await row("visible.txt").waitFor({ timeout: 30000 });
	assert.equal(await row(".secret.txt").count(), 0, "默认应隐藏以 . 开头的条目");

	await showBtn.click();
	await row(".secret.txt").waitFor({ timeout: 10000 });
	assert.equal(await row("visible.txt").count(), 1, "打开开关不应影响普通条目");

	await hideBtn.click();
	await row(".secret.txt").waitFor({ state: "detached", timeout: 10000 });

	await showBtn.click();
	await row(".secret.txt").waitFor({ timeout: 10000 });
	await page.reload();
	await row(".secret.txt").waitFor({ timeout: 30000 });
	assert.equal(await hideBtn.count(), 1, "刷新后开关应仍是「已显示」态");

	console.log("PASS: hidden-file toggle (default hidden, toggle, persisted across reload)");
} catch (err) {
	console.error(err);
	process.exitCode = 1;
} finally {
	await browser?.close();
	if (server.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		const force = setTimeout(() => server.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(force);
	}
	await rm(root, { recursive: true, force: true });
}
