/**
 * 发现页 E2E（零 token）：**收藏书源** + **直接搜这个源** + 分类浏览。
 *
 * 起一个假书源站（JSON 搜索接口 + 发现分类），种一个可用的书源，然后：
 *   1. 发现页「☆ 收藏」→ 按钮变「⭐ 已收藏」、下拉出现「⭐ 常用（收藏）」分组、出现「⭐ 常用」一键切换行、prefs.json 落盘；
 *   2. 在发现页搜索框输入关键词 → 列表出现搜索结果（书名）、标题写「🔍 搜索「x」」；
 *   3. 点分类 → 分类结果照常渲染（搜索与分类共用一个列表容器，不能互相串）。
 *
 * 没有 Chrome 时自动 SKIP。运行：先 build，再 node tests/legado-web-explore-test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8998;
const SITE = 8999;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_URL = `http://127.0.0.1:${SITE}`;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-explore-"));
let proc = null;
let site = null;
let sock = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

const source = {
	bookSourceUrl: SITE_URL,
	bookSourceName: "本地发现源",
	bookSourceType: 0,
	enabled: true,
	searchUrl: "/search?key={{key}}",
	// 发现分类：legado 的 exploreUrl 是「规则串」（JSON 数组 / 「分类::url」/ @js:），不是页面地址
	exploreUrl: '[{"title":"玄幻","url":"/explore?kind=1"}]',
	ruleSearch: { bookList: "$.data.list", name: "$.name", author: "$.author", bookUrl: "$.url" },
	ruleExplore: { bookList: "$.data.list", name: "$.name", author: "$.author", bookUrl: "$.url" },
	ruleContent: { content: "#content" },
};

function startSite() {
	const server = http.createServer((req, res) => {
		const u = new URL(req.url ?? "/", SITE_URL);
		if (u.pathname === "/search" || u.pathname === "/explore") {
			const key = u.searchParams.get("key") ?? "玄幻";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					data: { list: [{ name: `${key}测试书`, author: "某人", url: "/book/1" }] },
				}),
			);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><body>home</body></html>");
	});
	return new Promise((resolve) => server.listen(SITE, "127.0.0.1", () => resolve(server)));
}

try {
	site = await startSite();
	const pluginDir = join(dataDir, "plugins", "legado-web");
	cpSync(join(import.meta.dirname, "..", "plugins", "legado-web"), pluginDir, {
		recursive: true,
		filter: (s) => !/(^|[\\/])(node_modules|storage)([\\/]|$)/.test(s),
	});
	if (!existsSync(join(pluginDir, "client", "app", "index.html"))) throw new Error("缺 client/app —— 先 build");
	mkdirSync(join(dataDir, "legado-web"), { recursive: true });
	// 书源：exploreUrl 是「JSON 分类数组」形态（parseExploreKinds 直接认）
	writeFileSync(join(dataDir, "legado-web", "sources.json"), JSON.stringify([source]));

	freePort(PORT);
	proc = spawn(realpathSync(process.execPath), [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: process.cwd() },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	let up = false;
	for (let i = 0; i < 60; i++) {
		if (await portUp(PORT)) {
			up = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!up) throw new Error("服务未就绪");

	sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws 超时")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "explore-test" })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "plugins") {
				clearTimeout(timer);
				resolve();
			}
		});
		sock.on("error", reject);
	});

	if (!CHROME_PATH) {
		console.log("⚠ 没找到 Chrome（PI_WEB_CHROME 可覆盖）——跳过浏览器部分 SKIP");
	} else {
		const { chromium } = await import("playwright-core");
		const browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
		await page.goto(`${BASE}/plugins/legado-web/client/app/index.html`, { waitUntil: "load" });
		await page.waitForTimeout(2500);
		await page.click('nav button[data-tab="explore"]');
		await page.waitForTimeout(800);

		// 1) 收藏书源
		if (!(await page.textContent("#ex-pin")).includes("☆ 收藏")) fail("发现页没找到「☆ 收藏」按钮");
		await page.click("#ex-pin");
		await page.waitForTimeout(400);
		if (!(await page.textContent("#ex-pin")).includes("⭐ 已收藏")) fail("点收藏后按钮没变「⭐ 已收藏」");
		const groups = await page.locator("#ex-source optgroup").allTextContents();
		if (!groups.some((g) => g.includes("本地发现源"))) fail(`收藏的源没进下拉分组：${JSON.stringify(groups)}`);
		if (!(await page.locator("#tab-explore").textContent()).includes("⭐ 常用")) fail("没出现「⭐ 常用」快捷行");
		const prefs = existsSync(join(dataDir, "legado-web", "prefs.json"))
			? JSON.parse(readFileSync(join(dataDir, "legado-web", "prefs.json"), "utf8"))
			: null;
		if (!prefs?.pinned?.includes(SITE_URL)) fail(`收藏没落 prefs.json：${JSON.stringify(prefs)}`);
		if (!process.exitCode)
			console.log("✓ 发现页收藏书源：按钮状态 / 下拉「⭐ 常用（收藏）」分组 / 常用快捷行 / prefs.json");

		// 2) 发现页直接搜这个源
		await page.fill("#ex-search", "剑");
		await page.click("#ex-search-go");
		await page.waitForTimeout(1200);
		const listText = (await page.textContent("#ex-list")) ?? "";
		if (!listText.includes("🔍 搜索")) fail(`发现页搜索没渲染标题：${listText.slice(0, 120)}`);
		if (!listText.includes("剑测试书")) fail(`发现页搜索没渲染结果：${listText.slice(0, 160)}`);
		if (!(await page.textContent("#status")).includes("搜索「剑」")) fail("状态栏没提示搜索");
		if (!process.exitCode) console.log("✓ 发现页直接搜这个源（结果与标题都进同一个列表容器）");

		// 3) 分类浏览仍正常（两种模式共用一个容器）
		const kinds = await page.locator("#ex-kinds button[data-kind]").count();
		if (kinds) {
			await page.locator("#ex-kinds button[data-kind]").first().click();
			await page.waitForTimeout(1200);
			const kindText = (await page.textContent("#ex-list")) ?? "";
			if (kindText.includes("🔍 搜索")) fail("点分类后还停在搜索结果上（模式没切回来）");
			if (!kindText.includes("测试书")) fail(`分类结果没渲染：${kindText.slice(0, 140)}`);
			if (!process.exitCode) console.log("✓ 分类浏览与搜索共用列表容器、互不串味");
		} else {
			console.log("· 该源没解析出分类（跳过分类断言）");
		}

		if (errors.length) fail(`页面报错：${errors.slice(0, 2).join(" | ")}`);
		await browser.close();
	}
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	try {
		sock?.close();
	} catch {
		/* ignore */
	}
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {
			/* ignore */
		}
	}
	site?.close();
	await new Promise((r) => setTimeout(r, 600));
	freePort(PORT);
	freePort(SITE);
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
