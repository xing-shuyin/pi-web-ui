// 真实浏览器与本地模型服务：选区、引用卡片、发送、刷新、编辑重问；不访问真实模型。
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
let activePage;
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
		const independentResponse = await fetch(`http://127.0.0.1:${port}/api/quick-ask`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "独立API测试" }], fallbackModel: "local/quote-test" }),
		});
		assert(independentResponse.ok, JSON.stringify(await independentResponse.json()));
		assert.equal(requests[0].messages.length, 1);
		requests.length = 0;
		console.log("✓ 无主对话时随手问API可独立调用模型");
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
		activePage = page;
		const errors = [];
		const sessionReady = new Promise((resolve) => {
			page.on("websocket", (socket) =>
				socket.on("framereceived", ({ payload }) => {
					try {
						const message = JSON.parse(String(payload));
						if (message.type === "snapshot" && message.state?.sessionId && message.state?.model) resolve();
					} catch {}
				}),
			);
		});
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${port}`);
		const input = page.locator(".inputbox textarea");
		await input.waitFor();
		await Promise.race([
			sessionReady,
			sleep(15000).then(() => {
				throw new Error("No ready session snapshot");
			}),
		]);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await input.fill("生成测试内容");
		await page.waitForFunction(() => document.querySelector(".inputbox .send")?.disabled === false);
		await page.locator(".inputbox .send").click();
		const source = page.locator(".msg-assistant .msg-text").first();
		await source.waitFor({ timeout: 15000 });
		await page.waitForFunction(() => !document.querySelector(".msg-assistant .cursor"));
		await input.fill("保留正在编辑的问题");

		const select = async (selector) => {
			await page.locator(selector).first().scrollIntoViewIfNeeded();
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			return page.evaluate((target) => {
				const element = document.querySelector(target);
				element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
				element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
				const range = document.createRange();
				range.selectNodeContents(element);
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
				return selection.toString();
			}, selector);
		};
		await page.locator(".inputbox .send").waitFor();
		const mainMessageCount = await page.locator(".messages .msg").count();
		const composerDraft = "保留主对话草稿";
		await input.fill(composerDraft);
		await select(".msg-assistant .msg-text pre");
		const readingScroll = await page.locator(".messages").evaluate((element) => element.scrollTop);
		await page.locator(".selection-explain-trigger").click();
		const popup = page.getByRole("dialog", { name: "随手问", exact: true });
		await popup.locator(".quick-ask-assistant").waitFor();
		assert.equal(requests.length, 2);
		assert.equal(requests[1].messages.length, 1, JSON.stringify(requests[1]));
		assert(JSON.stringify(requests[1].messages[0]).includes("解释下: "));
		assert(JSON.stringify(requests[1].messages[0]).includes("console.log"));
		assert(!requests[1].tools?.length, "quick ask must not expose agent tools");
		assert.equal(await input.inputValue(), composerDraft);
		assert.equal(await page.locator(".messages .msg").count(), mainMessageCount);
		assert.equal(await page.locator(".messages").evaluate((element) => element.scrollTop), readingScroll);
		await input.click();
		assert.equal(await popup.isVisible(), true, "reading the main conversation should keep the window open");
		console.log("✓ 选中文字在独立小窗解释，不携带主对话上下文或工具，不改变草稿与阅读位置");

		const quickInput = popup.locator("textarea");
		await quickInput.fill("继续说明上一条");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").nth(1).waitFor();
		assert.equal(requests.length, 3);
		assert.equal(requests[2].messages.length, 3, "follow-ups use only the popup's own history");
		await popup.getByRole("button", { name: "新话题", exact: true }).click();
		assert.equal(await popup.locator(".quick-ask-message").count(), 0);
		await quickInput.fill("新话题测试");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").waitFor();
		assert.equal(requests[3].messages.length, 1);
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await page.getByRole("button", { name: "打开随手问", exact: true }).click();
		assert.equal(
			await popup.locator(".quick-ask-assistant").count(),
			1,
			"closing and reopening preserves popup history",
		);
		console.log("✓ 小窗连续追问、新话题清空与关闭后重新打开保留独立上下文");

		await quickInput.fill("慢回复随手问");
		await quickInput.press("Enter");
		await popup.getByRole("button", { name: "停止生成", exact: true }).waitFor();
		await popup.getByRole("button", { name: "新话题", exact: true }).click();
		await quickInput.fill("重置后只回答这条");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").waitFor();
		await sleep(5200);
		assert.equal(await popup.locator(".quick-ask-assistant").count(), 1);
		assert.equal(await popup.locator(".quick-ask-user").count(), 1);
		assert.equal(requests.at(-1).messages.length, 1);
		assert.equal(await page.locator(".messages .msg").count(), mainMessageCount);
		assert.equal(await input.inputValue(), composerDraft);
		const rect = await popup.boundingBox();
		assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1200);
		console.log("✓ 生成中重置取消旧请求，无过期结果污染");
		if (process.env.PI_QUICK_ASK_SCREENSHOT) await page.screenshot({ path: process.env.PI_QUICK_ASK_SCREENSHOT });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(100);
		const mobileRect = await popup.boundingBox();
		assert(mobileRect && mobileRect.x >= 0 && mobileRect.y >= 0 && mobileRect.x + mobileRect.width <= 390);
		await quickInput.fill("手机上继续提问");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").nth(1).waitFor();
		assert.equal(requests.at(-1).messages.length, 3);
		if (process.env.PI_QUICK_ASK_MOBILE_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_MOBILE_SCREENSHOT });
		console.log("✓ 手机小窗不越界，可继续追问");
		await page.keyboard.press("Escape");
		await popup.waitFor({ state: "detached" });
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "随手问", exact: true }).click();
		const quickSettings = page
			.locator(".set-section")
			.filter({ has: page.locator(".set-section-title", { hasText: /^随手问$/ }) });
		await quickSettings.getByLabel("随手问模型", { exact: true }).selectOption("local/quote-test");
		await quickSettings.getByLabel("思考强度", { exact: true }).selectOption("low");
		await quickSettings.getByLabel("系统提示词", { exact: true }).fill("仅供小窗的系统提示");
		await quickSettings.getByLabel("选中文字解释模板", { exact: true }).fill("简明解释: {{input}}");
		await quickSettings.getByLabel("显示常驻入口", { exact: true }).uncheck();
		await page.keyboard.press("Escape");
		await page.locator(".quick-ask-launcher").waitFor({ state: "detached", timeout: 5000 });
		await page.reload();
		await input.waitFor();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "随手问", exact: true }).click();
		assert.equal(await quickSettings.getByLabel("随手问模型", { exact: true }).inputValue(), "local/quote-test");
		assert.equal(await quickSettings.getByLabel("思考强度", { exact: true }).inputValue(), "low");
		assert.equal(await quickSettings.getByLabel("系统提示词", { exact: true }).inputValue(), "仅供小窗的系统提示");
		assert.equal(
			await quickSettings.getByLabel("选中文字解释模板", { exact: true }).inputValue(),
			"简明解释: {{input}}",
		);
		assert.equal(await quickSettings.getByLabel("显示常驻入口", { exact: true }).isChecked(), false);
		await page.keyboard.press("Escape");
		await select(".msg-assistant .msg-text pre");
		await page.locator(".selection-explain-trigger").click();
		await popup.locator(".quick-ask-assistant").waitFor();
		const configuredRequest = requests.at(-1);
		assert.equal(configuredRequest.messages.length, 2);
		assert.equal(configuredRequest.messages[0].role, "system");
		assert.equal(configuredRequest.messages[0].content, "仅供小窗的系统提示");
		assert(JSON.stringify(configuredRequest.messages[1]).includes("简明解释: "));
		assert(!configuredRequest.tools?.length);
		console.log("✓ 五项独立设置可保存并在刷新后生效，隐藏入口仍可解释选中文字");
		assert.deepEqual(errors, []);
		console.log("✓ 浏览器无脚本错误");
	}
} catch (error) {
	console.error(error);
	console.error(`Model requests: ${requests.length}`);
	if (activePage)
		console.error(
			(
				await activePage
					.locator("body")
					.innerText()
					.catch(() => "")
			).slice(-5000),
		);
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
