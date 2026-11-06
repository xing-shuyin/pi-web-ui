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
const base = mkdtempSync(join(tmpdir(), "pi-uilayout-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });
const SUB_DIR = "sub";
mkdirSync(join(WORK, SUB_DIR), { recursive: true });

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

const plugDir = join(DATA_DIR, "plugins", "layouttest");
mkdirSync(join(plugDir, "client"), { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "Layout Test",
		version: "0.0.1",
		view: true,
		permissions: ["ui"],
		ui: {
			bottombar: [
				{
					id: "b1",
					label: "B-ONE",
					labelEn: "B-ONE",
					hint: "底栏条目的悬浮提示",
					hintEn: "bottombar tooltip",
					kind: "action",
					action: "layouttest:b1",
				},
			],
			rightpanel: [{ id: "rp", label: "RP-TAB", labelEn: "RP-TAB", hint: "右栏 tab 的悬浮提示", kind: "view" }],
			arrange: [
				{ id: "host:cost", hide: true },
				{ id: "host:does-not-exist", hide: true },
			],
		},
	}),
);
writeFileSync(
	join(plugDir, "client", "entry.mjs"),
	`export default { mount(container) { container.textContent = "layouttest"; } };`,
);

function seedSession(cwd, id, text) {
	const dir = join(AGENT_DIR, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text }], timestamp: 1722700801000 },
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-08-04T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 1722700802000 },
			}),
		].join("\n") + "\n",
	);
	return file;
}
seedSession(WORK, "layout-seed", "布局不变量回归用的对话");

let server;
let browser;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

async function settle(page, quietMs = 2500) {
	let last = Date.now();
	const onNav = (f) => {
		if (f === page.mainFrame()) last = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		for (let i = 0; i < 80; i++) {
			if (Date.now() - last >= quietMs) break;
			await sleep(250);
		}
	} finally {
		page.off("framenavigated", onNav);
	}
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
}

async function openLayoutPage(page) {
	const btn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) === 0) {
			await tap(page, btn).catch(() => {});
		}
		if (await until(async () => (await page.locator(".settings-modal").count()) > 0, 8, 250)) break;
		await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 }).catch(() => {});
	}
	await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
	return until(async () => (await page.locator(".set-ui-slot").count()) > 0, 30, 250);
}

async function closeLayoutPage(page) {
	await tap(page, page.locator(".settings-modal .modal-close").first());
	return until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
}

function layoutRow(page, slotText, rowText) {
	return page.locator(".set-ui-slot", { hasText: slotText }).first().locator(".set-row", { hasText: rowText }).first();
}

const footerText = (page) => page.locator(".statusbar").first().textContent();

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
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
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);

	const footer = await footerText(page);
	check("底栏渲染出来了", !!footer);
	check("插件 arrange 隐藏 host:cost → 底栏不再显示成本", !/\$\d|\$0/.test(footer ?? ""), (footer ?? "").slice(0, 160));
	check(
		"同槽位其它宿主条目不受影响（上下文用量还在）",
		(await page.locator(".statusbar .bar-item-ctx").count()) === 1 &&
			/\d/.test((await page.locator(".statusbar .bar-item-ctx").first().textContent()) ?? ""),
	);

	check("插件贡献的底栏条目渲染在宿主底栏里", (footer ?? "").includes("B-ONE"), (footer ?? "").slice(0, 200));
	check(
		"插件的 hint 落成底栏条目的 title（悬浮提示不会静默丢掉）",
		(await page.locator(".statusbar .status-action", { hasText: "B-ONE" }).first().getAttribute("title")) ===
			"底栏条目的悬浮提示",
	);

	const tabs = page.locator(".panel-right .slot-tabs-bar [role=tab]");
	check("右栏是 slot tab 容器", await until(async () => (await tabs.count()) > 0, 40, 250));
	const tabLabels = (await tabs.allTextContents()).map((s) => s.trim());
	check(
		"右栏 tab 顺序 = 布局顺序（宿主「文件」在前、插件 tab 在后）",
		tabLabels.length === 2 && /文件|Files/.test(tabLabels[0]) && tabLabels[1] === "RP-TAB",
		tabLabels.join(" | "),
	);
	check("插件的 hint 落成右栏 tab 的 title", (await tabs.nth(1).getAttribute("title")) === "右栏 tab 的悬浮提示");
	await tap(page, tabs.nth(1));
	check(
		"插件 tab 的内容由插件渲染（PluginPage 挂载）",
		await until(
			async () => ((await page.locator(".plugin-page-host").first().textContent()) ?? "").includes("layouttest"),
			40,
			250,
		),
	);

	check("界面布局页可打开", await openLayoutPage(page));
	const diag = page.locator(".set-ui-diag").first();
	check("布局诊断横幅出现（arrange 目标不存在不再静默）", (await diag.count()) > 0);
	if ((await diag.count()) > 0) {
		const diagText = (await diag.textContent()) ?? "";
		check(
			"诊断里点名了插件与目标 id",
			diagText.includes("layouttest") && diagText.includes("host:does-not-exist"),
			diagText.trim().slice(0, 120),
		);
	}
	const cwdRow = layoutRow(page, /底栏|Bottom bar/, /工作目录|Working directory/);
	check("布局页列出了底栏的「工作目录」条目", await until(async () => (await cwdRow.count()) > 0, 30, 250));
	check("初始状态底栏有工作目录按钮", (await page.locator(".statusbar .status-cwd").count()) === 1);
	await tap(page, cwdRow.locator('input[type="checkbox"]').first());
	check(
		"取消勾选后底栏的工作目录消失（宿主条目也听用户偏好）",
		await until(async () => (await page.locator(".statusbar .status-cwd").count()) === 0, 30, 250),
	);
	await tap(page, cwdRow.locator('input[type="checkbox"]').first());
	check(
		"勾回来后它又出现",
		await until(async () => (await page.locator(".statusbar .status-cwd").count()) === 1, 30, 250),
	);

	const orderOf = async () =>
		await page.evaluate(() => {
			const bar = document.querySelector(".statusbar");
			if (!bar) return "";
			const ids = Array.from(bar.querySelectorAll("[data-bar-item]")).map((n) => n.getAttribute("data-bar-item") ?? "");
			return `${ids.indexOf("host:ctx")}:${ids.indexOf("host:msg-count")}`;
		});
	const before = await orderOf();
	const msgRow = layoutRow(page, /底栏|Bottom bar/, /消息|Messages/);
	const upBtn = msgRow.locator("button", { hasText: "↑" }).first();
	await tap(page, upBtn);
	let moved = false;
	for (let i = 0; i < 3 && !moved; i++) {
		const now = await orderOf();
		const [ctxIdx, msgIdx] = now.split(":").map(Number);
		if (ctxIdx >= 0 && msgIdx >= 0 && msgIdx < ctxIdx) {
			moved = true;
			break;
		}
		await tap(page, upBtn);
	}
	const after = await orderOf();
	const [ctxA, msgA] = after.split(":").map(Number);
	check("布局页 ↑ 调序后界面真的换位置", ctxA >= 0 && msgA >= 0 && msgA < ctxA, `${before} → ${after}`);

	const desktopOrder = async (a, b) =>
		await page.evaluate(
			([ta, tb]) => {
				const nodes = Array.from(document.querySelectorAll(".topbar-flow .chip"));
				const idx = (t) => nodes.findIndex((n) => (n.textContent ?? "").includes(t));
				return `${idx(ta)}:${idx(tb)}`;
			},
			[a, b],
		);
	const isBefore = (pair) => {
		const [a, b] = pair.split(":").map(Number);
		return a >= 0 && b >= 0 && a < b;
	};
	const themeRow = layoutRow(page, /顶栏|Top bar/, /主题|Theme/);
	check("布局页列出了顶栏的「主题」条目", await until(async () => (await themeRow.count()) > 0, 30, 250));
	const soundRow = layoutRow(page, /顶栏|Top bar/, /声音|Sound/);
	check("布局页列出了顶栏的「声音」条目", await until(async () => (await soundRow.count()) > 0, 30, 250));
	for (const row of [themeRow, soundRow]) {
		const box = row.locator('input[type="checkbox"]').first();
		if (!(await box.isChecked())) await tap(page, box);
	}
	check(
		"勾上后「主题」「声音」出现在主栏（这两个默认是隐藏的）",
		await until(async () => (await page.locator(".topbar-flow .chip", { hasText: /主题|Theme/ }).count()) > 0, 30, 250),
	);
	let orderAfter = await desktopOrder("主题", "声音");
	for (let i = 0; i < 3 && !isBefore(orderAfter); i++) {
		await tap(page, themeRow.locator("button", { hasText: "↑" }).first());
		orderAfter = await desktopOrder("主题", "声音");
	}
	check("关掉设置面板", await closeLayoutPage(page));
	const orderAfterClose = await desktopOrder("主题", "声音");
	check("顶栏 ↑ 调序后界面真的换位置（主题排到声音前面）", isBefore(orderAfterClose), orderAfterClose);

	check("再打开布局页", await openLayoutPage(page));
	check("布局页仍列出「声音」", await until(async () => (await soundRow.count()) > 0, 30, 250));
	await tap(page, soundRow.locator('input[type="checkbox"]').first());
	check("关掉设置面板（才能点顶栏）", await closeLayoutPage(page));
	check(
		"隐藏后顶栏的声音 chip 消失",
		await until(
			async () => (await page.locator(".topbar-flow .chip", { hasText: /声音|Sound/ }).count()) === 0,
			30,
			250,
		),
	);
	const moreBtn = page.locator(".plugin-topbar-more > button").first();
	check("顶栏「⋯」按钮出现（有隐藏条目）", (await moreBtn.count()) > 0);
	await tap(page, moreBtn);
	const soundInMenu = await until(
		async () => (await page.locator(".plugin-topbar-menu .chip", { hasText: /声音|Sound/ }).count()) > 0,
		20,
		200,
	);
	check("隐藏的声音整块出现在「⋯」溢出菜单里（不是死按钮）", soundInMenu);
	const menuHit = await page.evaluate(() => {
		const menu = document.querySelector(".plugin-topbar-menu");
		if (!menu) return "no-menu";
		const r = menu.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return "zero-size";
		if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
			return "outside-viewport";
		const el = document.elementFromPoint(r.x + Math.min(r.width - 5, 12), r.y + Math.min(r.height - 5, 12));
		return menu.contains(el) ? "ok" : `clipped-by:${el ? (el.className ?? el.tagName) : "null"}`;
	});
	check("溢出菜单真的可见可点（不被祖先 overflow 裁剪）", menuHit === "ok", String(menuHit));
	if (soundInMenu) {
		await tap(page, page.locator(".plugin-topbar-menu .chip", { hasText: /声音|Sound/ }).first());
		check(
			"点它真能展开声音设置面板（搬过去也还能用）",
			await until(async () => (await page.locator(".plugin-topbar-menu .dd-menu").count()) > 0, 20, 200),
		);
		await page.keyboard.press("Escape");
		check(
			"Esc 先收起内层声音面板",
			await until(async () => (await page.locator(".plugin-topbar-menu .dd-menu").count()) === 0, 20, 200),
		);
		check("分层关闭：溢出菜单此时仍开着", (await page.locator(".plugin-topbar-menu").count()) === 1);
		await page.keyboard.press("Escape");
		check(
			"再按一次 Esc 收起溢出菜单",
			await until(async () => (await page.locator(".plugin-topbar-menu").count()) === 0, 20, 200),
		);
	}
	if ((await page.locator(".plugin-topbar-menu").count()) > 0) await moreBtn.evaluate((el) => el.click());
	check("再打开布局页（恢复声音）", await openLayoutPage(page));
	await tap(page, soundRow.locator('input[type="checkbox"]').first());
	check("关掉设置面板", await closeLayoutPage(page));
	check(
		"勾回去后声音 chip 回到顶栏",
		await until(async () => (await page.locator(".topbar-flow .chip", { hasText: /声音|Sound/ }).count()) > 0, 30, 250),
	);

	const filesTab = page.locator(".panel-right .slot-tabs-bar [role=tab]").first();
	if ((await filesTab.count()) > 0) await tap(page, filesTab);
	await tap(page, page.locator(".statusbar .status-cwd").first());
	check("底栏 cwd 选择器打开", await until(async () => (await page.locator(".cwd-picker").count()) > 0, 20, 250));
	const enterBtn = page.locator(".cwd-picker .cwd-item", { hasText: SUB_DIR }).locator(".cwd-enter").first();
	const entered = await until(async () => (await enterBtn.count()) > 0, 20, 200);
	check(`选择器里能浏览到子目录（${SUB_DIR}）`, entered);
	const addRootBtn = page
		.locator(".cwd-picker .cwd-picker-head button", { hasText: /工作区根|workspace root/i })
		.first();
	if (entered) {
		check("浏览到主工作区时「＋ 工作区根」是禁用的（它就是主根）", !(await addRootBtn.isEnabled()));
		await tap(page, enterBtn);
		check("浏览到子目录后「＋ 工作区根」可用", await addRootBtn.isEnabled());
		await tap(page, addRootBtn);
		check(
			"点它后右栏出现根选择器（真的写进了 set_workspace_roots）",
			await until(async () => (await page.locator(".root-picker-trigger").count()) > 0, 40, 250),
		);
	}
	await tap(page, page.locator(".status-cwd-backdrop").first()).catch(() => {});
	await until(async () => (await page.locator(".cwd-picker").count()) === 0, 20, 200);
	check("cwd 选择器已关闭", (await page.locator(".cwd-picker").count()) === 0);
	if ((await page.locator(".root-picker-trigger").count()) > 0) {
		await tap(page, page.locator(".root-picker-trigger").first());
		await tap(page, page.locator(".root-picker-menu .root-picker-remove").first());
		check(
			"移除后根选择器消失",
			await until(async () => (await page.locator(".root-picker-trigger").count()) === 0, 30, 250),
		);
	}

	check("打开布局页（改名）", await openLayoutPage(page));
	const bottomRows = () =>
		page
			.locator(".set-ui-slot", { hasText: /底栏|Bottom bar/ })
			.first()
			.locator(".set-row");
	const topRows = () =>
		page
			.locator(".set-ui-slot", { hasText: /顶栏|Top bar/ })
			.first()
			.locator(".set-row");
	const rowIndexOf = async (rows, re) => {
		const n = await rows().count();
		for (let i = 0; i < n; i++) {
			if (re.test((await rows().nth(i).textContent()) ?? "")) return i;
		}
		return -1;
	};
	const ctxIdx = await rowIndexOf(bottomRows, /上下文|Context/);
	const termIdx = await rowIndexOf(topRows, /^.*终端|Terminal/);
	check("布局页列出了底栏「上下文」与顶栏「终端」", ctxIdx >= 0 && termIdx >= 0, `ctx=${ctxIdx} term=${termIdx}`);
	const ctxFoot = page.locator(".statusbar .bar-item-ctx").first();
	check("改名前底栏上下文只有数值、没有名字", !((await ctxFoot.textContent()) ?? "").includes("CTX"));
	const rename = async (row, value) => {
		const input = row.locator("input.set-ui-label").first();
		await input.click();
		await input.fill(value);
		await input.press("Enter");
	};
	await rename(bottomRows().nth(ctxIdx), "MY-CTX");
	await rename(topRows().nth(termIdx), "MY-TERM");
	check("关掉设置面板（改名提交）", await closeLayoutPage(page));
	const ctxAfter = (await ctxFoot.textContent()) ?? "";
	check(
		"底栏改了名真的换文案（名字挂在数值前面）",
		await until(async () => ((await ctxFoot.textContent()) ?? "").includes("MY-CTX"), 30, 250),
		ctxAfter.slice(0, 60),
	);
	check(
		"改名不吞掉实时数值（名字后面还是 tokens 用量）",
		/\d/.test(ctxAfter) && /[/]/.test(ctxAfter),
		ctxAfter.slice(0, 60),
	);
	const termBtn = page.locator('[data-bar-item="host:terminal"]').first();
	check(
		"顶栏改了名真的换文案",
		await until(async () => ((await termBtn.textContent()) ?? "").includes("MY-TERM"), 30, 250),
	);
	check("改名后内置文案不再出现（不是叠着画）", !((await termBtn.textContent()) ?? "").includes("终端"));
	check("再打开布局页（验证改名留存）", await openLayoutPage(page));
	check(
		"改名后的文案真的存下来了（重开面板 = 原值，不是空框）",
		(await bottomRows().nth(ctxIdx).locator("input.set-ui-label").first().inputValue()) === "MY-CTX" &&
			(await topRows().nth(termIdx).locator("input.set-ui-label").first().inputValue()) === "MY-TERM",
	);
	await rename(bottomRows().nth(ctxIdx), "");
	await rename(topRows().nth(termIdx), "");
	check("关掉设置面板（清空改名）", await closeLayoutPage(page));
	check(
		"清空后底栏回到内置数值（不带名字）",
		await until(async () => !((await ctxFoot.textContent()) ?? "").includes("MY-CTX"), 30, 250),
	);
	check(
		"清空后顶栏回到内置文案",
		await until(async () => !((await termBtn.textContent()) ?? "").includes("MY-TERM"), 30, 250),
	);

	const historyRow = page.locator(".panel-left .panel-sessions .session-item").first();
	check("左栏有历史会话可打开", await until(async () => (await historyRow.count()) > 0, 40, 250));
	await tap(page, historyRow);
	const msgRowEl = page.locator(".msg").first();
	check("消息列表渲染出来了", await until(async () => (await msgRowEl.count()) > 0, 50, 250));
	const actionsBefore = await page.locator(".msg-actions").count();
	check("hover 工具条默认存在（编辑重问是内置条目）", actionsBefore > 0, `${actionsBefore} 条`);

	check("再打开布局页", await openLayoutPage(page));
	const msgSlot = page.locator(".set-ui-slot", { hasText: /消息工具条|Message actions/ }).first();
	check("布局页列出了消息工具条分区", await until(async () => (await msgSlot.count()) > 0, 30, 250));
	const msgBoxes = msgSlot.locator('.set-row input[type="checkbox"]');
	const msgBoxCount = await msgBoxes.count();
	check("消息工具条列出了可隐藏条目（≥5 条内置）", msgBoxCount >= 5, `${msgBoxCount} 个`);
	check(
		"分区里能勾到「编辑重问」",
		(await msgSlot.locator(".set-row", { hasText: /编辑重问|Edit & re-ask/ }).count()) > 0,
	);
	for (let k = 0; k < msgBoxCount; k++) {
		const box = msgBoxes.nth(k);
		if (await box.isChecked()) await tap(page, box);
	}
	check(
		"全部隐藏后消息工具条整条不画（没有可渲染条目不留空壳）",
		await until(async () => (await page.locator(".msg-actions").count()) === 0, 40, 250),
	);

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
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
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {
			try {
				server.kill("SIGKILL");
			} catch {}
		}
	}
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
