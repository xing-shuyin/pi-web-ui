import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(process.env.PI_TEST_TMP_DIR || tmpdir(), "pi-ocr-install-ui-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "sample.txt"), "OCR installation test");
const port = 8942;
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repo,
	env: {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_DATA_DIR: join(root, "data"),
		PI_WEB_CWD: workspace,
		PI_WEB_TOKEN: "",
		PI_WEB_LOCALE: "zh",
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "";
server.stderr.on("data", (chunk) => {
	serverErrors = (serverErrors + chunk).slice(-5000);
});
let browser;
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.exitCode !== null) throw new Error(`Server exited: ${serverErrors}`);
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await sleep(200);
	}
	assert.ok(ready, serverErrors);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		window.installJobs = 0;
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...args) {
				super(...args);
				window.testSocket = this;
			}
			send(data) {
				try {
					if (JSON.parse(data).type === "plugin_job") window.installJobs++;
				} catch {}
				return super.send(data);
			}
		};
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".file-item").first().waitFor({ timeout: 30_000 });
	await page.waitForFunction(() => !!window.__piWebUiHost?.openImagePreview);
	assert.equal(await page.evaluate(() => window.__piWebUiHost.imageOcrProviders.list().length), 0);
	await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 600;
		canvas.height = 300;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, 600, 300);
		ctx.fillStyle = "black";
		ctx.font = "40px Arial";
		ctx.fillText("Install Image OCR", 30, 150);
		window.__piWebUiHost.openImagePreview({ src: canvas.toDataURL(), alt: "OCR install test.png" });
	});
	const ocr = page.getByRole("button", { name: "识别文字", exact: true });
	await ocr.click();
	await page.waitForFunction(
		() =>
			document.querySelector(".perm-modal-backdrop") ||
			window.__piWebUiHost.imageOcrProviders.list().length ||
			document.querySelector(".img-lightbox-ocr [role=alert]"),
		undefined,
		{ timeout: 30_000 },
	);
	if (await page.locator(".perm-modal-backdrop").count()) {
		const onTop = await page.locator(".perm-dialog-card").evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
		});
		assert.equal(onTop, true, "Installation approval was covered by the image preview");
		await page.locator(".perm-modal-backdrop").getByRole("button", { name: "仅本次允许", exact: true }).click();
	}
	await page.waitForFunction(() => window.__piWebUiHost.imageOcrProviders.list().length === 1, undefined, {
		timeout: 30_000,
	});
	assert.equal(await page.evaluate(() => window.installJobs), 1);
	const manifest = JSON.parse(await readFile(join(root, "data/plugins/image-ocr/manifest.json"), "utf8"));
	assert.equal(manifest.id, "image-ocr");
	assert.equal(await page.locator(".img-lightbox").count(), 1, "Preview closed during installation");
	await page.evaluate(() =>
		window.testSocket.send(JSON.stringify({ type: "set_settings", disabledPlugins: ["image-ocr"] })),
	);
	await page.waitForFunction(() => window.__piWebUiHost.imageOcrProviders.list().length === 0);
	await ocr.click();
	await page.waitForFunction(() => window.__piWebUiHost.imageOcrProviders.list().length === 1);
	assert.equal(
		await page.evaluate(() => window.installJobs),
		1,
		"Enabling the installed plugin started another install",
	);
	console.log(
		"Real app OCR install passed: visible missing-plugin button, approval above preview, bundled install, same preview, disabled-plugin enable without reinstall.",
	);
} finally {
	await browser?.close();
	if (server.exitCode === null) {
		server.kill("SIGTERM");
		await Promise.race([new Promise((ok) => server.once("exit", ok)), sleep(5000)]);
	}
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
