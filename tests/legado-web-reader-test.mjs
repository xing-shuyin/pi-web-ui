/**
 * legado-web 阅读页「章末导航」E2E（零 token、自包含）。
 *
 * 背景（用户反馈）：「阅读 tab 的末尾没有下一章」——正文读到页面底部没有任何翻章入口，
 * 想把这一章看完接着读只能滚回顶部。现在正文末尾补了一条导航（上一章 / 目录 / 下一章），
 * 本测试在真浏览器里钉住它的行为：
 *   1) 导航条长在**正文下方**（不是顶栏那条），第一章「上一章」禁用
 *   2) 读到底点章末「下一章」→ 正文换成下一章 + 页面回到顶部
 *   3) 最后一章「下一章」禁用 + 写明「已是最后一章」（顶栏同名按钮同样置灰）
 *   4) 章末「上一章」能回退；章末「目录」展开目录并滚回顶部
 *
 * 做法与 legado-web-explore-test 同款：起真 pi-web-ui 服务（临时数据目录 + 装好的插件）
 * + 一个假书源站（3 章正文），种好 sources.json / shelf.json，浏览器直接打开内嵌阅读页。
 *
 * 没有 Chrome 时自动 SKIP。运行：先 npm run build:server 与插件前端构建，再
 * node tests/legado-web-reader-test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8971;
const SITE = 8972;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_URL = `http://127.0.0.1:${SITE}`;
const BOOK_URL = `${SITE_URL}/book/1`;
const CHAPTERS = [1, 2, 3].map((n) => ({ name: `第 ${n} 章 测试章`, url: `${SITE_URL}/ch${n}` }));
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-reader-"));
let proc = null;
let site = null;
let sock = null;
let browser = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

const source = {
	bookSourceUrl: SITE_URL,
	bookSourceName: "本地阅读源",
	bookSourceType: 0,
	enabled: true,
	ruleContent: { content: "#content" },
};

/** 章节正文：够长（撑高页面，才能验证「读到底直接翻章」）+ 每章一个可断言的标记。 */
function chapterHtml(n) {
	const paras = [
		`第${n}章正文开始`,
		...Array.from({ length: 40 }, (_, i) => `第${n}章的正文段落 ${i + 1}：这是一段把页面撑高的测试文字。`.repeat(3)),
	].join("<br>");
	return `<!doctype html><html><head><meta charset="utf-8"><title>第 ${n} 章</title></head><body><div id="content">${paras}</div></body></html>`;
}

function startSite() {
	const server = http.createServer((req, res) => {
		const u = new URL(req.url ?? "/", SITE_URL);
		const m = /^\/ch(\d+)$/.exec(u.pathname);
		if (m) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(chapterHtml(Number(m[1])));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<!doctype html><html><body>home</body></html>");
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
	if (!existsSync(join(pluginDir, "client", "app", "index.html"))) throw new Error("缺 client/app —— 先构建插件前端");

	// 种数据：书源 + 书架（含 3 章目录），进度 0（= 第 1 章）
	mkdirSync(join(dataDir, "legado-web"), { recursive: true });
	writeFileSync(join(dataDir, "legado-web", "sources.json"), JSON.stringify([source]));
	writeFileSync(
		join(dataDir, "legado-web", "shelf.json"),
		JSON.stringify([
			{
				bookUrl: BOOK_URL,
				bookSourceUrl: SITE_URL,
				name: "测试书",
				author: "测试作者",
				tocUrl: BOOK_URL,
				chapters: CHAPTERS,
			},
		]),
	);
	writeFileSync(join(dataDir, "legado-web", "progress.json"), JSON.stringify({}));

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

	// attach 一次：插件在客户端 attach 时激活（/plugins-api/legado-web/* 路由要它）
	sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws 超时")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "reader-test" })));
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
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
		await page.goto(`${BASE}/plugins/legado-web/client/app/index.html`, { waitUntil: "load" });

		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const state = async () => ({
			prev2: await page.locator("#r-prev2").isDisabled(),
			next2: await page.locator("#r-next2").isDisabled(),
			prevTop: await page.locator("#r-prev").isDisabled(),
			nextTop: await page.locator("#r-next").isDisabled(),
			note: (await page.locator("#r-nav-meta").innerText()).trim(),
			scrollY: await page.evaluate(() => window.scrollY),
		});

		// -- 0. 从书架「继续读」进阅读页（等价于用户点开一本书） ------------------
		await page.waitForSelector("[data-read]", { timeout: 20_000 });
		await page.click("[data-read]");
		await page.waitForFunction(() => document.querySelector("#r-body")?.textContent?.includes("第1章正文开始"), null, {
			timeout: 20_000,
		});
		console.log("✓ 阅读页打开（第 1 章正文已渲染）");

		// 章末导航必须在正文下方 + 落在页面下半部分（说明它长在「末尾」）
		const navAtEnd = await page.evaluate(() => {
			const body = document.querySelector("#r-body")?.getBoundingClientRect();
			const nav = document.querySelector("#r-nav")?.getBoundingClientRect();
			if (!body || !nav) return null;
			return nav.top >= body.bottom - 1 && nav.top > window.innerHeight * 0.5;
		});
		if (navAtEnd !== true) fail(`章末导航不在正文末尾（#r-nav 位置不对：${navAtEnd}）`);
		else console.log("✓ 章末导航条位于正文下方（页面尾部，不是顶栏那条）");

		// -- 1. 第一章：上一章置灰、下一章可点 ------------------------------------
		let s = await state();
		if (!s.prev2 || !s.prevTop) fail(`第一章「上一章」应禁用：章末=${s.prev2} 顶栏=${s.prevTop}`);
		else if (s.next2) fail("第一章「下一章」不应禁用");
		else if (!s.note.includes("第 1/3 章") || s.note.includes("已是最后一章")) fail(`第一章章末说明不对：${s.note}`);
		else console.log(`✓ 第一章：上一章置灰、下一章可点（${s.note}）`);

		// -- 2. 读到底点章末「下一章」：换章 + 回到顶部 ------------------------------
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await sleep(150);
		if ((await page.evaluate(() => window.scrollY)) < 200) fail("正文没撑高页面，滚动断言无意义");
		await page.click("#r-next2");
		await page.waitForFunction(() => document.querySelector("#r-body")?.textContent?.includes("第2章正文开始"), null, {
			timeout: 20_000,
		});
		s = await state();
		if (s.scrollY !== 0) fail(`换章后没有回到页面顶部：scrollY=${s.scrollY}`);
		else if (!s.note.includes("第 2/3 章") || s.prev2 || s.next2) fail(`第 2 章状态不对：${JSON.stringify(s)}`);
		else console.log("✓ 章末「下一章」：正文换成第 2 章并把页面滚回顶部");

		// -- 3. 最后一章：下一章置灰 + 明说「已是最后一章」（顶栏同样置灰） ---------
		await page.click("#r-next2");
		await page.waitForFunction(() => document.querySelector("#r-body")?.textContent?.includes("第3章正文开始"), null, {
			timeout: 20_000,
		});
		s = await state();
		if (!s.next2 || !s.nextTop) fail(`最后一章「下一章」应禁用（章末=${s.next2} 顶栏=${s.nextTop}）`);
		else if (!s.note.includes("已是最后一章")) fail(`最后一章说明缺「已是最后一章」：${s.note}`);
		else console.log(`✓ 最后一章：下一章置灰并写明「已是最后一章」（${s.note}）`);

		// -- 4. 章末「上一章」回退 --------------------------------------------------
		await page.click("#r-prev2");
		await page.waitForFunction(() => document.querySelector("#r-body")?.textContent?.includes("第2章正文开始"), null, {
			timeout: 20_000,
		});
		s = await state();
		if (s.next2 || !s.note.includes("第 2/3 章")) fail(`章末「上一章」回退不对：${JSON.stringify(s)}`);
		else console.log("✓ 章末「上一章」回退到第 2 章，下一章恢复可点");

		// -- 5. 章末「目录」：展开目录 + 回到顶部 ------------------------------------
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await page.click("#r-toc2");
		const tocVisible = await page.locator("#r-toclist").isVisible();
		let topY = await page.evaluate(() => window.scrollY);
		for (let i = 0; i < 20 && topY > 5; i++) {
			await sleep(100); // 平滑滚动要几百毫秒：轮询到位置，别用固定 sleep 赌
			topY = await page.evaluate(() => window.scrollY);
		}
		if (!tocVisible) fail("章末「目录」没有展开目录");
		else if (topY > 5) fail(`章末「目录」没有滚回顶部：scrollY=${topY}`);
		else console.log("✓ 章末「目录」展开目录并滚回顶部");

		if (errors.length) fail(`页面报错：${errors.slice(0, 2).join(" | ")}`);
		if (!process.exitCode) console.log("ALL LEGADO READER TESTS PASSED");
	}
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	try {
		sock?.close();
	} catch {
		/* ignore */
	}
	await browser?.close().catch(() => {});
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
