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
const port = 8996;
const probe = createServer();
await new Promise((ok, fail) => {
	probe.once("error", fail);
	probe.listen(port, "127.0.0.1", ok);
});
await new Promise((ok) => probe.close(ok));
const root = await mkdtemp(join(tmpdir(), "pi-preview-toc-ui-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const filler = Array.from({ length: 30 }, (_, i) => `填充段落 ${i + 1}：把文档撑长，保证真的有得滚。`).join("\n\n");
await writeFile(
	join(workspace, "doc.md"),
	[
		"# 一级标题",
		"",
		filler,
		"",
		"## 二级标题",
		"",
		filler,
		"",
		"### 三级：中文与 123",
		"",
		filler,
		"",
		"## 重复",
		"",
		filler,
		"",
		"### 重复",
		"",
		filler,
		"",
	].join("\n"),
);
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

	const openDoc = async () => {
		const row = page
			.locator(".file-item.file")
			.filter({ has: page.locator(".file-name-text", { hasText: /^doc\.md$/ }) })
			.first();
		await row.waitFor({ timeout: 30000 });
		await row.locator(".file-name").click();
	};

	await openDoc();
	await page.locator(".fp-markdown").waitFor({ timeout: 15000 });

	const tocBtn = page.locator(".fp-attach.toc");
	await tocBtn.waitFor({ timeout: 10000 });
	assert.equal(await page.locator(".fp-toc").count(), 0, "默认不显示目录");

	await tocBtn.click();
	await page.locator(".fp-toc").waitFor({ timeout: 10000 });
	const links = page.locator(".fp-toc a");
	assert.equal(await links.count(), 5, "目录条目数应等于标题数（5）");
	assert.equal(await links.first().textContent(), "一级标题", "首条应为一级标题");

	const target = links.nth(1);
	await target.click();
	await page.waitForFunction(() => (document.querySelector(".fp-markdown")?.scrollTop ?? 0) > 100, null, {
		timeout: 8000,
	});
	await page.waitForFunction(
		() => {
			const all = [...document.querySelectorAll(".fp-toc a")];
			return all.length > 1 && all[1].classList.contains("on");
		},
		null,
		{ timeout: 8000 },
	);

	await tocBtn.click();
	await page.locator(".fp-toc").waitFor({ state: "detached", timeout: 10000 });
	await tocBtn.click();
	await page.locator(".fp-toc").waitFor({ timeout: 10000 });
	await page.reload();
	await openDoc();
	await page.locator(".fp-toc").waitFor({ timeout: 15000 });

	console.log("PASS: preview TOC (toggle / items / jump + highlight / persisted across reload)");
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
