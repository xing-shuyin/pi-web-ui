import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = realpathSync(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-flash-"));
const A = join(base, "proj-a");
const B = join(base, "proj-b");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [A, B, dataDir, agentDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(B, "b.txt"), "b");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const mock = createServer(async (req, res) => {
	for await (const _chunk of req) {
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "flash-mock",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "flash-mock",
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	chunk("ok");
	res.write(
		`data: ${JSON.stringify({
			id: "flash-mock",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: "flash-mock",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const MOCK_PORT = mock.address().port;
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ m: { type: "api_key", key: "flash" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			m: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "flash",
				models: [{ id: "flash-1", name: "Flash" }],
			},
		},
	}),
);

const PORT = 8952;
try {
	await freePort(PORT);
} catch {}
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: A,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});
for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

try {
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector("textarea", { timeout: 20000 });
	await sleep(800);
	const skip = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skip.isVisible().catch(() => false)) await skip.click();

	const prompt = async (text) => {
		await page.locator("textarea").first().fill(text);
		await page.keyboard.press("Enter");
		await sleep(2500);
	};
	const switchTo = async (path) => {
		await page.locator(".status-cwd").click();
		await page.locator(".status-cwd-input").fill(path);
		await page.keyboard.press("Enter");
		await sleep(3000);
	};
	const recordFrames = () =>
		page.evaluate(() => {
			window.__frames = [];
			const root = document.querySelector(".panel-left");
			const snap = () =>
				window.__frames.push({
					titles: [...root.querySelectorAll(".panel-conv-group-title")].map((el) => el.textContent),
					rows: root.querySelectorAll(".panel-convs .session-item").length,
					cwd: document.querySelector(".status-cwd")?.textContent ?? "",
				});
			snap();
			new MutationObserver(snap).observe(root, { childList: true, subtree: true, characterData: true });
		});
	const frames = () =>
		page.evaluate(() =>
			window.__frames.map((f) => ({
				...f,
				wantsTitle: !f.cwd.includes(f.titles.find?.((t) => t) ?? "\u0000"),
			})),
		);

	await prompt("A 里第一条消息");
	await page.waitForSelector(".panel-convs .session-item", { timeout: 15000 });
	const aFrames = await page.evaluate(() => {
		const root = document.querySelector(".panel-left");
		return {
			rows: root.querySelectorAll(".panel-convs .session-item").length,
			titles: [...root.querySelectorAll(".panel-conv-group-title")].map((el) => el.textContent),
		};
	});
	check("A 的当前对话进了「运行的对话」", aFrames.rows === 1, `rows=${aFrames.rows}`);
	check("当前项目不显示组标题", aFrames.titles.length === 0, JSON.stringify(aFrames.titles));

	await switchTo(B);
	await prompt("B 里第一条消息");
	await page.waitForFunction(() => document.querySelectorAll(".panel-convs .session-item").length === 1, null, {
		timeout: 15000,
	});

	await recordFrames();
	await switchTo(A);
	const backFrames = await page.evaluate(() => window.__frames);
	check(
		"切回 A 期间从未渲染过组标题（不再闪项目名）",
		backFrames.every((f) => f.titles.length === 0),
		JSON.stringify(backFrames.filter((f) => f.titles.length > 0).slice(0, 3)),
	);
	check(
		"全程只有一行（A 的当前对话）",
		backFrames.every((f) => f.rows <= 1),
		JSON.stringify(backFrames.slice(0, 3)),
	);

	await recordFrames();
	await switchTo(B);
	const forthFrames = await page.evaluate(() => window.__frames);
	check(
		"切到 B 期间同样没有组标题",
		forthFrames.every((f) => f.titles.length === 0),
		JSON.stringify(forthFrames.filter((f) => f.titles.length > 0).slice(0, 3)),
	);

	const finalState = await page.evaluate(() => {
		const root = document.querySelector(".panel-left");
		return {
			rows: root.querySelectorAll(".panel-convs .session-item").length,
			titles: [...root.querySelectorAll(".panel-conv-group-title")].map((el) => el.textContent),
			current: [...root.querySelectorAll(".panel-convs .session-sub")].map((el) => el.textContent),
		};
	});
	check("切完后只有一行", finalState.rows === 1, `rows=${finalState.rows}`);
	check(
		"那行标着「当前」",
		finalState.current.some((s) => s?.includes("当前")),
		JSON.stringify(finalState.current),
	);
	check("没有残留组标题", finalState.titles.length === 0, JSON.stringify(finalState.titles));
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	await browser.close();
	server.kill();
	mock.close();
}

console.log(failures === 0 && !process.exitCode ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? (process.exitCode ?? 0) : 1;
