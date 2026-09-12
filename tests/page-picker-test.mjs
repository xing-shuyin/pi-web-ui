/* 网页元素拾取扩展 E2E：**真实的 picker bundle** + **真实的 background 模块** + **真实的
 * pi-web-ui 页面**，把整条链跑通：
 *
 *   夹具页上选元素 → 采集契约（选择器/命中的 CSS 行号/React 源码位置/样式子集）
 *   → toPrompt 渲染 → deliver → MAIN world 调 __piWebUiHost.compose
 *   → pi-web-ui 输入框真的出现那段 Markdown
 *
 * 为什么不加载真扩展：Chromium 137 起 `--load-extension` 已被上游移除（本机 Chrome 153
 * 实测 `chrome://extensions` 里装不上），自动化装扩展这条路没了。这里改用等价做法 ——
 * 注入 dist/picker.js 真身，只把 `chrome.*` 桥到 Node 里跑真 background 模块；被绕过的
 * 只有 chrome 管道本身，那部分由 `tests/unit/page-picker-background.test.ts` 用假 chrome
 * 覆盖。用户手动「加载已解压的扩展程序」不受影响（那不是命令行开关）。
 *
 * Run: npm run build:extension && npm run build && node tests/page-picker-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";
import { composeInPage, detectPiWebUi, handleMessage } from "../plugins/page-picker/extension/dist/background.js";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const EXT_DIR = join(REPO_ROOT, "plugins", "page-picker", "extension");
const PICKER_BUNDLE = join(EXT_DIR, "dist", "picker.js");
const BIND_BUNDLE = join(EXT_DIR, "dist", "bind.js");
const PORT = 8900 + Math.floor(Math.random() * 90);
const FIXTURE_PORT = 9400 + Math.floor(Math.random() * 90);

if (!existsSync(PICKER_BUNDLE) || !existsSync(BIND_BUNDLE)) {
	console.log("✗ 缺 dist/picker.js 或 dist/bind.js —— 先跑 npm run build:extension");
	process.exit(1);
}

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具页</title>
<style data-vite-dev-id="/src/components/Card.css">/* line 1 of the source file */
.card {
  padding: 12px 16px;
  display: flex;
  gap: 8px;
}
</style>
<style data-vite-dev-id="/src/styles/base.css">body { margin: 0; }
</style></head>
<body>
<main id="app">
  <div class="row">
    <section id="card" class="card card--active"><h3>卡片标题</h3><p>正文内容</p></section>
  </div>
  <div class="row">
    <section id="card2" class="card">第二张 <span class="badge">NEW</span></section>
  </div>
</main>
<script>
  // 模拟 React dev 的 fiber：适配器就是靠 __reactFiber$ 前缀 + _debugSource 工作的
  var el = document.getElementById("card");
  el["__reactFiber$e2e000"] = {
    _debugSource: { fileName: location.origin + "/src/components/Card.tsx?t=1700000000", lineNumber: 18, columnNumber: 5 },
    type: function Card() {},
    memoizedProps: null,
    return: { _debugSource: { fileName: location.origin + "/src/pages/Settings.tsx?t=1", lineNumber: 7 }, type: function SettingsPage() {}, return: null }
  };
</script>
</body></html>`;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// --------------------------------------------------------------------- 夹具站
const fixture = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(FIXTURE_HTML);
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

// --------------------------------------------------------------------- pi-web-ui
const base = mkdtempSync(join(tmpdir(), "piweb-picker-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "fastfail-1", name: "FastFail" }],
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
		if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) {
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

// --------------------------------------------------------------------- 浏览器
const browser = await chromium.launch({ executablePath: CHROME_PATH });
const context = await browser.newContext();
const piPage = await context.newPage();
await piPage.goto(`http://localhost:${PORT}`);
await piPage.waitForSelector(".inputbox textarea", { timeout: 20000 });
await piPage.waitForFunction(
	() => {
		const ta = document.querySelector(".inputbox textarea");
		return ta && !ta.disabled;
	},
	{ timeout: 20000 },
);

// 把**真实的** composeInPage 装进 pi-web-ui 页面（投递时由假 scripting 调它）
await piPage.evaluate((fnText) => {
	globalThis.__composeFunc = (0, eval)(`(${fnText})`);
}, composeInPage.toString());

// --------------------------------------------------------------------- 假 chrome
const WEB_URL = `http://localhost:${PORT}/`;
let tabs = [{ id: 1, windowId: 1, url: WEB_URL }];
let delivered = [];
let injectedTabIds = [];
const bridgeLog = [];

const fakeStorage = {
	serverUrl: `http://localhost:${PORT}`,
	token: "",
	detail: "standard",
	// 「发送什么」的多选（设置页勾的那几项）：场景 8 会改成「只要定位+源码」
	sections: ["page", "selector", "source", "text", "rules", "styles", "skeleton"],
	copyToClipboard: true,
	screenshots: false,
	focusTarget: false,
};

globalThis.chrome = {
	storage: {
		sync: {
			get: async () => ({ ...fakeStorage }),
			set: async (patch) => {
				Object.assign(fakeStorage, patch); // 绑定会写 serverUrl：E2E 要看到它真的落盘
			},
		},
	},
	runtime: { getURL: (path) => `chrome-extension://fake/${path}` },
	tabs: {
		// 真的像 Chrome 一样校验 match pattern（裸 origin 会让真浏览器抛 Invalid url pattern）
		query: async (info = {}) => {
			for (const p of info.url ?? []) {
				// 像 Chrome 一样校验：match pattern 的 path 不能缺（裸 origin 会让真浏览器抛异常）
				if (!/^https?:\/\/[^/]+\//.test(String(p))) throw new Error(`Invalid url pattern '${p}'`);
			}
			return tabs;
		},
		update: async () => ({}),
		create: async () => ({}),
		captureVisibleTab: async () => {
			throw new Error("Cannot access contents of the page (no activeTab)");
		},
	},
	windows: { update: async () => ({}) },
	action: { setBadgeText: async () => {}, setTitle: async () => {} },
	permissions: { contains: async () => true, request: async () => true },
	scripting: {
		executeScript: async (injection) => {
			if (injection.files) return [{}]; // 注入拾取器：测试里已经手动注入
			// 投递：在真实 pi-web-ui 页面里跑真实 composeInPage
			const [text, attachments] = injection.args;
			injectedTabIds.push(injection.target.tabId);
			delivered.push({ text, attachments });
			const result = await piPage.evaluate((arg) => globalThis.__composeFunc(arg.text, arg.attachments), {
				text,
				attachments,
			});
			return [{ result }];
		},
	},
};

/** 内容脚本 → background（真实 handleMessage）的回环。 */
async function bridge(message) {
	bridgeLog.push(message);
	return await new Promise((resolve) => {
		handleMessage(message, {}, (response) => resolve(response ?? null));
	});
}

const fx = await context.newPage();
const jsErrors = [];
fx.on("pageerror", (e) => jsErrors.push(String(e)));
await fx.exposeFunction("__piBridge", bridge);
await fx.addInitScript(() => {
	globalThis.__sent = [];
	const stub = {
		runtime: {
			sendMessage: async (message) => {
				globalThis.__sent.push(message);
				return await globalThis.__piBridge(message);
			},
		},
	};
	try {
		Object.defineProperty(globalThis, "chrome", { value: stub, configurable: true, writable: true });
	} catch {
		globalThis.chrome = stub;
	}
});
await fx.goto(`http://127.0.0.1:${FIXTURE_PORT}/`);

const injectPicker = async () => {
	await fx.addScriptTag({ path: PICKER_BUNDLE });
	await fx.waitForSelector("#pi-page-picker-host", { timeout: 5000 });
	await fx.waitForTimeout(150);
};

// ============================================================= 场景 1：单选 → 投递
await injectPicker();
check("注入后拾取器挂上（overlay host 存在）", (await fx.$("#pi-page-picker-host")) !== null);

await fx.click("#card");
await fx.waitForTimeout(120);
check(
	"拾取器启动时向 background 要了设置（详细度档位）",
	bridgeLog.some((m) => m.type === "page-picker:settings"),
);

await fx.keyboard.press("Control+Enter");
await fx.waitForTimeout(600);

const pickedMsg = bridgeLog.find((m) => m.type === "page-picker:picked");
check(
	"拾取结果回传到 background",
	Boolean(pickedMsg),
	pickedMsg ? `${pickedMsg.payload.elements.length} 个元素` : "没收到",
);
const snap = pickedMsg?.payload?.elements?.[0]?.snapshot;
check("选择器唯一且短（有唯一 id 就用 #id，不再叠 tag/父级）", snap?.selector === "#card", snap?.selector);
check(
	"命中的 CSS 认到源文件",
	snap?.matchedRules?.some((r) => r.file === "/src/components/Card.css"),
	JSON.stringify(snap?.matchedRules?.[0] ?? null),
);
const cardRule = snap?.matchedRules?.find((r) => r.file === "/src/components/Card.css");
check("CSS 行号来自 Vite 的 data-vite-dev-id（.card 在第 2 行）", cardRule?.line === 2, `line=${cardRule?.line}`);
check(
	"React 源码位置（文件:行:列）",
	snap?.source?.file === "/src/components/Card.tsx" && snap?.source?.line === 18 && snap?.source?.column === 5,
	JSON.stringify(snap?.source),
);
check(
	"组件名 + 调用链",
	snap?.source?.component === "Card" &&
		JSON.stringify(snap?.source?.chain) === JSON.stringify(["Card", "SettingsPage"]),
	JSON.stringify(snap?.source?.chain),
);
check(
	"样式子集：只报作者动过的（默认值/继承值不进上下文）",
	snap?.styles?.display === "flex" &&
		snap?.styles?.padding === "12px 16px" &&
		!(snap?.styles && ("position" in snap.styles || "overflow" in snap.styles || "width" in snap.styles)),
	JSON.stringify(snap?.styles),
);
check("文本采集（折叠空白）", snap?.text?.includes("卡片标题"), JSON.stringify(snap?.text));
check(
	"页面上下文含 URL/视口/框架",
	pickedMsg?.payload?.page?.url?.includes("127.0.0.1"),
	pickedMsg?.payload?.page?.framework,
);

const md = delivered[0]?.text ?? "";
check("Markdown 渲染出来并投递", md.includes("### 网页元素拾取"), md.split("\n")[0]);
check("Markdown 带源码行号", md.includes("/src/components/Card.tsx:18:5"), "");
check("Markdown 带 CSS 命中块", md.includes("/* /src/components/Card.css:2 */"), "");

const ta = piPage.locator(".inputbox textarea");
const composer = await ta.inputValue();
check(
	"**真正的验收点**：pi-web-ui 输入框拿到了那段 Markdown",
	composer.includes("### 网页元素拾取") && composer.includes("/src/components/Card.tsx"),
	JSON.stringify(composer.slice(0, 60)),
);
check("发送成功后拾取器自己收起了 overlay", (await fx.$("#pi-page-picker-host")) === null);

// ============================================================= 场景 2：多选 + 备注
await ta.fill(""); // 清空输入框，方便断言这一轮的效果
await injectPicker(); // 重新注入 = 新一轮拾取（也验证了会自愈而不是叠出第二套 overlay）
const hosts = await fx.$$("#pi-page-picker-host");
check("重复注入不叠出第二套 overlay", hosts.length === 1, `${hosts.length} 个`);

await fx.click("#card");
await fx.keyboard.press("Escape"); // 回到拾取态继续加
await fx.click("#card2", { modifiers: ["Shift"] });
await fx.keyboard.press("Enter"); // 完成 → 编辑态
await fx.keyboard.press("Control+Enter");
await fx.waitForTimeout(600);

const multi = bridgeLog.filter((m) => m.type === "page-picker:picked").at(-1);
check("多选：两个元素都进了契约", multi?.payload?.elements?.length === 2, `${multi?.payload?.elements?.length} 个`);
check(
	"多选：每个元素各自的选择器（没串味）",
	multi?.payload?.elements?.[0]?.snapshot?.selector === "#card" &&
		multi?.payload?.elements?.[1]?.snapshot?.selector === "#card2",
	JSON.stringify(multi?.payload?.elements?.map((e) => e.snapshot.selector)),
);
check(
	"多选：两张卡片各自的选择器/文本都分开渲染（不串味）",
	/#### 元素 1[\s\S]*?#card[\s\S]*?#### 元素 2[\s\S]*?#card2/.test(delivered.at(-1)?.text ?? ""),
	"",
);
check("多选：渲染出两个区块", (delivered.at(-1)?.text.match(/#### 元素 \d/g) ?? []).length === 2, "");

// ============================================================= 场景 3：找不到 pi-web-ui → 复制兜底
await ta.fill("");
tabs = []; // 假装用户把 pi-web-ui 页面关了
const fallbackMsg = await bridge({ type: "page-picker:picked", payload: multi.payload });
check(
	"找不到 pi-web-ui 页面 → 不静默失败",
	fallbackMsg?.ok === false && typeof fallbackMsg?.copy === "string",
	JSON.stringify(fallbackMsg?.message),
);
check("兜底把 Markdown 交回给页面（可复制/手动粘贴）", (fallbackMsg?.copy ?? "").includes("### 网页元素拾取"));
check("输入框没有被写入（没有目标页面就别乱写）", (await ta.inputValue()) === "");

// ============================================================= 场景 4：开了截图但截屏失败
await ta.fill("");
tabs = [{ id: 1, windowId: 1, url: WEB_URL }];
fakeStorage.screenshots = true; // 设置里开了截图，但 captureVisibleTab 抛出（没有 activeTab）
const shotFail = await bridge({ type: "page-picker:picked", payload: multi.payload });
check("截图失败不影响投递（点了添加就必须进去）", shotFail?.ok === true, JSON.stringify(shotFail?.message));
await fx.waitForTimeout(200);
const composer4 = await ta.inputValue();
check(
	"截图失败时 Markdown 照常落进输入框",
	composer4.includes("### 网页元素拾取") && !composer4.includes("截图"),
	JSON.stringify(composer4.slice(0, 40)),
);

// ============================================================= 场景 5：多个标签页时投对地方
await ta.fill("");
injectedTabIds = [];
tabs = [
	{ id: 99, url: `http://127.0.0.1:${FIXTURE_PORT}/` }, // 正在调试的站点（不能往这注入）
	{ id: 1, url: WEB_URL }, // 真正的 pi-web-ui
	{ id: 98, url: `http://localhost:${PORT}/pi-other/` }, // 前缀相似的另一站（也不算）
];
const pickedRight = await bridge({ type: "page-picker:picked", payload: multi.payload });
check(
	"多个标签页时投到 pi-web-ui 那个（不碰调试站点/前缀相似的站）",
	pickedRight?.ok === true && injectedTabIds.join(",") === "1",
	`tab=${injectedTabIds.join(",")}`,
);
// compose 是同步调用的，但 React 的 setText 是异步提交 → 等它落进 DOM 再断言（别用 sleep）
const landed = await piPage
	.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("### 网页元素拾取"), null, {
		timeout: 3000,
	})
	.then(() => true)
	.catch(() => false);
check("内容真的进了 pi-web-ui 输入框", landed);

// ============================================ 场景 6：在 pi-web-ui 本页上一键绑定服务地址
// 远程/局域网部署的第一公里：地址是 IP:端口，不该逼用户去选项页手打。
// 这里跑**真实的探测函数**（真 pi-web-ui 页面 / 真夹具页）+ **真实的绑定浮条 bundle**。
const probeOnPi = await piPage.evaluate(detectPiWebUi);
check("真实 pi-web-ui 页面被认出来", probeOnPi?.isPiWebUi === true, JSON.stringify(probeOnPi));
const probeOnFixture = await fx.evaluate(detectPiWebUi);
check(
	"任意网页（连路径都回 200 的夹具页）不会被误认成 pi-web-ui",
	probeOnFixture?.isPiWebUi === false,
	JSON.stringify(probeOnFixture),
);

// 站在「本机绑着 127，远程页面其实是 localhost:PORT」的处境上（最经典的错位场景）
fakeStorage.serverUrl = "http://127.0.0.1:8787";
await piPage.exposeFunction("__piBridge", bridge);
await piPage.evaluate(() => {
	globalThis.chrome = {
		runtime: {
			sendMessage: async (message) => await globalThis.__piBridge(message),
		},
	};
});
await piPage.addScriptTag({ path: BIND_BUNDLE });
// 浮条 host 本身是 0×0（内容挂在 shadow 里的 fixed 卡片上）→ 只能等 attached
await piPage.waitForSelector("#pi-page-picker-bind-host", { state: "attached", timeout: 5000 });

const barText = async () =>
	piPage.evaluate(
		() => document.getElementById("pi-page-picker-bind-host")?.shadowRoot?.querySelector(".card")?.textContent ?? "",
	);
const bindBtnHidden = async () =>
	piPage.evaluate(
		() =>
			document
				.getElementById("pi-page-picker-bind-host")
				?.shadowRoot?.querySelector("button.primary")
				?.classList.contains("hidden") ?? false,
	);
const bar = await barText();
check(
	"浮条问的是「换成本页地址」，两个地址都写清楚",
	bar.includes(`http://localhost:${PORT}`) && bar.includes("http://127.0.0.1:8787"),
	bar.slice(0, 60),
);
check("浮条提供「设为服务地址」", bar.includes("设为服务地址"));

await piPage.locator("#pi-page-picker-bind-host button.primary").click();
const boundShown = await piPage
	.waitForFunction(
		() => (document.getElementById("pi-page-picker-bind-host")?.shadowRoot?.textContent ?? "").includes("已绑定"),
		null,
		{ timeout: 5000 },
	)
	.then(() => true)
	.catch(() => false);
check("绑定结果回显到浮条（不静默）", boundShown);
check(
	"绑定成功 → 存储里的 serverUrl 真的换成了本页地址",
	fakeStorage.serverUrl === `http://localhost:${PORT}`,
	fakeStorage.serverUrl,
);
check(
	"绑定消息带的是页面自己的地址（不依赖 tab.url 的权限）",
	bridgeLog.some((m) => m.type === "page-picker:bind" && m.url === WEB_URL),
);
// 再注入一次（= 又点了一次图标）：已经是同一个地址了，就不该再问「要不要绑」
await piPage.addScriptTag({ path: BIND_BUNDLE });
// 浮条 host 本身是 0×0（内容挂在 shadow 里的 fixed 卡片上）→ 只能等 attached
await piPage.waitForSelector("#pi-page-picker-bind-host", { state: "attached", timeout: 5000 });
await piPage.waitForTimeout(150);
check(
	"已绑定的地址再点图标 → 只说明现状，不再提供「设为服务地址」",
	(await barText()).includes("已绑定") && (await bindBtnHidden()),
	(await barText()).slice(0, 60),
);
check(
	"重复注入不叠出第二条浮条",
	(await piPage.$$("#pi-page-picker-bind-host")).length === 1,
	`${(await piPage.$$("#pi-page-picker-bind-host")).length} 条`,
);

// 绑定完必须**真的能投**（否则绑定只是改了个字符串）
await ta.fill("");
const afterBindDeliver = await bridge({ type: "page-picker:picked", payload: multi.payload });
check(
	"绑定之后拾取照常投递（新地址真的在用）",
	afterBindDeliver?.ok === true,
	JSON.stringify(afterBindDeliver?.message),
);
const landed2 = await piPage
	.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("### 网页元素拾取"), null, {
		timeout: 3000,
	})
	.then(() => true)
	.catch(() => false);
check("绑定后的内容落在输入框里", landed2);

check("夹具页全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

// ====================== 场景 8：多选生效（「信息太多」时只发勾了的那几类）
await ta.fill("");
fakeStorage.sections = ["selector", "source"]; // 只要定位 + 源码位置
await injectPicker();
await fx.click("#card");
await fx.keyboard.press("Control+Enter");
await fx.waitForTimeout(600);
const lean = delivered.at(-1)?.text ?? "";
check("多选：勾了的（选择器/源码）在", lean.includes("- 选择器：") && lean.includes("- 源码："), "");
check(
	"多选：没勾的（CSS 规则 / 计算样式 / HTML 骨架 / XPath）整段不出现",
	!lean.includes("命中的 CSS") &&
		!lean.includes("计算样式") &&
		!lean.includes("HTML 骨架") &&
		!lean.includes("- XPath："),
	lean.split(String.fromCharCode(10)).slice(0, 3).join(" | "),
);
check("多选：Markdown 也真的投进了输入框", (await ta.inputValue()).includes("- 选择器："));
fakeStorage.sections = ["page", "selector", "source", "text", "rules", "styles", "skeleton"]; // 还原

// ================================ 场景 7：浮条自己认页面（background 探测失败也不能「什么都没发生」）
// 真动机：MAIN world 探测可能被 CSP/权限挡住 —— 那时 background 照样注入浮条，
// 浮条自认不是 pi-web-ui 就得自己退场，并请 worker 补注入拾取器。
fx.on("pageerror", (e) => jsErrors.push(String(e)));
await fx.addScriptTag({ path: BIND_BUNDLE });
await fx.waitForTimeout(400);
check(
	"非 pi-web-ui 页面上：浮条自己退场（不闪空卡片、不留下垃圾 DOM）",
	(await fx.$("#pi-page-picker-bind-host")) === null,
);
check(
	"退场时请 worker 补注入拾取器（用户不会得到「点了没反应」）",
	bridgeLog.some((m) => m.type === "page-picker:pick-anyway"),
);
check("夹具页仍然无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

await browser.close();
fixture.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
