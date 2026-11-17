import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

/**
 * 插件自定义页（settings.pages / client mount）的挂载口径。
 *
 * 入口在 eef1f2973 里换过：旧版把每个 `ui.settings` 页塞进设置面板左侧一级导航
 * （`plugin-page:*` tab，与「插件」菜单重复），现在统一收进
 * 设置 → 插件 → 安装的插件 → 点行展开 → 「插件页」标签（`InstalledPluginsPanel` + `PluginPage`）。
 * 本用例盯的是真正的能力：按需挂载、切走卸载并调 cleanup、切回重新挂载、收起即卸载。
 */
const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-setpage-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });

let passed = 0;
const check = (name, cond, extra) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
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
		// 老清单里声明的 settings 页现在已经不占一级导航，但仍必须被接受（不报 manifest 错）
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
		// 设置入口可能被折叠进「更多功能与布局」溢出菜单
		if ((await btn.count()) === 0)
			await page
				.locator(".plugin-topbar-more > button")
				.first()
				.click()
				.catch(() => {});
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

	const pluginsTab = page.locator(".settings-tab", { hasText: /^插件|^Plugins/ }).first();
	await tap(page, pluginsTab);
	check(
		"插件页分成「安装的插件 / 插件市场」两个分页",
		(await until(async () => (await page.locator(".smart-tab-pill").count()) >= 2, 40, 250)) &&
			(await page.locator(".smart-tab-pill", { hasText: /安装的插件|Installed/ }).count()) > 0,
	);

	const row = page.locator(".ip-row", { hasText: "Set Page Test" }).first();
	check("安装列表里有这个插件", await until(async () => (await row.count()) > 0, 40, 250));
	const pluginBody = page.locator(".ip-item", { hasText: "Set Page Test" }).first();
	// 列表默认展开第一行；本插件是不是第一行取决于环境，所以按「是否已展开」决定点不点
	if (!((await pluginBody.getAttribute("class")) ?? "").includes("open")) await row.click();

	check(
		"展开后默认落在「概览」，插件页还没挂载（按需加载）",
		await until(
			async () =>
				(await pluginBody.locator(".ip-body").count()) > 0 && (await page.locator(".plugin-page-host").count()) === 0,
			40,
			250,
		),
	);

	await tap(page, pluginBody.locator('[data-ip-tab="page"]'));
	const mounted = await until(
		async () =>
			(await page
				.locator(".ip-page-host .plugin-page-host")
				.first()
				.textContent()
				.catch(() => "")) === "SET-PAGE-OK",
	);
	check("点「插件页」后插件自己的 mount() 渲染到画布", mounted);

	await tap(page, pluginBody.locator('[data-ip-tab="config"]'));
	check(
		"切到别的标签后插件画布从 DOM 里卸载",
		await until(async () => (await page.locator(".plugin-page-host").count()) === 0, 20, 150),
	);
	check(
		"切走时调用了插件 mount() 返回的 cleanup",
		await until(async () => (await page.evaluate(() => globalThis.__setPageCleanups || 0)) >= 1, 20, 150),
	);

	await tap(page, pluginBody.locator('[data-ip-tab="page"]'));
	check(
		"再点回来是重新挂载（不是一直留在 DOM 里）",
		await until(async () => (await page.evaluate(() => globalThis.__setPageMounts || 0)) >= 2, 40, 150),
	);

	// 收起：行若还展开着就点一下
	if (((await pluginBody.getAttribute("class")) ?? "").includes("open")) await row.click();
	check(
		"收起插件行后画布也卸掉（不留后台画布）",
		await until(async () => (await page.locator(".plugin-page-host").count()) === 0, 20, 150),
	);

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
	for (let i = 0; i < 6; i++) {
		try {
			rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			break;
		} catch {
			await sleep(300);
		}
	}
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
