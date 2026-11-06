import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { register } from "tsx/esm/api";
register();
const { UniversalSession, UniversalSessionStore, MockAgentDriver } = await import("../server/universal/index.ts");

if (!CHROME_PATH) {
	console.log("SKIP universal stream UI: Chrome unavailable");
	process.exit(0);
}
const repo = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.PI_ISSUE_EVIDENCE_DIR || join(tmpdir(), "pi-800-801-ui");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "universal-ui-"));
const driver = new MockAgentDriver(dir);
let sink;
let ready;
let release;
const started = new Promise((resolve) => {
	ready = resolve;
});
const done = new Promise((resolve) => {
	release = resolve;
});
driver.sendPrompt = async (_text, _attachments, events) => {
	sink = events;
	ready();
	await done;
};
const frames = [];
const session = new UniversalSession({
	clientId: "ui-regression",
	cwd: dir,
	dataDir: dir,
	agentDir: dir,
	store: new UniversalSessionStore(dir),
	driver,
	send: (msg) => frames.push(structuredClone(msg)),
});
const server = await createServer({
	configFile: `${repo}web/vite.config.ts`,
	root: repo,
	server: { host: "127.0.0.1", port: 23932, strictPort: true },
});
let browser;
let prompt;
try {
	await server.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("response", (response) => {
		if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`);
	});
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.route("**/api/prompt-templates", (route) => route.fulfill({ json: { templates: [] } }));
	await page.route("**/api/locales", (route) => route.fulfill({ json: { packs: [], defaultLocale: "en" } }));
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
	await page.goto("http://127.0.0.1:23932/tests/fixtures/stream-stability.html");
	await page.waitForFunction(() => !!window.streamTest);
	let offset = 0;
	const deliver = async () => {
		for (const msg of frames.slice(offset)) {
			if (msg.type === "snapshot" || msg.type === "message_delta") {
				await page.evaluate((msg) => window.streamTest.frame(msg), msg);
			}
		}
		offset = frames.length;
		await page.waitForTimeout(100);
	};
	prompt = session.prompt("Multi-tool streaming regression. " + "Earlier context. ".repeat(250));
	await started;
	sink.onThinkingDelta("Initial plan");
	sink.onToolStart("one", "bash", { command: "echo FIRST_OUTPUT" });
	await deliver();
	await page.waitForSelector(".toolcall.run");
	await page.screenshot({ path: join(evidence, "01-tool-running.png") });
	sink.onToolEnd("one", { output: "FIRST_OUTPUT" });
	await new Promise((resolve) => setTimeout(resolve, 90));
	await deliver();
	await page.waitForSelector(".toolcall.ok");
	assert(
		await page
			.locator(".toolcall")
			.first()
			.textContent()
			.then((t) => t.includes("FIRST_OUTPUT")),
		"tool output missing before turn ends",
	);
	sink.onThinkingDelta("Reasoning after first tool");
	sink.onToolStart("two", "read", { path: "missing.txt" });
	sink.onToolEnd("two", { error: "SECOND_ERROR" });
	sink.onThinkingDelta("Reasoning after second tool");
	await deliver();
	const samples = [];
	for (let i = 0; i < 10; i++) {
		sink.onThinkingDelta(` stable-${i}`);
		await deliver();
		const before = await page.evaluate(() => ({
			content: window.streamTest.state().streamingMessage.content,
			scrollTop: document.querySelector(".messages").scrollTop,
			scrollHeight: document.querySelector(".messages").scrollHeight,
		}));
		session.flushSnapshot();
		await deliver();
		const after = await page.evaluate(() => ({
			content: window.streamTest.state().streamingMessage.content,
			scrollTop: document.querySelector(".messages").scrollTop,
			scrollHeight: document.querySelector(".messages").scrollHeight,
		}));
		assert.deepEqual(after.content, before.content, "snapshot moved or removed streamed thinking");
		assert(Math.abs(after.scrollHeight - before.scrollHeight) <= 2, "snapshot changed rendered height");
		assert(Math.abs(after.scrollTop - before.scrollTop) <= 2, "snapshot oscillated scroll position");
		samples.push({ before, after });
	}
	assert.deepEqual(
		samples.at(-1).after.content.map((b) => b.type),
		["thinking", "toolCall", "thinking", "toolCall", "thinking"],
	);
	assert.equal(await page.locator(".toolcall.run").count(), 0, "completed tools still spinning");
	assert.equal(await page.locator(".toolcall.ok").count(), 1);
	assert.equal(await page.locator(".toolcall.err").count(), 1);
	await page.waitForFunction(() => document.querySelector(".messages")?.textContent.includes("stable-9"));
	await page.screenshot({ path: join(evidence, "02-multi-tool-thinking.png") });
	await page.locator(".messages").hover();
	await page.mouse.wheel(0, -600);
	await page.waitForTimeout(150);
	const oldTop = await page.locator(".messages").evaluate((el) => el.scrollTop);
	sink.onThinkingDelta(" more background reasoning");
	await deliver();
	session.flushSnapshot();
	await deliver();
	assert(
		Math.abs((await page.locator(".messages").evaluate((el) => el.scrollTop)) - oldTop) <= 2,
		"reading position moved",
	);
	await page.screenshot({ path: join(evidence, "03-reading-position.png") });
	sink.onTurnComplete();
	await deliver();
	assert.deepEqual(errors, []);
	writeFileSync(join(evidence, "ui-evidence.json"), JSON.stringify({ samples, errors, frames }, null, 2));
	console.log(
		`PASS UniversalSession -> reducer -> MessageList: two live tool results, chronological thinking, 10 stable snapshot/scroll comparisons, reading position. Evidence: ${evidence}`,
	);
} finally {
	await session.abort();
	release();
	await prompt;
	session.dispose();
	await browser?.close();
	await server.close();
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
