import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const port = 8994;
const probe = createServer();
await new Promise((ok, fail) => {
	probe.once("error", fail);
	probe.listen(port, "127.0.0.1", ok);
});
await new Promise((ok) => probe.close(ok));
const root = await mkdtemp(join(tmpdir(), "pi-archives-ui-"));
const workspace = join(root, "workspace");
await mkdir(join(workspace, "folder/nested"), { recursive: true });
await mkdir(join(workspace, "output"));
await mkdir(join(root, "local-folder/sub"), { recursive: true });
await writeFile(join(workspace, "sample.txt"), "source contents");
await writeFile(join(workspace, "folder/nested/hello.txt"), "nested contents");
await writeFile(join(root, "local-folder/sub/upload.txt"), "uploaded contents");
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
		Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
		Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
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
	await row("sample.txt").waitFor({ timeout: 30000 });
	async function menu(name, action) {
		await row(name).click({ button: "right" });
		await page.getByRole("menuitem", { name: action, exact: true }).click();
		await page.locator("dialog.file-transfer-dialog").waitFor();
	}
	async function submit(action) {
		await page.locator("dialog").getByRole("button", { name: action, exact: true }).click();
		await page.locator("dialog.file-transfer-dialog").waitFor({ state: "detached", timeout: 15000 });
	}
	await row("sample.txt").click({ button: "right" });
	assert.equal(await page.getByRole("menuitem", { name: "解压", exact: true }).count(), 0);
	await page.keyboard.press("Escape");
	await menu("sample.txt", "压缩");
	await submit("压缩");
	assert((await readdir(workspace)).includes("sample.txt.tar.gz"));
	await menu("sample.txt.tar.gz", "解压");
	await page.locator("dialog input").fill(join(workspace, "output"));
	await submit("解压");
	assert.equal(await readFile(join(workspace, "output/sample.txt"), "utf8"), "source contents");
	await writeFile(join(workspace, "output/sample.txt"), "keep me");
	await menu("sample.txt.tar.gz", "解压");
	await page.locator("dialog input").fill(join(workspace, "output"));
	await submit("解压");
	assert.equal(await readFile(join(workspace, "output/sample.txt"), "utf8"), "keep me");
	await menu("sample.txt.tar.gz", "解压");
	await page.locator("dialog input").fill(join(workspace, "output"));
	await page.locator("dialog select").selectOption("overwrite");
	await submit("解压");
	assert.equal(await readFile(join(workspace, "output/sample.txt"), "utf8"), "source contents");
	await menu("sample.txt", "压缩并下载");
	const downloadEvent = page.waitForEvent("download");
	await submit("压缩并下载");
	const download = await downloadEvent;
	assert.equal(download.suggestedFilename(), "sample.txt.tar.gz");
	assert.equal(await download.failure(), null);
	await menu("sample.txt", "上传文件夹");
	await page.locator("dialog input[type=file]").setInputFiles(join(root, "local-folder"));
	await submit("上传文件夹");
	assert.equal(await readFile(join(workspace, "local-folder/sub/upload.txt"), "utf8"), "uploaded contents");
	await menu("folder", "压缩");
	await submit("压缩");
	assert((await readdir(workspace)).some((name) => /^folder-.*\.tar\.gz$/.test(name)));
	await page.evaluate(() => {
		Object.defineProperty(window, "showDirectoryPicker", {
			configurable: true,
			value: async () => ({
				kind: "directory",
				name: "picked-folder",
				async *values() {
					yield { kind: "directory", name: "empty", async *values() {} };
					yield { kind: "file", name: "blank.txt", getFile: async () => new File([], "blank.txt") };
				},
			}),
		});
	});
	await menu("sample.txt", "上传文件夹");
	await page.locator("dialog").getByRole("button", { name: "选择文件夹", exact: true }).click();
	await submit("上传文件夹");
	assert.deepEqual(await readdir(join(workspace, "picked-folder/empty")), []);
	assert.equal(await readFile(join(workspace, "picked-folder/blank.txt"), "utf8"), "");
	console.log(
		"PASS: file/folder compression, extraction skip/overwrite, temporary download, recursive upload, empty directories",
	);
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
