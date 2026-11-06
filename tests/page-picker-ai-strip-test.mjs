import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

if (!CHROME_PATH) {
	console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
	process.exit(0);
}

const REPO = fileURLToPath(new URL("../", import.meta.url));
const PICKER_BUNDLE = join(REPO, "plugins", "page-picker", "extension", "dist", "picker.js");
if (!existsSync(PICKER_BUNDLE)) {
	console.log("✗ 缺 dist/picker.js —— 先跑 npm run build:extension");
	process.exit(1);
}
const PICKER = readFileSync(PICKER_BUNDLE, "utf8");

const PORT = 9600 + Math.floor(Math.random() * 300);
const PAGE_URL = `http://127.0.0.1:${PORT}/`;

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>夹具页</title>
<style>body { margin: 0; font: 14px/1.6 system-ui; } #card { width: 220px; height: 90px; background: #eee; }</style>
</head><body>
<h1>被调试的页面</h1>
<div id="card">卡片</div>
<button id="bottom-bar">细条正下方的元素</button>
<script>
  // 细条在底部居中（bottom:10px，高约 38px）——把按钮钉在它背后，用来验证「细条不挡点击」
  var b = document.getElementById("bottom-bar");
  b.style.cssText = "position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:320px;height:40px;";
</script>
</body></html>`;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(FIXTURE);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));

await page.goto(PAGE_URL);

await page.evaluate(() => {
	const orig = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function (init) {
		return orig.call(this, { ...init, mode: "open" });
	};
	const sent = [];
	const stub = {
		runtime: {
			sendMessage: async (message) => {
				sent.push(message);
				if (message.type === "page-picker:settings") return { detail: "standard" };
				if (message.type === "page-picker:page-state") return globalThis.__state;
				return { ok: true };
			},
		},
	};
	globalThis.__sent = sent;
	globalThis.__state = { origin: "http://127.0.0.1:5173", authorized: false, aiControl: true };
	Object.defineProperty(globalThis, "chrome", { value: stub, configurable: true, writable: true });
});

const inject = async (state) => {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(120);
	await page.evaluate((next) => {
		globalThis.__state = next;
		globalThis.__sent.length = 0;
	}, state);
	await page.addScriptTag({ content: PICKER });
	await page.waitForSelector("#pi-page-picker-host", { timeout: 5000 });
	await page.waitForTimeout(200);
};

const strip = () =>
	page.evaluate(() => {
		const host = document.getElementById("pi-page-picker-host");
		const node = host?.shadowRoot?.querySelector(".mini");
		if (!node) return null;
		return {
			hidden: node.classList.contains("hidden"),
			text: node.textContent ?? "",
			rect: node.getBoundingClientRect().toJSON(),
			buttons: [...node.querySelectorAll("button")].map((b) => b.textContent ?? ""),
		};
	});

const confirmBar = () =>
	page.evaluate(() => {
		const host = document.getElementById("pi-page-picker-host");
		const node = host?.shadowRoot?.querySelector(".bar");
		return {
			hidden: node?.classList.contains("hidden") ?? true,
			selector: node?.querySelector(".sel")?.textContent ?? "",
		};
	});

const sentTypes = () => page.evaluate(() => globalThis.__sent.map((m) => m.type));

console.log("\n[1] 点一次图标（拾取态）就能看见「让 AI 操作本页…」");
await inject({ origin: "http://127.0.0.1:5173", authorized: false, aiControl: true });
let s = await strip();
check("拾取态就有底部细条（还没点任何元素）", s !== null && s.hidden === false, JSON.stringify(s?.text));
check("细条报的是「未授权」", s?.text.includes("未授权"), s?.text);
check(
	"三个入口都在：让 AI 操作本页 / 与另一页配对 / 退出",
	JSON.stringify(s?.buttons) === JSON.stringify(["让 AI 操作本页…", "与另一页配对…", "退出"]),
	JSON.stringify(s?.buttons),
);
check("细条贴底且很矮（不占页面主体）", s.rect.height < 50 && s.rect.bottom > 700 - 60, JSON.stringify(s.rect));
check(
	"细条容器 pointer-events:none、按钮 auto（非按钮区域照旧算页面）",
	await page.evaluate(() => {
		const host = document.getElementById("pi-page-picker-host");
		const node = host.shadowRoot.querySelector(".mini");
		return (
			getComputedStyle(node).pointerEvents === "none" &&
			getComputedStyle(node.querySelector("button")).pointerEvents === "auto"
		);
	}),
);

console.log("\n[2] 细条上的按钮");
await page.evaluate(() => {
	document.getElementById("pi-page-picker-host").shadowRoot.querySelector(".mini button").click();
});
await page.waitForTimeout(200);
check(
	"点「让 AI 操作本页…」→ 请 worker 打开设置页的授权面板（带本页地址）",
	await page.evaluate(() =>
		globalThis.__sent.some((m) => m.type === "page-picker:grant-here" && m.url === location.href),
	),
	JSON.stringify(await sentTypes()),
);
check(
	"点了就有反馈（页面上给 toast，不静默）",
	await page.evaluate(() =>
		Boolean(document.getElementById("pi-page-picker-host").shadowRoot.querySelector(".toast")?.textContent),
	),
);

await page.evaluate(() => {
	const buttons = document.getElementById("pi-page-picker-host").shadowRoot.querySelectorAll(".mini button");
	buttons[1].click();
});
await page.waitForTimeout(200);
check("点「与另一页配对…」→ 请 worker 打开配对面板", (await sentTypes()).includes("page-picker:pair-here"));

console.log("\n[3] 细条不挡页面：点它正下方的元素能拾到");
const stripStatus = await page.evaluate(() => {
	const host = document.getElementById("pi-page-picker-host");
	const r = host.shadowRoot.querySelector(".mini .st").getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.click(stripStatus.x, stripStatus.y);
await page.waitForTimeout(200);
let bar = await confirmBar();
s = await strip();
check(
	"点细条上的状态区 → 事件穿透到页面元素并被拾取",
	bar.hidden === false && bar.selector.includes("bottom-bar"),
	bar.selector,
);
check("进入确认条后细条让位（不叠两套 UI）", s?.hidden === true);
check(
	"确认条里同样有「让 AI 操作本页…」",
	await page.evaluate(
		() =>
			document
				.getElementById("pi-page-picker-host")
				.shadowRoot.querySelector(".bar")
				?.textContent?.includes("让 AI 操作本页…") ?? false,
	),
);

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Esc 回拾取态：细条回来了", (await strip())?.hidden === false);

console.log("\n[4] 细条报的状态");
await inject({ origin: "http://127.0.0.1:5173", authorized: true, title: "开发预览页", aiControl: true });
s = await strip();
check("已授权 → 「已授权 · 模型可操作本页」", s?.text.includes("已授权 · 模型可操作本页"), s?.text);
check("已授权 → 按钮不再催着点（改成打开设置页）", s?.text.includes("已授权 · 打开设置页"));

await inject({ origin: "http://127.0.0.1:5173", authorized: true, aiControl: false });
s = await strip();
check("已授权但总开关关着 → 明说总开关（不然用户以为功能坏了）", s?.text.includes("总开关"), s?.text);

await inject(undefined);
s = await strip();
check(
	"查不到状态 → 说「查不到」，不装成「未授权」",
	s?.text.includes("查不到") && !s?.text.includes("未授权"),
	s?.text,
);

console.log("\n[5] 退出");
await page.evaluate(() => {
	const buttons = document.getElementById("pi-page-picker-host").shadowRoot.querySelectorAll(".mini button");
	buttons[2].click();
});
await page.waitForTimeout(200);
check("点「退出」→ 拾取浮层整个收掉", (await page.$("#pi-page-picker-host")) === null);

check("夹具页全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
