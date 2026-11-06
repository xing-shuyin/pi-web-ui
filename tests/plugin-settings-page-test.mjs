import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-setpage-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });

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

const pdir = join(DATA_DIR, "plugins", "setpage");
mkdirSync(join(pdir, "client"), { recursive: true });
writeFileSync(
	join(pdir, "manifest.json"),
	JSON.stringify({
		name: "Set Page Test",
		version: "0.0.1",
		view: false,
		permissions: ["ui"],
		ui: {
			settings: [
				{ id: "conf", label: "Set Test", labelEn: "Set Test", icon: "🧪", kind: "page" },
				{ id: "hidden-page", label: "Hidden Page", labelEn: "Hidden Page", hidden: true },
			],
		},
	}),
);
writeFileSync(
	join(pdir, "client", "entry.mjs"),
	`export default {
	mount(container) {
		globalThis.__setPageMounts = (globalThis.__setPageMounts || 0) + 1;
		container.dataset.mounts = String(globalThis.__setPageMounts);
		container.textContent = "SET-PAGE-OK";
		return () => {
			globalThis.__setPageCleanups = (globalThis.__setPageCleanups || 0) + 1;
			container.textContent = "";
		};
	},
};
`,
);

let server;
let browser;

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

function railTab(page, text) {
	return page.locator(".settings-tab", { hasText: text }).first();
}

async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openSettings(page) {
	const btn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) > 0) return true;
		await tap(page, btn).catch(() => {});
		for (let i = 0; i < 15; i++) {
			if ((await page.locator(".settings-modal").count()) > 0) return true;
			await sleep(200);
		}
		await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 }).catch(() => {});
	}
	return false;
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

async function settle(page, quietMs = 2500) {
	let last = Date.now();
	const onNav = (f) => {
		if (f === page.mainFrame()) last = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		for (let i = 0; i < 80; i++) {
			if (Date.now() - last >= quietMs) break;
			await sleep(250);
		}
	} finally {
		page.off("framenavigated", onNav);
	}
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WORK, PI_WEB_DATA_DIR: DATA_DIR },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);

	check("设置面板打开", await openSettings(page));
	await page.waitForSelector(".settings-tab", { timeout: 10000 });

	const appeared = await until(async () => (await railTab(page, "Set Test").count()) > 0, 40, 250);
	check("manifest 的 settings.pages 条目出现在设置面板导航里", appeared);
	check("hidden: true 的插件页默认不在导航里", (await railTab(page, "Hidden Page").count()) === 0);

	await tap(page, railTab(page, "Set Test"));
	const mounted = await until(
		async () =>
			(await page
				.locator(".plugin-page-host")
				.first()
				.textContent()
				.catch(() => "")) === "SET-PAGE-OK",
	);
	check("点开后插件自己的 mount() 渲染到页面画布", mounted);

	await tap(page, page.locator(".settings-tab", { hasText: /系统提示词|System prompt/ }).first());
	const left = await until(async () => (await page.locator(".plugin-page-host").count()) === 0, 20, 150);
	check("切走后插件页从 DOM 里卸载", left);
	const cleanups = await page.evaluate(() => globalThis.__setPageCleanups || 0);
	check("切走时调用了插件 mount() 返回的 cleanup", cleanups >= 1);

	await tap(page, railTab(page, "Set Test"));
	const remounted = await until(async () => (await page.evaluate(() => globalThis.__setPageMounts || 0)) >= 2, 40, 150);
	check("再点回来是重新挂载（不是一直留在 DOM 里）", remounted);

	await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
	const slotRow = page.locator(".set-ui-slot", { hasText: /设置页|Settings pages/ }).first();
	const pageRow = slotRow.locator(".set-row", { hasText: "Set Test" }).first();
	const listed = await until(async () => (await pageRow.count()) > 0, 30, 200);
	check("界面布局页列出了这个插件页（可隐藏/排序）", listed);
	if (listed) {
		await tap(page, pageRow.locator('input[type="checkbox"]').first());
		await until(async () => (await railTab(page, "Set Test").count()) === 0, 20, 200);
	}
	check("取消勾选后导航项消失", (await railTab(page, "Set Test").count()) === 0);
	const activeLabel =
		(await page
			.locator(".settings-tab.active")
			.first()
			.textContent()
			.catch(() => "")) ?? "";
	check("当前分区回落到默认页（不留空白正文）", !activeLabel.includes("Set Test") && activeLabel.trim().length > 0);
	check("回落后不再挂着插件画布", (await page.locator(".plugin-page-host").count()) === 0);

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
	console.log(`\n${passed} checks passed`);
}

try {
	await main();
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {}
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {
			try {
				server.kill("SIGKILL");
			} catch {}
		}
	}
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
