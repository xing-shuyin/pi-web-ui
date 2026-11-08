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
mkdirSync(join(workDir, "docs"));
writeFileSync(join(workDir, "README.md"), "REFERENCE_FILE_MARKER: this file was explicitly selected.");
writeFileSync(join(workDir, "docs", "guide.md"), "DIRECTORY_FILE_MARKER: this is the selected folder content.");
const requests = [];
const reply =
	"引用功能测试正文。\n\n```js\nconst value = 1;\n  console.log(value);\n```\n\n第二个可引用片段。\n\nA command-line interface lets you interact with your computer using text commands.";
const modelServer = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	requests.push(JSON.parse(raw));
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "quote-reply", object: "chat.completion.chunk", created: 1, model: "quote-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	const latest = requests.at(-1).messages.at(-1);
	const incremental = JSON.stringify(latest).includes("流式验证");
	const translated = JSON.stringify(latest).includes("Translation style:");
	const answer = translated
		? JSON.stringify(latest).includes("Japanese")
			? "文字コマンドでコンピューターを操作できます。"
			: JSON.stringify(latest).includes("English")
				? "A command-line interface lets you operate your computer using text commands."
				: "命令行界面让你通过文字命令操作电脑。"
		: reply;
	chunk({ role: "assistant", content: incremental ? answer.slice(0, 12) : answer });
	if (incremental) {
		await sleep(1200);
		chunk({ content: answer.slice(12) });
	}
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
						models: [
							{
								id: "quote-test",
								name: "Quote Test",
								input: ["text", "image"],
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
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
		await page.addInitScript(() => {
			const NativeWebSocket = window.WebSocket;
			window.__quickAskHoldSettings = sessionStorage.getItem("quick-ask-settings-ready") !== "1";
			window.__quickAskHeldSettings = [];
			window.WebSocket = class extends NativeWebSocket {
				constructor(...args) {
					super(...args);
					this.addEventListener("message", (event) => {
						try {
							if (window.__quickAskHoldSettings && JSON.parse(event.data).type === "settings_state") {
								event.stopImmediatePropagation();
								window.__quickAskHeldSettings.push({ socket: this, data: event.data });
							}
						} catch {}
					});
				}
			};
		});
		const errors = [];
		let markMainTurnReady;
		const mainTurnReady = new Promise((resolve) => {
			markMainTurnReady = resolve;
		});
		const sessionReady = new Promise((resolve) => {
			page.on("websocket", (socket) =>
				socket.on("framereceived", ({ payload }) => {
					try {
						const message = JSON.parse(String(payload));
						if (message.type === "snapshot" && message.state?.sessionId && message.state?.model) resolve();
						if (
							message.type === "snapshot" &&
							!message.state?.isStreaming &&
							!message.state?.streamingMessage &&
							message.state?.messages?.some((entry) => entry.role === "assistant")
						)
							markMainTurnReady();
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
		await page.waitForFunction(
			() =>
				!document.querySelector(".msg-assistant .cursor") &&
				document.querySelector(".msg-assistant .msg-text pre")?.textContent.includes("console.log"),
		);
		await Promise.race([
			mainTurnReady,
			sleep(15000).then(() => {
				throw new Error("Main turn did not reach its final snapshot");
			}),
		]);
		await input.fill("保留正在编辑的问题");

		const select = async (selector) => {
			await page
				.locator(selector)
				.first()
				.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
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
		const waitForAnswer = async (index = 0) => {
			await popup.locator(".quick-ask-stream-status").waitFor({ state: "detached" });
			await popup.locator(".quick-ask-assistant").nth(index).waitFor();
			assert.equal(await popup.getByRole("button", { name: /展开回答|收起回答/ }).count(), 0);
		};
		const newTopic = async () => {
			await popup.locator(".quick-ask-header").getByRole("button", { name: "新话题", exact: true }).click();
			assert.equal(await popup.locator(".quick-ask-message").count(), 0, "one click starts a new topic");
			assert.equal(await page.getByRole("dialog", { name: "更多操作", exact: true }).count(), 0);
		};
		await waitForAnswer();
		assert.equal(await popup.locator("textarea").count(), 0, "selection explanations start without an input box");
		assert.equal(
			await popup.locator(".quick-ask-message").count(),
			2,
			"the complete question and answer render immediately",
		);
		const answerRect = await popup.boundingBox();
		assert(answerRect && answerRect.width <= 320 && answerRect.height <= 520, JSON.stringify(answerRect));
		assert.equal(await popup.locator(".quick-ask-answer").evaluate((el) => getComputedStyle(el).fontSize), "14px");
		assert.equal(
			await popup.locator(".quick-ask-answer").evaluate((el) => getComputedStyle(el).webkitLineClamp),
			"none",
		);
		assert.equal(
			await popup.locator(".quick-ask-answer pre").isVisible(),
			true,
			"Markdown code is available immediately",
		);
		assert.equal(
			await popup.locator(".quick-ask-header").getByRole("button", { name: "新话题", exact: true }).isVisible(),
			true,
		);
		const answerBody = popup.locator(".quick-ask-body");
		assert(await answerBody.evaluate((el) => el.clientHeight > 0 && el.scrollHeight > el.clientHeight));
		await answerBody.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		assert(
			(await popup.locator(".quick-ask-answer").innerText()).includes(reply.split("\n").at(-1)),
			"scrolling reaches the end without expanding",
		);
		assert(
			(await popup.locator(".quick-ask-user .quick-ask-selection").innerText()).includes("console.log"),
			"the selected text is visible in the question bubble",
		);
		await popup.getByRole("button", { name: "更多操作", exact: true }).click();
		const more = page.getByRole("dialog", { name: "更多操作", exact: true });
		await more.waitFor();
		assert((await more.locator(".quick-ask-model").innerText()).includes("quote-test"));
		assert.equal(await more.locator(".copy-btn").count(), 1);
		const menuRect = await more.boundingBox();
		assert(menuRect && menuRect.x >= 0 && menuRect.y >= 0 && menuRect.x + menuRect.width <= 1200);
		await page.keyboard.press("Escape");
		await more.waitFor({ state: "detached" });
		assert.equal(await popup.isVisible(), true, "Escape closes the menu before the answer card");
		if (process.env.PI_QUICK_ASK_SELECTION_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_SELECTION_SCREENSHOT });
		console.log("✓ 默认直接显示 14px 完整 Markdown，长回答内部滚动；标题栏直接显示新话题加号");
		await waitForAnswer();
		assert(
			(await popup.locator(".quick-ask-assistant").innerText()).includes("console.log"),
			"the complete Markdown answer needs no extra click",
		);
		assert.equal(requests.length, 2);
		assert.equal(requests[1].messages.length, 1, JSON.stringify(requests[1]));
		assert(JSON.stringify(requests[1].messages[0]).includes("解释下: "));
		assert(JSON.stringify(requests[1].messages[0]).includes("console.log"), JSON.stringify(requests[1].messages[0]));
		assert(!requests[1].tools?.length, "quick ask must not expose agent tools");
		assert.equal(await input.inputValue(), composerDraft);
		assert.equal(await page.locator(".messages .msg").count(), mainMessageCount);
		assert.equal(await page.locator(".messages").evaluate((element) => element.scrollTop), readingScroll);
		await input.click();
		assert.equal(await popup.isVisible(), true, "reading the main conversation should keep the window open");
		console.log("✓ 选中文字在独立小窗解释，不携带主对话上下文或工具，不改变草稿与阅读位置");
		await popup.getByRole("button", { name: "追问", exact: true }).click();
		const quickInput = popup.locator("textarea");
		await quickInput.fill("保留小窗草稿");
		await popup.getByRole("button", { name: "收起输入框", exact: true }).click();
		assert.equal(await quickInput.count(), 0);
		await popup.getByRole("button", { name: "追问", exact: true }).click();
		assert.equal(await quickInput.inputValue(), "保留小窗草稿", "collapsing the input preserves the draft");
		await quickInput.fill("继续说明上一条");
		await quickInput.press("Enter");
		await waitForAnswer(1);
		assert.equal(requests.length, 3);
		assert.equal(requests[2].messages.length, 3, "follow-ups use only the popup's own history");
		await newTopic();
		assert.equal(await popup.locator(".quick-ask-message").count(), 0);
		await quickInput.fill("新话题测试");
		await quickInput.press("Enter");
		await waitForAnswer();
		assert.equal(requests[3].messages.length, 1);
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await page.getByRole("button", { name: "打开随手问", exact: true }).click();
		assert.equal(
			await popup.locator(".quick-ask-assistant").count(),
			1,
			"closing and reopening preserves popup history",
		);
		console.log("✓ 小窗连续追问、新话题清空与关闭后重新打开保留独立上下文");

		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		const launcher = page.getByRole("button", { name: "打开随手问", exact: true });
		const dragLauncher = async (dx, dy) => {
			const icon = await launcher.locator("svg").boundingBox();
			assert(icon);
			const x = icon.x + icon.width / 2;
			const y = icon.y + icon.height / 2;
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(x + dx, y + dy, { steps: 8 });
			await page.mouse.up();
		};
		const launcherBeforeDrag = await launcher.boundingBox();
		await dragLauncher(-210, -130);
		const launcherAfterDrag = await launcher.boundingBox();
		assert(Math.abs(launcherAfterDrag.x - (launcherBeforeDrag.x - 210)) < 1);
		assert(Math.abs(launcherAfterDrag.y - (launcherBeforeDrag.y - 130)) < 1);
		assert.equal(await popup.count(), 0, "releasing a launcher drag does not open the popup");
		assert.equal(await launcher.evaluate((element) => getComputedStyle(element).cursor), "grab");
		if (process.env.PI_QUICK_ASK_LAUNCHER_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_LAUNCHER_SCREENSHOT });
		await dragLauncher(1, 1);
		await popup.waitFor();
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		const retainedLauncher = await launcher.boundingBox();
		assert.equal(retainedLauncher.x, launcherAfterDrag.x);
		assert.equal(retainedLauncher.y, launcherAfterDrag.y, "a slight movement opens without moving the launcher");
		await launcher.focus();
		await page.keyboard.press("Enter");
		await popup.waitFor();
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await launcher.focus();
		await page.keyboard.press("Space");
		await popup.waitFor();
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await dragLauncher(-1500, -1500);
		const launcherAtOrigin = await launcher.boundingBox();
		assert.equal(launcherAtOrigin.x, 8);
		assert.equal(launcherAtOrigin.y, 8);
		await dragLauncher(1500, 1500);
		const launcherAtEdge = await launcher.boundingBox();
		assert.equal(launcherAtEdge.x + launcherAtEdge.width, 1192);
		assert.equal(launcherAtEdge.y + launcherAtEdge.height, 892);
		assert.equal(await popup.count(), 0, "dragging the launcher to viewport edges does not activate it");
		await launcher.click();
		console.log("✓ 随手问按钮可拖动且不误开，轻点与键盘可打开，重开保留位置并限制在视口内");

		const dragHeader = async (dx, dy) => {
			const header = await popup.locator(".quick-ask-header").boundingBox();
			assert(header);
			await page.mouse.move(header.x + 20, header.y + header.height / 2);
			await page.mouse.down();
			await page.mouse.move(header.x + 20 + dx, header.y + header.height / 2 + dy, { steps: 8 });
			await page.mouse.up();
		};
		const beforeDrag = await popup.boundingBox();
		await dragHeader(-260, -170);
		const afterDrag = await popup.boundingBox();
		assert(Math.abs(afterDrag.x - (beforeDrag.x - 260)) < 1, "header drag moves the popup horizontally");
		assert(Math.abs(afterDrag.y - (beforeDrag.y - 170)) < 1, "header drag moves the popup vertically");
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await page.getByRole("button", { name: "打开随手问", exact: true }).click();
		let retained = await popup.boundingBox();
		assert.equal(retained.x, afterDrag.x);
		assert.equal(retained.y, afterDrag.y, "closing and reopening retains the dragged position");
		if (process.env.PI_QUICK_ASK_DRAG_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_DRAG_SCREENSHOT });
		await newTopic();
		retained = await popup.boundingBox();
		assert.equal(retained.x, afterDrag.x);
		assert.equal(retained.y, afterDrag.y, "a new topic retains the dragged position");
		await dragHeader(1500, 1500);
		const atEdge = await popup.boundingBox();
		assert(atEdge.x + atEdge.width <= 1192 && atEdge.y + atEdge.height <= 892, "drag stays inside the viewport");
		await dragHeader(-1500, -1500);
		const atOrigin = await popup.boundingBox();
		assert.equal(atOrigin.x, 8);
		assert.equal(atOrigin.y, 8);
		await dragHeader(1500, 1500);
		console.log("✓ 真实鼠标拖动，关闭重开与新话题保留位置，拖出四边时限制在视口内");

		await quickInput.fill("慢回复随手问");
		await quickInput.press("Enter");
		await popup.getByRole("button", { name: "停止生成", exact: true }).waitFor();
		await newTopic();
		await quickInput.fill("重置后只回答这条");
		await quickInput.press("Enter");
		await waitForAnswer();
		await sleep(5200);
		assert.equal(await popup.locator(".quick-ask-assistant").count(), 1);
		assert.equal(await popup.locator(".quick-ask-user").count(), 1);
		assert.equal(requests.at(-1).messages.length, 1);
		assert.equal(await page.locator(".messages .msg").count(), mainMessageCount);
		assert.equal(await input.inputValue(), composerDraft);
		const rect = await popup.boundingBox();
		assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1200);
		console.log("✓ 生成中重置取消旧请求，无过期结果污染");

		assert.equal(await popup.locator(".quick-ask-selection").count(), 0, "new topics clear the selection");
		await quickInput.fill("流式验证");
		await quickInput.press("Enter");
		const incrementalAnswer = popup.locator(".quick-ask-assistant").last();
		await incrementalAnswer.locator(".is-streaming").waitFor();
		assert.equal(await popup.locator(".quick-ask-stream-status").isVisible(), true);
		assert(
			!(await incrementalAnswer.innerText()).includes("console.log"),
			"first delta is visible before the answer finishes",
		);
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await page.locator(".quick-ask-launcher.is-loading").waitFor();
		await page.locator(".quick-ask-launcher.has-answer").waitFor();
		await page.getByRole("button", { name: "打开随手问", exact: true }).click();
		assert((await popup.locator(".quick-ask-assistant").last().innerText()).includes("console.log"));
		console.log("✓ 真实文本增量先于完成事件显示，收起后继续生成并提示回答就绪");

		await quickInput.fill("慢回复流式验证");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").last().locator(".is-streaming").waitFor();
		await popup.getByRole("button", { name: "停止生成", exact: true }).click();
		const partial = await popup.locator(".quick-ask-assistant").last().innerText();
		assert(partial.includes(reply.slice(0, 12).trim()));
		await sleep(1500);
		assert.equal(
			await popup.locator(".quick-ask-assistant").last().innerText(),
			partial,
			"stopping preserves text without late deltas",
		);
		await popup.getByRole("button", { name: "重试", exact: true }).click();
		await popup.locator(".quick-ask-stream-status").waitFor();
		await popup.locator(".quick-ask-assistant").last().locator(".is-streaming").waitFor();
		const readingBody = popup.locator(".quick-ask-body");
		assert(await readingBody.evaluate((element) => element.scrollHeight > element.clientHeight));
		await readingBody.evaluate((element) => {
			element.scrollTop = 0;
		});
		await sleep(1500);
		assert.equal(
			await readingBody.evaluate((element) => element.scrollTop),
			0,
			"streaming does not pull a reader away from earlier messages",
		);
		const beforeClose = await readingBody.evaluate((element) => {
			element.scrollTop = Math.min(42, element.scrollHeight - element.clientHeight);
			return element.scrollTop;
		});
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		await page.getByRole("button", { name: "打开随手问", exact: true }).click();
		assert.equal(
			await readingBody.evaluate((element) => element.scrollTop),
			beforeClose,
			"reopening preserves the reading position while the complete answer stays available",
		);
		await newTopic();
		await quickInput.fill("截图用完整回答");
		await quickInput.press("Enter");
		await waitForAnswer();
		console.log("✓ 中途停止保留部分回答，可重试；新话题取消正在重试的请求");
		if (process.env.PI_QUICK_ASK_SCREENSHOT) await page.screenshot({ path: process.env.PI_QUICK_ASK_SCREENSHOT });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(100);
		const mobileRect = await popup.boundingBox();
		assert(mobileRect && mobileRect.x >= 0 && mobileRect.y >= 0 && mobileRect.x + mobileRect.width <= 390);
		const touchSession = await page.context().newCDPSession(page);
		const touchHeader = await popup.locator(".quick-ask-header").boundingBox();
		const touchX = touchHeader.x + 20;
		const touchY = touchHeader.y + touchHeader.height / 2;
		await touchSession.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: touchX, y: touchY }],
		});
		await touchSession.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x: touchX - 30, y: touchY - 75 }],
		});
		await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await touchSession.detach();
		const afterTouch = await popup.boundingBox();
		assert(Math.abs(afterTouch.x - (mobileRect.x - 30)) < 1);
		assert(Math.abs(afterTouch.y - (mobileRect.y - 75)) < 1, "real touch input moves the popup without scrolling");
		console.log("✓ 真实触屏拖动标题栏");
		await popup.getByRole("button", { name: "关闭随手问", exact: true }).click();
		const mobileLauncher = await launcher.boundingBox();
		assert(
			mobileLauncher.x >= 8 &&
				mobileLauncher.y >= 8 &&
				mobileLauncher.x + mobileLauncher.width <= 382 &&
				mobileLauncher.y + mobileLauncher.height <= 836,
			"the launcher remains visible after a smaller viewport and reopening",
		);
		await launcher.click();
		console.log("✓ 缩小窗口后重新出现的随手问按钮仍在视口内");
		await quickInput.fill("手机上继续提问");
		await quickInput.press("Enter");
		await waitForAnswer(1);
		assert.equal(requests.at(-1).messages.length, 3);
		await popup.getByRole("button", { name: "收起输入框", exact: true }).click();
		const mobileAnswerRect = await popup.boundingBox();
		assert(mobileAnswerRect && mobileAnswerRect.width <= 320 && mobileAnswerRect.height <= 520);
		assert((await popup.locator(".quick-ask-assistant").last().innerText()).includes("console.log"));
		assert.equal(
			await popup.locator(".quick-ask-header").getByRole("button", { name: "新话题", exact: true }).isVisible(),
			true,
		);
		if (process.env.PI_QUICK_ASK_MOBILE_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_MOBILE_SCREENSHOT });
		for (const viewport of [
			{ width: 320, height: 568 },
			{ width: 568, height: 280 },
		]) {
			await page.setViewportSize(viewport);
			await popup.getByRole("button", { name: "追问", exact: true }).click();
			await page.waitForFunction(() => {
				const rect = document.querySelector(".quick-ask-popover").getBoundingClientRect();
				return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
			});
			const bounded = await popup.boundingBox();
			assert(
				bounded &&
					bounded.x >= 0 &&
					bounded.y >= 0 &&
					bounded.x + bounded.width <= viewport.width &&
					bounded.y + bounded.height <= viewport.height,
				JSON.stringify(bounded),
			);
			assert(await readingBody.evaluate((el) => el.clientHeight > 0 && el.scrollHeight > el.clientHeight));
			assert.equal(await popup.getByRole("button", { name: /展开回答|收起回答/ }).count(), 0);
			await popup.getByRole("button", { name: "收起输入框", exact: true }).click();
		}
		await page.setViewportSize({ width: 390, height: 844 });
		await popup.getByRole("button", { name: "追问", exact: true }).click();
		await quickInput.fill("慢回复流式验证");
		await quickInput.press("Enter");
		await popup.locator(".quick-ask-assistant").last().locator(".is-streaming").waitFor();
		await popup.getByRole("button", { name: "收起输入框", exact: true }).click();
		await popup.getByRole("button", { name: "停止生成", exact: true }).click();
		assert((await popup.locator(".quick-ask-assistant").last().innerText()).includes(reply.slice(0, 12).trim()));
		await popup.getByRole("button", { name: "重试", exact: true }).click();
		await popup.locator(".quick-ask-stream-status").waitFor();
		assert.equal(await popup.locator("textarea").count(), 0, "stop and retry work with the composer collapsed");
		await newTopic();
		console.log("✓ 手机与矮窗口内完整回答可滚动，无需展开；可直接停止、重试与新建话题");
		await page.keyboard.press("Escape");
		await popup.waitFor({ state: "detached" });
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.waitForFunction(() => window.__quickAskHeldSettings.length > 0);
		assert.equal(await page.locator(".settings-modal").count(), 0, "settings content waits for its initial snapshot");
		await page.evaluate(() => {
			window.__quickAskHoldSettings = false;
			sessionStorage.setItem("quick-ask-settings-ready", "1");
			for (const { socket, data } of window.__quickAskHeldSettings) {
				socket.dispatchEvent(new MessageEvent("message", { data }));
			}
			window.__quickAskHeldSettings = [];
		});
		await page.getByRole("button", { name: "随手问", exact: true }).click();
		console.log("✓ 首次设置快照延迟到达时安全挂载，Hook 顺序保持稳定");
		const quickSettings = page
			.locator(".set-section")
			.filter({ has: page.locator(".set-section-title", { hasText: /^随手问$/ }) });
		await quickSettings.getByLabel("随手问模型", { exact: true }).selectOption("local/quote-test");
		await quickSettings.getByLabel("思考强度", { exact: true }).selectOption("low");
		await quickSettings.getByRole("button", { name: /^系统提示词/ }).click();
		await quickSettings.getByLabel("系统提示词", { exact: true }).fill("仅供小窗的系统提示");
		await quickSettings.getByRole("button", { name: /^选中文字解释模板/ }).click();
		await quickSettings.getByLabel("选中文字解释模板", { exact: true }).fill("简明解释: {{input}}");
		await quickSettings.getByRole("button", { name: /^翻译模板/ }).click();
		await quickSettings.getByLabel("翻译模板", { exact: true }).fill("译成{{targetLanguage}}：{{input}}");
		await quickSettings.getByLabel("目标语言", { exact: true }).selectOption("ja");
		await quickSettings.getByLabel("翻译风格", { exact: true }).selectOption("technical");
		await quickSettings.getByLabel("默认显示原文对照", { exact: true }).check();
		await quickSettings.getByRole("button", { name: /^引用范围/ }).click();
		await quickSettings.getByLabel("对话引用", { exact: true }).selectOption("full");
		await quickSettings.getByLabel("文件夹引用", { exact: true }).selectOption("content");
		await quickSettings.getByLabel("显示常驻入口", { exact: true }).uncheck();
		await page.keyboard.press("Escape");
		await page.locator(".quick-ask-launcher").waitFor({ state: "detached", timeout: 5000 });
		await page.reload();
		await input.waitFor();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "随手问", exact: true }).click();
		assert.equal(await quickSettings.getByLabel("随手问模型", { exact: true }).inputValue(), "local/quote-test");
		assert.equal(await quickSettings.getByLabel("思考强度", { exact: true }).inputValue(), "low");
		await quickSettings.getByRole("button", { name: /^系统提示词/ }).click();
		assert.equal(await quickSettings.getByLabel("系统提示词", { exact: true }).inputValue(), "仅供小窗的系统提示");
		await quickSettings.getByRole("button", { name: /^选中文字解释模板/ }).click();
		assert.equal(
			await quickSettings.getByLabel("选中文字解释模板", { exact: true }).inputValue(),
			"简明解释: {{input}}",
		);
		assert.equal(await quickSettings.getByLabel("显示常驻入口", { exact: true }).isChecked(), false);
		assert.equal(await quickSettings.getByLabel("目标语言", { exact: true }).inputValue(), "ja");
		assert.equal(await quickSettings.getByLabel("翻译风格", { exact: true }).inputValue(), "technical");
		assert.equal(await quickSettings.getByLabel("默认显示原文对照", { exact: true }).isChecked(), true);
		await quickSettings.getByRole("button", { name: /^翻译模板/ }).click();
		assert.equal(
			await quickSettings.getByLabel("翻译模板", { exact: true }).inputValue(),
			"译成{{targetLanguage}}：{{input}}",
		);
		await quickSettings.getByRole("button", { name: /^引用范围/ }).click();
		assert.equal(await quickSettings.getByLabel("对话引用", { exact: true }).inputValue(), "full");
		assert.equal(await quickSettings.getByLabel("文件夹引用", { exact: true }).inputValue(), "content");
		await quickSettings.getByRole("button", { name: /^翻译模板/ }).click();
		await quickSettings.getByRole("button", { name: /^引用范围/ }).click();
		await page.locator(".settings-modal .modal-body").evaluate((el) => {
			el.scrollTop = 0;
		});
		if (process.env.PI_QUICK_ASK_SETTINGS_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_SETTINGS_SCREENSHOT });
		await page.keyboard.press("Escape");
		await select(".msg-assistant .msg-text pre");
		await page.locator(".selection-explain-trigger").click();
		await waitForAnswer();
		assert((await popup.locator(".quick-ask-user .quick-ask-selection").innerText()).includes("console.log"));
		const configuredRequest = requests.at(-1);
		assert.equal(configuredRequest.messages.length, 2);
		assert.equal(configuredRequest.messages[0].role, "system");
		assert.equal(configuredRequest.messages[0].content, "仅供小窗的系统提示");
		assert(JSON.stringify(configuredRequest.messages[1]).includes("简明解释: "));
		assert(!configuredRequest.tools?.length);
		console.log("✓ A紧凑分组与翻译/引用设置刷新后生效，折叠编辑器保存草稿");
		await select(".msg-assistant .msg-text p:last-child");
		await page.getByRole("button", { name: "翻译", exact: true }).click();
		await waitForAnswer();
		assert((await popup.locator(".quick-ask-answer").innerText()).includes("文字コマンド"));
		assert.equal(await popup.locator("textarea").count(), 0);
		assert(
			(await popup.locator(".quick-ask-user .quick-ask-selection").innerText()).includes("command-line interface"),
		);
		const translatedRequest = JSON.stringify(requests.at(-1).messages);
		assert(translatedRequest.includes("译成Japanese"));
		assert(translatedRequest.includes("precise technical terminology"));
		assert(!translatedRequest.includes("生成测试内容"), "translation does not silently include the main conversation");
		if (process.env.PI_QUICK_ASK_TRANSLATION_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_TRANSLATION_SCREENSHOT });
		await popup.getByLabel("目标语言", { exact: true }).selectOption("en");
		await popup.locator(".quick-ask-stream-status").waitFor({ state: "detached" });
		assert(JSON.stringify(requests.at(-1).messages).includes("译成English"));
		assert((await popup.locator(".quick-ask-answer").innerText()).includes("A command-line interface"));
		console.log("✓ 划词翻译按目标语言与风格独立请求，卡头语言切换可重新翻译");

		await newTopic();
		const draftTags = popup.locator(":scope > .quick-ask-references .quick-ask-reference-tag");
		await popup
			.locator('input[type="file"]')
			.first()
			.setInputFiles({
				name: "note.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("UPLOAD_REFERENCE_MARKER: only this uploaded file."),
			});
		await draftTags.filter({ hasText: "note.txt" }).waitFor();
		await quickInput.fill("只说明附加的文件");
		await quickInput.press("Enter");
		await waitForAnswer();
		assert(JSON.stringify(requests.at(-1).messages).includes("UPLOAD_REFERENCE_MARKER"));
		assert(!JSON.stringify(requests.at(-1).messages).includes("生成测试内容"));
		await quickInput.fill("继续说明这个文件");
		await quickInput.press("Enter");
		await waitForAnswer(1);
		const occurrences = JSON.stringify(requests.at(-1).messages).split("UPLOAD_REFERENCE_MARKER").length - 1;
		assert.equal(occurrences, 1, "unchanged attachments are not duplicated on follow-up turns");

		const readme = page
			.locator(".file-item.file")
			.filter({ has: page.locator(".file-name-text", { hasText: /^README\.md$/ }) })
			.first();
		await readme.click({ button: "right" });
		await page.getByRole("menuitem", { name: "引用到随手问", exact: true }).click();
		await draftTags.filter({ hasText: "README.md" }).waitFor();
		await readme.click({ button: "right" });
		await page.getByRole("menuitem", { name: "引用到随手问", exact: true }).click();
		await popup.locator(".quick-ask-reference-status").waitFor({ state: "detached" });
		assert.equal(await draftTags.count(), 2, "repeated references to the same source deduplicate");
		const directory = page
			.locator(".file-item.dir")
			.filter({ has: page.locator(".file-name", { hasText: /^docs$/ }) })
			.first();
		await directory.click({ button: "right" });
		await page.getByRole("menuitem", { name: "引用到随手问", exact: true }).click();
		await popup.getByRole("button", { name: "展开引用", exact: true }).waitFor();
		await popup.getByRole("button", { name: "展开引用", exact: true }).click();
		assert.equal(await draftTags.count(), 3);
		assert((await draftTags.allTextContents()).some((name) => name.includes("docs")));
		await popup.getByRole("button", { name: "附件与引用", exact: true }).click();
		await page
			.getByRole("dialog", { name: "附件与引用", exact: true })
			.getByRole("button", { name: "引用当前对话", exact: true })
			.click();
		await page.waitForFunction(
			() =>
				document.querySelectorAll(".quick-ask-popover > .quick-ask-references .quick-ask-reference-tag").length === 4,
		);
		await popup
			.locator('input[type="file"]')
			.first()
			.setInputFiles({
				name: "pixel.png",
				mimeType: "image/png",
				buffer: Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9JAAAAABJRU5ErkJggg==",
					"base64",
				),
			});
		await draftTags.filter({ hasText: "pixel.png" }).waitFor();
		await quickInput.fill("结合这些文件、图片和明确引用的对话说明下一步");
		await quickInput.press("Enter");
		await waitForAnswer(2);
		const withReferences = JSON.stringify(requests.at(-1).messages);
		assert(withReferences.includes("REFERENCE_FILE_MARKER"));
		assert(withReferences.includes("DIRECTORY_FILE_MARKER"));
		assert(
			withReferences.includes("生成测试内容"),
			"main messages enter only after explicit current-conversation reference",
		);
		assert(withReferences.includes("data:image/png;base64,"));
		assert(!requests.at(-1).tools?.length);
		assert.equal(await input.inputValue(), composerDraft);
		assert.equal(await page.locator(".messages .msg").count(), mainMessageCount);
		await popup.getByRole("button", { name: "收起引用", exact: true }).first().click();
		await popup.getByRole("button", { name: "收起输入框", exact: true }).click();
		if (process.env.PI_QUICK_ASK_REFERENCES_SCREENSHOT)
			await page.screenshot({ path: process.env.PI_QUICK_ASK_REFERENCES_SCREENSHOT });
		console.log("✓ 文本/图片附件、文件/文件夹右键、当前对话引用真实进入独立模型；去重与主草稿隔离有效");

		await newTopic();
		await popup
			.locator('input[type="file"]')
			.first()
			.setInputFiles({
				name: "archive.zip",
				mimeType: "application/zip",
				buffer: Buffer.from([80, 75, 3, 4, 0, 0, 0, 0, 255, 0, 0, 0]),
			});
		await popup.locator(".quick-ask-reference-error").waitFor();
		assert((await popup.locator(".quick-ask-reference-error").innerText()).includes("不支持"));
		assert.equal(await draftTags.count(), 0);
		let releaseContext;
		let markStarted;
		const contextStarted = new Promise((resolve) => {
			markStarted = resolve;
		});
		await page.route("**/api/quick-ask/context", async (route) => {
			markStarted();
			await new Promise((resolve) => {
				releaseContext = resolve;
			});
			await route
				.fulfill({
					json: { attachment: { id: "stale", kind: "file", name: "stale.txt", content: "SHOULD_NEVER_APPEAR" } },
				})
				.catch(() => {});
		});
		await popup
			.locator('input[type="file"]')
			.first()
			.setInputFiles({ name: "stale.txt", mimeType: "text/plain", buffer: Buffer.from("delayed") });
		await contextStarted;
		await newTopic();
		releaseContext();
		await sleep(100);
		assert.equal(await draftTags.count(), 0, "reset cancels pending reference snapshots");
		assert.equal(await popup.locator(".quick-ask-reference-status").count(), 0);
		await page.unroute("**/api/quick-ask/context");
		console.log("✓ 不支持的二进制明确报错；新话题取消未完成引用，迟到快照不污染新话题");

		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "随手问", exact: true }).click();
		await quickSettings.getByLabel("显示常驻入口", { exact: true }).check();
		await page.keyboard.press("Escape");
		await launcher.waitFor();
		const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		activePage = phone;
		phone.on("pageerror", (error) => errors.push(error.message));
		await phone.goto(page.url());
		const phoneLauncher = phone.getByRole("button", { name: "打开随手问", exact: true });
		const phonePopup = phone.getByRole("dialog", { name: "随手问", exact: true });
		await phoneLauncher.tap();
		await phonePopup.waitFor();
		await phonePopup.getByRole("button", { name: "关闭随手问", exact: true }).tap();
		const phoneLauncherBeforeDrag = await phoneLauncher.boundingBox();
		const launcherTouch = await phone.context().newCDPSession(phone);
		await launcherTouch.send("Input.synthesizeScrollGesture", {
			x: phoneLauncherBeforeDrag.x + phoneLauncherBeforeDrag.width / 2,
			y: phoneLauncherBeforeDrag.y + phoneLauncherBeforeDrag.height / 2,
			xDistance: -50,
			yDistance: -65,
			speed: 300,
			gestureSourceType: "touch",
			preventFling: true,
		});
		const launcherAfterTouch = await phoneLauncher.boundingBox();
		assert(launcherAfterTouch.x < phoneLauncherBeforeDrag.x - 40);
		assert(launcherAfterTouch.y < phoneLauncherBeforeDrag.y - 55);
		assert.equal(await phonePopup.count(), 0, "a touch drag does not open the popup");
		if (process.env.PI_QUICK_ASK_LAUNCHER_MOBILE_SCREENSHOT)
			await phone.screenshot({ path: process.env.PI_QUICK_ASK_LAUNCHER_MOBILE_SCREENSHOT });
		await phoneLauncher.tap();
		await phonePopup.waitFor();
		await launcherTouch.detach();
		await phone.close();
		activePage = page;
		console.log("✓ 真实触屏拖动按钮不误开，拖动后的轻点仍可打开");
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
