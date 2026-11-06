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
const base = mkdtempSync(join(tmpdir(), "pi-ctxmenu-ui-"));
const WORK = join(base, "work");
const SUB = join(WORK, "subproject");
const FILE = join(WORK, "readme.txt");
const UPLOAD_SRC = join(base, "incoming", "upload-me.txt");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(SUB, { recursive: true });
writeFileSync(FILE, "hello\n");
writeFileSync(join(SUB, "inside.txt"), "sub\n");
mkdirSync(join(base, "incoming"), { recursive: true });
writeFileSync(UPLOAD_SRC, "upload\n");

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
		].join("\n") + "\n",
	);
	return file;
}
seedSession(WORK, "ctxmenu-seed", "右键菜单回归用的对话");

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

async function rightClick(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("rightClick: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
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

const menuItems = (page) => page.locator(".ctx-menu .ctx-menu-item, .ctx-menu .ctx-item");
async function menuTexts(page) {
	return (await menuItems(page).allTextContents()).map((s) => s.trim());
}
async function hasMenuItem(page, text) {
	return (await menuTexts(page)).some((t) => t.includes(text));
}
async function clickMenuItem(page, text) {
	const item = menuItems(page).filter({ hasText: text }).first();
	await tap(page, item);
}

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

	const dirRow = page.locator('.panel-right .file-item.dir[data-path="subproject"]').first();
	if (!(await until(async () => (await dirRow.count()) > 0, 8, 250))) {
		await tap(
			page,
			page
				.locator(
					'button.panel-toggle[aria-label*="文件列表"], button.panel-toggle[aria-label*="Files"], button[title*="文件列表"], button[title*="Files"]',
				)
				.first(),
		);
	}
	check("右栏文件树列出了子目录", await until(async () => (await dirRow.count()) > 0, 40, 250));

	await page.evaluate(
		"window.__ctx=[]; window.addEventListener('contextmenu', e => window.__ctx.push((e.target && e.target.className) || 'x'), true)",
	);
	await rightClick(page, dirRow);
	const ctxInfo = await page.evaluate(
		"JSON.stringify({ev: window.__ctx, menu: document.querySelectorAll('.ctx-menu').length, backdrop: document.querySelectorAll('.modal-backdrop').length})",
	);
	if (process.env.CTX_DEBUG) console.log("DEBUG", ctxInfo);
	check(
		"目录行右键弹出**全局**右键菜单（.ctx-menu）",
		await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150),
		ctxInfo,
	);
	const dirTexts = await menuTexts(page);
	check(
		"菜单含「上传到文件夹」",
		dirTexts.some((t) => t.includes("上传文件到此文件夹")),
		dirTexts.join(" | "),
	);
	check(
		"菜单含「以项目打开」",
		dirTexts.some((t) => t.includes("以项目打开")),
	);
	check(
		"菜单含「添加为工作区根」",
		dirTexts.some((t) => t.includes("添加为工作区根")),
	);

	await clickMenuItem(page, "添加为工作区根");
	check("菜单点后关闭", await until(async () => (await page.locator(".ctx-menu").count()) === 0, 20, 150));
	const rootPicker = page.locator(".root-picker-trigger").first();
	check("加根后右栏出现根选择器", await until(async () => (await rootPicker.count()) > 0, 40, 250));

	await tap(page, rootPicker);
	const pickerRows = page.locator(".root-picker-menu .root-picker-row");
	check("选择器列出主根 + 1 个额外根", (await pickerRows.count()) === 2, `${await pickerRows.count()} 行`);
	const extraRow = pickerRows.filter({ hasText: "subproject" }).first();
	check("额外根行显示的是绝对路径", ((await extraRow.textContent()) ?? "").includes("subproject"));
	await tap(page, extraRow.locator(".root-picker-item").first());
	const browsed = await until(
		async () => ((await page.locator(".panel-crumbs").first().textContent()) ?? "").includes("subproject"),
		40,
		250,
	);
	check("选中额外根后文件树切到该根（crumbs 显示它的路径）", browsed);
	check(
		"切到根后列出的是根下面的内容（inside.txt）",
		await until(
			async () => (await page.locator('.panel-right .file-item[data-path*="inside.txt"]').count()) > 0,
			40,
			250,
		),
	);

	await tap(page, rootPicker);
	await tap(page, page.locator(".root-picker-menu .root-picker-remove").first());
	check(
		"移除根后选择器消失",
		await until(async () => (await page.locator(".root-picker-trigger").count()) === 0, 40, 250),
	);
	check(
		"移除后文件树回到主工作区（重新看到 subproject）",
		await until(
			async () => (await page.locator('.panel-right .file-item.dir[data-path="subproject"]').count()) > 0,
			40,
			250,
		),
	);

	const fileRow = page.locator('.panel-right .file-item.file[data-path="readme.txt"]').first();
	check("文件树列出了文件行", await until(async () => (await fileRow.count()) > 0, 40, 250));
	await rightClick(page, fileRow);
	check("文件行右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	const fileTexts = await menuTexts(page);
	check(
		"文件行菜单是「上传到当前目录」",
		fileTexts.some((t) => t.includes("上传文件到当前目录")),
		fileTexts.join(" | "),
	);
	check("文件行没有「以项目打开」", !fileTexts.some((t) => t.includes("以项目打开")));
	check("文件行没有「添加为工作区根」", !fileTexts.some((t) => t.includes("添加为工作区根")));
	await page.keyboard.press("Escape");

	const body = page.locator(".panel-right .panel-body").first();
	const bodyBox = await body.boundingBox();
	await page.mouse.click(bodyBox.x + bodyBox.width - 20, bodyBox.y + bodyBox.height - 20, { button: "right" });
	check("列表空白处右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	const blankTexts = await menuTexts(page);
	check(
		"空白处菜单含「上传到当前目录」",
		blankTexts.some((t) => t.includes("上传文件到当前目录")),
		blankTexts.join(" | "),
	);
	check(
		"空白处菜单没有「以项目打开」/「添加为工作区根」",
		!blankTexts.some((t) => t.includes("以项目打开") || t.includes("添加为工作区根")),
	);

	const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
	await clickMenuItem(page, "上传文件到当前目录");
	const fc = await chooser;
	check("点「上传到当前目录」打开了文件选择器", !!fc);
	if (fc) {
		await fc.setFiles(UPLOAD_SRC);
		const uploaded = await until(
			async () =>
				(await page
					.locator(".notice, .toast")
					.filter({ hasText: /上传|uploaded/i })
					.count()) > 0,
			40,
			250,
		);
		check("上传后界面给出回执（功能真的接上了）", uploaded);
	}

	const leftPanel = page.locator(".panel-left").first();
	check("左栏可见", await until(async () => (await leftPanel.count()) > 0, 30, 250));

	const historyRow = leftPanel.locator(".panel-sessions .lp-row").first();
	check("左栏列出种进去的历史会话", await until(async () => (await historyRow.count()) > 0, 40, 250));
	await rightClick(page, historyRow);
	check("历史会话行右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	let leftTexts = await menuTexts(page);
	check(
		"历史行菜单含「关闭已结束子代理」",
		leftTexts.some((t) => t.includes("已结束子代理")),
		leftTexts.join(" | "),
	);
	check("历史行菜单没有「强行关闭对话」", !leftTexts.some((t) => t.includes("强行关闭")), leftTexts.join(" | "));
	await page.keyboard.press("Escape");

	await tap(page, leftPanel.locator(".panel-sessions .session-item").first());
	const runningSection = leftPanel.locator(".lp-section-convs").first();
	check("打开会话后「运行的对话」区出现", await until(async () => (await runningSection.count()) > 0, 50, 250));

	const runningRow = runningSection.locator(".lp-row").first();
	if (await runningSection.count()) {
		await rightClick(page, runningRow);
		const openedRow = await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150);
		check("运行中对话行右键弹出菜单", openedRow);
		if (openedRow) {
			leftTexts = await menuTexts(page);
			check(
				"对话行菜单含「强行关闭对话」",
				leftTexts.some((t) => t.includes("强行关闭对话")),
				leftTexts.join(" | "),
			);
			await clickMenuItem(page, "强行关闭对话");
			const armed = await until(async () => await hasMenuItem(page, "确认强行关闭"), 20, 150);
			check("第一次点只进入确认态（菜单不关、文案换成确认）", armed && (await page.locator(".ctx-menu").count()) > 0);
			await page.keyboard.press("Escape");
		}
	}

	await rightClick(page, runningSection);
	const openedSection = await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150);
	check("运行对话区右键弹出菜单", openedSection);
	if (openedSection) {
		leftTexts = await menuTexts(page);
		check(
			"区域菜单含「关闭已结束子代理」",
			leftTexts.some((t) => t.includes("已结束子代理")),
			leftTexts.join(" | "),
		);
		check("区域菜单没有「强行关闭对话」", !leftTexts.some((t) => t.includes("强行关闭")));
		await page.keyboard.press("Escape");
	}

	await rightClick(page, dirRow);
	await clickMenuItem(page, "以项目打开");
	const cwdChanged = await until(
		async () => ((await page.locator(".statusbar .status-cwd").first().textContent()) ?? "").includes("subproject"),
		50,
		250,
	);
	check("「以项目打开」切换了工作目录（底栏 cwd 显示 subproject）", cwdChanged);
	await until(
		async () => (await page.locator('.panel-right .file-item.dir[data-path="subproject"]').count()) > 0,
		50,
		250,
	);

	await tap(
		page,
		page
			.locator(
				'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
			)
			.first(),
	);
	const modalOpen = await until(async () => (await page.locator(".settings-modal").count()) > 0, 30, 250);
	check("设置面板打开", modalOpen);
	if (modalOpen) {
		await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
		const panelsSlot = page.locator(".set-ui-slot", { hasText: /右侧面板|Right panel/ }).first();
		const filesRow = panelsSlot.locator(".set-row", { hasText: /文件列表|Files/ }).first();
		const listed = await until(async () => (await filesRow.count()) > 0, 30, 250);
		check("布局页列出了右栏的「文件列表」条目", listed);
		if (listed) {
			await tap(page, filesRow.locator('input[type="checkbox"]').first());
			const hidden = await until(async () => (await page.locator(".panel-right .panel-body").count()) === 0, 30, 250);
			check("取消勾选后右栏的文件树消失（用户偏好对内置 tab 同样生效）", hidden);
			await tap(page, filesRow.locator('input[type="checkbox"]').first());
			const back = await until(async () => (await page.locator(".panel-right .panel-body").count()) > 0, 30, 250);
			check("勾回去后文件树回来", back);
		}
		await tap(page, page.locator(".settings-modal .modal-close").first());
		await until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
	}

	if (modalOpen) {
		await tap(
			page,
			page
				.locator(
					'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
				)
				.first(),
		);
		if (await until(async () => (await page.locator(".settings-modal").count()) > 0, 30, 250)) {
			await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
			const topbarSlot = page.locator(".set-ui-slot", { hasText: /顶栏|Top bar/ }).first();
			const tasksRow = topbarSlot.locator(".set-row", { hasText: /后台任务|Background tasks/ }).first();
			if (await until(async () => (await tasksRow.count()) > 0, 30, 250)) {
				await tap(page, tasksRow.locator('input[type="checkbox"]').first());
				await tap(page, page.locator(".settings-modal .modal-close").first());
				await until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
				const mainGone = (await page.locator("button.bg-task-chip").count()) === 0;
				check("隐藏后主栏的后台任务按钮消失", mainGone);
				await tap(page, page.locator(".plugin-topbar-more > button").first());
				const inOverflow = await until(
					async () =>
						(await page
							.locator(".plugin-topbar-menu")
							.filter({ hasText: /后台任务|Background tasks/ })
							.count()) > 0,
					20,
					200,
				);
				check("隐藏后它出现在「⋯」溢出菜单里", inOverflow);
				await tap(
					page,
					page
						.locator(".plugin-topbar-menu .plugin-topbar-menu-keep, .plugin-topbar-menu [role=menuitem]")
						.filter({ hasText: /后台任务|Background tasks/ })
						.first(),
				);
				const tasksOpen = await until(
					async () => (await page.getByText(/后台任务|Background tasks/).count()) > 0,
					20,
					200,
				);
				check("点溢出菜单里的它能真的打开面板（不是死按钮）", tasksOpen);
			}
		}
	}

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
