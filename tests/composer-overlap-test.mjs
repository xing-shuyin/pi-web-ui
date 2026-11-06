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
const base = mkdtempSync(join(tmpdir(), "piweb-composer-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(workdir, "a.txt"), "a");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [
					{
						id: "anthropic-claude-sonnet-4-5-20250929-preview-very-long-id",
						name: "Claude Sonnet 4.5 Preview Long Name",
					},
				],
			},
		},
	}),
);

const WIDTHS = [320, 360, 390, 414, 428, 460, 500, 520, 560, 561, 600, 700, 768, 900, 1200];

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
for (let i = 0; i < 80; i++) {
	try {
		const res = await fetch(`http://localhost:${PORT}/api/health`);
		if (res.ok) break;
	} catch {}
	await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 428, height: 900 } });
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".composer-tools", { timeout: 20000 });
await sleep(1000);

for (const w of WIDTHS) {
	await page.setViewportSize({ width: w, height: 900 });
	await sleep(200);
	const info = await page.evaluate(() => {
		const actions = document.querySelector(".composer-tools-right .inputbox-actions");
		if (!actions.querySelector(".split-send")) {
			const pill = document.createElement("div");
			pill.className = "split-send";
			pill.innerHTML =
				'<button type="button" class="split-queue"></button><button type="button" class="split-steer"></button>';
			actions.prepend(pill);
		}
		const left = document.querySelector(".composer-tools-left");
		const right = document.querySelector(".composer-tools-right");
		const chipsRight = Math.max(...[...left.children].map((el) => el.getBoundingClientRect().right));
		const label = document.querySelector(".composer-tools-left .chip-model");
		const caret = document.querySelector(".composer-tools-left .dd-caret");
		const pill = actions.querySelector(".split-send");
		return {
			leftOverflow: left.scrollWidth - left.clientWidth,
			chipsRight: +chipsRight.toFixed(1),
			rightLeft: +right.getBoundingClientRect().left.toFixed(1),
			labelShown: label ? getComputedStyle(label).display !== "none" : false,
			caretShown: caret ? getComputedStyle(caret).display !== "none" : false,
			pillWidth: +pill.getBoundingClientRect().width.toFixed(1),
			halfWidths: [...pill.querySelectorAll("button")].map((b) => +b.getBoundingClientRect().width.toFixed(1)),
		};
	});
	const gap = +(info.rightLeft - info.chipsRight).toFixed(1);
	check(
		`w=${w} → 左侧不压右侧按钮`,
		info.chipsRight <= info.rightLeft + 0.5 && info.leftOverflow <= 2,
		`间距 ${gap}px，溢出 ${info.leftOverflow}`,
	);
	check(
		`w=${w} → 对半胶囊 78px 且两半等宽`,
		info.pillWidth === 78 && Math.abs(info.halfWidths[0] - info.halfWidths[1]) <= 0.5,
		`胶囊 ${info.pillWidth}px，两半 ${info.halfWidths.join(" / ")}`,
	);
	if (w <= 560) {
		check(`w=${w} → 模型/思考 只剩图标`, !info.labelShown && !info.caretShown);
	} else {
		check(`w=${w} → 标签可见（有余量时保留文字）`, info.labelShown, `chip 标签 ${info.labelShown}`);
	}
}

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
