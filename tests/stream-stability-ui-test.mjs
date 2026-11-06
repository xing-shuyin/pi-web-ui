import { createServer } from "vite";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CHROME_PATH } from "./lib/chrome.mjs";

if (!CHROME_PATH) {
	console.log("SKIP stream stability: Chrome unavailable");
	process.exit(0);
}
const repo = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
	configFile: `${repo}web/vite.config.ts`,
	root: repo,
	server: { host: "127.0.0.1", port: 23931, strictPort: true },
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => {
		errors.push(String(e));
		console.error("PAGE ERROR", e.stack);
	});
	await page.goto("http://127.0.0.1:23931/tests/fixtures/stream-stability.html");
	await page.waitForFunction(() => !!window.streamTest);
	const settle = async (text) => {
		await page.evaluate((text) => window.streamTest.update(text), text);
		await page.waitForFunction(
			(text) => document.querySelector('[data-msg-id="stream-123"]')?.textContent.includes(text.split("\n").at(-1)),
			text,
		);
	};
	for (const flow of [false, true]) {
		await page.evaluate((flow) => {
			document.documentElement.style.setProperty("--flow-inline-stream", flow ? "1" : "0");
			window.dispatchEvent(new Event("pi-web-ui:theme-change"));
		}, flow);
		for (const reason of ["stop", "aborted", "error"]) {
			await page.evaluate(() => window.streamTest.reset());
			await settle("Stable first paragraph.");
			await page.evaluate(() => {
				window.firstParagraph = document.querySelector('[data-msg-id="stream-123"] .md p');
			});
			await settle("Stable first paragraph.\n\nSecond paragraph.");
			assert(
				await page.evaluate(() => window.firstParagraph === document.querySelector('[data-msg-id="stream-123"] .md p')),
				"freezing a paragraph replaced its DOM",
			);
			await page.evaluate(() => {
				const el = document.querySelector(".messages");
				el.scrollTop = 40;
				el.dispatchEvent(new Event("scroll"));
				window.beforeScroll = el.scrollTop;
				window.finalBody = document.querySelector('[data-msg-id="stream-123"] .msg-text');
			});
			await page.waitForTimeout(300);
			await page.evaluate(() => {
				const el = document.querySelector(".messages");
				el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
				el.scrollTop = 40;
				el.dispatchEvent(new Event("scroll"));
				window.beforeScroll = el.scrollTop;
			});
			await page.waitForTimeout(80);
			await page.evaluate((reason) => window.streamTest.finish(reason), reason);
			await page.waitForSelector('[data-msg-id="a-123-1"]');
			await page.waitForTimeout(150);
			assert(
				await page.evaluate(() => window.finalBody === document.querySelector('[data-msg-id="a-123-1"] .msg-text')),
				`finalization replaced body (${reason})`,
			);
			assert(
				await page.evaluate(() => window.firstParagraph === document.querySelector('[data-msg-id="a-123-1"] .md p')),
				`finalization replaced paragraph (${reason})`,
			);
			assert(
				await page.evaluate(() => Math.abs(document.querySelector(".messages").scrollTop - window.beforeScroll) <= 2),
				`finalization moved reading position (${reason})`,
			);
		}
		await page.evaluate(() => {
			window.streamTest.reset();
		});
		await page.evaluate(() => window.streamTest.tool());
		await page.waitForSelector('[data-msg-id="stream-123"] .thinking');
		await page.evaluate(() => {
			window.thinkingNode = document.querySelector('[data-msg-id="stream-123"] .thinking');
			window.streamTest.toolText();
		});
		await page.waitForFunction(() =>
			document.querySelector('[data-msg-id="stream-123"]')?.textContent.includes("Body after reasoning."),
		);
		assert(
			await page.evaluate(() => window.thinkingNode === document.querySelector('[data-msg-id="stream-123"] .thinking')),
			"reasoning-to-body transition remounted card",
		);
		await page.evaluate(() => window.streamTest.finish());
		await page.waitForSelector('[data-msg-id="a-123-1"]');
		assert(
			await page.evaluate(() => window.thinkingNode === document.querySelector('[data-msg-id="a-123-1"] .thinking')),
			"reasoning card remounted on finalization",
		);
	}
	assert.deepEqual(errors, []);
	console.log(
		"PASS stream stability: real MessageList/Markdown, paragraph freeze, stop/abort/error finalization, scroll position",
	);
} finally {
	await browser?.close();
	await server.close();
}
