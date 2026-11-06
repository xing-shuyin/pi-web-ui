import { spawn, execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = realpathSync(process.execPath);

const PORT = 31000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-scm-"));
const repo = join(workdir, "repo");
const dataDir = join(workdir, "data");
process.env.PI_WEB_CWD = repo;
process.env.PI_WEB_DATA_DIR = dataDir;
const CHROME = CHROME_PATH;

execSync("mkdir repo", { cwd: workdir, stdio: "ignore" });
execSync("git init -b main", { cwd: repo, stdio: "ignore" });
execSync("git config user.name scm-test", { cwd: repo, stdio: "ignore" });
execSync("git config user.email scm@test.local", { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "hello.txt"), "line one\nline two\n");
execSync("git add hello.txt", { cwd: repo, stdio: "ignore" });
execSync("git commit -m init", { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "hello.txt"), "line one\nline two\nline three\n");
writeFileSync(join(repo, "newfile.txt"), "brand new\n");

process.env.PI_WEB_PORT = String(PORT);

const server = spawn(NODE, [join(here, "dist", "server", "index.js")], {
	cwd: here,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {}
	try {
		rmSync(workdir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
	} catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

const termOutput = new Map();
const notices = [];
async function watchTerminalOutput() {
	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = rej;
	});
	ws.onmessage = (ev) => {
		let msg;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			return;
		}
		if (msg.type === "terminal_output") {
			termOutput.set(msg.terminalId, (termOutput.get(msg.terminalId) ?? "") + msg.data);
		}
		if (msg.type === "notice") notices.push(msg.text);
	};
	ws.send(JSON.stringify({ type: "hello", clientId: "scm-test-ws" }));
	return ws;
}

async function waitFor(fn, timeoutMs, what) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${what}`);
		await sleep(150);
	}
}

async function main() {
	await waitServer();
	console.log("server up");
	const ws = await watchTerminalOutput();

	const browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--no-sandbox"],
	});
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on("pageerror", (e) => console.log("[pageerror]", e.message));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 20000 });
	await sleep(800);

	const skipBtn = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skipBtn.isVisible().catch(() => false)) {
		await skipBtn.click();
		await sleep(300);
	}

	await page.click('.topbar-flow [role="tab"]:has-text("Git")');
	await page.waitForSelector(".scm-view", { timeout: 5000 });
	console.log("git view opened");

	let fileRows = null;
	try {
		fileRows = await waitFor(
			async () => {
				const paths = await page.locator(".scm-file-path").allTextContents();
				return paths.length >= 2 ? paths : null;
			},
			30000,
			"status file list",
		);
	} catch (err) {
		console.log("[debug] status timeout — panel error:", await page.locator(".scm-error").allTextContents());
		console.log("[debug] notices:", notices);
		console.log(
			"[debug] query-terminal output:",
			JSON.stringify((termOutput.get("scm-git-query") ?? "").slice(0, 800)),
		);
		throw err;
	}
	check("status lists hello.txt + newfile.txt", fileRows.includes("hello.txt") && fileRows.includes("newfile.txt"));

	const branchText = await page.locator(".scm-branch-current").textContent();
	check("branch chip shows main", branchText?.includes("main"));

	await page.locator(".scm-file-path", { hasText: "hello.txt" }).click();
	const diffText = await waitFor(
		async () => {
			const t = await page.locator(".scm-diff-body").textContent();
			return t && t.includes("line three") ? t : null;
		},
		20000,
		"file diff",
	);
	check("diff shows added line", diffText.includes("+line three"));
	const addLines = await page.locator(".scm-diff-line.add").count();
	check("diff renders + lines", addLines >= 1);
	check(
		"diff header shows file name",
		await page
			.locator(".scm-diff-header")
			.textContent()
			.then((s) => s?.includes("hello.txt")),
	);

	await page.locator(".scm-file-path", { hasText: "newfile.txt" }).click();
	await waitFor(
		async () =>
			(await page.locator(".scm-empty").allTextContents()).some((s) => s.includes("未跟踪") || s.includes("Untracked")),
		10000,
		"untracked note",
	);
	check("untracked file shows note", true);

	await page.locator(".scm-commit-input").fill("my first commit");
	await page.click('.scm-header button:has-text("全部提交"), .scm-header button:has-text("Commit All")');
	await page.waitForSelector('.topbar-flow [role="tab"][aria-selected="true"]:has-text("终端")', {
		timeout: 5000,
	});
	check("view auto-switched to terminal", true);
	await page.waitForSelector('.term-tab:has-text("git commit")', { timeout: 8000 });
	check("terminal tab 'git commit' created", true);

	await waitFor(
		() => {
			try {
				const log = execSync("git log -1 --format=%s", { cwd: repo }).toString().trim();
				return log === "my first commit" ? log : null;
			} catch {
				return null;
			}
		},
		30000,
		"commit lands on disk",
	);
	check("commit landed with the right message", true);
	const tabTitle = await page.locator('.term-tab:has-text("git commit")').textContent();
	check("commit tab shows the command", !!tabTitle);

	await page.click('.topbar-flow [role="tab"]:has-text("Git")');
	await waitFor(
		async () =>
			(await page.locator(".scm-empty").allTextContents()).some((s) => s.includes("干净") || s.includes("clean")),
		25000,
		"clean tree after commit",
	);
	check("status auto-refreshed to clean", true);
	check(
		"newfile.txt committed too (git add -A)",
		execSync("git status --porcelain", { cwd: repo }).toString().trim() === "",
	);

	await page.click('.topbar-flow [role="tab"]:has-text("Git")');
	await page.waitForSelector(".scm-divider", { timeout: 5000 });
	const readSidebarWidth = () =>
		page.locator(".scm-files").evaluate((el) => Math.round(el.getBoundingClientRect().width));
	const readStoredWidth = () => page.evaluate(() => localStorage.getItem("pi-web-ui:scm-sidebar-width"));
	const startWidth = await readSidebarWidth();
	check("sidebar starts at the 300px default", startWidth === 300);

	const dividerBox = await page.locator(".scm-divider").boundingBox();
	await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 120, dividerBox.y + dividerBox.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
	await sleep(200);
	const draggedWidth = await readSidebarWidth();
	check("dragging the divider widens the sidebar (+120px)", Math.abs(draggedWidth - 420) <= 2, `width=${draggedWidth}`);
	check("dragged width is persisted", (await readStoredWidth()) === String(draggedWidth));

	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 20000 });
	await sleep(600);
	const skipAgain = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skipAgain.isVisible().catch(() => false)) await skipAgain.click();
	await page.click('.topbar-flow [role="tab"]:has-text("Git")');
	await page.waitForSelector(".scm-divider", { timeout: 5000 });
	await sleep(300);
	const restoredWidth = await readSidebarWidth();
	check("width survives a page reload", Math.abs(restoredWidth - draggedWidth) <= 2, `width=${restoredWidth}`);

	await page.locator(".scm-divider").dblclick();
	await sleep(200);
	check("double-click resets to 300px", (await readSidebarWidth()) === 300);
	check("reset is persisted too", (await readStoredWidth()) === "300");

	execSync("git branch feature-x", { cwd: repo, stdio: "ignore" });
	await page.click(".scm-title-row .panel-refresh");
	await waitFor(
		async () => (await page.locator(".scm-select option").allTextContents()).some((s) => s.includes("feature-x")),
		20000,
		"branch appears in select",
	);
	await page.selectOption(".scm-select", "feature-x");
	await page.click('.scm-row button:has-text("切换")');
	await waitFor(
		async () => execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim() === "feature-x",
		20000,
		"branch switched on disk",
	);
	check("branch switched to feature-x", true);

	await page.waitForSelector('.term-tab:has-text("git checkout")', { timeout: 8000 });
	check("terminal tab 'git checkout' created", true);

	await page.click('.topbar-flow [role="tab"]:has-text("Git")');
	await page.click(".scm-title-row .panel-refresh");
	await waitFor(
		async () => (await page.locator(".scm-branch-current").textContent())?.includes("feature-x"),
		20000,
		"panel shows switched branch",
	);
	check("panel branch updated to feature-x", true);

	console.log(`\n${passed} checks passed`);
	await browser.close();
	ws.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {}
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("E2E FAILED:", err);
	process.exit(1);
});
