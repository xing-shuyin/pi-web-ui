/**
 * 源代码管理（Git / SCM）端到端回归 —— 对齐 A+C 改版后的真实 UI 语义。
 *
 * A：分组暂存（已暂存 / 更改，行首勾选框 = 暂存开关，组头 +all/−all、同步条、提交栏摘要）
 * C：⌘⇧P 操作面板（分组动作 + 搜索 + ↑↓/⏎/Esc）
 *
 * 约定：
 * - 仓库、数据目录全部在 mkdtemp 里；绝不在源码仓库做任何 git 写操作。
 * - 端口随机且先探测空闲；只按 PID 杀进程（detached → 负 PID 杀进程组）。
 * - UI 里的写操作都通过终端执行，所以断言一律回读磁盘：
 *   「已暂存」= `git diff --cached`（索引 vs HEAD），「更改」= `git diff` + 未跟踪文件。
 *   不用 `git status --porcelain` 的列位做断言——那一列在并发 status 刷新时会出现瞬时错位。
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = realpathSync(process.execPath);
/**
 * 按 PID 杀进程树：Windows 上 process.kill(-pid) 无效（没有进程组语义），必须 taskkill /T。
 * 只认 PID，不碰任何别的进程（禁 pkill -f / killall）。
 */
function killTree(pid) {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 端口：≥ 8900、随机、启动前探测空闲                                    */
/* ------------------------------------------------------------------ */

function portFree(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.once("listening", () => srv.close(() => resolve(true)));
		srv.listen(port, "127.0.0.1");
	});
}

async function pickPort() {
	for (let i = 0; i < 60; i++) {
		const port = 8900 + Math.floor(Math.random() * 30000);
		if (port >= 8900 && (await portFree(port))) return port;
	}
	throw new Error("no free port available");
}

const PORT = await pickPort();

/* ------------------------------------------------------------------ */
/* fixture：临时仓库 + 暂存 / 工作区 / 未跟踪 / both 四种状态             */
/* ------------------------------------------------------------------ */

const workdir = mkdtempSync(join(tmpdir(), "piweb-scm-"));
const repo = join(workdir, "repo");
const dataDir = join(workdir, "data");
const remotePath = join(workdir, "remote.git");
const otherRepo = join(workdir, "other");
process.env.PI_WEB_CWD = repo;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_PORT = String(PORT);

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
function gitIn(cwd, args) {
	try {
		return execSync(`git --no-pager ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"], env: gitEnv })
			.toString()
			.trim();
	} catch (err) {
		const stderr = err.stderr ? err.stderr.toString().trim() : "";
		throw new Error(`git ${args} (in ${cwd}) failed: ${stderr || err.message}`);
	}
}
const git = (args) => gitIn(repo, args);
const lines = (text) =>
	text
		? text
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
		: [];
/** 已暂存 = 索引相对 HEAD 的改动（提交栏里的“已暂存”就是这个语义）。 */
const stagedFiles = () => lines(git("diff --cached --name-only"));
/** 更改 = 工作区相对索引的改动。 */
const worktreeFiles = () => lines(git("diff --name-only"));
const untrackedFiles = () => lines(git("ls-files --others --exclude-standard"));
const treeClean = () => stagedFiles().length === 0 && worktreeFiles().length === 0 && untrackedFiles().length === 0;

execSync(`mkdir ${JSON.stringify(repo)}`, { cwd: workdir, stdio: "ignore" });
git("init -b main");
git("config user.name scm-e2e");
git("config user.email scm@e2e.local");
git("config core.autocrlf false");
writeFileSync(join(repo, "only-staged.txt"), "s1\ns2\ns3\n");
writeFileSync(join(repo, "only-worktree.txt"), "u1\nu2\nu3\n");
writeFileSync(join(repo, "both.txt"), "b1\n");
writeFileSync(join(repo, "discard-me.txt"), "keep\n");
git("add -A");
git("commit -m init");
// 已暂存（只有索引位）
writeFileSync(join(repo, "only-staged.txt"), "s1\ns3\n");
git("add only-staged.txt");
// 只有工作区改动
writeFileSync(join(repo, "only-worktree.txt"), "u1\n");
// 两者都有：先 add 再改一次（x=M y=M）
writeFileSync(join(repo, "both.txt"), "b1\nb2\n");
git("add both.txt");
writeFileSync(join(repo, "both.txt"), "b1\nb2\nb3\n");
// 未跟踪
writeFileSync(join(repo, "brand-new.txt"), "n1\n");

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = spawn(NODE, [join(here, "dist", "server", "index.js")], {
	cwd: here,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

let cleaned = false;
/**
 * 杀服务（按进程组 PID）+ 删临时目录。
 * Windows 上 pty/子进程句柄释放是异步的，删目录要重试几次，别把 mkdtemp 的残留留在临时目录里。
 */
async function cleanup() {
	if (cleaned) return true;
	cleaned = true;
	killTree(server.pid);
	for (let i = 0; i < 12; i++) {
		try {
			rmSync(workdir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
			if (!existsSync(workdir)) return true;
		} catch {}
		await sleep(300);
	}
	console.log("[cleanup] 临时目录没删干净：", workdir);
	return false;
}
// 兜底：异常退出时至少别留下活着的服务进程。
process.on("exit", () => {
	killTree(server.pid);
});

let passed = 0;
const failed = [];
const check = (name, cond, detail) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed.push({ name, detail });
		console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
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

/**
 * 等磁盘状态收敛到期望再断言。
 * UI 写操作是「终端里跑 git」的异步链路，所以单次瞬时读可能读到中间态；
 * 这里只在有界时间内等收敛，最终断言仍然是磁盘真状态，不放松要求。
 */
async function waitDisk(predicate, what, timeoutMs = 30000) {
	try {
		await waitFor(() => (predicate() ? true : null), timeoutMs, what);
	} catch {}
	return predicate();
}

/**
 * 点一个「在终端里跑 git」的动作，然后等磁盘生效。
 *
 * 同一个动作用第二次时会复用同名终端（runGitCommand → terminal.restart + run_command），
 * 重启与下发命令之间是既有竞态，命令偶尔会丢一次。这里最多补点一次并打日志（不静默跳过）。
 */
async function clickGitAction(click, done, what, timeoutMs = 20000) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		await click();
		if (await waitDisk(done, what, timeoutMs)) return true;
		if (attempt === 1) console.log(`  ! ${what}：第一次点击没落地，补点一次（终端重启竞态）`);
	}
	return false;
}

/* ------------------------------------------------------------------ */
/* 终端旁路：xterm 渲染出来的文本里应该有真实命令行                      */
/* ------------------------------------------------------------------ */

let notices = [];
async function watchWebSocket() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = rej;
	});
	ws.onmessage = (ev) => {
		try {
			const msg = JSON.parse(ev.data);
			if (msg.type === "notice") notices.push(msg.text);
		} catch {}
	};
	ws.send(JSON.stringify({ type: "hello", clientId: "scm-e2e-ws" }));
	return ws;
}

/* ------------------------------------------------------------------ */
/* 浏览器侧小工具                                                       */
/* ------------------------------------------------------------------ */

let page;
let promptAnswer = "";
const dialogs = [];

/** 面板是否真的在视口里（手机上右栏是抽屉，DOM 在但可能在屏外）。 */
async function panelInViewport() {
	const box = await page
		.locator(".scm-view")
		.boundingBox()
		.catch(() => null);
	const vp = page.viewportSize();
	if (!box || !vp) return false;
	return box.width > 40 && box.x < vp.width && box.x + box.width > 0 && box.y < vp.height;
}

/** 打开 Git 面板（顶栏 Git 标签是开关，所以最多点两次；只看是否真在视口）。 */
async function showGit() {
	for (let i = 0; i < 5; i++) {
		if (await panelInViewport()) {
			await sleep(200);
			return;
		}
		const tab = page.locator('.topbar-flow [role="tab"]:has-text("Git")').first();
		if ((await tab.count()) > 0) await tab.click().catch(() => {});
		else await page.keyboard.press("Control+Shift+G");
		await sleep(500);
	}
	await page.waitForSelector(".scm-view", { state: "visible", timeout: 20000 });
}

async function refreshPanel() {
	const btn = page.locator(".scm-header .panel-refresh");
	await btn.waitFor({ state: "visible", timeout: 10000 });
	if (await btn.isDisabled().catch(() => true)) await sleep(400);
	await btn.click({ force: true }).catch(() => {});
	await sleep(600);
}

const groupPaths = (group) => page.locator(`.scm-group[data-group="${group}"] .scm-file-path`).allTextContents();
const groupCount = (group) => page.locator(`.scm-group[data-group="${group}"] .scm-file`).count();
const rowOf = (group, path) =>
	page
		.locator(`.scm-group[data-group="${group}"] .scm-file`)
		.filter({ has: page.locator(".scm-file-path", { hasText: path }) })
		.first();

const commitButton = () => page.locator(".gd-commit-bar .commit-row button.btn.primary");
const commitMetaText = async () => (await page.locator(".scm-commit-meta span").first().textContent()) ?? "";
const commitTargetText = async () =>
	(await page
		.locator(".scm-commit-target")
		.textContent()
		.catch(() => "")) ?? "";
const syncButton = (label) => page.locator(`.scm-sync button:has-text("${label}")`).first();
const stageAllBtn = () => page.locator(".scm-files-header .scm-files-head-actions .scm-act").nth(0);
const unstageAllBtn = () => page.locator(".scm-files-header .scm-files-head-actions .scm-act").nth(1);

/** 当前渲染出来的终端文本（xterm DOM 渲染器把每行写进 .xterm-rows）。 */
async function terminalText() {
	return page.evaluate(() => {
		const rows = [...document.querySelectorAll(".xterm-rows")];
		return rows.map((r) => r.textContent ?? "").join("\n");
	});
}

async function waitTerminalCommand(command, timeoutMs = 25000) {
	return waitFor(
		async () => ((await terminalText()).includes(command) ? true : null),
		timeoutMs,
		`terminal shows "${command}"`,
	).catch(() => false);
}

const phase = (name) => console.log(`\n── ${name} ──`);

/* 操作面板（⌘⇧P） */
const palLabels = () => page.locator(".scm-pal-row-label").allTextContents();
const palDisabled = () => page.locator(".scm-pal-row").evaluateAll((rows) => rows.map((r) => r.disabled));
async function palIndex(label) {
	return page.evaluate((label) => {
		const rows = [...document.querySelectorAll(".scm-pal-row")];
		return rows.findIndex((r) => r.querySelector(".scm-pal-row-label")?.textContent?.trim() === label);
	}, label);
}
async function openPalette() {
	if (!(await page.locator(".scm-pal").count())) {
		await page.locator('.scm-header button[aria-haspopup="dialog"]').click();
	}
	await page.waitForSelector(".scm-pal", { state: "visible", timeout: 8000 });
	await sleep(150);
}
async function closePalette() {
	if (await page.locator(".scm-pal").count()) await page.keyboard.press("Escape");
	await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 }).catch(() => {});
}
async function palSearch(query) {
	await openPalette();
	const input = page.locator(".scm-pal input");
	await input.fill("");
	await input.fill(query);
	await sleep(250);
}
/**
 * 面板里执行一个「在终端里跑 git」的动作，并等磁盘副作用落地。
 * 第二次用同一个动作时会复用/重启同名终端（runGitCommand），重启与下发命令之间有既有竞态，
 * 命令偶尔丢一次；这里最多重试一次并打日志（不静默通过）。
 */
async function palRunUntil(label, query, done, what, timeoutMs = 30000) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		await palRun(label, query);
		if (await waitDisk(done, what, timeoutMs)) return true;
		if (attempt === 1) console.log(`  ! ${what}：第一次执行没落地，重试一次（终端重启竞态）`);
		await showGit();
		await refreshPanel();
	}
	return false;
}

/** 搜索 → 按 ↑↓ 把游标挪到目标行（Enter 用的是 cursor，不是 hover） → 回车。 */
async function palRun(label, query = label) {
	await palSearch(query);
	const idx = await palIndex(label);
	if (idx < 0) throw new Error(`palette row not found: ${label}`);
	if ((await palDisabled())[idx]) throw new Error(`palette row disabled: ${label}`);
	for (let i = 0; i < 80; i++) {
		const selected = await page.locator('.scm-pal-row[aria-selected="true"] .scm-pal-row-label').textContent();
		if ((await palIndex(selected?.trim() ?? "")) === idx) break;
		await page.keyboard.press("ArrowDown");
		await sleep(40);
	}
	await page.keyboard.press("Enter");
	await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 });
	await sleep(300);
}

async function main() {
	await waitServer();
	console.log("server up");
	const ws = await watchWebSocket();

	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on("pageerror", (e) => console.log("[pageerror]", e.message));
	page.on("console", (m) => {
		if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 600));
	});
	page.on("crash", () => console.log("[page crashed]"));
	page.on("dialog", async (d) => {
		dialogs.push({ type: d.type(), message: d.message() });
		if (d.type() === "prompt") await d.accept(promptAnswer).catch(() => {});
		else await d.accept().catch(() => {});
	});
	// 语言钉成中文，文案断言才确定（第 20 条再切英文验证）。
	await page.addInitScript(() => {
		try {
			if (!localStorage.getItem("pi-web-ui:lang")) localStorage.setItem("pi-web-ui:lang", "zh");
		} catch {}
	});

	await page.goto(`http://127.0.0.1:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 20000 });
	await sleep(900);
	const skipBtn = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skipBtn.isVisible().catch(() => false)) {
		await skipBtn.click();
		await sleep(300);
	}

	/* ---------------------------------------------------------------- */
	phase("[1] ⌘⇧G 打开 Git 面板");
	/* ---------------------------------------------------------------- */
	await page.keyboard.press("Control+Shift+G");
	await page.waitForSelector(".scm-view", { state: "visible", timeout: 20000 });
	check("[1] Ctrl+Shift+G 打开 Git 面板（.scm-view 可见）", await page.locator(".scm-view").isVisible());

	/* ---------------------------------------------------------------- */
	phase("[2] 分组：已暂存 2（含 both）/ 更改 3（含 both）");
	/* ---------------------------------------------------------------- */
	await waitFor(
		async () => ((await page.locator(".scm-file-path").count()) >= 5 ? true : null),
		30000,
		"status file list",
	).catch(async (err) => {
		console.log("[debug] panel error:", await page.locator(".scm-error").allTextContents());
		console.log("[debug] notices:", notices);
		throw err;
	});
	const staged0 = await groupPaths("staged");
	const changes0 = await groupPaths("changes");
	check(
		"[2] 已暂存组 = only-staged.txt + both.txt",
		staged0.length === 2 && staged0.includes("only-staged.txt") && staged0.includes("both.txt"),
		JSON.stringify(staged0),
	);
	check(
		"[2] 更改组 = only-worktree.txt + brand-new.txt + both.txt",
		changes0.length === 3 &&
			changes0.includes("only-worktree.txt") &&
			changes0.includes("brand-new.txt") &&
			changes0.includes("both.txt"),
		JSON.stringify(changes0),
	);
	check(
		"[2] both 文件同时出现在两组（x/y 归组单源生效）",
		(await rowOf("staged", "both.txt").count()) === 1 && (await rowOf("changes", "both.txt").count()) === 1,
	);
	check(
		"[2] 组头计数 = 2 / 3",
		(await page.locator('.scm-group[data-group="staged"] .scm-group-count').textContent()) === "2" &&
			(await page.locator('.scm-group[data-group="changes"] .scm-group-count').textContent()) === "3",
	);
	check(
		"[2] 组头有 +add / −del 汇总",
		(await page.locator('.scm-group[data-group="staged"] .scm-group-stat').count()) > 0,
	);

	/* ---------------------------------------------------------------- */
	phase("[8] 路径筛选");
	/* ---------------------------------------------------------------- */
	const filter = page.locator(".scm-filter input");
	check("[8] 有文件时才出现筛选框", await filter.isVisible());
	await filter.fill("only-work");
	await sleep(250);
	const filteredPaths = await page.locator(".scm-file-path").allTextContents();
	check(
		"[8] 输入片段只剩匹配行",
		filteredPaths.length === 1 && filteredPaths[0] === "only-worktree.txt",
		JSON.stringify(filteredPaths),
	);
	await filter.fill("zzz-nope");
	await sleep(250);
	check(
		"[8] 无匹配显示空态文案",
		(await page.locator(".scm-files-list .scm-empty").textContent())?.includes("没有匹配的文件"),
	);
	await page.locator(".scm-filter-clear").click();
	await sleep(300);
	const clearedPaths = await page.locator(".scm-file-path").count();
	check("[8] 清空后行数恢复（已暂存 2 + 更改 3 = 5 行）", clearedPaths === 5, `rows=${clearedPaths}`);

	/* ---------------------------------------------------------------- */
	phase("[9] 选中文件 → diff；历史 / 储藏标签仍可打开");
	/* ---------------------------------------------------------------- */
	await rowOf("staged", "only-staged.txt").locator(".scm-file-path").click();
	const diffText = await waitFor(
		async () => {
			const t = await page.locator(".scm-diff-body").textContent();
			return t && t.includes("s2") ? t : null;
		},
		20000,
		"file diff",
	);
	check("[9] 点文件行 → 右侧 diff 有内容（显示被删行 -s2）", diffText.includes("-s2"));
	check("[9] diff 渲染出 del 行", (await page.locator(".scm-diff-line.del").count()) >= 1);
	check("[9] diff 头显示文件路径", (await page.locator(".scm-diff-header").textContent())?.includes("only-staged.txt"));

	await page.click('.gd-seg [role="tab"]:has-text("提交树")');
	await page.waitForSelector(".scm-history", { timeout: 10000 });
	check(
		"[9] 历史 tab 打开且有提交",
		!!(await waitFor(
			async () => ((await page.locator(".scm-commit").count()) > 0 ? true : null),
			20000,
			"history list",
		)),
	);
	await page.locator(".scm-commit").first().click();
	const commitDetail = await waitFor(
		async () => {
			const t = await page.locator(".scm-diff-body").textContent();
			return t && t.includes("Author") ? t : null;
		},
		20000,
		"commit detail",
	);
	check("[9] 提交详情渲染（含 Author）", commitDetail.includes("Author"));

	await page.locator('.gd-seg button:has-text("储藏")').click();
	await page.waitForSelector(".scm-stash", { timeout: 10000 });
	check("[9] 储藏 tab 打开", await page.locator(".scm-stash").isVisible());
	await page.click('.gd-seg [role="tab"]:has-text("更改")');
	await sleep(300);

	/* ---------------------------------------------------------------- */
	phase("[7a] 提交栏摘要 = N 个文件 · +a · −d + 提交到 <branch>");
	/* ---------------------------------------------------------------- */
	// 独立按服务器同一公式（diff --numstat + diff --cached --numstat）算期望值，不经 UI。
	function numstat(args) {
		const out = {};
		for (const line of lines(git(args))) {
			const [a, d, ...rest] = line.split("\t");
			const path = rest.join("\t").trim();
			const prev = out[path] ?? [0, 0];
			out[path] = [prev[0] + (Number(a) || 0), prev[1] + (Number(d) || 0)];
		}
		return out;
	}
	const worktreeStats = numstat("diff --numstat");
	const cachedStats = numstat("diff --cached --numstat");
	const expectStat = (path) => [
		(worktreeStats[path]?.[0] ?? 0) + (cachedStats[path]?.[0] ?? 0),
		(worktreeStats[path]?.[1] ?? 0) + (cachedStats[path]?.[1] ?? 0),
	];
	const stagedPaths = await groupPaths("staged");
	const expectAdd = stagedPaths.reduce((sum, p) => sum + expectStat(p)[0], 0);
	const expectDel = stagedPaths.reduce((sum, p) => sum + expectStat(p)[1], 0);
	const meta = await commitMetaText();
	check("[7] 摘要文件数 = 已暂存组行数", meta.includes(`${stagedPaths.length} 个文件`), `meta=${meta}`);
	check("[7] 摘要 +a 与磁盘 numstat 累加一致", meta.includes(`+${expectAdd}`), `expect +${expectAdd} · meta=${meta}`);
	check("[7] 摘要 −d 与磁盘 numstat 累加一致", meta.includes(`−${expectDel}`), `expect −${expectDel} · meta=${meta}`);
	check("[7] 显示提交目标分支「提交到 main」", (await commitTargetText()).includes("提交到 main"));

	/* ---------------------------------------------------------------- */
	phase("[3] 勾选框 = 真实 git add / git reset");
	/* ---------------------------------------------------------------- */
	const addOk = await clickGitAction(
		() => rowOf("changes", "only-worktree.txt").locator('input[type="checkbox"]').click(),
		() => stagedFiles().includes("only-worktree.txt"),
		"勾选暂存 only-worktree.txt",
	);
	check("[3] 勾未暂存文件 → 磁盘 git add（进入索引）", addOk, JSON.stringify(stagedFiles()));
	await showGit();
	await waitFor(
		async () => ((await rowOf("staged", "only-worktree.txt").count()) === 1 ? true : null),
		25000,
		"row moved to staged",
	);
	check("[3] 该行移动到「已暂存」组", (await rowOf("staged", "only-worktree.txt").count()) === 1);
	check(
		"[3] 组计数跟着更新（已暂存 3）",
		(await page.locator('.scm-group[data-group="staged"] .scm-group-count').textContent()) === "3",
	);

	const resetOk = await clickGitAction(
		() => rowOf("staged", "only-staged.txt").locator('input[type="checkbox"]').click(),
		() => !stagedFiles().includes("only-staged.txt"),
		"取消暂存 only-staged.txt",
	);
	check("[3] 已暂存行取消勾选 → 磁盘 git reset HEAD -- <path>", resetOk, JSON.stringify(stagedFiles()));
	check("[3] 文件仍在工作区（内容没丢）", worktreeFiles().includes("only-staged.txt"));
	await showGit();
	await waitFor(
		async () => ((await rowOf("changes", "only-staged.txt").count()) === 1 ? true : null),
		25000,
		"row moved back",
	);
	check("[3] 该行回到「更改」组", (await rowOf("changes", "only-staged.txt").count()) === 1);

	/* ---------------------------------------------------------------- */
	phase("[4] 组头 +all / −all");
	/* ---------------------------------------------------------------- */
	const stageAllOk = await clickGitAction(
		() => stageAllBtn().click(),
		() => stagedFiles().length === 4,
		"git add -A",
	);
	check("[4] +all 执行 git add -A（4 个文件进索引）", stageAllOk, JSON.stringify(stagedFiles()));
	check("[4] 未跟踪文件也被 add（brand-new.txt）", stagedFiles().includes("brand-new.txt"));
	await showGit();
	await waitFor(async () => ((await groupCount("changes")) === 0 ? true : null), 25000, "changes group empty");
	check(
		"[4] 暂存后「更改」组消失、已暂存 4 行",
		(await groupCount("changes")) === 0 && (await groupCount("staged")) === 4,
	);

	const unstageAllOk = await clickGitAction(
		() => unstageAllBtn().click(),
		() => stagedFiles().length === 0,
		"git reset HEAD",
	);
	check("[4] −all 执行 git reset HEAD（索引清空）", unstageAllOk, JSON.stringify(stagedFiles()));
	check(
		"[4] 未跟踪回到未跟踪（4 个文件都回到工作区）",
		untrackedFiles().includes("brand-new.txt") && worktreeFiles().length === 3,
	);
	await showGit();
	await waitFor(async () => ((await groupCount("staged")) === 0 ? true : null), 25000, "staged group empty");
	check("[4] 「已暂存」组消失、更改 4 行", (await groupCount("staged")) === 0 && (await groupCount("changes")) === 4);

	/* ---------------------------------------------------------------- */
	phase("[6] 提交按钮三态 + 真实 commit");
	/* ---------------------------------------------------------------- */
	const commitInput = page.locator(".scm-commit-input");
	await commitInput.fill("");
	check("[6] 无提交信息 → 提交按钮 disabled", await commitButton().isDisabled());
	await commitInput.fill("scm e2e commit");
	check("[6] 有信息但没有暂存 → 仍然 disabled", await commitButton().isDisabled());
	check(
		"[7] 没勾文件时提示「勾选文件后才会进入本次提交」",
		(await commitMetaText()).includes("勾选文件后才会进入本次提交"),
		await commitMetaText(),
	);

	await clickGitAction(
		() => stageAllBtn().click(),
		() => stagedFiles().length === 4,
		"stage all again",
	);
	await showGit();
	await waitFor(async () => ((await commitButton().isDisabled()) === false ? true : null), 25000, "commit enabled");
	check("[6] 有暂存 + 有信息 → enabled", !(await commitButton().isDisabled()));
	check("[7] 暂存后摘要恢复「4 个文件」", (await commitMetaText()).includes("4 个文件"), await commitMetaText());

	await commitButton().click();
	await page.waitForSelector('.topbar-flow [role="tab"][aria-selected="true"]:has-text("终端")', { timeout: 15000 });
	check(
		"[6] 提交后切到终端执行（顶栏 Terminal 标签被选中）",
		(await page.locator('.topbar-flow [role="tab"][aria-selected="true"]:has-text("终端")').count()) === 1,
	);
	const commitLanded = await waitDisk(
		() => git("log -1 --format=%s") === "scm e2e commit",
		"commit lands on disk",
		45000,
	);
	check("[6] 磁盘 git log 多一条且信息正确", commitLanded, git("log -1 --format=%s"));
	check("[6] 四个文件都进了提交（工作区干净）", await waitDisk(treeClean, "clean after commit"));
	check("[6] 终端里跑了 git commit", (await page.locator('.term-tab:has-text("git commit")').count()) > 0);

	await showGit();
	// 注意只看「文件列表」里的空态：diff 区的“点击左侧文件查看差异”也是 .scm-empty，
	// 拿它当条件会立刻满足，随后读到的还是旧列表。
	const listClean = await waitFor(
		async () =>
			(await page.locator(".scm-files-list .scm-empty").allTextContents()).some((s) => s.includes("工作区干净"))
				? true
				: null,
		30000,
		"file list shows clean tree",
	).catch(() => false);
	check(
		"[6] 提交后列表清空（工作区干净）",
		listClean && (await page.locator(".scm-group").count()) === 0,
		JSON.stringify(await page.locator(".scm-files-list .scm-empty").allTextContents()),
	);

	/* ---------------------------------------------------------------- */
	phase("[5] 丢弃：未跟踪 rm -rf / 已跟踪 git restore");
	/* ---------------------------------------------------------------- */
	writeFileSync(join(repo, "discard-me.txt"), "keep\nchanged\n");
	writeFileSync(join(repo, "temp-new.txt"), "tmp\n");
	await refreshPanel();
	await waitFor(async () => ((await page.locator(".scm-file-path").count()) === 2 ? true : null), 25000, "two rows");

	// 行内动作按钮是 hover 才显形的（.scm-file:hover .scm-file-actions），先 hover 再点。
	const untrackedRow = rowOf("changes", "temp-new.txt");
	await untrackedRow.hover();
	const dialogsBefore = dialogs.length;
	check(
		"[5] 未跟踪文件丢弃 = rm -rf（文件从磁盘消失）",
		await clickGitAction(
			() => untrackedRow.locator('.scm-act[title*="未跟踪"]').click(),
			() => !existsSync(join(repo, "temp-new.txt")),
			"rm -rf untracked",
		),
	);
	check(
		"[5] 丢弃前弹了 confirm（不可恢复的操作要确认）",
		dialogs.slice(dialogsBefore).some((d) => d.type === "confirm" && d.message.includes("temp-new.txt")),
		JSON.stringify(dialogs.slice(dialogsBefore)),
	);

	await showGit();
	await waitFor(
		async () => ((await rowOf("changes", "discard-me.txt").count()) === 1 ? true : null),
		25000,
		"tracked row",
	);
	const trackedRow = rowOf("changes", "discard-me.txt");
	await trackedRow.hover();
	check(
		"[5] 已跟踪文件丢弃 = git restore（内容回到 HEAD）",
		await clickGitAction(
			() => trackedRow.locator('.scm-act[title*="放弃"]').click(),
			() => readFileSync(join(repo, "discard-me.txt"), "utf8") === "keep\n",
			"git restore from HEAD",
		),
	);
	check("[5] 丢弃后工作区干净", await waitDisk(treeClean, "clean after discard", 15000));

	/* ---------------------------------------------------------------- */
	phase("[10][12] 无 upstream：拉取/推送 disabled；获取 = git fetch --all --prune");
	/* ---------------------------------------------------------------- */
	await showGit();
	await refreshPanel();
	const pullBtn = syncButton("拉取");
	const pushBtn = syncButton("推送");
	const fetchBtn = syncButton("获取");
	check("[10] 无 upstream：拉取 disabled", await pullBtn.isDisabled());
	check("[10] 无 upstream：推送 disabled", await pushBtn.isDisabled());
	check("[10] 获取按钮仍可用", !(await fetchBtn.isDisabled()));

	await fetchBtn.click();
	await page.waitForSelector('.term-tab:has-text("git fetch")', { timeout: 15000 });
	check("[12] 获取在终端里创建 git fetch 标签", (await page.locator('.term-tab:has-text("git fetch")').count()) > 0);
	check("[12] 获取 = git fetch --all --prune（终端回显）", await waitTerminalCommand("git fetch --all --prune"));

	/* ---------------------------------------------------------------- */
	phase("[11] 有 upstream：ahead ↑1 / behind ↓1 与按钮联动");
	/* ---------------------------------------------------------------- */
	execSync(`git init --bare -b main ${JSON.stringify(remotePath)}`, { stdio: "ignore", env: gitEnv });
	git(`remote add origin ${JSON.stringify(remotePath)}`);
	git("push -u origin main");
	await showGit();
	await refreshPanel();
	await waitFor(async () => ((await pushBtn.isDisabled()) ? true : null), 25000, "push disabled at ahead=0");
	check("[11] ahead=0 → 推送 disabled", await pushBtn.isDisabled());
	check("[11] behind=0 → 拉取 disabled", await pullBtn.isDisabled());

	writeFileSync(join(repo, "local-only.txt"), "l1\n");
	git("add -A");
	git("commit -m local-one");
	await refreshPanel();
	await waitFor(async () => ((await pushBtn.isDisabled()) === false ? true : null), 25000, "push enabled with ahead 1");
	check("[11] 本地 ahead 1 → 推送 enabled", !(await pushBtn.isDisabled()));
	check(
		"[11] 推送按钮带 ↑1",
		(await pushBtn.locator(".scm-sync-count").textContent()) === "↑1",
		await pushBtn.textContent(),
	);

	await pushBtn.click();
	check(
		"[11] 点推送后远端前进（git push 生效）",
		await waitDisk(() => git("log origin/main -1 --format=%s") === "local-one", "remote got the commit", 45000),
		git("log origin/main -1 --format=%s"),
	);
	await showGit();
	await refreshPanel();
	await waitFor(async () => ((await pushBtn.isDisabled()) ? true : null), 25000, "push disabled after push");
	check("[11] 推送后 ahead 归零 → 按钮回 disabled", await pushBtn.isDisabled());

	// 远端多一条：另一个 clone 推上去，本仓库 fetch 后 behind 1。
	execSync(`git clone ${JSON.stringify(remotePath)} ${JSON.stringify(otherRepo)}`, { stdio: "ignore", env: gitEnv });
	gitIn(otherRepo, "config user.name other-dev");
	gitIn(otherRepo, "config user.email other@e2e.local");
	writeFileSync(join(otherRepo, "remote-only.txt"), "r1\n");
	gitIn(otherRepo, "add -A");
	gitIn(otherRepo, "commit -m remote-work");
	gitIn(otherRepo, "push origin main");

	await fetchBtn.click();
	await waitDisk(() => git("log origin/main -1 --format=%s") === "remote-work", "fetch picked up remote commit", 45000);
	await showGit();
	await refreshPanel();
	await waitFor(async () => ((await pullBtn.isDisabled()) === false ? true : null), 25000, "pull enabled behind 1");
	check("[11] 远端 ahead → 拉取 enabled", !(await pullBtn.isDisabled()));
	check(
		"[11] 拉取按钮带 ↓1",
		(await pullBtn.locator(".scm-sync-count").textContent()) === "↓1",
		await pullBtn.textContent(),
	);
	await pullBtn.click();
	check(
		"[11] 拉取后本地包含远端提交",
		await waitDisk(() => git("log -1 --format=%s") === "remote-work", "pull landed", 45000),
		git("log -1 --format=%s"),
	);

	/* ---------------------------------------------------------------- */
	phase("[13][14] 操作面板：打开 / 关闭 / 搜索");
	/* ---------------------------------------------------------------- */
	await showGit();
	await page.locator('.scm-header button[aria-haspopup="dialog"]').click();
	await page.waitForSelector(".scm-pal", { state: "visible", timeout: 8000 });
	check("[13] 按钮（aria-haspopup=dialog）可开面板", await page.locator(".scm-pal").isVisible());
	await page.keyboard.press("Escape");
	await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 });
	check("[13] Esc 可关", (await page.locator(".scm-pal").count()) === 0);

	await page.keyboard.press("Control+Shift+P");
	await page.waitForSelector(".scm-pal", { state: "visible", timeout: 8000 });
	check("[13] ⌘⇧P（Ctrl+Shift+P）可开", await page.locator(".scm-pal").isVisible());
	await page.locator(".scm-pal-backdrop").click({ position: { x: 6, y: 6 } });
	await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 }).catch(() => {});
	check("[13] 点遮罩可关", (await page.locator(".scm-pal").count()) === 0);

	await palSearch("stash");
	const stashLabels = await palLabels();
	check(
		"[14] 搜 stash 只剩储藏动作（3 条）",
		stashLabels.length === 3 && stashLabels.every((l) => l.includes("储藏")),
		JSON.stringify(stashLabels),
	);
	await palSearch("branch");
	const branchLabels = await palLabels();
	check(
		"[14] 搜 branch 只剩分支动作（含各分支）",
		branchLabels.length >= 3 && branchLabels.every((l) => /分支|main|feat-pal|重命名|新建/.test(l)),
		JSON.stringify(branchLabels),
	);
	await palSearch("tag");
	const tagLabels = await palLabels();
	check(
		"[14] 搜 tag 只剩标签动作（2 条）",
		tagLabels.length === 2 && tagLabels.every((l) => l.includes("标签")),
		JSON.stringify(tagLabels),
	);
	await palSearch("zzz-nope");
	check("[14] 无匹配显示空态文案", (await page.locator(".scm-pal-empty").textContent())?.includes("没有匹配的操作"));

	/* ---------------------------------------------------------------- */
	phase("[15] ↑↓ 跳过 disabled / ⏎ 执行");
	/* ---------------------------------------------------------------- */
	await palSearch("");
	const flags = await palDisabled();
	check("[15] 面板里有 disabled 行（用来验证跳过）", flags.some(Boolean), JSON.stringify(flags));
	const visited = [];
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press("ArrowDown");
		await sleep(60);
		visited.push(
			await page
				.locator('.scm-pal-row[aria-selected="true"]')
				.first()
				.isDisabled()
				.catch(() => true),
		);
	}
	check(
		"[15] ↑↓ 始终不停在 disabled 行上",
		visited.length === 12 && visited.every((d) => d === false),
		JSON.stringify(visited),
	);
	await closePalette();

	await palSearch("获取全部远端");
	await page.keyboard.press("Enter");
	await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 });
	let enterFetch = await waitTerminalCommand("git fetch --all --prune", 12000);
	if (!enterFetch) {
		console.log("  ! ⏎ 获取全部远端：第一次没落地，重试一次（终端重启竞态）");
		await showGit();
		await refreshPanel();
		await palSearch("获取全部远端");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".scm-pal", { state: "detached", timeout: 5000 });
		enterFetch = await waitTerminalCommand("git fetch --all --prune", 20000);
	}
	check("[15] ⏎ 执行「获取全部远端」→ 终端跑 git fetch --all --prune", enterFetch);

	/* ---------------------------------------------------------------- */
	phase("[16] 面板动作的真实副作用");
	/* ---------------------------------------------------------------- */
	// 切换分支
	git("branch feat-pal");
	await showGit();
	await refreshPanel();
	const checkoutOk = await palRunUntil(
		"feat-pal",
		"feat-pal",
		() => git("rev-parse --abbrev-ref HEAD") === "feat-pal",
		"面板切分支到 feat-pal",
		45000,
	);
	check("[16] 面板切分支 → git status 的 branch 变了", checkoutOk, git("rev-parse --abbrev-ref HEAD"));

	// feat-pal 没有 upstream，但仓库有远端分支（origin/main）：`git push --tags` 推的是标签引用、
	// 不需要当前分支的 upstream，所以这里应当**可点**。（「连远端都没有」的场景由
	// tests/unit/scm-palette-actions.test.ts 覆盖，不在本 fixture 里再造一个无远端仓库。）
	await showGit();
	await refreshPanel();
	await openPalette();
	const tagPushIdx = await palIndex("推送标签");
	check(
		"[17] 没有 upstream 但有远端 → 面板「推送标签」可点",
		tagPushIdx >= 0 && (await palDisabled())[tagPushIdx] === false,
		`idx=${tagPushIdx} · ${(await palLabels()).join("/")}`,
	);
	await closePalette();
	// 回到 main（有 upstream）再验标签动作：git push --tags 需要一个能推的远端上下文
	git("checkout main");
	await showGit();
	await refreshPanel();

	// 创建标签
	promptAnswer = "v-pal-1";
	const tagOk = await palRunUntil(
		"创建标签",
		"创建标签",
		() => lines(git("tag")).includes("v-pal-1"),
		"面板创建标签",
		45000,
	);
	check("[16] 面板创建标签 → git tag 出现 v-pal-1", tagOk, git("tag"));

	// 推送标签
	promptAnswer = "";
	await showGit();
	await refreshPanel();
	const tagPushed = await palRunUntil(
		"推送标签",
		"推送标签",
		() => git("ls-remote --tags origin").includes("refs/tags/v-pal-1"),
		"面板推送标签",
		45000,
	);
	check("[16] 面板推送标签 → 远端出现该标签", tagPushed, git("ls-remote --tags origin"));

	// blame：先造一个改动文件并选中
	writeFileSync(join(repo, "discard-me.txt"), "keep\nblame-me\n");
	await showGit();
	await refreshPanel();
	await waitFor(
		async () => ((await rowOf("changes", "discard-me.txt").count()) === 1 ? true : null),
		25000,
		"row for blame",
	);
	await rowOf("changes", "discard-me.txt").locator(".scm-file-path").click();
	await sleep(600);
	await palRun("显示追溯", "追溯");
	check(
		"[16] 面板显示追溯 → diff 区出现逐行 blame（作者 scm-e2e）",
		!!(await waitFor(
			async () => {
				const body = await page.locator(".scm-diff-body").textContent();
				return body && body.includes("scm-e2e") ? body : null;
			},
			30000,
			"blame rows",
		).catch(() => null)),
	);

	// 储藏（含未跟踪）
	writeFileSync(join(repo, "stash-untracked.txt"), "su\n");
	await showGit();
	await refreshPanel();
	promptAnswer = "";
	const stashesBefore = lines(git("stash list")).length;
	const stashOk = await palRunUntil(
		"储藏（含未跟踪）",
		"储藏（含未跟踪）",
		() => lines(git("stash list")).length === stashesBefore + 1,
		"面板储藏 -u",
		45000,
	);
	check("[16] 面板储藏 -u → git stash 多一条", stashOk, git("stash list"));
	check("[16] 储藏含未跟踪：未跟踪文件从工作区消失", !existsSync(join(repo, "stash-untracked.txt")));
	// 储藏列表走的是同一条 runGitCapture 抓取通道：UI 里能看到这条储藏
	await showGit();
	await page.locator('.gd-seg button:has-text("储藏")').click();
	await page.waitForSelector(".scm-stash", { timeout: 10000 });
	await page.locator('.scm-stash button:has-text("储藏列表")').click();
	check(
		"[16] 储藏 tab 里能列出这条储藏（抓取通道没被命令回显骗到）",
		!!(await waitFor(
			async () => ((await page.locator(".scm-stash .scm-file").count()) > 0 ? true : null),
			25000,
			"stash list rows",
		).catch(() => null)),
	);
	await page.click('.gd-seg [role="tab"]:has-text("更改")');
	await sleep(300);
	check("[16] 储藏后工作区干净", await waitDisk(treeClean, "clean after stash", 15000));

	// 去终端
	await showGit();
	await refreshPanel();
	await palRun("去终端", "去终端");
	await page.waitForSelector('.topbar-flow [role="tab"][aria-selected="true"]:has-text("终端")', { timeout: 15000 });
	check(
		"[16] 面板「去终端」→ 切到终端视图",
		(await page.locator('.topbar-flow [role="tab"][aria-selected="true"]:has-text("终端")').count()) === 1,
	);

	/* ---------------------------------------------------------------- */
	phase("[17] disabled 逻辑抽检");
	/* ---------------------------------------------------------------- */
	writeFileSync(join(repo, "discard-me.txt"), "keep\nagain\n");
	await showGit();
	await refreshPanel();
	await clickGitAction(
		() => stageAllBtn().click(),
		() => stagedFiles().length > 0,
		"stage for [17]",
	);
	await showGit();
	await waitFor(async () => ((await groupCount("staged")) > 0 ? true : null), 25000, "staged row for [17]");
	await page.locator(".scm-commit-input").fill("");
	await openPalette();
	const commitIdx = await palIndex("提交");
	check(
		"[17] 没写提交信息 → 提交项 disabled",
		commitIdx >= 0 && (await palDisabled())[commitIdx] === true,
		`idx=${commitIdx}`,
	);
	await closePalette();
	await page.locator(".scm-commit-input").fill("wip");
	await openPalette();
	const commitIdx2 = await palIndex("提交");
	check(
		"[17] 写了信息且有暂存 → 提交项可点（对照组）",
		commitIdx2 >= 0 && (await palDisabled())[commitIdx2] === false,
		`idx=${commitIdx2}`,
	);
	await closePalette();
	await page.locator(".scm-commit-input").fill("");

	// 没上游 → 推送/拉取不可点
	git("remote remove origin");
	await refreshPanel();
	await openPalette();
	const pushIdx = await palIndex("推送");
	const pullIdx = await palIndex("拉取");
	const flags2 = await palDisabled();
	check(
		"[17] 没上游 → 面板推送/拉取 disabled",
		pushIdx >= 0 && pullIdx >= 0 && flags2[pushIdx] === true && flags2[pullIdx] === true,
		`push=${flags2[pushIdx]} pull=${flags2[pullIdx]}`,
	);
	await closePalette();
	check("[17] 没上游 → 同步条推送 disabled（与面板一致）", await syncButton("推送").isDisabled());

	// detached HEAD → 重命名不可点
	git("checkout --detach");
	await showGit();
	await refreshPanel();
	await waitFor(
		async () => ((await page.locator(".gd-branch-name").textContent())?.includes("分离 HEAD") ? true : null),
		25000,
		"detached branch chip",
	);
	check(
		"[17] detached HEAD 时分支标签显示「分离 HEAD」",
		(await page.locator(".gd-branch-name").textContent())?.includes("分离 HEAD"),
	);
	await openPalette();
	const renameIdx = await palIndex("重命名");
	check(
		"[17] detached HEAD → 重命名 disabled",
		renameIdx >= 0 && (await palDisabled())[renameIdx] === true,
		`idx=${renameIdx}`,
	);
	await closePalette();
	git("checkout main");

	/* ---------------------------------------------------------------- */
	phase("[18] 侧栏拖拽宽度 + 双击复位");
	/* ---------------------------------------------------------------- */
	await showGit();
	await refreshPanel();
	await page.waitForSelector(".scm-divider", { timeout: 10000 });
	const readSidebarWidth = () =>
		page.locator(".scm-files").evaluate((el) => Math.round(el.getBoundingClientRect().width));
	const readStoredWidth = () => page.evaluate(() => localStorage.getItem("pi-web-ui:scm-sidebar-width"));
	check("[18] 侧栏默认 300px", (await readSidebarWidth()) === 300, `w=${await readSidebarWidth()}`);

	const dividerBox = await page.locator(".scm-divider").boundingBox();
	await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 120, dividerBox.y + dividerBox.height / 2, { steps: 8 });
	await page.mouse.up();
	await sleep(300);
	const draggedWidth = await readSidebarWidth();
	// 「文件列表 + diff」现在住在右栏（最小 560px），侧栏上限 = 容器宽 - diff 最小宽 220，
	// 所以期望值按真实几何算，而不是写死 420。
	const containerPx = await page.locator(".scm-body").evaluate((el) => Math.round(el.getBoundingClientRect().width));
	const expectedDrag = Math.max(200, Math.min(420, containerPx - 220));
	check(
		`[18] 拖拽 +120px（受容器限制，期望 ${expectedDrag}）`,
		Math.abs(draggedWidth - expectedDrag) <= 2,
		`w=${draggedWidth} container=${containerPx}`,
	);
	check("[18] 拖拽宽度已持久化", (await readStoredWidth()) === String(draggedWidth));

	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 20000 });
	await sleep(700);
	const skipAgain = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skipAgain.isVisible().catch(() => false)) await skipAgain.click();
	await showGit();
	await page.waitForSelector(".scm-divider", { timeout: 10000 });
	await sleep(400);
	// 刷新后右栏按自身偏好宽度回来（可能只有 ~240px），侧栏渲染宽度要按真实几何钳制，
	// 但列表不许被压没（scm-panel.css 给了 200px 下限）。
	const dockAfter = await page.locator(".scm-body").evaluate((el) => Math.round(el.getBoundingClientRect().width));
	const expectAfter = Math.max(200, Math.min(draggedWidth, dockAfter - 220));
	const restoredWidth = await readSidebarWidth();
	check(
		"[18] 刷新后宽度保持（按容器钳制，期望 " + expectAfter + "）",
		Math.abs(restoredWidth - expectAfter) <= 2,
		`w=${restoredWidth} dock=${dockAfter}`,
	);
	check("[18] 持久化值没被改写", (await readStoredWidth()) === String(draggedWidth), await readStoredWidth());
	check("[18] 窄dock下文件列表仍有可读宽度（≥200px，不会压到 19px）", restoredWidth >= 200, `w=${restoredWidth}`);

	await page.locator(".scm-divider").dblclick();
	await sleep(300);
	const expectReset = Math.max(200, Math.min(300, dockAfter - 220));
	check(
		"[18] 双击复位到 300px（按容器钳制，期望 " + expectReset + "）",
		Math.abs((await readSidebarWidth()) - expectReset) <= 2,
		`w=${await readSidebarWidth()}`,
	);
	check("[18] 复位也持久化（存的是 300）", (await readStoredWidth()) === "300", await readStoredWidth());

	/* ---------------------------------------------------------------- */
	phase("[19] 窄屏 900 / 390 不横向溢出");
	/* ---------------------------------------------------------------- */
	for (const width of [900, 390]) {
		await page.setViewportSize({ width, height: 820 });
		await sleep(700);
		await showGit();
		await sleep(500);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		check(`[19] ${width}px 无横向溢出`, overflow <= 0, `overflow=${overflow}px`);
		const box = await page.locator(".scm-view").boundingBox();
		check(
			`[19] ${width}px 面板在视口内可用`,
			!!box && box.width > 200 && box.x >= -1 && box.x + box.width <= width + 1,
			JSON.stringify(box),
		);
		check(`[19] ${width}px 提交输入框可见`, await page.locator(".scm-commit-input").isVisible());
	}
	await page.setViewportSize({ width: 1400, height: 900 });
	await sleep(600);

	/* ---------------------------------------------------------------- */
	phase("[20] 中英文关键文案");
	/* ---------------------------------------------------------------- */
	git("reset"); // 清掉 [17] 留下的暂存，提交栏才会显示「勾选文件后才会进入本次提交」
	await showGit();
	await refreshPanel();
	await waitFor(
		async () => ((await commitMetaText()).includes("勾选文件后") ? true : null),
		25000,
		"empty staged state",
	);
	await openPalette();
	check(
		"[20] 中文：面板占位符本地化",
		(await page.locator(".scm-pal input").getAttribute("placeholder"))?.includes("搜索 Git 操作"),
	);
	await closePalette();
	const zhMeta = await commitMetaText();
	check("[20] 中文：「勾选文件后才会进入本次提交」存在", zhMeta.includes("勾选文件后才会进入本次提交"), zhMeta);

	await page.evaluate(() => localStorage.setItem("pi-web-ui:lang", "en"));
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 20000 });
	await sleep(900);
	const skipEn = page.locator("button:has-text('Skip')").first();
	if (await skipEn.isVisible().catch(() => false)) await skipEn.click();
	await showGit();
	await refreshPanel();
	const enMeta = await commitMetaText();
	check(
		"[20] 英文：Check files to include them in this commit",
		enMeta.includes("Check files to include them in this commit"),
		enMeta,
	);
	await openPalette();
	check(
		"[20] 英文：面板占位符本地化",
		(await page.locator(".scm-pal input").getAttribute("placeholder"))?.includes("Search git actions"),
	);
	await closePalette();
	await page.evaluate(() => localStorage.setItem("pi-web-ui:lang", "zh"));

	/* ---------------------------------------------------------------- */
	console.log(`\n${passed} checks passed, ${failed.length} failed`);
	if (failed.length) {
		console.log("failed checks:");
		for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ""}`);
	}
	await browser.close();
	ws.close();
	const removed = await cleanup();
	process.exit(failed.length || !removed ? 1 : 0);
}

main().catch(async (err) => {
	console.error("E2E FAILED:", err);
	console.log(`\n${passed} checks passed, ${failed.length} failed`);
	if (failed.length) for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ""}`);
	await cleanup();
	process.exit(1);
});
