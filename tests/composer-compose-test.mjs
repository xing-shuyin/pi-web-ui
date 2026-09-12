/* 输入框注入桥 E2E（window.__piWebUiHost.compose）：把内容塞进输入框草稿，用户补一句话
 * 再自己发 —— 浏览器元素拾取扩展走的就是这条路（plugins/page-picker）。
 *
 * 锁住的行为：
 *   1. 宿主 API 版本 ≥ 2（compose 是 v2 新增能力，旧宿主上插件会看到 undefined）
 *   2. compose({text}) 真的落进 textarea，光标跑到末尾
 *   3. **绝不覆盖用户正在打的内容** —— 追加到末尾（与「撤回消息放回输入框」同一语义）
 *   4. compose({attachments}) 追加附件 chip；同 key 去重、异 key 累加
 *   5. 文本 + 附件一次投递 → 两者同时到位
 *   6. 空内容拒收（false），不往输入框塞空行
 *   7. 全程无 JS 报错
 *
 * Run: npm run build && node tests/composer-compose-test.mjs
 */
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
const base = mkdtempSync(join(tmpdir(), "piweb-compose-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
// 假 provider（指向黑洞端口）：只为让会话就绪、输入框可编辑，不会真发请求
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

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => {
	if (m.type() === "error") jsErrors.push(m.text());
});

await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".inputbox textarea", { timeout: 20000 });
// 等连接就绪（textarea disabled={!connected}）
await page.waitForFunction(
	() => {
		const ta = document.querySelector(".inputbox textarea");
		return ta && !ta.disabled;
	},
	{ timeout: 20000 },
);
await sleep(300);

const ta = page.locator(".inputbox textarea");
const chips = page.locator(".attach-chip");

/** 等 textarea 的 value 真的变成期望值再断言。
 *  compose() 是同步返回的，但 React 的状态更新是异步提交的 —— 直接读会读到上一帧
 *  （实测偶发：断言拿到的是「用户刚打的字」而 compose 的内容还没落进 DOM）。 */
const waitValue = (expected) =>
	page
		.waitForFunction((v) => document.querySelector(".inputbox textarea")?.value === v, expected, { timeout: 3000 })
		.then(() => true)
		.catch(() => false);

/** 等附件 chip 数量。 */
const waitChips = (n) =>
	page
		.waitForFunction((want) => document.querySelectorAll(".attach-chip").length === want, n, { timeout: 3000 })
		.then(() => true)
		.catch(() => false);

const shot = (key) => ({ path: "", name: `${key}.png`, mode: "inline", imageData: "QUJD", key });

// 1) 版本号
const version = await page.evaluate(() => globalThis.__piWebUiHost?.version ?? -1);
check("宿主 API 版本 ≥ 2（compose 已暴露）", version >= 2, `version=${version}`);

// 2) 纯文本注入
let ok = await page.evaluate(() => globalThis.__piWebUiHost.compose({ text: "## 元素 1" }));
check("compose({text}) 返回 true", ok === true, `returned ${ok}`);
check("文本落进输入框", await waitValue("## 元素 1"), JSON.stringify(await ta.inputValue()));

await page.waitForTimeout(120); // 光标是 setText 之后由 rAF 设的，等一拍更稳
const caretAtEnd = await page.evaluate(() => {
	const el = document.querySelector(".inputbox textarea");
	return el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
});
check("光标移到末尾（接着就能补充问题）", caretAtEnd === true);

// 3) 绝不覆盖用户正在打的内容
// 注意：受控 textarea 上不能用 fill("文本") —— Playwright 的「选中→插入」之间 React 会
// 重渲染，选区丢失后变成追加（测试自身的坑，与 compose 无关）。清空用 fill("")，
// 打用户内容用 pressSequentially（逐字 → 每个字符都过 React state）。
await ta.fill("");
await ta.pressSequentially("这个卡片跟上面那个");
await page.evaluate(() => globalThis.__piWebUiHost.compose({ text: "### 元素 2\n间距不一致" }));
const expectMerged = "这个卡片跟上面那个\n### 元素 2\n间距不一致";
check("追加而非覆盖，用户已打的字原样保留", await waitValue(expectMerged), JSON.stringify(await ta.inputValue()));

// 4) 附件注入 + 同 key 去重
await ta.fill("");
ok = await page.evaluate((s) => globalThis.__piWebUiHost.compose({ attachments: [s] }), shot("pick-1"));
check("compose({attachments}) 返回 true", ok === true);
check("附件 chip 出现", await waitChips(1), `${await chips.count()} 个`);

await page.evaluate((s) => globalThis.__piWebUiHost.compose({ attachments: [s] }), shot("pick-1"));
await sleep(200); // 去重是「注入了但没变化」，没有可等的目标 → 只能给一拍
check("同 key 重复注入 → 去重（不叠成两个）", (await chips.count()) === 1, `${await chips.count()} 个`);

await page.evaluate((s) => globalThis.__piWebUiHost.compose({ attachments: [s] }), shot("pick-2"));
check("不同 key → 累加", await waitChips(2), `${await chips.count()} 个`);

// 4b) 附件追加不能吃掉用户已 attach 的东西
check("注入的附件与已有 chip 共存（count 未回退）", (await chips.count()) === 2);

// 5) 文本 + 附件一次投递
await ta.fill("");
const before = await chips.count();
ok = await page.evaluate((s) => globalThis.__piWebUiHost.compose({ text: "看这个", attachments: [s] }), shot("pick-3"));
check("文本 + 附件一次投递 → 返回 true", ok === true);
check("文本到位", await waitValue("看这个"), JSON.stringify(await ta.inputValue()));
check("附件到位", await waitChips(before + 1), `${await chips.count()} 个`);

// 6) 空内容拒收
const emptyResults = await page.evaluate(() => [
	globalThis.__piWebUiHost.compose({}),
	globalThis.__piWebUiHost.compose({ text: "   " }),
	globalThis.__piWebUiHost.compose({ text: "", attachments: [] }),
]);
await sleep(150);
check(
	"空内容 / 全空白文本 → 全部拒收 false",
	emptyResults.every((r) => r === false),
	JSON.stringify(emptyResults),
);
check("拒收后输入框没被塞空行", await waitValue("看这个"), JSON.stringify(await ta.inputValue()));

// 7) 脏入参不炸页面
const dirty = await page.evaluate(() => {
	const host = globalThis.__piWebUiHost;
	try {
		return [host.compose(null), host.compose({ text: 42, attachments: "nope" })];
	} catch (e) {
		return [`threw: ${e}`];
	}
});
check("脏入参不抛错（返回 false 或静默容忍）", typeof dirty[0] !== "string", JSON.stringify(dirty));

check("全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
