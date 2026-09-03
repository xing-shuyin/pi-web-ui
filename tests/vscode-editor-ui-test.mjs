/**
 * vscode-editor 插件 — 浏览器 UI 冒烟测试（零 token）。
 *
 * 起隔离端口 server（临时 data-dir + 临时工作区），Chrome headless 加载页面：
 * - 顶栏出现 📝 插件 tab，点击切到插件视图
 * - 文件树渲染工作区条目
 * - 点击文件 → 标签页出现 + CodeMirror 编辑器带内容
 * - 修改内容 + Ctrl+S → 磁盘落盘核对
 *
 * 运行：先 npm run build:server，再 node tests/vscode-editor-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = CHROME_PATH;
const PORT = 8968;
const URL = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-ui-"));
const workspace = join(dataDir, "ws");

// 种插件 + 工作区
const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
const repo = new globalThis.URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
cpSync(join(repo, "plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repo, "plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repo, "plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, "sub"), { recursive: true }); // 拖拽上传的目标文件夹
writeFileSync(join(workspace, "README.md"), "# Hello\n");
writeFileSync(join(workspace, "src", "app.js"), "let n = 1;\n");
// CRLF 行尾文件（Windows 仓库常见）：回归「刚打开就提示未保存」误报
writeFileSync(join(workspace, "src", "crlf.js"), "let a = 1;\r\nlet b = 2;\r\n");

let server = null;
try {
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: repo,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workspace },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(URL);

	// 等插件清单到达（顶栏出现插件 tab）
	await page.waitForSelector("button.plugin-tab", { timeout: 20000 });
	const tab = page.locator("button.plugin-tab", { hasText: "编辑器" }).first();
	check("顶栏出现 📝 插件 tab", (await tab.count()) > 0);
	await tab.click();

	// 视图挂载 + 文件树渲染
	await page.waitForSelector(".vsc .vsc-tree .vsc-row", { timeout: 15000 });
	const rows = await page.locator(".vsc-row .nm").allInnerTexts();
	check("文件树渲染工作区根目录", rows.includes("src") && rows.includes("README.md"), rows.join(","));

	// 展开目录
	await page.locator(".vsc-row", { hasText: "src" }).first().click();
	await sleep(400);
	check("展开 src 目录可见 app.js", (await page.locator(".vsc-row", { hasText: "app.js" }).count()) > 0);

	// 点击打开 README.md → 标签页 + CodeMirror 内容
	await page.locator(".vsc-row", { hasText: "README.md" }).first().click();
	await page.waitForSelector(".vsc-tab.active", { timeout: 10000 });
	check("标签页出现并激活", (await page.locator(".vsc-tab.active .tn").innerText()).includes("README.md"));
	await page.waitForSelector(".vsc-editor .cm-content", { timeout: 10000 });
	const cmText = await page.locator(".vsc-editor .cm-content").innerText();
	check("编辑器加载文件内容", cmText.includes("Hello"), cmText);
	const statusPath = await page.locator(".vsc-path").innerText();
	check("状态栏显示路径", statusPath === "README.md", statusPath);

	// 编辑 + Ctrl+S 保存 → 磁盘核对
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nedited-by-test\n");
	await page.keyboard.press("Control+s");
	await sleep(600);
	const onDisk = readFileSync(join(workspace, "README.md"), "utf-8");
	check("Ctrl+S 保存落盘", onDisk.includes("edited-by-test"), JSON.stringify(onDisk));
	const stState = await page.locator(".vsc-state").innerText();
	check("状态栏显示已保存", stState.includes("已保存"), stState);
	const dirtyDot = await page.locator(".vsc-tab .dot").count();
	check("保存后脏标记消失", dirtyDot === 0, `dot=${dirtyDot}`);

	// CRLF 回归：打开零修改的 CRLF 文件直接关闭，不得弹「未保存」确认框
	let dialogFired = false;
	page.on("dialog", (d) => {
		dialogFired = true;
		void d.dismiss();
	});
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("CRLF 文件零修改关闭不弹确认框", !dialogFired);

	// CRLF 保存后磁盘行尾保持
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\nlet c = 3;");
	await page.keyboard.press("Control+s");
	await sleep(600);
	const crlfDisk = readFileSync(join(workspace, "src", "crlf.js"), "utf-8");
	check(
		"CRLF 文件保存后行尾保持 \\r\\n",
		crlfDisk.includes("let c = 3;") && !/(?<!\r)\n/.test(crlfDisk),
		JSON.stringify(crlfDisk),
	);

	// Ctrl+P 快速打开
	await page.keyboard.press("Control+p");
	await page.waitForSelector(".vsc-quickopen input", { timeout: 5000 });
	await page.locator(".vsc-quickopen input").fill("app");
	await sleep(300);
	await page.keyboard.press("Enter");
	await sleep(500);
	const activeTab = await page
		.locator(".vsc-tab.active .tn")
		.innerText()
		.catch(() => "");
	check("Ctrl+P 快速打开 app.js", activeTab.includes("app.js"), activeTab);

	// ---- 上传：按钮 ⬆ / 拖拽到树（不触发主应用「附加到对话」） --------------------------

	// ① 工具栏 ⬆ 按钮 → 文件选择框 → 上传到工作区根目录
	const fc = page.waitForEvent("filechooser");
	await page.locator('.vsc-pane[data-pane="files"] button[data-act="upload"]').click();
	const chooser = await fc;
	await chooser.setFiles({ name: "via-button.txt", mimeType: "text/plain", buffer: Buffer.from("button upload\n") });
	await sleep(900);
	check("⬆ 按钮上传到工作区根目录", readFileSync(join(workspace, "via-button.txt"), "utf-8") === "button upload\n");

	// ② 拖拽到树空白处 → 根目录；且不变成主应用的对话附件
	const msgsBefore = await page.locator(".messages-wrap .msg").count();
	await page.evaluate(() => {
		const tree = document.querySelector(".vsc-tree");
		const dt = new DataTransfer();
		dt.items.add(new File(["drag root\n"], "drag-root.txt", { type: "text/plain" }));
		tree.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
		tree.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
	});
	await sleep(900);
	check("拖拽到树空白处上传到根目录", readFileSync(join(workspace, "drag-root.txt"), "utf-8") === "drag root\n");
	check("树内拖拽未附加到对话（消息数不变）", (await page.locator(".messages-wrap .msg").count()) === msgsBefore);

	// ③ 拖拽到文件夹行 → 上传到该文件夹
	await page.evaluate(() => {
		const row = [...document.querySelectorAll(".vsc-row")].find(
			(r) => r.dataset.path === "sub" && r.dataset.type === "dir",
		);
		if (!row) throw new Error("sub 行未找到");
		const dt = new DataTransfer();
		dt.items.add(new File(["in sub\n"], "in-sub.txt", { type: "text/plain" }));
		row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
		row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
	});
	await sleep(900);
	check("拖拽到文件夹行上传到该文件夹", readFileSync(join(workspace, "sub", "in-sub.txt"), "utf-8") === "in sub\n");

	await browser.close();
} catch (err) {
	failures++;
	console.error("test error:", err);
} finally {
	try {
		server?.kill("SIGTERM");
	} catch {}
	await sleep(400);
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
