/**
 * Left-panel layout: the running-conversations list is pinned above the
 * scrolling history; both section titles live OUTSIDE the scroll container.
 * (Blank new chats stay OUT of the running list — so with nothing but blank
 * chats the section stays hidden — while the ACTIVE chat shows up there as
 * soon as it has content, issue #140; the last section asserts both halves.)
 *
 * 零 token：本地起一个「永不回包」的假模型（同 recall-queue-test），制造流式窗口。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;
const base = mkdtempSync(join(tmpdir(), "pi-layout-"));
const WS = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
mkdirSync(WS, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(join(WS, "a.txt"), "a");

// 假模型：GET 正常回（防启动模型刷新卡死），POST 永不回包（制造流式窗口）。
const hang = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [] }));
		return;
	}
	req.socket.on("error", () => {});
});
await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const HANG_PORT = hang.address().port;
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ hang: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			hang: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${HANG_PORT}`,
				apiKey: "dummy",
				models: [{ id: "hang-1", name: "Hang" }],
			},
		},
	}),
);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(PROJ, "panel-layout-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WS,
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_CODING_AGENT_DIR: AGENT_DIR,
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });
await sleep(800);

// 1. Single conversation → history title exists, no convs section.
const histTitles = await page.locator(".panel-sessions .panel-section-title").allTextContents();
check(
	"history title present",
	histTitles.some((t) => t.includes("历史")),
);
check("no convs section yet", (await page.locator(".panel-left .panel-convs").count()) === 0);

// 2. Two more new chats (still never ran, never displaced while streaming):
//    the running-conversations section must STAY hidden by design.
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(900);
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.includes("新对话"));
	btn?.click();
});
await sleep(900);

check("convs section still absent (no background run)", (await page.locator(".panel-left .panel-convs").count()) === 0);
const convTitles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"no 运行的对话 title without listed conversations",
	!convTitles.some((t) => t.includes("运行的对话")),
	convTitles.join("|"),
);

// 3. Structure: history title must be OUTSIDE the scroll container.
const historyTitleInsideScroll = await page.locator(".panel-sessions .sessions-scroll .panel-section-title").count();
check(
	"history title NOT inside the scroll container",
	historyTitleInsideScroll === 0,
	`inside=${historyTitleInsideScroll}`,
);

// 4. Scroll behavior: sessions-scroll is the scrolling area.
const styles = await page.evaluate(() => {
	const ss = document.querySelector(".sessions-scroll");
	const gs = getComputedStyle;
	return {
		sessionsScrollOverflow: ss ? gs(ss).overflowY : "missing",
		sessionsFlex: document.querySelector(".panel-sessions")
			? gs(document.querySelector(".panel-sessions")).flex
			: "missing",
	};
});
check("sessions-scroll is the scrolling area", styles.sessionsScrollOverflow === "auto");

// 5. Titles must not move when the sessions list scrolls.
const before = await page.evaluate(() => {
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
const after = await page.evaluate(async () => {
	const sc = document.querySelector(".sessions-scroll");
	if (sc) sc.scrollTop = 300;
	await new Promise((r) => setTimeout(r, 200));
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
check("history title stays fixed after scroll", before !== null && before === after, `top=${before}→${after}`);

// 6. issue #140：当前对话一旦有内容就在「运行的对话」里（还在流式输出时也要有）
//    —— 假模型不回包，所以只看到 streaming 那一帧就行。
await page.locator("textarea").first().fill("SLOW 第一条消息");
await page.keyboard.press("Enter");
const convsAppeared = await page
	.waitForSelector(".panel-left .panel-convs", { timeout: 20000 })
	.then(() => true)
	.catch(() => false);
check("running-conversations section appears for the active chat with content", convsAppeared);
const titlesNow = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"运行的对话 title is rendered now",
	titlesNow.some((t) => t.includes("运行的对话")),
	titlesNow.join("|"),
);
check(
	"the row is the row of the chat we are looking at (当前)",
	(await page.locator(".panel-convs .session-item .session-sub").allTextContents()).some((s) => s.includes("当前")),
);
// 行一出现（用户消息入库）不等于运行已进入流式：服务端启动 run 后才置 isStreaming，所以等待标记出现，
// 而不是行一出现就立刻计数（假模型永不回包，标记会一直保留）。
const streamingShown = await page
	.waitForSelector(".panel-convs .session-item.is-running", { timeout: 15000 })
	.then(() => true)
	.catch(() => false);
check("the row shows the streaming indicator while the run is in flight", streamingShown);
check(
	"only that one row is listed (blank chats stay out)",
	(await page.locator(".panel-convs .session-item").count()) === 1,
);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
