import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-colalign-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");

const VIEWPORTS = [
	{ name: "2560 宽屏", w: 2560, h: 1100, wide: false },
	{ name: "2560 宽屏聊天列", w: 2560, h: 1100, wide: true },
	{ name: "1440 双侧栏", w: 1440, h: 900, wide: false },
	{ name: "1200 窄主列", w: 1200, h: 800, wide: false },
	{ name: "900 极窄桌面", w: 900, h: 700, wide: false },
	{ name: "700 移动布局", w: 700, h: 800, wide: false },
	{ name: "390 手机", w: 390, h: 844, wide: false },
];
const COLUMN_SELECTORS = {
	"消息 .msg": ".msg",
	"消息正文 .msg-text": ".msg-text",
	"重试条幅 .retry-notice": ".retry-notice",
	"折叠行 .msg-collapsed": ".msg-collapsed",
	"目标条 .goalbar": ".goalbar",
	"任务执行看板 .plan-board": ".plan-board",
	"斜杠菜单 .slash-menu": ".slash-menu",
	"问卷面板 .dialog-inline": ".dialog-inline",
};

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(workdir, "a.txt"), "a");
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
	},
	stdio: "ignore",
});
for (let i = 0; i < 80; i++) {
	try {
		const res = await fetch(`http://localhost:${PORT}/api/health`);
		if (res.ok) break;
	} catch {}
	await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const ctx = await browser.newContext();
const page = await ctx.newPage();

for (const vp of VIEWPORTS) {
	await ctx.addInitScript((wide) => {
		try {
			localStorage.setItem("pi-web-ui:wide-chat", JSON.stringify({ wide }));
		} catch {}
	}, vp.wide);
	await page.setViewportSize({ width: vp.w, height: vp.h });
	await page.goto(`http://localhost:${PORT}`);
	await page.waitForSelector(".messages", { timeout: 20000 });
	await sleep(600);

	const rects = await page.evaluate((selectors) => {
		const box = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { l: +b.left.toFixed(2), r: +b.right.toFixed(2), w: +b.width.toFixed(2) };
		};
		const msgs = document.querySelector(".messages");
		const add = (cls, html, parent) => {
			const d = document.createElement("div");
			d.className = cls;
			d.innerHTML = html;
			(parent ?? msgs).appendChild(d);
		};
		add(
			"msg",
			'<div class="msg-meta"><span class="msg-role">USER</span></div><div class="msg-text"><p>hello</p></div>',
		);
		add("retry-notice", '<span class="retry-pulse"></span><span class="retry-text">retrying</span>');
		add(
			"msg-collapsed",
			'<span class="msg-collapsed-role">USER</span><span class="msg-collapsed-body"><span class="msg-collapsed-preview">hi</span></span>',
		);
		add("slash-menu", '<div class="slash-menu-item">/help</div>', document.querySelector(".inputbar"));
		add("dialog-inline", "<div>question</div>", document.querySelector(".main"));
		add("plan-board", '<div class="plan-board-row">board</div>', document.querySelector(".main"));
		const wrap = document.querySelector(".messages-wrap");
		add("qn-rail", '<button class="qn-bar"><span class="qn-bar-text">1. q</span></button>', wrap);
		const out = {
			mainWidth: +document.querySelector(".main").getBoundingClientRect().width.toFixed(1),
			mainLeft: +document.querySelector(".main").getBoundingClientRect().left.toFixed(2),
			chatPad: Number.parseFloat(getComputedStyle(document.querySelector(".main")).getPropertyValue("--chat-pad")),
			gutter: getComputedStyle(document.documentElement).getPropertyValue("--msgs-gutter").trim(),
		};
		for (const sel of Object.values(selectors)) out[sel] = box(sel);
		out[".inputbox"] = box(".inputbox");
		out.rail = box(".qn-rail");
		return out;
	}, COLUMN_SELECTORS);

	const label = `${vp.name}（主列 ${rects.mainWidth}，gutter ${rects.gutter}）`;
	const input = rects[".inputbox"];
	check(`${label} → 输入框存在`, !!input);
	if (!input) continue;
	for (const [name, sel] of Object.entries(COLUMN_SELECTORS)) {
		const b = rects[sel];
		if (!b) {
			check(`${label} → ${name} 存在`, false);
			continue;
		}
		check(
			`${label} → ${name} 与输入框同宽齐平`,
			Math.abs(b.l - input.l) <= 0.6 && Math.abs(b.r - input.r) <= 0.6 && Math.abs(b.w - input.w) <= 0.6,
			`[${b.l}, ${b.r}] w=${b.w} vs [${input.l}, ${input.r}] w=${input.w}`,
		);
	}
	const msg = rects[".msg"];
	const inset = +(msg.l - rects.mainLeft).toFixed(2);
	const floor = vp.w < 641 ? rects.chatPad : Math.max(rects.chatPad, 48);
	check(`${label} → 消息列不贴边`, inset >= floor - 0.6, `inset=${inset} floor=${floor} chatPad=${rects.chatPad}`);
	if (rects.rail && rects.rail.w > 0) {
		check(
			`${label} → 提问导航条不压消息列`,
			rects.rail.l - msg.r >= 0,
			`rail.l - msg.r = ${+(rects.rail.l - msg.r).toFixed(2)}`,
		);
	}
}

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
