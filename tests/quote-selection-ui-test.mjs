import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "piweb-quote-"));
const agentDir = join(base, "agent");
const workDir = join(base, "work");
mkdirSync(agentDir);
mkdirSync(workDir);
const requests = [];
const reply = "引用功能测试正文。\n\n```js\nconst value = 1;\n  console.log(value);\n```\n\n第二个可引用片段。";
const modelServer = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	requests.push(JSON.parse(raw));
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "quote-reply", object: "chat.completion.chunk", created: 1, model: "quote-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	chunk({ role: "assistant", content: reply });
	const latest = requests.at(-1).messages.at(-1);
	if (JSON.stringify(latest).includes("慢回复")) await sleep(5000);
	chunk({}, "stop");
	res.end("data: [DONE]\n\n");
});
let server;
let browser;
let port;
let logs = "";

async function reservePort() {
	const probe = createServer();
	await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const value = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
	assert(value >= 8900);
	return value;
}

try {
	if (!CHROME_PATH) {
		console.log("SKIP: 未找到 Chrome");
	} else {
		await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "test" } }));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						api: "openai-completions",
						baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
						apiKey: "test",
						models: [{ id: "quote-test", name: "Quote Test", contextWindow: 128000, maxTokens: 4096 }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "quote-test" }),
		);
		port = await reservePort();
		assert.equal(await portUp(port), false);
		server = spawn(process.execPath, ["dist/server/index.js"], {
			cwd: root,
			env: {
				...process.env,
				PI_WEB_PORT: String(port),
				PI_WEB_CWD: workDir,
				PI_WEB_DATA_DIR: join(base, "data"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_WEB_REMOTE_CATALOG_SYNC: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		server.stdout.on("data", (data) => {
			logs += data.toString();
		});
		server.stderr.on("data", (data) => {
			logs += data.toString();
		});
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
			} catch {}
			if (ready) break;
			await sleep(200);
		}
		assert(ready, logs);
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${port}`);
		const input = page.locator(".inputbox textarea");
		await input.waitFor();
		await input.fill("生成测试内容");
		await page.waitForFunction(() => document.querySelector(".inputbox .send")?.disabled === false);
		await input.press("Enter");
		const source = page.locator(".msg-assistant .msg-text").first();
		await source.waitFor({ timeout: 15000 });
		await page.waitForFunction(() => !document.querySelector(".msg-assistant .cursor"));
		await input.fill("保留正在编辑的问题");

		const select = async (selector) => {
			await page.locator(selector).first().scrollIntoViewIfNeeded();
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			return page.evaluate((target) => {
				const element = document.querySelector(target);
				const range = document.createRange();
				range.selectNodeContents(element);
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
				return selection.toString();
			}, selector);
		};
		const quoteButton = page.locator(".quote-selection-button").first();
		const codeText = await select(".msg-assistant .msg-text pre");
		await quoteButton.waitFor({ timeout: 3000 });
		await quoteButton.click();
		assert.equal(await input.inputValue(), "保留正在编辑的问题");
		assert.equal(await page.locator(".quote-card").count(), 1);
		await page.locator(".quote-card summary").click();
		assert.equal(await page.locator(".quote-card pre").textContent(), codeText);
		assert(codeText.includes("  console.log(value);"), JSON.stringify(codeText));
		mkdirSync(join(root, "tests/scratch"), { recursive: true });
		await page.screenshot({ path: join(root, "tests/scratch/quote-selection.png") });
		console.log("✓ 选中代码后添加引用，保留原文缩进与输入框草稿");

		await select(".msg-assistant .msg-text pre");
		await quoteButton.click();
		assert.equal(await page.locator(".quote-card").count(), 1);
		const secondText = await select(".msg-assistant .msg-text p");
		await quoteButton.click();
		assert.equal(await page.locator(".quote-card").count(), 2);
		await page.locator(".quote-card .quote-remove").last().click();
		assert.equal(await page.locator(".quote-card").count(), 1);
		console.log("✓ 同一引用去重，多条引用可独立移除");

		await select(".msg-assistant .msg-text p");
		await page.keyboard.press("Escape");
		assert.equal(await quoteButton.count(), 0);
		await select(".msg-assistant .msg-text p");
		await page.locator(".messages").evaluate((element) => element.dispatchEvent(new Event("scroll")));
		assert.equal(await quoteButton.count(), 0);
		console.log("✓ Escape 和滚动隐藏选区按钮");

		await input.fill("解释引用代码");
		await input.press("Enter");
		await page.waitForFunction(() => document.querySelectorAll(".messages .quote-card").length === 1);
		for (let i = 0; i < 60 && requests.length < 2; i++) await sleep(100);
		assert.equal(requests.length, 2);
		const quoted = requests[1].messages
			.flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).map((b) => b.text ?? "")))
			.find((text) => text.includes("<quoted-text>"));
		assert(quoted);
		const payload = JSON.parse(quoted.match(/<quoted-text>\n([^\n]*)\n<\/quoted-text>/)[1]);
		assert.equal(payload.text, codeText);
		assert.equal(payload.role, "assistant");
		assert(payload.messageId && payload.sessionId);
		assert(!payload.text.includes(secondText));
		console.log("✓ 引用原文与来源通过真实发送链路送达模型服务");

		await page.locator(".inputbox .send").waitFor();
		await input.fill("慢回复");
		await input.press("Enter");
		await page.locator(".inputbox .stop").waitFor();
		await page.waitForFunction(() => document.querySelectorAll(".msg-assistant .msg-text pre").length === 3);
		await select(".msg-assistant .msg-text pre");
		await quoteButton.waitFor({ timeout: 2000 });
		await quoteButton.click();
		await input.fill("引用排队测试");
		await page.locator(".split-queue").click();
		await page.locator(".msg-queued .quote-card").waitFor({ timeout: 1500 });
		await page.locator(".msg-queued-recall").click();
		await page.locator(".msg-queued").waitFor({ state: "detached" });
		assert.equal(await input.inputValue(), "引用排队测试");
		assert.equal(await page.locator(".inputbar .quote-card").count(), 1);
		await page.locator(".split-queue").click();
		for (let i = 0; i < 100 && requests.length < 4; i++) await sleep(100);
		assert.equal(requests.length, 4);
		const queuedQuestion = requests[3].messages.findLast((message) => message.role === "user");
		assert(JSON.stringify(queuedQuestion).includes("<quoted-text>"), JSON.stringify(queuedQuestion));
		console.log("✓ 生成期间排队、撤回重发保留引用与对应问题");

		await page.locator(".inputbox .send").waitFor();
		await input.fill("慢回复插队测试");
		await input.press("Enter");
		await page.locator(".inputbox .stop").waitFor();
		await page.waitForFunction(() => document.querySelectorAll(".msg-assistant .msg-text pre").length === 5);
		await select(".msg-assistant .msg-text pre");
		await quoteButton.click();
		await page.locator(".split-steer").click();
		await page.locator(".msg-queued .quote-card").waitFor({ timeout: 1500 });
		for (let i = 0; i < 100 && requests.length < 6; i++) await sleep(100);
		assert.equal(requests.length, 6);
		assert(
			JSON.stringify(requests[5].messages.findLast((message) => message.role === "user")).includes("<quoted-text>"),
		);
		console.log("✓ 生成期间仅发送引用的插队消息送达模型服务");

		await page.reload();
		await page.locator(".messages .quote-card").first().waitFor();
		await page.locator(".messages .quote-card summary").first().click();
		assert.equal(await page.locator(".messages .quote-card pre").first().textContent(), codeText);
		const question = page.locator(".msg-user").filter({ hasText: "解释引用代码" });
		await question.hover();
		await question.locator(".msg-action").filter({ hasText: "编辑" }).click();
		assert((await question.locator(".msg-editor").textContent()).includes(codeText.trim()));
		console.log("✓ 刷新后保留引用，编辑重问恢复原引用");
		const editor = page.locator(".msg-editor");
		await editor.locator("textarea").fill("");
		assert.equal(await editor.locator(".primary").isEnabled(), true);
		await editor.locator(".primary").click();
		for (let i = 0; i < 100 && requests.length < 7; i++) await sleep(100);
		assert.equal(requests.length, 7);
		assert(JSON.stringify(requests[6].messages).includes("<quoted-text>"));
		console.log("✓ 编辑重问可仅发送保留的引用");
		assert.deepEqual(errors, []);
		console.log("✓ 浏览器无脚本错误");
	}
} catch (error) {
	console.error(error);
	if (logs) console.error(logs.slice(-4000));
	process.exitCode = 1;
} finally {
	await browser?.close();
	if (server && server.exitCode === null) {
		const exited = new Promise((resolve) => server.once("exit", resolve));
		server.kill();
		await Promise.race([exited, sleep(5000)]);
		if (server.exitCode === null) server.kill("SIGKILL");
	}
	modelServer.closeAllConnections();
	await new Promise((resolve) => modelServer.close(resolve));
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
