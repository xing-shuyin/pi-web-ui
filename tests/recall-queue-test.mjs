import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MAIN_REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const REPO_ROOT = process.env.PI_TEST_REPO || MAIN_REPO;
const PORT = 8931;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(REPO_ROOT, "recall-queue-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

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
console.log(`hang model on :${HANG_PORT}`);

const base = mkdtempSync(join(tmpdir(), "piweb-recall-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(workdir, "a.txt"), "a");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
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

let server;
try {
	try {
		freePort(PORT);
	} catch {}
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
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server failed to start");

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(`http://127.0.0.1:${PORT}`);
	await page.waitForSelector("textarea", { timeout: 20000 });
	await sleep(1200);
	await page.screenshot({ path: join(base, "recall-0-boot.png") });

	await page.locator("textarea").fill("主问题（hang 住别回）");
	await page.keyboard.press("Enter");
	const streaming = await page
		.waitForSelector(".btn.stop", { timeout: 45000 })
		.then(() => true)
		.catch(() => false);
	check("streaming 开始（假模型 hang 住）", streaming);
	if (!streaming) {
		await page.screenshot({ path: join(base, "recall-FAIL-nostream.png") });
		throw new Error("no streaming — check screenshot recall-FAIL-nostream.png");
	}

	const queuedCount = () => page.locator(".msg-queued").count();
	const recallBtns = () => page.locator(".msg-queued-recall");
	const inputVal = () => page.locator("textarea").inputValue();

	await page.locator("textarea").fill("第一条排队内容");
	await page.locator(".split-queue").click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 1, null, { timeout: 10000 });
	check("排队气泡出现", (await queuedCount()) === 1);
	check(
		"↩ 与 ✕ 同时存在",
		(await recallBtns().count()) === 1 && (await page.locator(".msg-queued-remove").count()) === 1,
	);
	const rb = await recallBtns().first().boundingBox();
	const xb = await page.locator(".msg-queued-remove").first().boundingBox();
	check("↩ 在 ✕ 左边", !!(rb && xb && rb.x + rb.width <= xb.x + 1), `recall.x=${rb?.x} remove.x=${xb?.x}`);
	await page.screenshot({ path: join(base, "recall-1-queued.png") });

	await recallBtns().first().click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 0, null, { timeout: 10000 });
	check("撤回后气泡消失", (await queuedCount()) === 0);
	check("文字落回输入框", (await inputVal()) === "第一条排队内容", JSON.stringify(await inputVal()));
	const focused = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
	check("输入框获焦", focused);
	const cursor = await page.evaluate(() => {
		const ta = document.querySelector("textarea");
		return ta ? [ta.selectionStart, ta.selectionEnd, ta.value.length] : null;
	});
	check("光标在末尾", !!cursor && cursor[0] === cursor[1] && cursor[1] === cursor[2], JSON.stringify(cursor));
	await page.screenshot({ path: join(base, "recall-2-recalled.png") });

	await page.locator("textarea").fill("");
	await page.locator("textarea").fill("第二条内容");
	await page.locator(".split-queue").click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 1, null, { timeout: 10000 });
	await page.locator("textarea").fill("正在打的字");
	await recallBtns().first().click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 0, null, { timeout: 10000 });
	const v5 = await inputVal();
	check("非空追加（单换行分隔、不覆盖手打）", v5 === "正在打的字\n第二条内容", JSON.stringify(v5));

	await page.locator("textarea").fill("");
	await page.locator("textarea").fill("连A");
	await page.locator(".split-queue").click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 1, null, { timeout: 10000 });
	await page.locator("textarea").fill("连B");
	await page.locator(".split-queue").click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 2, null, { timeout: 10000 });
	const btns = () => page.locator(".msg-queued-recall");
	await btns().nth(0).click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 1, null, { timeout: 10000 });
	await btns().nth(0).click();
	await page.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 0, null, { timeout: 10000 });
	const v6 = await inputVal();
	check("连续撤回两条都回来且有序", v6 === "连A\n连B", JSON.stringify(v6));
	await page.screenshot({ path: join(base, "recall-3-multi.png") });

	const mobCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const mob = await mobCtx.newPage();
	await mob.goto(`http://127.0.0.1:${PORT}`);
	await mob.waitForSelector("textarea", { timeout: 20000 });
	await sleep(1000);
	await mob.locator("textarea").fill("主问题mobile（hang住）");
	await mob.keyboard.press("Enter");
	const mobStreaming = await mob
		.waitForSelector(".btn.stop", { timeout: 45000 })
		.then(() => true)
		.catch(() => false);
	check("手机端 streaming 开始", mobStreaming);
	if (mobStreaming) {
		await mob.locator("textarea").fill("手机端一条");
		await mob.locator(".split-queue").click();
		await mob
			.waitForFunction(() => document.querySelectorAll(".msg-queued").length >= 1, null, { timeout: 10000 })
			.catch(() => {});
		const n = await mob.locator(".msg-queued").count();
		check("手机端排队气泡渲染", n >= 1, `count=${n}`);
		await mob.screenshot({ path: join(base, "recall-4-mobile.png") });
		if (n >= 1) {
			await mob.locator(".msg-queued-recall").first().click();
			await mob
				.waitForFunction(() => document.querySelectorAll(".msg-queued").length === 0, null, { timeout: 10000 })
				.catch(() => {});
			check("手机端撤回落字", (await mob.locator("textarea").inputValue()) === "手机端一条");
		}
	}

	await browser.close();
	server.kill("SIGKILL");
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	hang.close();
	try {
		freePort(PORT);
	} catch {}
}
