// Vision bridge — settings-panel UI test (no model calls).
// Opens the ⚙ settings modal and verifies the vision-bridge section:
// toggle switch reflects server state, the model picker lists the configured
// vision models, picking one round-trips through set_settings → settings_state,
// and turning the bridge off hides the picker.
// Usage: npm run build && node vision-bridge-ui-test.mjs
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
const PORT = 30000 + Math.floor(Math.random() * 5000);
const URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-vbu-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({
		main: { type: "api_key", key: "k" },
		vision: { type: "api_key", key: "k" },
	}),
);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "k",
				models: [{ id: "deepseek-main", input: ["text"] }],
			},
			vision: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "k",
				models: [
					{ id: "qwen-vl", name: "Qwen VL", input: ["text", "image"] },
					{ id: "glm-vl", name: "GLM Vision", input: ["text", "image"] },
				],
			},
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});
process.on("exit", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

async function run() {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${URL}/`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	const browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(URL);
	// Wait for the app shell (chat input).
	await page.waitForSelector(".chat-input, .inputbar, textarea", {
		timeout: 30000,
	});

	// Open settings via the ⚙ chip in the top bar.
	const settingsChip = page.locator('[title*="设置"], [title*="Settings"]').first();
	await settingsChip.click();
	await page.waitForSelector(".settings-modal", { timeout: 10000 });

	// Sidebar navigation: the settings modal is now tabbed (left rail), only
	// the active group is rendered — open the vision-bridge tab first.
	await page.locator(".settings-tab", { hasText: "视觉桥" }).click();
	await page.waitForSelector(".set-section-title", { timeout: 5000 });

	// Vision bridge section heading.
	const heading = page.locator(".set-section-title", { hasText: "视觉桥" });
	check("vision bridge section rendered", (await heading.count()) > 0);
	await heading.first().scrollIntoViewIfNeeded();

	// Toggle switch present and ON by default.
	const sw = page.locator(".set-switch").last();
	const swOn = await sw.evaluate((el) => el.classList.contains("on"));
	check("toggle starts enabled", swOn);

	// Model picker lists both vision models + auto option. (The vision-bridge
	// section now has TWO selects — model + prompt mode — so scope to the
	// first one inside the section.)
	const vbSection = page.locator(".set-section", { hasText: "视觉桥" });
	const modelSelect = vbSection.locator("select").first();
	await modelSelect.waitFor({ timeout: 5000 });
	const opts = await modelSelect.locator("option").allTextContents();
	check(
		"picker lists auto + 2 vision models",
		opts.length === 3 && opts.some((o) => o.includes("自动")),
		JSON.stringify(opts),
	);

	// Pick the second vision model → server echoes it back.
	await modelSelect.selectOption("vision/glm-vl");
	await page.waitForFunction(
		() => {
			const sections = [...document.querySelectorAll(".set-section")];
			const vb = sections.find((el) => el.textContent.includes("视觉桥"));
			const sel = vb?.querySelector("select");
			return sel instanceof HTMLSelectElement && sel.value === "vision/glm-vl";
		},
		{ timeout: 10000 },
	);
	check("picker keeps the chosen model after server echo", true);

	// Turn the bridge off → picker disappears, hint appears.
	await sw.click();
	await page.waitForSelector(".settings-modal", { timeout: 5000 });
	await sleep(800);
	const pickerInVb = await vbSection.locator("select").count();
	const hint = await page.locator(".set-hint", { hasText: "已关闭" }).count();
	check("disabling hides picker + shows off hint", pickerInVb === 0 && hint > 0);

	// -- replace-mode prefills the built-in default prompts --------------------
	// Vision bridge: switch its prompt mode to "replace" → the textarea must be
	// prefilled with the built-in default transcription prompt (ready to edit).
	await sw.click(); // re-enable the bridge
	await sleep(800);
	const vbModeSelect = vbSection.locator("select").nth(1);
	await vbModeSelect.waitFor({ timeout: 5000 });
	await vbModeSelect.selectOption("replace");
	await page.waitForFunction(
		() => {
			const sections = [...document.querySelectorAll(".set-section")];
			const vb = sections.find((el) => el.textContent.includes("视觉桥"));
			const ta = vb?.querySelector(".set-prompt-input");
			return ta instanceof HTMLTextAreaElement && ta.value.includes("You are a vision bridge");
		},
		{ timeout: 10000 },
	);
	check("replace mode prefills the built-in vision-bridge prompt", true);

	// System prompt: switch to the “replace” tab group first (only the active
	// sidebar group is rendered), then flip to "replace" — the textarea must
	// show the built-in default system prompt (the SDK's default, since the
	// test agent dir has no system-prompt file).
	await page.locator(".settings-tab", { hasText: "系统提示词" }).click();
	const sysSection = page.locator(".set-section", { hasText: "系统提示词" });
	const sysModeSelect = sysSection.locator("select").first();
	await sysModeSelect.selectOption("replace");
	await page.waitForFunction(
		() => {
			const sections = [...document.querySelectorAll(".set-section")];
			const sys = sections.find((el) => el.textContent.includes("系统提示词"));
			const ta = sys?.querySelector(".set-prompt-input");
			return ta instanceof HTMLTextAreaElement && ta.value.includes("You are an expert coding assistant");
		},
		{ timeout: 10000 },
	);
	check("replace mode prefills the built-in system prompt", true);

	await browser.close();
}

try {
	await run();
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
} catch (err) {
	console.error("ERROR:", err.message);
	process.exit(1);
} finally {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}
