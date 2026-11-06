import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-dock-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
mkdirSync(WORK, { recursive: true });
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

const plugDir = join(DATA_DIR, "plugins", "docktest");
mkdirSync(join(plugDir, "client"), { recursive: true });
const items = (p) => [
	{ id: `${p}1`, label: `${p}-TOP`, labelEn: `${p}-TOP`, kind: "action", action: `docktest:${p}1`, align: "start" },
	{ id: `${p}2`, label: `${p}-MID`, labelEn: `${p}-MID`, kind: "action", action: `docktest:${p}2`, align: "center" },
	{ id: `${p}3`, label: `${p}-BOT`, labelEn: `${p}-BOT`, kind: "action", action: `docktest:${p}3`, align: "end" },
];
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "Dock Test",
		version: "0.0.1",
		view: false,
		permissions: ["ui"],
		ui: { "sidebar.left": items("L"), "sidebar.right": items("R") },
	}),
);
writeFileSync(join(plugDir, "client", "entry.mjs"), "export default {};");

function seedPrefs(sideDockFloat) {
	writeFileSync(
		join(DATA_DIR, "client-state.json"),
		JSON.stringify({ __settings__: { projects: [], settings: { uiLayout: { sideDockFloat } } } }),
	);
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
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
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

const geoScript = () => {
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) };
	};
	const dock = document.querySelector(".side-dock-left");
	const dump = (sel) =>
		[...document.querySelectorAll(sel)].map((s) => ({ ...rect(s), pe: getComputedStyle(s).pointerEvents }));
	return {
		dockCls: dock.className,
		dock: rect(dock),
		slots: dump(".side-dock-left .side-dock-slot"),
		segs: dump(".side-dock-left .side-dock-seg"),
		rightSegs: dump(".side-dock-right .side-dock-seg"),
		collapseButtons: document.querySelectorAll(".side-dock-collapse-btn").length,
		toggleButtons: document.querySelectorAll(".side-dock-toggle-btn").length,
	};
};

async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".side-dock-left .side-dock-seg", { timeout: 60000 });
	await sleep(2000);
	return { page, errors };
}

async function main() {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	console.log("\n§1 流内：align 读作竖轴（靠上 / 居中 / 靠下）");
	seedPrefs(false);
	await startServer();
	{
		const { page, errors } = await openPage();
		const g = await page.evaluate(geoScript);
		check(
			"左停靠栏画了三颗药丸（插件按 start/center/end 声明的三条都渲染）",
			g.segs.length === 3,
			`segs=${g.segs.length}`,
		);
		check("右停靠栏同口径", g.rightSegs.length === 3, `segs=${g.rightSegs.length}`);
		const [top, mid, bot] = g.segs;
		check("竖向次序 = 靠上 → 居中 → 靠下", top.top < mid.top && mid.bottom < bot.bottom);
		check("靠上那颗贴着停靠栏顶端", Math.abs(top.top - (g.dock.top + 6)) <= 2, `top=${top.top} dockTop=${g.dock.top}`);
		check(
			"靠下那颗贴着停靠栏底端",
			Math.abs(bot.bottom - (g.dock.bottom - 6)) <= 2,
			`bottom=${bot.bottom} dockBottom=${g.dock.bottom}`,
		);
		check(
			"居中那颗落在停靠栏竖向正中（±2px）",
			Math.abs((mid.top + mid.bottom) / 2 - (g.dock.top + g.dock.bottom) / 2) <= 2,
			`mid=${(mid.top + mid.bottom) / 2} dock=${(g.dock.top + g.dock.bottom) / 2}`,
		);
		check(
			"药丸是内容高，没被弹性格子拉满整条",
			g.segs.every((s) => s.bottom - s.top < 120),
			g.segs.map((s) => s.bottom - s.top).join("/"),
		);
		check("弹性格子撑满整列（三段的边界首尾相接）", Math.abs(g.slots.at(-1).bottom - (g.dock.bottom - 6)) <= 2);
		check("流内模式没有折叠按钮", g.collapseButtons === 0 && g.toggleButtons === 0);
		check("页面无 JS 报错", errors.length === 0, errors.join(" | "));
		await page.close();
	}
	killServer();
	await sleep(400);

	console.log("\n§2 悬浮：折叠按钮只在这里出现，空白处不吃点击");
	seedPrefs(true);
	await startServer();
	{
		const { page, errors } = await openPage();
		const g = await page.evaluate(geoScript);
		check("切到悬浮浮层（.side-dock-float）", /\bside-dock-float\b/.test(g.dockCls), g.dockCls);
		check(
			"浮层有高度但不满屏（靠上/靠下才看得出来）",
			g.dock.bottom - g.dock.top > 200 && g.dock.bottom - g.dock.top < 900,
		);
		check(
			"弹性格子（空白区）不吃点击，药丸自己吃",
			g.slots.every((s) => s.pe === "none") && g.segs.every((s) => s.pe === "auto"),
		);
		check("悬浮模式有折叠按钮", g.collapseButtons === 2, `count=${g.collapseButtons}`);

		const collapse = page.locator(".side-dock-left .side-dock-collapse-btn");
		const box = await collapse.boundingBox();
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await sleep(600);
		const collapsed = await page.evaluate(() => {
			const btn = document.querySelector(".side-dock-left .side-dock-toggle-btn");
			if (!btn) return null;
			const r = btn.getBoundingClientRect();
			const dock = document.querySelector(".side-dock-left").getBoundingClientRect();
			return {
				w: Math.round(r.width),
				h: Math.round(r.height),
				dockH: Math.round(dock.height),
				segs: document.querySelectorAll(".side-dock-left .side-dock-seg").length,
			};
		});
		check("收起后只剩一个展开按钮", collapsed !== null && collapsed.segs === 0, JSON.stringify(collapsed));
		check(
			"展开按钮是小的（22×22），收起态不再占一整条",
			collapsed?.w === 22 && collapsed?.h === 22 && collapsed.dockH <= 40,
			JSON.stringify(collapsed),
		);

		const toggle = page.locator(".side-dock-left .side-dock-toggle-btn");
		const tbox = await toggle.boundingBox();
		await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
		let segsBack = 0;
		for (let i = 0; i < 20; i++) {
			segsBack = await page.locator(".side-dock-left .side-dock-seg").count();
			if (segsBack === 3) break;
			await sleep(200);
		}
		check("点展开按钮回到三颗药丸", segsBack === 3, `segs=${segsBack}`);
		check("页面无 JS 报错", errors.length === 0, errors.join(" | "));
		await page.close();
	}
	killServer();

	console.log(`\n${passed} checks passed`);
}

try {
	await main();
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {}
	killServer();
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
