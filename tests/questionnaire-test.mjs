import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-q-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {}
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
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function waitIdle(page, timeout = 60_000) {
	for (let i = 0; i < timeout / 500; i++) {
		const sendBtn = await page.locator(".btn.send").count();
		if (sendBtn > 0) {
			await sleep(1500);
			return true;
		}
		await sleep(500);
	}
	return false;
}

async function sendPrompt(page, text) {
	await page.fill(".inputbox textarea", text);
	await page.keyboard.press("Enter");
}

async function waitToolDone(page, timeout = 180_000) {
	const tc = page.locator('.toolcall:has(.toolcall-name:text-is("ask_user_question"))');
	await tc.last().waitFor({ state: "visible", timeout });
	await page
		.locator('.toolcall:has(.toolcall-name:text-is("ask_user_question"))')
		.last()
		.locator(".toolcall-status")
		.waitFor({ state: "visible", timeout });
	for (let i = 0; i < timeout / 500; i++) {
		const status = await page
			.locator('.toolcall:has(.toolcall-name:text-is("ask_user_question"))')
			.last()
			.locator(".toolcall-status")
			.textContent()
			.catch(() => "");
		if (status === "完成") return true;
		await sleep(500);
	}
	return false;
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	console.log("round 1: answering the questionnaire…");
	await sendPrompt(
		page,
		"请立即调用 ask_user_question 工具问我一个问题：「测试问题：1+1 等于几？」并给出两个选项：「等于 2」和「等于 3」。调用后等待我的回答，不要做其他事。",
	);

	await page.waitForSelector(".dialog-inline", {
		state: "visible",
		timeout: 180_000,
	});
	check("inline dialog panel appears", true);

	const title = await page.locator(".dialog-title").textContent();
	check("dialog shows the question", title?.includes("1+1") ?? false);

	const optCount = await page.locator(".dialog-option").count();
	check("dialog shows options (2 + Type something.)", optCount === 3);
	const opts = await page.locator(".dialog-option").allTextContents();
	check(
		"custom-answer sentinel present",
		opts.some((t) => t.includes("Type something.")),
	);
	if (optCount < 2) {
		console.log(
			"[debug] dialog content:",
			await page
				.locator(".dialog-inline")
				.innerText()
				.catch(() => "<none>"),
		);
	}

	const mainPanel = page.locator(".main .dialog-inline");
	check("panel is inside the chat main column", (await mainPanel.count()) === 1);
	const panelBox = await page.locator(".dialog-inline").boundingBox();
	const inputBox = await page.locator(".inputbox").boundingBox();
	const listBox = await page
		.locator(".messages")
		.boundingBox()
		.catch(() => null);
	check("panel sits above the input box", !!panelBox && !!inputBox && panelBox.y + panelBox.height <= inputBox.y + 2);
	check("message list stays visible while asking", !!listBox && listBox.height > 0);

	await page.locator(".dialog-option").first().click();
	await page.waitForSelector(".dialog-inline", {
		state: "detached",
		timeout: 10_000,
	});
	check("panel closes after answering", true);
	check("tool completed after answer", await waitToolDone(page));
	check("agent idle after round 1", await waitIdle(page));
	console.log("round 1 done\n");

	console.log("round 2: dismissing with Escape…");
	await sendPrompt(
		page,
		"请再次调用 ask_user_question 工具问我一个问题（不要用文字回复，必须调用工具）：「测试问题：继续吗？」给出两个选项：「继续」和「停下」。调用后等待我的回答，不要做其他事。",
	);
	await page.waitForSelector(".dialog-inline", {
		state: "visible",
		timeout: 180_000,
	});
	check("second dialog appears", true);

	await page.keyboard.press("Escape");
	await page.waitForSelector(".dialog-inline", {
		state: "detached",
		timeout: 10_000,
	});
	check("panel closes on Escape", true);
	check("tool completed after cancel", await waitToolDone(page));
	console.log("round 2 done\n");

	if (consoleErrors.length > 0) {
		console.log("console errors:", consoleErrors.slice(0, 5));
	}
	console.log(`\n${passed} checks passed`);
	await browser.close();
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("test crashed:", err);
	process.exit(1);
});
