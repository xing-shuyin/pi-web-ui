/* Lazy windowing E2E: seeds a long chat with very tall messages via WS, then
 * verifies that messages outside the viewport+margin buffer are replaced by
 * equal-height placeholders (.msg-lazy-ph) that keep data-msg-id, that they
 * remount when scrolled near, that opening search force-renders everything,
 * and that question-nav jumps pin their target.
 * Run: npm run build && node lazy-window-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-lazywin-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
for (let i = 1; i <= 35; i++) {
	writeFileSync(join(workdir, `seed-${String(i).padStart(2, "0")}.txt`), `seed content ${i}\n`);
}
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "test-model" }],
			},
		},
	}),
);
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const CLIENT_ID = "lazy-window-test-client";
// 每条约 12000 字 → 渲染高度几千 px，足以撑出缓冲带
const TALL_TEXT = "很长的需求描述。".repeat(2000);

const server = spawn(
	process.execPath,
	[join(fileURLToPath(new URL("..", import.meta.url)), "dist", "server", "index.js")],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

/** Seed: 1 prompt with 35 attachments (→ 36 msgs) + 2 tall prompts. Resolves
 *  once the persisted message count reaches `want`. */
function seedChat(want) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 30000);
		let step = 0;
		// 协议 v2：后续快照可能是增量，本地累计消息数
		let known = 0;
		const sendNext = () => {
			if (step === 0) {
				const attachments = [];
				for (let i = 1; i <= 35; i++) attachments.push({ path: `seed-${String(i).padStart(2, "0")}.txt` });
				ws.send(
					JSON.stringify({
						type: "prompt",
						text: "请总结这些文件",
						attachments,
					}),
				);
			} else {
				ws.send(JSON.stringify({ type: "prompt", text: `${TALL_TEXT}\n\n第 ${step} 条` }));
			}
			step++;
		};
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID })));
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") return sendNext();
			let total = -1;
			if (msg.type === "snapshot") {
				known = msg.state.messages.length;
				total = known;
			} else if (msg.type === "snapshot_delta") {
				known += msg.appended?.length ?? 0;
				total = known;
			}
			if (total < 0) return;
			// 等到本步的消息都落盘再发下一条（避免并发 prompt 打断）
			if (step === 1 && total >= 36) return sendNext();
			if (step === 2 && total >= 38) return sendNext();
			if (total >= want) {
				clearTimeout(timer);
				ws.close();
				resolve(total);
			}
		});
		ws.on("error", reject);
	});
}

async function main() {
	await waitServer();
	const total = await seedChat(38);
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	await page.addInitScript((id) => localStorage.setItem("pi-web-client-id", id), CLIENT_ID);

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForSelector(".msg", { timeout: 30000 });
	await sleep(500); // 等 attach 后首帧 sweep 完成

	const phCount = () => page.locator(".msg-lazy-ph").count();
	const initialPh = await phCount();
	check("viewport-distant messages collapsed to placeholders", initialPh > 0);

	// 占位保留 data-msg-id（导航 / 跳转查询不受影响）
	const phId = await page.locator(".msg-lazy-ph").first().getAttribute("data-msg-id");
	check("placeholder keeps data-msg-id", !!phId);

	// 底部常驻区不被占位：最后一条消息一定是真实渲染
	const lastReal = await page.evaluate(() => {
		const all = document.querySelectorAll(".messages [data-msg-id]");
		const last = all[all.length - 1];
		return last?.classList.contains("msg") ?? false;
	});
	check("bottom region stays fully rendered", lastReal);

	// 记录一个占位 id，向上滚动后应恢复为真实内容
	await page.evaluate(() => {
		const el = document.querySelector(".messages");
		el.scrollTop = 0;
	});
	await sleep(600); // rAF sweep + React commit
	const restored = await page.evaluate((id) => {
		const el = document.querySelector(`[data-msg-id="${id}"]`);
		return !!el && el.classList.contains("msg");
	}, phId);
	check("scrolled-near placeholder remounts as real message", restored);
	const afterScrollPh = await phCount();
	check("far-away messages collapsed while reading the top", afterScrollPh > 0);

	// 搜索打开期间强制全渲染（兼容 Range 收集 / DOM 高亮）
	await page.keyboard.press("Control+f");
	await page.waitForSelector(".search-bar", { timeout: 5000 });
	await sleep(400);
	check("opening search force-renders all messages", (await phCount()) === 0);
	await page.keyboard.press("Escape");

	// 问题导航跳转：目标消息被 pin 成真实渲染并 flash
	const qnCount = await page.locator(".qn-bar").count();
	check("question nav rail rendered", qnCount > 0);
	const qnText = ((await page.locator(".qn-bar").first().textContent()) ?? "").replace(/^\d+\.\s*/, "");
	await page.locator(".qn-bar").first().click();
	await sleep(600);
	const jumpedOk = await page.evaluate((text) => {
		const target = [...document.querySelectorAll(".messages [data-msg-id]")].find(
			(n) =>
				// 第一个问题是最早的 user 消息
				n.getAttribute("data-role") === "user" && n.textContent.includes(text),
		);
		return !!target && target.classList.contains("msg") && target.classList.contains("msg-flash");
	}, qnText);
	check("jump pins target and flashes it", jumpedOk);

	// 贴底按钮仍工作
	await page.evaluate(() => {
		const el = document.querySelector(".messages");
		el.scrollTop = 0;
	});
	await sleep(300);
	await page.locator(".scroll-bottom").click();
	await sleep(300);
	const atBottom = await page.evaluate(() => {
		const el = document.querySelector(".messages");
		return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	});
	check("back-to-bottom button works", atBottom);

	check("no page errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) console.log("   console errors:", consoleErrors.slice(0, 3));

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
