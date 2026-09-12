/**
 * 「AI 修复源」按钮 E2E（零 token）。
 *
 * 不起 React 主界面，而是搭一个最小宿主页（harness）顶替它：
 *   harness 页 → 动态 import 插件的 client/entry.mjs → mount(容器, 假 ctx)
 *   → 容器里出现内嵌阅读页 iframe（真产物 client/app/index.html）
 *   → 在 iframe 里点「🤖 AI 修复源」
 *   → entry.mjs 组正文 → 调 window.__piWebUiHost.startChat（harness 记录的假宿主）
 * 这样能把「按钮 → postMessage → entry 转发 → 宿主 API」整条链路跑通，且不会真的
 * 触发一次模型调用（没有主应用，就没有 agent 运行）。
 *
 * 没有 Chrome 时自动 SKIP（与 fence-render-test 同策略）；纯函数的正文组装断言
 * 在这之前先跑（见 tests/legado-web-engine-test.mjs 里也有一份，保持同步）。
 *
 * 运行：npm run build:server && node tests/legado-web-ai-fix-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { buildFixPrompt, isAiFixMessage, normalizeFixContext } from "../plugins/legado-web/client/ai-fix.mjs";

const PORT = 8996;
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = realpathSync(process.execPath);
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-aifix-"));
let proc = null;
let sock = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- 0. 纯函数：正文组装（无 Chrome 也会跑） --------------------------------
{
	const msg = {
		type: "legado:ai-fix",
		context: {
			scene: "content",
			sourceUrl: "http://api.ieasou.com/",
			sourceName: "宜搜小说",
			bookName: "斗破苍穹",
			bookUrl: "http://api.ieasou.com/book/1",
			url: "http://api.ieasou.com/chapter/12",
			error: "正文规则未解析出内容（规则：#content）",
			rules: { ruleContent: { content: "#content" } },
		},
	};
	if (!isAiFixMessage(msg) || isAiFixMessage({ type: "other" })) fail("isAiFixMessage 判定不对");
	const text = buildFixPrompt(msg.context, {
		sourcesFile: "C:/Users/x/.pi-web/legado-web/sources.json",
		rulesFile: "C:/Users/x/.pi-web/plugins/legado-web/rules.md",
		dataDir: "C:/Users/x/.pi-web/legado-web",
		pluginDir: "C:/Users/x/.pi-web/plugins/legado-web",
	});
	for (const need of [
		"【AI 修复书源】",
		"宜搜小说",
		"http://api.ieasou.com/",
		"正文规则未解析出内容",
		'"content":"#content"',
		"legado_source_probe",
		"C:/Users/x/.pi-web/legado-web/sources.json",
		"C:/Users/x/.pi-web/legado-web（书源/书架/检测数据都在这儿）",
		"不要修改阅读插件的任何文件",
	]) {
		if (!text.includes(need)) fail(`正文缺内容：${need}`);
	}
	const dirty = normalizeFixContext({ scene: "not-a-scene", sourceUrl: 42, error: "x".repeat(9000) });
	if (dirty.scene !== "source" || dirty.sourceUrl !== "" || dirty.error.length !== 1500) fail("脏上下文没被归一化");
	if (!process.exitCode) console.log("✓ 纯函数：请求判定 / 脏上下文归一化 / 给 AI 的正文组装");
}

// ---- 1. 起服务 + 装插件 + 种一个书源 ---------------------------------------
const pluginDir = join(dataDir, "plugins", "legado-web");
cpSync(join(import.meta.dirname, "..", "plugins", "legado-web"), pluginDir, {
	recursive: true,
	filter: (s) => !/(^|[\\/])(node_modules|storage|server[\\/]engine\.mjs)([\\/]|$)/.test(s),
});
if (!existsSync(join(pluginDir, "client", "app", "index.html"))) {
	console.error("✗ 缺 client/app/index.html —— 先跑 node plugins/legado-web/build.mjs");
	process.exit(1);
}
mkdirSync(join(dataDir, "legado-web"), { recursive: true });
writeFileSync(
	join(dataDir, "legado-web", "sources.json"),
	JSON.stringify([
		{
			bookSourceUrl: "http://127.0.0.1:9/fake",
			bookSourceName: "测试书源",
			bookSourceType: 0,
			searchUrl: "/search?key={{key}}",
			exploreUrl: "/explore",
			ruleSearch: { bookList: "li", name: "a", bookUrl: "a@href" },
			ruleContent: { content: "#content" },
		},
	]),
);

try {
	freePort(PORT);
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
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

	// 插件在 attach 时才装载/激活（路由与 AI 工具随之注册）——照主界面的行为来
	sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws 超时")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "aifix-test" })));
		sock.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugins") {
				clearTimeout(timer);
				if (!(msg.plugins ?? []).some((p) => p.id === "legado-web")) reject(new Error("清单里没有 legado-web"));
				else resolve();
			}
		});
		sock.on("error", reject);
	});
	console.log("✓ 插件已装载（WS attach 后生效）");

	if (!CHROME_PATH) {
		console.log("⚠ 没找到 Chrome（PI_WEB_CHROME 可覆盖）——跳过浏览器部分 SKIP");
	} else {
		const { chromium } = await import("playwright-core");
		const browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));
		// 先落到同源页面，再写入 harness（URL 不变 → 与 iframe 同源）
		await page.goto(`${BASE}/`, { waitUntil: "load" });
		await page.setContent(`<!doctype html><meta charset="utf-8"><div id="view"></div>
<script type="module">
  window.__calls = []; window.__views = [];
  window.__piWebUiHost = {
    version: 1,
    setView: (v) => window.__views.push(v),
    startChat: (opts) => { window.__calls.push(opts); return true; },
  };
  const onDataCbs = [];
  const ctx = {
    pluginId: "legado-web",
    send: (payload) => { if (payload && payload.type === "info") setTimeout(() => onDataCbs.forEach((cb) => cb({ kind: "info", sourcesFile: "D:/data/legado-web/sources.json", rulesFile: "P:/plugin/rules.md", dataDir: "D:/data/legado-web", pluginDir: "P:/plugin" })), 30); },
    onData: (cb) => { onDataCbs.push(cb); return () => {}; },
  };
  const mod = await import("/plugins/legado-web/client/entry.mjs");
  mod.default.mount(document.getElementById("view"), ctx);
  window.__mounted = true;
<\/script>`);
		await page.waitForFunction(() => window.__mounted === true, null, { timeout: 15_000 });

		// 内嵌阅读页 → 书源页 → 点「AI 修复源」
		const app = page.frameLocator("#view iframe");
		// 等首屏渲染完（否则 nav 的监听还没挂上，点了不生效）
		await app.locator("#tab-shelf .card").first().waitFor({ timeout: 20_000 });
		await app.locator('nav button[data-tab="sources"]').click({ timeout: 20_000 });
		const btn = app.locator("#tab-sources .book button.aifix").first();
		await btn.waitFor({ state: "visible", timeout: 20_000 });
		const rows = await app.locator(".book b").allTextContents();
		if (!rows.some((t) => t.includes("测试书源"))) fail(`书源列表没渲染出来：${JSON.stringify(rows)}`);
		await btn.click();
		await page.waitForFunction(() => window.__calls.length > 0, null, { timeout: 15_000 });

		const calls = await page.evaluate(() => window.__calls);
		const views = await page.evaluate(() => window.__views);
		const call = calls[0];
		if (!call?.newChat) fail(`startChat 没要求新建对话：${JSON.stringify(call)?.slice(0, 120)}`);
		if (call?.cwd !== "D:/data/legado-web") fail(`cwd 应为书源所在目录（dataDir），实际 ${call?.cwd}`);
		if (!String(call?.prompt ?? "").includes("测试书源")) fail("正文里没有书源名");
		if (!String(call?.prompt ?? "").includes("http://127.0.0.1:9/fake")) fail("正文里没有书源 URL");
		if (!String(call?.prompt ?? "").includes("ruleContent")) fail("正文里没有相关规则");
		if (!views.includes("chat")) fail(`没有切到对话视图：${JSON.stringify(views)}`);
		if (!process.exitCode)
			console.log("✓ 书源页点按钮 → entry 转发 → 宿主 startChat（切 chat、新对话、cwd=书源所在目录、正文含现场）");

		// 书源页的「AI 新建书源」：只给一个网站链接
		await app.locator("#src-ai-url").fill("example.com");
		await app.locator("#src-ai-new").click();
		await page.waitForFunction(() => window.__calls.length > 1, null, { timeout: 15_000 });
		const newCall = (await page.evaluate(() => window.__calls)).at(-1);
		const newPrompt = String(newCall?.prompt ?? "");
		if (!newPrompt.includes("【AI 新建书源】")) fail(`新建源正文标题不对：${newPrompt.slice(0, 80)}`);
		if (!newPrompt.includes("https://example.com"))
			fail(`新建源没带上（补全 scheme 后的）网址：${newPrompt.slice(0, 160)}`);
		if (!newPrompt.includes("legado_book_sources")) fail("新建源正文没提 legado_book_sources add");
		if (!newPrompt.includes("不要修改阅读插件")) fail("新建源正文缺「别改插件本体」的硬约束");
		if (!process.exitCode)
			console.log("✓ 书源页「AI 新建书源」：只给域名也能自动补 scheme 并交给 AI（正文含网址/工具/硬约束）");

		// 发现页也要有（书源选择行 / 分类解析失败处）
		await app.locator('nav button[data-tab="explore"]').click();
		const exBtn = app.locator("#tab-explore button.aifix").first();
		await exBtn.waitFor({ state: "visible", timeout: 20_000 });
		await exBtn.click();
		await page.waitForFunction(() => window.__calls.length > 2, null, { timeout: 15_000 });
		const exCall = (await page.evaluate(() => window.__calls)).at(-1);
		if (!String(exCall?.prompt ?? "").includes("测试书源")) fail("发现页正文里没有书源名");
		if (!String(exCall?.prompt ?? "").includes("发现"))
			fail(`发现页场景不对：${String(exCall?.prompt ?? "").slice(0, 120)}`);
		if (!process.exitCode) console.log("✓ 发现页点按钮同样可用（场景=发现）");
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
