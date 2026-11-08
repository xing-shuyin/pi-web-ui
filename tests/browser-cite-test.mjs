import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 90);
const base = mkdtempSync(join(tmpdir(), "piweb-bcite-"));
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

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

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
		const res = await fetch(`http://localhost:${PORT}/api/health`);
		if (res.ok) {
			up = true;
			break;
		}
	} catch {}
	await sleep(250);
}
if (!up) {
	console.log("✗ 服务端未起来，跳过");
	server.kill();
	process.exit(1);
}

const PAGE_A = { origin: "https://a.example", title: "A 页面标题", open: true };
const PAGE_B = { origin: "https://b.example", title: "B 页面标题", open: false };

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => {
	if (m.type() === "error") jsErrors.push(m.text());
});

await page.addInitScript(() => {
	globalThis.__pageFixtures = { installed: true, aiControl: true, allowEval: false, pages: [] };
	globalThis.__piBridge = {
		call: async (req) => {
			if (req?.op === "status") return { ...globalThis.__pageFixtures };
			return { ok: true };
		},
	};
});

await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".inputbox textarea", { timeout: 20000 });
await page.waitForFunction(
	() => {
		const ta = document.querySelector(".inputbox textarea");
		return ta && !ta.disabled;
	},
	{ timeout: 20000 },
);
await sleep(300);

const chips = page.locator(".attach-chip.page");
const normalBtn = page.locator(".browser-control:not(.single):not(.caret)");
const singleBtn = page.locator(".browser-control.single");
const caretBtn = page.locator(".browser-control.caret");
const panel = page.locator(".browser-control-modal");
const refreshBtn = page.locator(".browser-control-modal .bc-actions button").nth(1);

const setPages = (pages) => page.evaluate((p) => void (globalThis.__pageFixtures.pages = p), pages);
const countChips = () => chips.count();
const waitChips = (n) =>
	page
		.waitForFunction((want) => document.querySelectorAll(".attach-chip.page").length === want, n, { timeout: 3000 })
		.then(() => true)
		.catch(() => false);

check("未授权任何页面 → 普通「浏览器」按钮", (await normalBtn.count()) === 1, `${await normalBtn.count()} 个`);

await setPages([PAGE_A]);
await normalBtn.click();
await panel.waitFor({ timeout: 5000 });
await refreshBtn.click();
await sleep(300);
await page.locator(".modal-close").click();
await panel.waitFor({ state: "detached", timeout: 5000 });
check(
	"单个已授权页面 → 顶栏出现「页面按钮 + ▾」两段",
	(await singleBtn.count()) === 1 && (await caretBtn.count()) === 1,
);
check(
	"页面按钮上写的是页面标题",
	(await singleBtn.innerText()).includes("A 页面标题"),
	await singleBtn.innerText().catch(() => "?"),
);

await singleBtn.click();
check("点击后输入框出现网页引用 chip", await waitChips(1), `${await countChips()} 个`);
const chipClass = await chips.first().getAttribute("class");
check("chip 用的是 page 模式（不是 reference/inline）", chipClass.includes("page"), chipClass);
check("chip 上显示页面标题", (await chips.first().innerText()).includes("A 页面标题"), await chips.first().innerText());
check("引用不自动发送：输入框文本仍为空", (await page.locator(".inputbox textarea").inputValue()) === "");
check("有轻提示告诉用户东西去哪儿了", (await page.locator(".bc-flash").count()) === 1);

await singleBtn.click();
await sleep(250);
check("重复引用同一页面 → 去重", (await countChips()) === 1, `${await countChips()} 个`);

await chips.first().locator(".attach-remove").click();
check("chip 可删除", await waitChips(0), `${await countChips()} 个`);

await setPages([PAGE_A, PAGE_B]);
await caretBtn.click();
await panel.waitFor({ timeout: 5000 });
await refreshBtn.click();
await sleep(300);
await page.locator(".modal-close").click();
await panel.waitFor({ state: "detached", timeout: 5000 });
await sleep(200);
check("两个授权页面 → 退回普通按钮（含数量）", (await singleBtn.count()) === 0 && (await normalBtn.count()) === 1);
check("普通按钮显示页面数", (await normalBtn.innerText()).includes("2"), await normalBtn.innerText());

await normalBtn.click();
await panel.waitFor({ timeout: 5000 });
const items = page.locator(".browser-control-modal .bc-pages li");
check("面板列出两个已授权页面", (await items.count()) === 2, `${await items.count()} 项`);
check("每项都有引用按钮", (await page.locator(".browser-control-modal .bc-cite").count()) === 2);
await page.locator(".browser-control-modal .bc-cite").first().click();
check("面板里点引用 → chip 出现", await waitChips(1), `${await countChips()} 个`);
check("引用后面板仍开着（可连续引用多个）", (await panel.count()) === 1);
await page.locator(".browser-control-modal .bc-cite").nth(1).click();
check("连续引用第二个页面 → 两个 chip", await waitChips(2), `${await countChips()} 个`);

check("全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
