/* 输入框 ↑/↓ 历史回溯 vs 自动折行（issue #127）E2E —— 只有真浏览器有布局引擎，
 * 「视觉行」判定必须在真页面里锁。
 *
 * 锁住的行为：
 *   1. 没有 \n 但会自动折行的长草稿里按 ↑ → 光标上移一视觉行，**不翻历史**、值不变
 *   2. 折行的每一行都能用 ↑ 走完（draft 的视觉行数决定要按几次）
 *   3. 光标真的到首视觉行后，↑ 才切到上一条历史（功能本身不退化）
 *   4. ↓ 能从历史切回正在编辑的草稿（草稿没丢）
 *   5. 真实换行的多行草稿：首/末行边界行为与改动前一致
 *   6. 单行短草稿：↑ 立刻翻历史（老行为不变）
 *   7. 测量用的隐藏镜像节点不残留草稿正文
 *   8. 全程无 JS 报错
 *
 * Run: npm run build && node tests/composer-history-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 90);
const base = mkdtempSync(join(tmpdir(), "piweb-caretline-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
// 假 provider（指向黑洞端口）：只为让会话就绪、输入框可编辑，不会真发请求
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			failfast: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "failfast-1", name: "FastFail" }],
			},
		},
	}),
);

const OLDER = ["更早的提问 A", "更早的提问 B"]; // localStorage 里预置的两条历史（B 更新）
// 没有换行符、但在输入框里必然折成多行的长草稿
const LONG = "这是一段没有换行符但会按输入框宽度自动折行的长文本，用来验证方向键不会误触发历史回溯。".repeat(3);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

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
let up = false;
for (let i = 0; i < 80; i++) {
	try {
		const res = await fetch(`http://localhost:${PORT}/api/health`);
		if (res.ok) {
			up = true;
			break;
		}
	} catch {}
	await sleep(250);
}
if (!up) {
	console.log("✗ 服务端未起来，跳过");
	server.kill();
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => {
	if (m.type() === "error") jsErrors.push(m.text());
});
// 预置全局 prompt 历史（App 与输入框共用 localStorage 里的这一份）
await page.addInitScript((history) => {
	localStorage.setItem("pi-web-ui:prompt-history", JSON.stringify(history));
}, OLDER);

await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".inputbox textarea", { timeout: 20000 });
await page.waitForFunction(
	() => {
		const ta = document.querySelector(".inputbox textarea");
		return ta && !ta.disabled;
	},
	{ timeout: 20000 },
);
await sleep(300);

const ta = page.locator(".inputbox textarea");

const caret = () =>
	page.evaluate(() => {
		const el = document.querySelector(".inputbox textarea");
		return { value: el.value, start: el.selectionStart, end: el.selectionEnd };
	});

/** 草稿实际占用的视觉行数（(scrollHeight - 上下 padding) / 行高），用来确认「确实折行了」
 *  以及要按几次 ↑ 才能走到首视觉行。 */
const rows = () =>
	page.evaluate(() => {
		const el = document.querySelector(".inputbox textarea");
		const cs = getComputedStyle(el);
		const lh = parseFloat(cs.lineHeight) || 0;
		if (!lh) return 0;
		const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
		return Math.round((el.scrollHeight - pad) / lh);
	});

/** 把一段文本塞进输入框（走宿主 compose 桥：React 状态更新，不逐字敲键盘）。光标落在末尾。 */
const setDraft = async (text) => {
	await ta.fill("");
	// fill("") 到 React 提交之间有一帧空窗，这期间 compose 会按「追加」合并 → 等到真清空再注入。
	await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "", null, {
		timeout: 3000,
	});
	const ok = await page.evaluate((t) => globalThis.__piWebUiHost.compose({ text: t }), text);
	if (!ok) throw new Error("compose 注入失败");
	await page.waitForFunction((t) => document.querySelector(".inputbox textarea")?.value === t, text, {
		timeout: 3000,
	});
	await page.waitForTimeout(120); // 光标由 setText 之后的 rAF 设置
};

// ── 1) 折行草稿里 ↑ 只移动光标 ────────────────────────────────────────────────
await setDraft(LONG);
const draftRows = await rows();
check("草稿确实自动折行（≥3 个视觉行）", draftRows >= 3, `rows=${draftRows}`);

const before = await caret();
check("草稿里没有换行符（问题场景）", !LONG.includes("\n") && before.value === LONG);

await ta.press("ArrowUp");
let after = await caret();
check("↑ 不翻历史：输入框内容原样保留", after.value === LONG, JSON.stringify(after.value.slice(0, 12)));
check(
	"↑ 把光标移到上一视觉行（selectionStart 变小、无选区）",
	after.start < before.start && after.start === after.end,
	`${before.start} → ${after.start}`,
);

// ── 2) 一路 ↑ 到首视觉行，再 ↑ 才翻历史 ──────────────────────────────────────
let presses = 1; // 上面已经按过一次（只移动了光标）
let cursorMoved = 1;
let cur = after;
let switched = false;
for (let i = 0; i < 12; i++) {
	await ta.press("ArrowUp");
	presses++;
	const next = await caret();
	if (next.value !== LONG) {
		switched = true;
		cur = next;
		break;
	}
	if (next.start >= cur.start) {
		check(`第 ${presses} 次 ↑ 没有继续上移光标`, false, `${cur.start} → ${next.start}`);
		break;
	}
	cursorMoved++;
	cur = next;
}
check(
	"折行草稿：rows-1 次 ↑ 逐行上移，第 rows 次才切历史",
	switched && cursorMoved === draftRows - 1 && presses === draftRows,
	`moved=${cursorMoved} presses=${presses} rows=${draftRows}`,
);
check("↑ 到边界后确实切到上一条历史（功能没退化）", cur.value === OLDER[1], JSON.stringify(cur.value));

// ── 3) ↓ 切回正在编辑的草稿（草稿没丢） ─────────────────────────────────────
await ta.press("ArrowDown");
after = await caret();
check("↓ 从历史切回未发送的草稿", after.value === LONG, JSON.stringify(after.value.slice(0, 12)));

// ── 4) 真实换行的多行草稿：首行边界行为与改动前一致 ──────────────────────────
await setDraft("第一行\n第二行");
await ta.press("Control+Home");
after = await caret();
check("Ctrl+Home 把光标放到文首", after.start === 0, `start=${after.start}`);
await ta.press("ArrowUp");
after = await caret();
check("换行草稿的光标在首行时 ↑ 仍然切历史（老行为不变）", after.value === OLDER[1], JSON.stringify(after.value));

// ── 5) 单行短草稿：↑ 立刻切历史 ─────────────────────────────────────────────
await setDraft("短草稿");
check("单行草稿只占 1 个视觉行", (await rows()) === 1);
await ta.press("ArrowUp");
after = await caret();
check("单行草稿（光标在唯一一行）↑ 直接切历史", after.value === OLDER[1], JSON.stringify(after.value));

// ── 6) 测量节点不留正文 ─────────────────────────────────────────────────────
const mirrorText = await page.evaluate(() => {
	const el = document.querySelector("body > div[data-caret-mirror]");
	return el ? el.textContent : "missing";
});
check("隐藏镜像节点存在且不残留草稿正文", mirrorText === "", JSON.stringify(mirrorText));

check("全程无 JS 报错", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
