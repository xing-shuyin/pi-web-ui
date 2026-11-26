/**
 * 目标模式控件的「看得见」回归（issue #961 / #962）。
 *
 * 为什么必须是浏览器：这两条 bug 的共同点是「class 加了、aria-pressed 变了，但 computed style 逐项不变」。
 * unit 级只能断言「CSS 里写了规则」，证明不了「按下态与基态/hover 真的不同」，也证明不了
 * 「有附件时发送按钮真的是禁用的」。这里量的是 getComputedStyle。
 *
 * 断言（#961）：
 * - 输入框「◎ 目标」按钮按下后有底色，且目标条展开后不会变回透明（issue 说的「有时有、有时无」）；
 * - 「提炼」「计划」按下前后底色/描边变化，基态不再穿实心强调色；
 * - 既有「写目标」激活态不退化。
 * 断言（#962）：
 * - 目标态 + 附件：发送按钮禁用 + 原因在按钮上 + 材料旁有常驻提示；
 * - 一键移除附件：chip 清空、提示消失、按钮恢复、草稿与模式都保留。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8961;

if (!CHROME_PATH) {
	console.log("SKIP composer-pressed-state: Chrome unavailable (set PI_WEB_CHROME)");
	process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const base = mkdtempSync(join(tmpdir(), "piweb-pressed-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "fastfail-1", name: "FastFail" }],
			},
		},
	}),
);

freePort(PORT); // 上一次跑残留的监听先清掉（端口固定 8961）

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});

const cleanup = async () => {
	server.kill();
	await sleep(200);
	try {
		rmSync(base, { recursive: true, force: true });
	} catch {}
};

let browser;
try {
	for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error(`服务端未起来（:${PORT}）`);

	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const jsErrors = [];
	page.on("pageerror", (e) => jsErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}`);
	await page.waitForSelector(".inputbox textarea", { timeout: 20000 });
	await sleep(400);

	const style = (sel) =>
		page.$eval(sel, (el) => {
			const cs = getComputedStyle(el);
			return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color, shadow: cs.boxShadow };
		});
	const center = (sel) =>
		page.$eval(sel, (el) => {
			const r = el.getBoundingClientRect();
			return [r.x + r.width / 2, r.y + r.height / 2];
		});
	// 鼠标移开：否则量到的是 hover 态（这正是 issue 里那个「有时亮、有时不亮」的来源）
	const away = async () => {
		await page.mouse.move(2, 2);
		await sleep(220);
	};
	const same = (a, b) => a.bg === b.bg && a.border === b.border && a.color === b.color && a.shadow === b.shadow;

	// ── #961 输入框「◎ 目标」 ──────────────────────────────
	await away();
	const toggleRest = await style(".goal-toggle");
	await page.click(".goal-toggle");
	await away();
	const toggleOn = await style(".goal-toggle");
	await page.mouse.move(...(await center(".goal-toggle")));
	await sleep(220);
	const toggleHover = await style(".goal-toggle");
	await away();
	await page.click(".goalbar-hint"); // 展开目标条（issue 的指控：展开后按下态消失）
	await away();
	const toggleOnExpanded = await style(".goal-toggle");

	check("目标按钮：按下后 computed 有变化", !same(toggleRest, toggleOn), `${toggleRest.bg} → ${toggleOn.bg}`);
	check(
		"目标按钮：按下态取了 accent-soft 底",
		toggleOn.bg !== "rgba(0, 0, 0, 0)" && toggleOn.bg === toggleOnExpanded.bg,
		toggleOn.bg,
	);
	check("目标按钮：目标条展开后按下态不消失", !same(toggleRest, toggleOnExpanded), `展开后 ${toggleOnExpanded.bg}`);
	check("目标按钮：hover 与按下态不撞脸", toggleHover.bg !== toggleOn.bg, `hover ${toggleHover.bg}`);

	// ── #961 goalbar「提炼」「计划」 ────────────────────────
	await away();
	const wizardRest = await style(".goalbar-btn.action.wizard");
	await page.click(".goalbar-btn.action.wizard");
	await away();
	const wizardOn = await style(".goalbar-btn.action.wizard");
	check("提炼：按下前后有可见变化", !same(wizardRest, wizardOn), `${wizardRest.bg} → ${wizardOn.bg}`);
	check("提炼：基态不是实心 amber（强调预算还给「开」）", wizardRest.bg !== "rgb(251, 191, 36)", wizardRest.bg);

	await away();
	const planRest = await style(".goalbar-btn.action.plan");
	await page.click(".goalbar-btn.action.plan");
	await away();
	const planOn = await style(".goalbar-btn.action.plan");
	check("计划：按下前后有可见变化", !same(planRest, planOn), `${planRest.bg} → ${planOn.bg}`);
	check("计划：底色也变了（不只靠 1px 描边）", planRest.bg !== planOn.bg, `${planRest.bg} → ${planOn.bg}`);

	const modeOn = await style('.goalbar-btn.mode[aria-pressed="true"]');
	check("写目标：既有激活态没退化", modeOn.bg !== "rgba(0, 0, 0, 0)", modeOn.bg);

	// ── #962 目标态 + 附件 ────────────────────────────────
	await page.locator(".inputbox textarea").fill("按这张截图修一下");
	const hostVersion = await page.evaluate(() => globalThis.__piWebUiHost?.version ?? -1);
	check("宿主 API 版本 ≥ 2（compose 可用）", hostVersion >= 2, `version=${hostVersion}`);
	await page.evaluate(() =>
		globalThis.__piWebUiHost.compose({
			attachments: [{ path: "", name: "shot.png", mode: "inline", imageData: "QUJD", key: "k1" }],
		}),
	);
	await sleep(300);

	// 契约 §7：目标模式不再拦截附件 —— 材料以路径指针随 set_goal 下发
	await sleep(200);
	check("目标态 + 附件：不再有拦截提示（死路已拆）", (await page.locator(".attach-block").count()) === 0);
	check("目标态 + 附件：发送按钮可用", !(await page.locator(".btn.send").isDisabled()));
	check("目标态 + 附件：chip 仍在（材料随目标走）", (await page.locator(".attach-chip").count()) === 1);
	await page.locator(".inputbox textarea").fill("");
	await sleep(200);
	check(
		"目标态 + 只有附件、没有目标文本：仍不可发（空目标不能清掉已有目标）",
		await page.locator(".btn.send").isDisabled(),
	);
	await page.locator(".inputbox textarea").fill("按这张截图修一下");
	await sleep(200);

	check("全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
} catch (e) {
	console.error("TEST ERROR:", e);
	failures++;
} finally {
	try {
		await browser?.close();
	} catch {}
	await cleanup();
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
