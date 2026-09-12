/**
 * 存储 E2E（零 token）：**数据只落数据目录文件，不写浏览器 localStorage**。
 *
 * 背景：书源列表动辄几 MB（用户实测 4.5MB）+ 书架每本书带整份章节表，曾把浏览器
 * 5MB 配额顶满（页面报 QuotaExceededError）。现在：
 *   - 页面只在内存里放一份镜像，同步渲染读它；
 *   - 数据落 `<dataDir>/legado-web/*.json`（后端文件是唯一事实源）；
 *   - 老版本的浏览器数据只做一次性只读迁移，迁完把老键删掉。
 *
 * 断言：
 * 1. 1.8MB 书源 + 3000 章书架下无 QuotaExceededError、无红条；
 * 2. 跑完后 localStorage 里**一个 legado.* 键都不剩**；
 * 3. 刷新页面数据仍在（来自文件，不是浏览器缓存）：书源页列全、书架章节数正常；
 * 4. 老数据（localStorage 里的 legado.shelf.v1）被迁到文件、文件内容正确、老键被清。
 *
 * 没有 Chrome 时自动 SKIP。运行：先 build，再 node tests/legado-web-storage-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = 8997;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-store-"));
let proc = null;
let sock = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- 种数据：~1.8MB 书源（老版本会直接顶爆浏览器缓存）放文件；书架只放浏览器（测迁移） ----
const pad = "x".repeat(6000);
const sources = Array.from({ length: 300 }, (_, i) => ({
	bookSourceUrl: `http://src${i}.example.com`,
	bookSourceName: `书源${i}`,
	bookSourceType: 0,
	searchUrl: `/s?key={{key}}`,
	ruleSearch: { bookList: "li", name: "a", bookUrl: "a@href" },
	ruleContent: { content: "#content" },
	header: JSON.stringify({ pad }),
}));
const legacyChapters = Array.from({ length: 3000 }, (_, i) => ({
	name: `第${i}章`,
	url: `http://src0.example.com/c/${i}`,
}));
const legacyShelf = [
	{
		bookUrl: "http://src0.example.com/b/1",
		bookSourceUrl: sources[0].bookSourceUrl,
		name: "大书",
		author: "某人",
		tocUrl: "http://src0.example.com/toc/1",
		chapters: legacyChapters,
		chapterIndex: 12,
	},
];

try {
	const pluginDir = join(dataDir, "plugins", "legado-web");
	cpSync(join(import.meta.dirname, "..", "plugins", "legado-web"), pluginDir, {
		recursive: true,
		filter: (s) => !/(^|[\\/])(node_modules|storage)([\\/]|$)/.test(s),
	});
	if (!existsSync(join(pluginDir, "client", "app", "index.html"))) throw new Error("缺 client/app —— 先 build");
	mkdirSync(join(dataDir, "legado-web"), { recursive: true });
	writeFileSync(join(dataDir, "legado-web", "sources.json"), JSON.stringify(sources));
	const shelfFile = join(dataDir, "legado-web", "shelf.json");
	console.log(
		`· 种下 ${sources.length} 个书源（${(JSON.stringify(sources).length / 1024 / 1024).toFixed(1)}MB，放文件）+ 浏览器里的老书架（${legacyChapters.length} 章，测迁移）`,
	);

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
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "store-test" })));
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
		page.on("pageerror", (e) => errors.push(String(e)));
		page.on("console", (m) => {
			if (m.type() === "error" && /Quota|storage/i.test(m.text())) errors.push(m.text());
		});

		// 先到同源页面写下「老版本」的浏览器数据，再打开阅读页
		await page.goto(`${BASE}/`, { waitUntil: "load" });
		await page.evaluate((shelf) => localStorage.setItem("legado.shelf.v1", JSON.stringify(shelf)), legacyShelf);

		const probe = async () => {
			await page.goto(`${BASE}/plugins/legado-web/client/app/index.html`, { waitUntil: "load" });
			await page.waitForTimeout(2500);
			await page.click('nav button[data-tab="sources"]');
			await page.waitForTimeout(500);
			const sourceRows = await page.locator("#tab-sources .book b").count();
			return page.evaluate(
				(rows) => ({
					sourceRows: rows,
					status: document.getElementById("status")?.textContent ?? "",
					banner: document.getElementById("boot-error")?.textContent ?? null,
					shelfText: document.getElementById("tab-shelf")?.textContent?.replace(/\s+/g, " ") ?? "",
					legadoKeys: Object.keys(localStorage).filter((k) => k.startsWith("legado.")),
				}),
				sourceRows,
			);
		};

		const first = await probe();
		if (errors.length) fail(`页面报错：${errors.slice(0, 2).join(" | ")}`);
		if (first.banner) fail(`页面顶部还有错误提示：${first.banner.slice(0, 120)}`);
		if (first.sourceRows !== sources.length) fail(`书源页应列全 ${sources.length} 个，实际 ${first.sourceRows}`);
		if (!first.status.includes("存储：数据目录 legado-web")) fail(`状态栏不对：${first.status}`);
		if (first.legadoKeys.length) fail(`localStorage 里仍有 legado.* 键：${first.legadoKeys.join(", ")}`);
		if (!first.shelfText.includes("3000 章")) fail(`书架没显示章节数：${first.shelfText.slice(0, 120)}`);

		// 书源页：搜索 + 置顶（存 prefs.json，刷新后仍在）
		const searchBox = page.locator("#src-search");
		await searchBox.fill("src42.example.com");
		await page.waitForTimeout(400);
		let rows = await page.locator("#tab-sources .book b").allTextContents();
		if (rows.length !== 1 || !rows[0].includes("书源42"))
			fail(`搜索书源应只剩 1 个，实际 ${rows.length}：${rows.slice(0, 3)}`);
		const listTitle = (await page.locator("#tab-sources h3").nth(1).textContent()) ?? "";
		if (!listTitle.includes("匹配")) fail(`书源列表标题没显示匹配数：${listTitle}`);

		await page.locator("#tab-sources .book button[data-pin]").first().click();
		await page.waitForTimeout(300);
		if (!(await page.textContent("#status")).includes("已置顶")) fail("点 ⭐ 后状态栏没提示置顶");
		await page.locator("#src-search-clear").click();
		await page.waitForTimeout(300);
		rows = await page.locator("#tab-sources .book b").allTextContents();
		if (!rows[0]?.includes("书源42")) fail(`置顶的源应排在第一位，实际第一行是 ${rows[0]}`);
		if (rows.length !== sources.length) fail(`清空搜索后应显示全部 ${sources.length} 个，实际 ${rows.length}`);

		await page.fill("#src-search", "书源42");
		await page.waitForTimeout(400);
		await page.check("#src-only-pinned");
		await page.waitForTimeout(300);
		rows = await page.locator("#tab-sources .book b").allTextContents();
		if (rows.length !== 1) fail(`「只看置顶」应只剩 1 个，实际 ${rows.length}`);
		await page.uncheck("#src-only-pinned");
		await page.fill("#src-search", "");
		await page.waitForTimeout(400);

		const prefs = existsSync(join(dataDir, "legado-web", "prefs.json"))
			? JSON.parse(readFileSync(join(dataDir, "legado-web", "prefs.json"), "utf8"))
			: null;
		if (!prefs?.pinned?.includes(sources[42].bookSourceUrl)) fail(`置顶没落 prefs.json：${JSON.stringify(prefs)}`);
		if (!process.exitCode) console.log("✓ 书源页：搜索/只看置顶/⭐ 置顶（落 prefs.json）");

		// 迁移结果：老书架进文件，老键被清
		const migrated = existsSync(shelfFile) ? JSON.parse(readFileSync(shelfFile, "utf8")) : null;
		if (!Array.isArray(migrated) || migrated[0]?.name !== "大书") fail("浏览器里的老书架没被迁到文件");
		if (migrated[0]?.chapters?.length !== 3000) fail("迁移后章节表不完整（文件里应保留整份 chapters）");

		// 刷新后数据仍在（来自文件，不依赖浏览器缓存）
		const second = await probe();
		if (second.sourceRows !== sources.length || !second.shelfText.includes("3000 章"))
			fail("刷新后数据丢了（文件为事实源没生效）");
		if (second.legadoKeys.length) fail(`刷新后又出现 legado.* 键：${second.legadoKeys.join(", ")}`);
		const pinnedFirst = (await page.locator("#tab-sources .book b").first().textContent()) ?? "";
		if (!pinnedFirst.includes("书源42")) fail(`刷新后置顶丢了（第一行是 ${pinnedFirst}）`);
		if (errors.length) fail(`刷新后页面报错：${errors.slice(0, 2).join(" | ")}`);

		if (!process.exitCode)
			console.log(
				`✓ 只用数据目录文件：无 QuotaExceededError、localStorage 无 legado.* 键、刷新生效、老书架已迁移（${migrated.length} 本 / ${migrated[0].chapters.length} 章）`,
			);
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
	await new Promise((r) => setTimeout(r, 600));
	freePort(PORT);
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
