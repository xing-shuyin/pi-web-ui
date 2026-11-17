import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { waitForStablePage } from "./lib/page-stability.mjs";
import { startMockSsh, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8965;
const SSH_PORT = 22965;
const URL = `http://localhost:${PORT}`;
const REPO = realpathSync(new globalThis.URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-ui-"));
const plugDst = join(dataDir, "plugins", "vscode-editor");

mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
ensurePluginSsh2Dep(plugDst, join(REPO, "plugins/vscode-editor"));
// vscode-editor 在默认 disabledPlugins 里（内置插件默认关闭，要用户在设置里打开）：
// 这里预先把全局设置写成「已启用」，模拟用户打开过它，否则顶栏插件菜单里根本没有这一行。
writeFileSync(
	join(dataDir, "client-state.json"),
	JSON.stringify({ __settings__: { projects: [], settings: { disabledPlugins: [] } } }),
);

let server = null;
let sshServer = null;
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: REPO,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: REPO },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", () => {});
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(URL);
	await waitForStablePage(page);

	const plugBtn = page.locator('button.chip[aria-haspopup="menu"]').first();
	// 顶栏插件入口现在走统一 bar-item 层：视口窄时会折叠进「更多功能与布局」溢出菜单，
	// 插件快照也得等一会儿才到，所以先直接找，找不到就展开溢出菜单再等。
	if ((await plugBtn.count()) === 0) {
		await page.locator(".plugin-topbar-more > button").first().click();
	}
	await plugBtn.waitFor({ state: "visible", timeout: 20000 });
	await plugBtn.click();
	const row = page.locator(".pm-panel .pm-row-main", { hasText: "编辑器" }).first();
	await row.waitFor({ timeout: 15000 });
	await row.click();
	await page.waitForSelector(".vsc", { timeout: 15000 });
	check("插件视图挂载", true);

	await page.locator('.vsc-stabs .stab[data-pane="ssh"]').click();
	await page.locator('.vsc-pane[data-pane="ssh"] button[data-act="add-host"]').click();
	await page.waitForSelector(".vsc-host-bg:not(.vsc-hidden)", { timeout: 5000 });
	const form = page.locator(".vsc-host-bg .vsc-modal");
	await form.locator('input[name="h-name"]').fill("mock-host");
	await form.locator('input[name="h-host"]').fill("127.0.0.1");
	await form.locator('input[name="h-port"]').fill(String(SSH_PORT));
	await form.locator('input[name="h-user"]').fill("tester");
	await form.locator('input[name="h-pass"]').fill("secret123");
	await form.locator(".save-host").click();
	await page.waitForSelector(".vsc-hrow", { timeout: 8000 });
	// 插件会顺带列出本机 ~/.ssh/config 里的主机，所以必须按 mock-host 定位，不能 .first()
	const mockRow = page.locator('.vsc-hrow:has(.nm:text-is("mock-host"))').first();
	await mockRow.waitFor({ state: "visible", timeout: 8000 });
	const nm = await mockRow.locator(".nm").innerText();
	check("主机保存后出现在列表", nm.includes("mock-host"), nm);

	await mockRow.click();
	await page.waitForSelector('.vsc-sshtree .vsc-row[data-scope^="c"]', { timeout: 25000 });
	check("连接成功且远端目录树展开", true);
	const names = await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"] .nm').allInnerTexts();
	check(
		"远端目录列出 home 内容",
		names.some((n) => n.includes("a.txt")) && names.some((n) => n.includes("sub")),
		names.join(","),
	);

	await page.locator('.vsc-pane[data-pane="ssh"] .vsc-side-head button[data-act="new-term"]').click();
	await page.waitForSelector(".vsc-termarea .xterm", { timeout: 15000 });
	check("xterm 终端渲染", true);
	const tt = await page.locator(".vsc-ttab .tn").first().innerText();
	check("终端标签显示主机名", tt.includes("mock-host"), tt);

	await page.locator(".vsc-termarea").click();
	await page.keyboard.type("ui-smoke");
	await page.keyboard.press("Enter");
	await sleep(600);
	check("终端输入无异常", true);

	await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"]', { hasText: "a.txt" }).first().click();
	await page.waitForSelector(".vsc-editor:not(.vsc-hidden) .cm-content", { timeout: 8000 });
	const content = await page.locator(".vsc-editor .cm-content").innerText();
	check("CodeMirror 加载远端文件内容", content.includes("hello ssh"), JSON.stringify(content.slice(0, 40)));
	const scopeTxt = await page.locator(".vsc-status .vsc-scope").innerText();
	check("状态栏标记远程范围", scopeTxt.includes("mock-host"), scopeTxt);

	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nui-edited-line");
	await page.keyboard.press("Control+s");
	await sleep(1000);
	const st = await page.locator(".vsc-state").innerText();
	check("保存后状态恢复干净", !st.includes("未保存"), st);
	const savedOnRemote = await import("./lib/mock-ssh.mjs").then((m) => m.files["/home/test/a.txt"]?.toString());
	check("修改已写回 mock 远端", savedOnRemote?.includes("ui-edited-line"), JSON.stringify(savedOnRemote));

	let dialogFired = false;
	page.on("dialog", (d) => {
		dialogFired = true;
		void d.dismiss();
	});
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("已保存关闭不弹确认框", !dialogFired);

	await page.locator('.vsc-stabs .stab[data-pane="ssh"]').click();
	await mockRow.hover();
	await mockRow.locator('button[data-hop="dis"]').click();
	await page
		.waitForSelector('.vsc-sshtree .vsc-row[data-scope^="c"]', { state: "detached", timeout: 8000 })
		.catch(() => {});
	// 断开的语义是「远端树清掉 + 按钮回到 ⇄」；编辑器画布里的 .vsc-empty 是「没开文件」的占位，
	// 跟连接无关，拿它判断会误报（尤其本机 ~/.ssh/config 还有别的真实主机时）。
	const backToIdle = await mockRow.locator('button[data-hop="conn"]').count();
	const treeLeft = await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"]').count();
	check("断开后回到未连接态（远端树清空、按钮回到连接）", backToIdle > 0 && treeLeft === 0, {
		backToIdle,
		treeLeft,
	});

	await browser.close();
} catch (err) {
	failures++;
	console.error("test error:", err);
} finally {
	try {
		sshServer?.close();
		server?.kill("SIGTERM");
	} catch {}
	await sleep(400);
	// Windows 上 mock sshd / 服务端退得慢，临时目录可能还占着：重试几次，别用 EPERM 顶掉整轮结论
	for (let i = 0; i < 6; i++) {
		try {
			rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			break;
		} catch (err) {
			if (i === 5) console.warn(`清理临时目录失败（忽略）: ${err?.code ?? err?.message}`);
			else await sleep(300);
		}
	}
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
