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
 * 插件自定义页（`ui.settings` / `settings.pages`）的挂载口径。
 *
 * 入口在 eef1f2973 里换过：旧版把每个声明页塞进设置面板左侧一级导航（`plugin-page:*`），
 * 现在统一收进「设置 → 插件 → 安装的插件 → 点行展开 → 一个声明页一个标签」。
 * 本用例盯的是能力本身，一条都不能松：
 *   1. 声明几页就有几个标签，`hidden:true` 的不进导航；
 *   2. 点标签才挂载（懒加载），`ctx.page` 拿到的是声明里的 itemId；
 *   3. 切走即卸载并调 cleanup，点回来重新挂载；
 *   4. 没声明页的插件仍给一个通用「插件页」标签（ctx.page === undefined）；
 *   5. 界面布局里勾掉那一页，标签真的消失（这条正是「布局开关不能空转」的守卫）。
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

/** 声明了两页（一页显式 hidden）的插件 */
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
const CLIENT = `export default {
	mount(container, ctx) {
		globalThis.__setPageMounts = (globalThis.__setPageMounts || 0) + 1;
		globalThis.__setPageLast = ctx?.page ?? "generic";
		container.textContent = "PAGE:" + (ctx?.page ?? "generic");
		return () => {
			globalThis.__setPageCleanups = (globalThis.__setPageCleanups || 0) + 1;
			container.textContent = "";
		};
	},
};
`;
writeFileSync(join(pdir, "client", "entry.mjs"), CLIENT);

/** 只提供 client、不声明任何页的插件：应拿到通用「插件页」标签 */
const plainDir = join(DATA_DIR, "plugins", "plainpage");
mkdirSync(join(plainDir, "client"), { recursive: true });
writeFileSync(
	join(plainDir, "manifest.json"),
	JSON.stringify({ name: "Plain Page Test", version: "0.0.1", view: false, permissions: ["ui"] }),
);
writeFileSync(join(plainDir, "client", "entry.mjs"), CLIENT);

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
	server.stderr.on("data", (d) => process.stderr.write(`[srv!] ${d}`));

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

	const row = page.locator(".ip-row", { hasText: "Set Page Test" }).first();
	check("安装列表里有这个插件", await until(async () => (await row.count()) > 0, 40, 250));
	const item = page.locator(".ip-item", { hasText: "Set Page Test" }).first();
	const openItem = async (target) => {
		if (!((await target.getAttribute("class")) ?? "").includes("open")) {
			await target.locator(".ip-row").first().click();
			await sleep(300);
		}
	};
	await openItem(item);

	const tabLabels = () =>
		item.locator("[data-ip-tab]").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
	const tabsNow = await tabLabels();
	check("声明的插件页变成了详情里的标签", tabsNow.includes("Set Test"), tabsNow);
	check("hidden: true 的页不进导航", !tabsNow.includes("Hidden Page"), tabsNow);
	check("展开默认落「概览」，插件页还没挂载（按需加载）", (await page.locator(".plugin-page-host").count()) === 0);

	const pageTab = () => item.locator("[data-ip-tab]").filter({ hasText: "Set Test" }).first();
	await tap(page, pageTab());
	const mounted = await until(
		async () =>
			(await page
				.locator(".ip-page-host .plugin-page-host")
				.first()
				.textContent()
				.catch(() => "")) === "PAGE:conf",
	);
	check(
		"点该页才挂载，且 ctx.page 透传声明里的 itemId",
		mounted,
		await page.evaluate(() => globalThis.__setPageLast ?? null),
	);

	await tap(page, item.locator('[data-ip-tab="overview"]'));
	check(
		"切到别的标签后插件画布从 DOM 里卸载",
		await until(async () => (await page.locator(".plugin-page-host").count()) === 0, 20, 150),
	);
	check(
		"切走时调用了插件 mount() 返回的 cleanup",
		await until(async () => (await page.evaluate(() => globalThis.__setPageCleanups || 0)) >= 1, 20, 150),
	);

	await tap(page, pageTab());
	check(
		"再点回来是重新挂载（不是一直留在 DOM 里）",
		await until(async () => (await page.evaluate(() => globalThis.__setPageMounts || 0)) >= 2, 40, 150),
	);

	// 没声明页的插件：退回一个通用「插件页」标签，ctx.page 为 undefined
	const plainItem = page.locator(".ip-item", { hasText: "Plain Page Test" }).first();
	const plainRow = page.locator(".ip-row", { hasText: "Plain Page Test" }).first();
	await tap(page, plainRow);
	await sleep(300);
	const plainTabs = await plainItem
		.locator("[data-ip-tab]")
		.evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
	check("没声明页的插件拿到通用「插件页」标签", plainTabs.includes("插件页"), plainTabs);
	await tap(page, plainItem.locator('[data-ip-tab="page"]'));
	check(
		"通用页挂载时 ctx.page 为空（插件自己决定渲染）",
		await until(
			async () =>
				(await page
					.locator(".ip-page-host .plugin-page-host")
					.first()
					.textContent()
					.catch(() => "")) === "PAGE:generic",
		),
	);

	// 界面布局：勾掉这一页 → 标签真的消失（开关不再是摆设）
	await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
	const slotRow = page.locator(".set-ui-slot", { hasText: /设置页|Settings pages/ }).first();
	const layoutRow = slotRow.locator(".set-row", { hasText: "Set Test" }).first();
	const listed = await until(async () => (await layoutRow.count()) > 0, 30, 200);
	check("界面布局里列出了这个插件页（可隐藏/排序）", listed);
	if (listed) {
		await tap(page, layoutRow.locator('input[type="checkbox"]').first());
		await sleep(600);
	}
	await tap(page, pluginsTab);
	await sleep(400);
	const backItem = page.locator(".ip-item", { hasText: "Set Page Test" }).first();
	await openItem(backItem);
	const tabsAfterHide = await backItem
		.locator("[data-ip-tab]")
		.evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
	check("布局里勾掉后该页标签消失（布局开关真的生效）", !tabsAfterHide.includes("Set Test"), tabsAfterHide);
	check("被勾掉后不再留后台画布", (await page.locator(".plugin-page-host").count()) === 0);

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
