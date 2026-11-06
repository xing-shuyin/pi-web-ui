import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-swipe-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
mkdirSync(WORK, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ dummy: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			dummy: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "dummy-1", name: "Dummy" }],
			},
		},
	}),
);
const PORT = 21000 + Math.floor(Math.random() * 3000);

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
		process.exitCode = 1;
	}
};

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设 PI_WEB_CHROME 指定）");
	process.exit(0);
}

let server;
let browser;

async function startServer() {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_DIR: AGENT_DIR,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", () => {});
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

function killServer() {
	if (!server?.pid) return;
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		try {
			server.kill("SIGKILL");
		} catch {}
	}
	server = undefined;
}

const probe = (sel) => {
	const el = document.querySelector(sel);
	if (!el) return null;
	const cs = getComputedStyle(el);
	return {
		open: el.classList.contains("open"),
		tx: Math.round(new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform).m41),
	};
};

async function openPage() {
	const page = await browser.newPage({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		deviceScaleFactor: 3,
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".panel-drawer.drawer-left", { timeout: 60000 });
	await sleep(2500);
	return { page, errors };
}

function makeSwipe(cdp) {
	return async (x0, y0, x1, y1, { steps = 10, stepMs = 0, end = true } = {}) => {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
		for (let i = 1; i <= steps; i++) {
			const k = i / steps;
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k }],
			});
			if (stepMs) await sleep(stepMs);
		}
		if (end) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	};
}

async function main() {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	await startServer();
	const { page, errors } = await openPage();
	const cdp = await page.context().newCDPSession(page);
	const swipe = makeSwipe(cdp);
	const left = () => page.evaluate(probe, ".panel-drawer.drawer-left");
	const right = () => page.evaluate(probe, ".panel-drawer.drawer-right");
	const veil = () =>
		page.evaluate(() => {
			const el = document.querySelector(".drawer-backdrop");
			if (!el) return null;
			return { on: el.classList.contains("on"), opacity: Number(getComputedStyle(el).opacity) };
		});

	console.log("\n§1 左栏：边缘右滑拉出（跟手）+ 遮罩渐显");
	{
		const before = await left();
		check("初始：左栏关着且完全藏住（tx ≈ -105%）", !before.open && before.tx < -290, `tx=${before.tx}`);
		const v0 = await veil();
		check("移动端遮罩常驻但不吃点击（无 .on）", v0 !== null && !v0.on && v0.opacity === 0);
		const hit = await page.evaluate(() => document.elementFromPoint(195, 420)?.className ?? "");
		check("收起时遮罩不挡命中（elementFromPoint 不是遮罩）", !String(hit).includes("drawer-backdrop"), `hit=${hit}`);

		await swipe(18, 420, 218, 420, { steps: 8, stepMs: 45, end: false });
		const mid = await left();
		check("跟手期间面板跟着手指走（不再是 -105%，也没到 0）", mid.tx < -40 && mid.tx > -290, `tx=${mid.tx}`);
		const midVeil = await veil();
		check("跟手期间遮罩同步变暗", midVeil.opacity > 0.2, `opacity=${midVeil.opacity}`);

		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await sleep(450);
		const after = await left();
		check("松手后左栏打开并归位", after.open && after.tx === 0, `open=${after.open} tx=${after.tx}`);
		const v1 = await veil();
		check("遮罩点亮（可点关闭）", v1.on && v1.opacity === 1);
	}

	console.log("\n§2 左栏：在遮罩上左滑收回");
	{
		await swipe(350, 420, 100, 420, { steps: 10, stepMs: 45 });
		await sleep(450);
		const after = await left();
		check("左栏收回（tx 回到藏匿位）", !after.open && after.tx < -290, `tx=${after.tx}`);
		const v = await veil();
		check("遮罩同步淡出", !v.on && v.opacity === 0, `opacity=${v.opacity}`);
	}

	console.log("\n§4 右栏：边缘左滑拉出 / 右滑收回");
	{
		await swipe(372, 420, 172, 420, { steps: 10, stepMs: 45 });
		await sleep(450);
		const opened = await right();
		check("右栏打开", opened.open && opened.tx === 0, `open=${opened.open} tx=${opened.tx}`);

		await swipe(40, 420, 290, 420, { steps: 10, stepMs: 45 });
		await sleep(450);
		const closed = await right();
		check("右栏收回", !closed.open && closed.tx > 290, `tx=${closed.tx}`);
	}

	console.log("\n§5 轻扫：一小段就开（走 flick 判定，不必拖 40%）");
	{
		await swipe(16, 420, 76, 420, { steps: 4 });
		await sleep(450);
		const after = await left();
		check("60px 轻扫也把左栏拉出来", after.open, `open=${after.open}`);
		await swipe(350, 420, 60, 420, { steps: 5 });
		await sleep(450);
		check("轻扫同样能收回", !(await left()).open);
	}

	console.log("\n§6 不抢手势：非边缘起手 / 竖向拖动都不动抽屉");
	{
		await swipe(200, 300, 330, 300, { steps: 8, stepMs: 30 });
		await sleep(400);
		const a = await left();
		const b = await right();
		check("屏幕中间横滑不拉抽屉", !a.open && !b.open, `left=${a.open} right=${b.open}`);

		await swipe(20, 700, 20, 300, { steps: 8, stepMs: 30 });
		await sleep(400);
		const c = await left();
		check("边缘起手但竖着划 → 手里这手作废（留给页面滚动）", !c.open, `left=${c.open}`);
	}

	check("页面无 JS 报错", errors.length === 0, errors.join(" | "));

	await page.close();
	killServer();
	await browser.close();
	console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	killServer();
	process.exit(1);
});
