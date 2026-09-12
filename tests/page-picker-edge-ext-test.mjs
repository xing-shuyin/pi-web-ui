/* page-picker 扩展「真浏览器 + 真扩展」E2E：**装真扩展**跑一遍投递与绑定。
 *
 * 为什么需要它（0.2.0 的真实事故）：`tabs.query` 的 url 过滤必须是合法 match pattern，
 * 而我们曾把「裸 origin」当成模式之一传进去 —— 真 Chrome/Edge 直接抛
 * `Invalid url pattern 'http://localhost:8787'`，被 catch 成「没找到打开的 pi-web-ui 页面」。
 * `page-picker-test.mjs` 用的是**假 chrome**（不校验模式），所以整条链全绿也放过了它 ——
 * 只有真扩展 + 真 chrome.* 才能发现这类问题。
 *
 * 为什么不加载真扩展就装不了（Chromium 137 起 --load-extension 被移除）：**实测 Edge 152
 * 的 headless 仍然认这个开关**，所以这里用 Edge 跑；没有 Edge / 开关失效时**自动 SKIP**
 * （不是失败）—— 它是额外保险，不是唯一防线（单测里的假 chrome 也会校验 match pattern）。
 *
 * Run: npm run build:extension && npm run build && node tests/page-picker-edge-ext-test.mjs
 * 覆盖跳过：PI_WEB_EDGE=/path/to/msedge
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT_DIR = join(REPO_ROOT, "plugins", "page-picker", "extension");
const PICKER_BUNDLE = join(EXT_DIR, "dist", "picker.js");
const BIND_BUNDLE = join(EXT_DIR, "dist", "bind.js");

const EDGE_CANDIDATES = [
	process.env.PI_WEB_EDGE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge",
	join(homedir(), "AppData/Local/Microsoft/Edge/Application/msedge.exe"),
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));

const PORT = 8960 + Math.floor(Math.random() * 30);
const FIXTURE_PORT = 9440 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (!EDGE) {
	console.log("… SKIP：没找到 Edge（设 PI_WEB_EDGE 可指定路径）");
	process.exit(0);
}
if (!existsSync(PICKER_BUNDLE) || !existsSync(BIND_BUNDLE)) {
	console.log("✗ 缺 dist/picker.js / dist/bind.js —— 先跑 npm run build:extension");
	process.exit(1);
}

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具页</title></head>
<body><main id="app"><section id="card" class="card"><h3>卡片标题</h3><p>正文</p></section></main></body></html>`;

const fixture = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(FIXTURE_HTML);
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

// ------------------------------------------------------------------ 真 pi-web-ui
const base = mkdtempSync(join(tmpdir(), "piweb-edgeext-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "f", name: "F" }],
			},
		},
	}),
);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});
let up = false;
for (let i = 0; i < 80; i++) {
	try {
		if ((await fetch(`${BASE}/api/health`)).ok) {
			up = true;
			break;
		}
	} catch {}
	await sleep(250);
}
if (!up) {
	console.log("✗ pi-web-ui 没起来");
	fixture.close();
	server.kill();
	process.exit(1);
}

// ------------------------------------------------------------------ 真 Edge + 真扩展
const userDataDir = mkdtempSync(join(tmpdir(), "edge-ext-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
	executablePath: EDGE,
	headless: true,
	args: [
		`--disable-extensions-except=${EXT_DIR}`,
		`--load-extension=${EXT_DIR}`,
		"--enable-unsafe-extension-debugging",
		"--no-first-run",
		"--no-default-browser-check",
	],
});

const findSw = async (ms) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const sw = ctx.serviceWorkers().find((s) => s.url().startsWith("chrome-extension://"));
		if (sw) return sw;
		await sleep(300);
	}
	return null;
};

const sw = await findSw(8000);
if (!sw) {
	console.log("… SKIP：这个 Edge 不接受 --load-extension（装不上真扩展就测不了）");
	await ctx.close();
	fixture.close();
	server.kill();
	process.exit(0);
}
console.log("✓ 真扩展已加载：", sw.url().replace(/\/dist\/background\.js$/, ""));

const piPage = await ctx.newPage();
await piPage.goto(BASE, { waitUntil: "domcontentloaded" });
await piPage.waitForSelector(".inputbox textarea", { timeout: 30000 });

const fxPage = await ctx.newPage();
await fxPage.goto(`http://127.0.0.1:${FIXTURE_PORT}/`, { waitUntil: "domcontentloaded" });

/** 在扩展 SW 里找标签页（按 URL 包含关系）。 */
const tabIdOf = (needle) =>
	sw.evaluate(async (n) => {
		const tabs = await chrome.tabs.query({});
		return tabs.find((t) => t.url?.includes(n))?.id ?? null;
	}, needle);

const piTabId = await tabIdOf(`:${PORT}/`);
const fxTabId = await tabIdOf(`:${FIXTURE_PORT}/`);
check("两个标签页都在（真 tabs.query）", piTabId != null && fxTabId != null, `pi=${piTabId} fx=${fxTabId}`);

// 0) 这一条就是 0.2.0 漏掉的那个坑：裸 origin 不是合法 match pattern
const patternCheck = await sw.evaluate(
	async ([port]) => {
		const out = {};
		try {
			await chrome.tabs.query({ url: [`http://localhost:${port}/*`, `http://localhost:${port}`] });
			out.bare = "没抛（这个版本居然容忍裸 origin）";
		} catch (e) {
			out.bare = String(e.message);
		}
		const ok = await chrome.tabs.query({ url: [`http://localhost:${port}/*`] });
		out.originOnly = `ok(${ok.length})`;
		return out;
	},
	[PORT],
);
check(
	"裸 origin 会被真浏览器拒绝（所以代码里只能用 origin 模式查询）",
	patternCheck.bare.includes("Invalid url pattern"),
	patternCheck.bare,
);
check("origin 级模式能查到页面", patternCheck.originOnly.includes("ok("), patternCheck.originOnly);

// 1) 绑定服务地址（等同用户在选项页/浮条上做的那一步）
await sw.evaluate(async (url) => {
	await chrome.storage.sync.set({ serverUrl: url });
}, BASE);

// 2) 真投递：真 picker.js 注入夹具页 → 拾取 → 添加到对话 → 真 pi-web-ui 输入框
const injected = await sw.evaluate(
	async ([tabId]) => {
		try {
			await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/picker.js"] });
			return "ok";
		} catch (e) {
			return `throw: ${e.message}`;
		}
	},
	[fxTabId],
);
check("真扩展把拾取器注入到开发页", injected === "ok", injected);
await fxPage.waitForSelector("#pi-page-picker-host", { timeout: 5000 });

await fxPage.click("#card");
await fxPage.keyboard.press("Control+Enter");
const landed = await piPage
	.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("### 网页元素拾取"), null, {
		timeout: 10000,
	})
	.then(() => true)
	.catch(() => false);
const composerText = await piPage.inputValue(".inputbox textarea");
check(
	"**真扩展的全链路**：拾取 → 投递 → Markdown 落进 pi-web-ui 输入框",
	landed && composerText.includes("#card"),
	JSON.stringify(composerText.slice(0, 60)),
);
check(
	"投递成功时没有走「复制兜底」（说明真的找到了那个标签页）",
	!composerText.includes("没找到打开的 pi-web-ui 页面"),
);

// 3) 绑定浮条：pi-web-ui 页面上真的会弹，且能落盘
await piPage.evaluate(() => {
	window.chrome ??= { runtime: { sendMessage: async () => null } };
});
await sw.evaluate(
	async ([tabId]) => {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/bind.js"] });
	},
	[piTabId],
);
await piPage.waitForTimeout(500);
const bar = await piPage.evaluate(() => {
	const host = document.getElementById("pi-page-picker-bind-host");
	const card = host?.shadowRoot?.querySelector(".card");
	return { present: Boolean(card), hidden: card?.classList.contains("hidden") ?? true, text: card?.textContent ?? "" };
});
check("真扩展在 pi-web-ui 页面上弹出绑定浮条（自己认得出页面）", bar.present && !bar.hidden, bar.text.slice(0, 50));

// 4) 非 pi-web-ui 页面上浮条要自己退场（background 探测失败时也不能「什么都没发生」）
const beforePick = await fxPage.evaluate(() => Boolean(document.getElementById("pi-page-picker-host")));
await sw.evaluate(
	async ([tabId]) => {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/bind.js"] });
	},
	[fxTabId],
);
await fxPage.waitForTimeout(800);
const afterBindOnFixture = await fxPage.evaluate(() => ({
	bar: Boolean(document.getElementById("pi-page-picker-bind-host")),
	picker: Boolean(document.getElementById("pi-page-picker-host")),
}));
check("夹具页上浮条自己退场", !afterBindOnFixture.bar, JSON.stringify(afterBindOnFixture));
check(
	"退场后由 worker 补注入拾取器（点图标永不静默）",
	afterBindOnFixture.picker || beforePick,
	JSON.stringify(afterBindOnFixture),
);

await ctx.close();
fixture.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
