/**
 * 编辑器插件（vscode-editor，含 Remote-SSH）— 浏览器 UI 冒烟测试（零 token、自包含）。
 *
 * 起隔离端口 server（临时 data-dir）+ 内嵌 mock SSH 远端，Chrome headless：
 * - 顶栏插件 tab → 编辑器视图挂载
 * - 侧栏「＋」新建主机弹层 → 主机出现在列表
 * - 点击主机连接 → 远端目录树展开；底部终端面板开 xterm
 * - 点击远端文件 → CodeMirror 加载内容；编辑 + Ctrl+S 保存回远端（磁盘核对）
 * - 关闭标签不弹确认框；断开后回到空视图
 *
 * 运行：先 npm run build:server，再 node tests/ssh-plugin-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { startMockSsh, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

// 种插件 + 离线依赖
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
ensurePluginSsh2Dep(plugDst, join(REPO, "plugins/vscode-editor"));

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

	// -- 1. 插件 tab 出现并切换 -------------------------------------------------
	await page.waitForSelector("button.plugin-tab", { timeout: 20000 });
	await page.locator("button.plugin-tab", { hasText: "编辑器" }).first().click();
	await page.waitForSelector(".vsc", { timeout: 15000 });
	check("插件视图挂载", true);

	// -- 2. SSH tab：新建主机弹层 ------------------------------------------------------
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
	const nm = await page.locator(".vsc-hrow .nm").innerText();
	check("主机保存后出现在列表", nm.includes("mock-host"), nm);

	// -- 3. 点击主机连接 → 远端目录树展开 --------------------------------------------
	await page.locator(".vsc-hrow").first().click();
	await page.waitForSelector('.vsc-sshtree .vsc-row[data-scope^="c"]', { timeout: 25000 });
	check("连接成功且远端目录树展开", true);
	const names = await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"] .nm').allInnerTexts();
	check(
		"远端目录列出 home 内容",
		names.some((n) => n.includes("a.txt")) && names.some((n) => n.includes("sub")),
		names.join(","),
	);

	// -- 4. 底部终端面板（SSH tab 的 🖥 入口） --------------------------------------------
	await page.locator('.vsc-pane[data-pane="ssh"] .vsc-side-head button[data-act="new-term"]').click();
	await page.waitForSelector(".vsc-termarea .xterm", { timeout: 15000 });
	check("xterm 终端渲染", true);
	const tt = await page.locator(".vsc-ttab .tn").first().innerText();
	check("终端标签显示主机名", tt.includes("mock-host"), tt);

	// 敲一条命令进终端（输出渲染在 canvas 里不直接断言文本，只确保面板无异常）
	await page.locator(".vsc-termarea").click();
	await page.keyboard.type("ui-smoke");
	await page.keyboard.press("Enter");
	await sleep(600);
	check("终端输入无异常", true);

	// -- 5. 打开远程文件编辑 ------------------------------------------------------------
	await page.locator('.vsc-sshtree .vsc-row[data-scope^="c"]', { hasText: "a.txt" }).first().click();
	await page.waitForSelector(".vsc-editor:not(.vsc-hidden) .cm-content", { timeout: 8000 });
	const content = await page.locator(".vsc-editor .cm-content").innerText();
	check("CodeMirror 加载远端文件内容", content.includes("hello ssh"), JSON.stringify(content.slice(0, 40)));
	const scopeTxt = await page.locator(".vsc-status .vsc-scope").innerText();
	check("状态栏标记远程范围", scopeTxt.includes("mock-host"), scopeTxt);

	// 修改 + Ctrl+S 保存 → 远端内存 FS 核对
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nui-edited-line");
	await page.keyboard.press("Control+s");
	await sleep(1000);
	const st = await page.locator(".vsc-state").innerText();
	check("保存后状态恢复干净", !st.includes("未保存"), st);
	const savedOnRemote = await import("./lib/mock-ssh.mjs").then((m) => m.files["/home/test/a.txt"]?.toString());
	check("修改已写回 mock 远端", savedOnRemote?.includes("ui-edited-line"), JSON.stringify(savedOnRemote));

	// 关闭标签（已保存，不应弹确认框）
	let dialogFired = false;
	page.on("dialog", (d) => {
		dialogFired = true;
		void d.dismiss();
	});
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("已保存关闭不弹确认框", !dialogFired);

	// -- 6. 断开（SSH tab） ---------------------------------------------------------------
	await page.locator('.vsc-stabs .stab[data-pane="ssh"]').click();
	await page.locator(".vsc-hrow").first().hover();
	await page.locator('.vsc-hrow button[data-hop="dis"]').click();
	await page.waitForSelector(".vsc-empty:not(.vsc-hidden)", { timeout: 8000 }).catch(() => {});
	const phVisible = await page
		.locator(".vsc-empty")
		.isVisible()
		.catch(() => false);
	check("断开后回到空视图", phVisible);

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
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
