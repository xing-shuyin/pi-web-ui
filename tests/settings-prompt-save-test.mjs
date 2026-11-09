// 设置面板 · 提示词分段覆盖的保存回归：
// 1) 编辑「灵魂提示词」后点开「追加段」再点回来，内容不允许回退（历史 bug：pending patch 被当成整值重建草稿）
// 2) 关面板重开/新快照后仍是新值（真的落到了服务端，而不是只在内存里显示）
// 3) 顶部状态胶囊必须反映服务端回执（保存中 / 已保存 / 未保存可重试），不再用定时器假装成功
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), "pi-settings-prompt-save-"));
const WORK = join(BASE, "work");
const DATA_DIR = join(BASE, "data");
const AGENT_DIR = join(BASE, "agent");
const MARK = "你是灵魂回归体 SOUL-SAVE-MARK";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

async function waitServer(port) {
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`http://localhost:${port}/api/health`)).ok) return;
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

async function openSettings(page) {
	const btn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) > 0) return true;
		await tap(page, btn).catch(() => {});
		for (let i = 0; i < 15; i++) {
			if ((await page.locator(".settings-modal").count()) > 0) return true;
			await sleep(200);
		}
	}
	return false;
}

const row = (page, token) =>
	page
		.locator(".override-row")
		.filter({ hasText: `{{${token}}}` })
		.first();
const soulValue = async (page) => {
	const area = row(page, "soul").locator("textarea");
	if ((await area.count()) === 0) return null;
	return area.first().inputValue();
};

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	mkdirSync(WORK, { recursive: true });
	mkdirSync(join(AGENT_DIR, "sessions"), { recursive: true });
	writeFileSync(join(WORK, "a.txt"), "a\n");
	const port = 24000 + Math.floor(Math.random() * 4000);
	const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_DIR: AGENT_DIR,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
	let browser;
	try {
		await waitServer(port);
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 40000 });
		// 首屏 settings_state 到达前打开面板会拿到空快照，等首轮 settle
		await sleep(2500);
		// 隔离 agent 目录下首屏会弹 PiSetupModal（挡住底栏），先关掉
		for (let i = 0; i < 10; i++) {
			const setupClose = page.locator(".setup-modal .modal-close").first();
			if ((await page.locator(".setup-modal").count()) === 0) break;
			await tap(page, setupClose).catch(() => {});
			await sleep(300);
		}
		const opened = await openSettings(page);
		check("设置面板打开", opened);
		if (!opened) {
			console.log(
				"DEBUG modals:",
				JSON.stringify(
					await page.evaluate(() => [...document.querySelectorAll(".modal, .modal-backdrop")].map((e) => e.className)),
				),
			);
			console.log(
				"DEBUG buttons:",
				JSON.stringify(
					await page.evaluate(() =>
						[...document.querySelectorAll("button.chip, .footer button, button[data-tip], button[title]")]
							.slice(0, 40)
							.map((b) => `${b.className}|${b.getAttribute("data-tip") ?? ""}|${b.getAttribute("title") ?? ""}`),
					),
				),
			);
		}
		await page.waitForSelector(".settings-tab", { timeout: 25000 });
		await tap(page, page.locator('.settings-tab[data-tab="prompt"]').first());
		await page.locator(".override-row").first().waitFor({ timeout: 15000 });

		// 1) 灵魂提示词：点默认内容填空 → 改成标记文本
		await tap(page, row(page, "soul").locator(".source-default").first());
		const soulArea = row(page, "soul").locator("textarea").first();
		await soulArea.waitFor({ state: "visible", timeout: 10000 });
		await soulArea.click();
		await page.keyboard.press("Control+A");
		await page.keyboard.type(MARK, { delay: 10 });
		check("编辑后输入框是新值", (await soulValue(page)) === MARK);

		// 2) 点开「追加段」编辑器（这里曾经把灵魂的 pending 冲掉）
		const appendArea = row(page, "append").locator("textarea").first();
		if ((await appendArea.count()) > 0) await tap(page, appendArea);
		else await tap(page, row(page, "append").locator(".source-default").first());
		await sleep(400);
		check("切到追加段后灵魂内容不回退", (await soulValue(page)) === MARK, String(await soulValue(page)));

		// 3) 再点灵魂提示词行（行头），内容仍应是新值
		await tap(page, row(page, "soul").locator(".override-row-head").first());
		await sleep(300);
		check("点回灵魂提示词行不丢内容", (await soulValue(page)) === MARK, String(await soulValue(page)));

		// 4) 状态胶囊 = 服务端回执驱动的「已保存」
		const pill = page.locator(".settings-live-pill").first();
		await until(async () => ((await pill.innerText()) ?? "").trim().length > 0, 40, 150);
		const pillText = (await pill.innerText()).trim();
		const pillClass = (await pill.getAttribute("class")) ?? "";
		check(
			"保存状态来自回执（已保存且非失败态）",
			/已保存|Saved/.test(pillText) && !pillClass.includes("failed"),
			`${pillText} / ${pillClass}`,
		);

		// 5) 关面板 → 重开：值来自服务端快照，证明真的保存了
		await tap(page, page.locator(".settings-modal .modal-close").first());
		await until(async () => (await page.locator(".settings-modal").count()) === 0, 30, 200);
		check("重开设置面板", await openSettings(page));
		await page.waitForSelector(".settings-tab", { timeout: 25000 });
		await tap(page, page.locator('.settings-tab[data-tab="prompt"]').first());
		await until(async () => (await soulValue(page)) === MARK, 40, 250);
		check("关面板重开后仍是保存后的值（落盘）", (await soulValue(page)) === MARK, String(await soulValue(page)));

		// 5b) 「恢复默认模板并清空所有覆盖」必须真的清空服务端覆盖（逐个 token 发空串，空对象补丁删不掉）
		await tap(page, page.locator(".compose-toolbar > button.set-btn").last());
		await until(async () => (await soulValue(page)) === null, 40, 200);
		check("一键恢复默认后覆盖框消失", (await soulValue(page)) === null, String(await soulValue(page)));
		await tap(page, page.locator(".settings-modal .modal-close").first());
		await until(async () => (await page.locator(".settings-modal").count()) === 0, 30, 200);
		check("清空后重开设置面板", await openSettings(page));
		await page.waitForSelector(".settings-tab", { timeout: 25000 });
		await tap(page, page.locator('.settings-tab[data-tab="prompt"]').first());
		await sleep(1200);
		check("清空是持久的（服务端覆盖真的删了）", (await soulValue(page)) === null, String(await soulValue(page)));

		// 6) 保存失败必须明说：断开服务端再改 → 胶囊转 failed（红色）。禁止静默假装成功。
		server.kill("SIGKILL");
		await sleep(1500);
		await tap(page, row(page, "soul").locator(".source-default").first());
		const soulAgain = row(page, "soul").locator("textarea").first();
		await soulAgain.click();
		await page.keyboard.type("-FAIL", { delay: 10 });
		await tap(page, page.locator(".settings-tab").first()).catch(() => {});
		const failedPill = page.locator(".settings-live-pill.failed").first();
		const sawFailed = await until(async () => (await failedPill.count()) > 0, 60, 250);
		check(
			"保存未确认时胶囊显式报警（failed）",
			sawFailed,
			sawFailed ? (await failedPill.innerText()).trim() : (await pill.innerText()).trim(),
		);

		check("无前端异常", errors.filter((e) => !/WebSocket|ws/i.test(e)).length === 0, errors.slice(0, 2).join(" | "));
	} finally {
		await browser?.close().catch(() => {});
		try {
			process.kill(-server.pid);
		} catch {
			server.kill("SIGKILL");
		}
	}
}

await main();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
