import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { waitForStablePage } from "./lib/page-stability.mjs";
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

const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
const repo = new globalThis.URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
cpSync(join(repo, "plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repo, "plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repo, "plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, "sub"), { recursive: true });
writeFileSync(join(workspace, "README.md"), "# Hello\n");
writeFileSync(join(workspace, "src", "app.js"), "let n = 1;\n");
writeFileSync(join(workspace, "src", "crlf.js"), "let a = 1;\r\nlet b = 2;\r\n");
writeFileSync(join(workspace, "big.js"), "// big-file fixture\n".repeat(60000));
// vscode-editor 在默认布局里是关闭的（重型插件）；这条用例要测它的真实界面，先在数据目录里启用。
writeFileSync(
	join(dataDir, "client-state.json"),
	JSON.stringify({ __settings__: { projects: [], settings: { disabledPlugins: [] } } }),
);

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
	await waitForStablePage(page);

	const plugBtn = page.locator('button.chip[aria-haspopup="menu"]').first();
	await plugBtn.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
	if ((await plugBtn.count()) === 0) {
		await page.locator(".plugin-topbar-more > button").first().click();
		await plugBtn.waitFor({ state: "attached", timeout: 5000 });
	}
	await plugBtn.click();
	const row = page.locator(".pm-panel .pm-row-main", { hasText: /编辑器|Editor/ }).first();
	await row.waitFor({ timeout: 15000 });
	check("插件面板列出 📝 编辑器", (await row.count()) > 0);
	await row.click();

	await page.waitForSelector(".vsc .vsc-tree .vsc-row", { timeout: 15000 });
	const groupGeom = await page.evaluate(() => {
		const main = document.querySelector(".vsc-main");
		const group = document.querySelector(".vsc-group");
		return {
			main: main ? main.getBoundingClientRect().width : 0,
			group: group ? group.getBoundingClientRect().width : 0,
		};
	});
	check("单组铺满主区宽度（0 宽回归）", groupGeom.group >= groupGeom.main - 24, JSON.stringify(groupGeom));
	const rows = await page.locator(".vsc-row .nm").allInnerTexts();
	check("文件树渲染工作区根目录", rows.includes("src") && rows.includes("README.md"), rows.join(","));

	await page.locator(".vsc-row", { hasText: "src" }).first().click();
	await sleep(400);
	check("展开 src 目录可见 app.js", (await page.locator(".vsc-row", { hasText: "app.js" }).count()) > 0);

	await page.locator(".vsc-row", { hasText: "README.md" }).first().click();
	await page.waitForSelector(".vsc-tab.active", { timeout: 10000 });
	check("标签页出现并激活", (await page.locator(".vsc-tab.active .tn").innerText()).includes("README.md"));
	await page.waitForSelector(".vsc-editor .cm-content", { timeout: 10000 });
	const cmText = await page.locator(".vsc-editor .cm-content").innerText();
	check("编辑器加载文件内容", cmText.includes("Hello"), cmText);
	const statusPath = await page.locator(".vsc-path").innerText();
	check("状态栏显示路径", statusPath === "README.md", statusPath);

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

	let dialogFired = false;
	page.once("dialog", (d) => {
		dialogFired = true;
		void d.dismiss();
	});
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);
	check("CRLF 文件零修改关闭不弹确认框", !dialogFired);

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

	await page.keyboard.press("Control+p");
	await page.waitForSelector(".vsc-quickopen input", { timeout: 5000 });
	await page.locator(".vsc-quickopen input").fill("app");
	await sleep(300);
	const quickDiskBefore = readFileSync(join(workspace, "src", "app.js"), "utf-8");
	await page.keyboard.press("Enter");
	await sleep(500);
	const activeTab = await page
		.locator(".vsc-tab.active .tn")
		.innerText()
		.catch(() => "");
	check("Ctrl+P 快速打开 app.js", activeTab.includes("app.js"), activeTab);
	const quickDiskAfter = readFileSync(join(workspace, "src", "app.js"), "utf-8");
	check("Ctrl+P 回车不会把换行写进文件", quickDiskAfter === quickDiskBefore, JSON.stringify(quickDiskAfter.slice(-60)));
	check("Ctrl+P 打开后不产生脏标记", (await page.locator(".vsc-tab.active .dot").count()) === 0);

	// ---- 标签右键菜单 / 固定 / 分屏（issue #920） ----
	const appTab = page.locator(".vsc-group .vsc-tab", { hasText: "app.js" }).first();
	await appTab.click({ button: "right" });
	await page.waitForSelector(".vsc-menu:not(.vsc-hidden) button", { timeout: 5000 });
	check("标签右键菜单出现", (await page.locator(".vsc-menu button").count()) >= 4);
	await page
		.locator(".vsc-menu button", { hasText: /固定标签|Pin Tab/ })
		.first()
		.click();
	await sleep(250);
	check("Pin 后标签带固定标记", (await page.locator(".vsc-tab.pinned .tn").allInnerTexts()).includes("app.js"));
	await appTab.click({ button: "right" });
	await page
		.locator(".vsc-menu button", { hasText: /取消固定|Unpin Tab/ })
		.first()
		.click();
	await sleep(250);
	check("Unpin 后固定标记消失", (await page.locator(".vsc-tab.pinned").count()) === 0);

	await page.locator(".vsc-tab.active", { hasText: "app.js" }).first().click({ button: "right" });
	await page
		.locator(".vsc-menu button", { hasText: /向右拆分|Split Right/ })
		.first()
		.click();
	await sleep(500);
	check("向右拆分出现两个编辑组", (await page.locator(".vsc-group").count()) === 2);
	check("分屏是横向行容器", (await page.locator(".vsc-split-row").count()) === 1);
	check("两个编辑组各自保留编辑器", (await page.locator(".vsc-editor .cm-content").count()) === 2);
	const splitPath = await page.locator(".vsc-path").innerText();
	check("拆分后状态栏仍指向当前文件", splitPath === "src/app.js", splitPath);

	await page.locator(".vsc-group").nth(1).locator(".vsc-tab.active").first().click({ button: "right" });
	await page
		.locator(".vsc-menu button", { hasText: /合并分组|Merge Groups/ })
		.first()
		.click();
	await sleep(500);
	check("合并分组回到单组", (await page.locator(".vsc-group").count()) === 1);

	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	const tabsBeforeCloseRight = await page.locator(".vsc-tab").count();
	await page.locator(".vsc-tab", { hasText: "crlf.js" }).first().click({ button: "right" });
	await page
		.locator(".vsc-menu button", { hasText: /关闭右侧标签|Close Tabs to the Right/ })
		.first()
		.click();
	await sleep(350);
	check(
		"关闭右侧标签生效",
		(await page.locator(".vsc-tab").count()) < tabsBeforeCloseRight,
		`before=${tabsBeforeCloseRight} after=${await page.locator(".vsc-tab").count()}`,
	);

	// 未保存内容在分屏/跨组迁移时不能丢（VS Code 式行为）
	await page.locator(".vsc-row", { hasText: "app.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+End");
	await page.keyboard.type("\n// split-keeps-edits\n");
	await sleep(300);
	await page.locator(".vsc-splitbtn[data-split='row']").click();
	await sleep(500);
	check("工具栏按钮也能向右拆分", (await page.locator(".vsc-group").count()) === 2);
	const splitText = await page.locator(".vsc-group").nth(1).locator(".vsc-editor .cm-content").innerText();
	check("分屏后未保存编辑仍在", splitText.includes("split-keeps-edits"), splitText.slice(-80));
	check("分屏后保留脏标记", (await page.locator(".vsc-group").nth(1).locator(".vsc-tab.active .dot").count()) > 0);

	// 跨组拖拽（Pointer 事件）：第二个组的标签拖回第一个组 → 空组自动收起
	{
		const srcTab = page.locator(".vsc-group").nth(1).locator(".vsc-tab").first();
		const dstBox = page.locator(".vsc-group").first().locator(".vsc-tabs");
		const sb = await srcTab.boundingBox();
		const db = await dstBox.boundingBox();
		if (!sb || !db) throw new Error("跨组拖拽源/目标没有包围盒");
		await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
		await page.mouse.down();
		await page.mouse.move(sb.x + sb.width / 2 + 12, sb.y + sb.height / 2, { steps: 4 });
		await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 6 });
		await page.mouse.up();
	}
	await sleep(500);
	check("跨组拖拽后空组自动收起", (await page.locator(".vsc-group").count()) === 1);
	const movedText = await page.locator(".vsc-editor .cm-content").innerText();
	check("跨组拖拽后未保存编辑仍在", movedText.includes("split-keeps-edits"), movedText.slice(-80));

	// 拖到「编辑区正文」也能迁移（不要求精确投到标签栏），且拖完立刻点标签不会被吞
	await page.locator(".vsc-row", { hasText: "crlf.js" }).first().click();
	await sleep(400);
	await page.locator(".vsc-splitbtn[data-split='row']").click();
	await sleep(450);
	check("拖到正文前已分成两组", (await page.locator(".vsc-group").count()) === 2);
	{
		const totalBefore = await page.locator(".vsc-tab").count();
		const srcGroupIndex = await page.evaluate(() => {
			const groups = [...document.querySelectorAll(".vsc-group")];
			return groups.findIndex((g) => [...g.querySelectorAll(".vsc-tab")].some((t) => t.textContent.includes("app.js")));
		});
		check("拆分后 app.js 在某个组里", srcGroupIndex >= 0, `index=${srcGroupIndex}`);
		const srcTab = page.locator(".vsc-group").nth(srcGroupIndex).locator(".vsc-tab", { hasText: "app.js" }).first();
		const dstBody = page
			.locator(".vsc-group")
			.nth(srcGroupIndex === 0 ? 1 : 0)
			.locator(".vsc-editor .cm-content");
		const sb = await srcTab.boundingBox();
		const db = await dstBody.boundingBox();
		if (!sb || !db) throw new Error("拖到正文：源/目标没有包围盒");
		await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
		await page.mouse.down();
		await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 + 14, { steps: 4 });
		await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 6 });
		await page.mouse.up();
		await sleep(500);
		check("拖到编辑区正文也能迁移标签", (await page.locator(".vsc-tab").count()) === totalBefore);
		check("拖到正文后空组自动收起", (await page.locator(".vsc-group").count()) === 1);
	}
	await page.locator(".vsc-tab", { hasText: "app.js" }).first().click();
	await sleep(350);
	const afterDragClick = await page
		.locator(".vsc-tab.active .tn")
		.innerText()
		.catch(() => "");
	check("拖拽后立刻点标签仍能激活（无点击封锁）", afterDragClick.includes("app.js"), afterDragClick);
	const afterDragText = await page.locator(".vsc-editor .cm-content").innerText();
	check("拖拽后点开的标签内容仍在", afterDragText.includes("split-keeps-edits"));

	// 大文件只读：连 contenteditable 一起关（手机上不弹键盘误导用户以为能输入）
	// 先把当前标签存盘，避免切换时被未保存确认框拦下（Playwright 默认 dismiss）
	await page.locator(".vsc-editor .cm-content").click();
	await page.keyboard.press("Control+s");
	await sleep(400);
	await page.locator(".vsc-row", { hasText: "big.js" }).first().click();
	await page.waitForFunction(
		() => document.querySelector(".vsc-editor .cm-content")?.getAttribute("contenteditable") === "false",
		null,
		{ timeout: 15000 },
	);
	const bigState = await page.evaluate(() => ({
		editable: document.querySelector(".vsc-editor .cm-content")?.getAttribute("contenteditable"),
		saveDisabled: document.querySelector(".vsc-savebtn")?.hasAttribute("disabled"),
	}));
	check(
		"大文件只读：不可编辑且保存按钮禁用",
		bigState.editable === "false" && bigState.saveDisabled === true,
		JSON.stringify(bigState),
	);
	await page.locator(".vsc-tab.active .x").click();
	await sleep(300);

	const fc = page.waitForEvent("filechooser");
	await page.locator('.vsc-pane[data-pane="files"] button[data-act="upload"]').click();
	const chooser = await fc;
	await chooser.setFiles({ name: "via-button.txt", mimeType: "text/plain", buffer: Buffer.from("button upload\n") });
	await sleep(900);
	check("⬆ 按钮上传到工作区根目录", readFileSync(join(workspace, "via-button.txt"), "utf-8") === "button upload\n");

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

	// ---- 顶栏标签拖拽换位（issue #920）：同分组内换位并持久化 ----
	const flowIds = await page.$$eval(".topbar-flow > [data-ui-id]", (els) => els.map((e) => e.dataset.uiId));
	check("顶栏条目带稳定 id 供拖拽", flowIds.length >= 2, flowIds.join(","));
	if (flowIds.length >= 2) {
		const targetId = flowIds[0];
		const sourceId = flowIds[1];
		const source = page.locator(`.topbar-flow > [data-ui-id="${sourceId}"]`);
		const target = page.locator(`.topbar-flow > [data-ui-id="${targetId}"]`);
		const sb = await source.boundingBox();
		const tb = await target.boundingBox();
		if (!sb || !tb) throw new Error("拖拽源/目标没有包围盒");
		await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
		await page.mouse.down();
		await page.mouse.move(sb.x + sb.width / 2 + 12, sb.y + sb.height / 2, { steps: 4 });
		await page.mouse.move(tb.x + 2, tb.y + tb.height / 2, { steps: 6 });
		await page.mouse.up();
		await sleep(600);
		const afterDrag = await page.$$eval(".topbar-flow > [data-ui-id]", (els) => els.map((e) => e.dataset.uiId));
		check(
			"顶栏拖拽后两标签交换位置",
			afterDrag.indexOf(sourceId) < afterDrag.indexOf(targetId),
			`${flowIds.join(",")} → ${afterDrag.join(",")}`,
		);
		// 触屏长按同样能拖（Pointer 事件而非 HTML5 DnD）：这次拖到目标右侧
		await page.evaluate(
			async ({ sourceId, targetId }) => {
				const els = [...document.querySelectorAll(".topbar-flow > [data-ui-id]")];
				const source = els.find((e) => e.dataset.uiId === sourceId);
				const target = els.find((e) => e.dataset.uiId === targetId);
				if (!source || !target) throw new Error("触屏拖拽源/目标未找到");
				const sb = source.getBoundingClientRect();
				const tb = target.getBoundingClientRect();
				const base = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 91, isPrimary: true };
				source.dispatchEvent(
					new PointerEvent("pointerdown", {
						...base,
						clientX: sb.left + sb.width / 2,
						clientY: sb.top + sb.height / 2,
					}),
				);
				await new Promise((r) => setTimeout(r, 500));
				const x = tb.right - 2;
				const y = tb.top + tb.height / 2;
				window.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: x, clientY: y }));
				window.dispatchEvent(new PointerEvent("pointerup", { ...base, clientX: x, clientY: y }));
			},
			{ sourceId, targetId },
		);
		await sleep(600);
		const afterTouchDrag = await page.$$eval(".topbar-flow > [data-ui-id]", (els) => els.map((e) => e.dataset.uiId));
		check(
			"触屏长按拖拽同样能换位",
			afterTouchDrag.indexOf(targetId) < afterTouchDrag.indexOf(sourceId),
			afterTouchDrag.join(","),
		);
		// 先保存脏标签，避免 beforeunload 确认框拦住 reload
		await page.locator(".vsc-editor .cm-content").click();
		await page.keyboard.press("Control+s");
		await sleep(500);
		await page.reload();
		await waitForStablePage(page);
		const persisted = await page.$$eval(".topbar-flow > [data-ui-id]", (els) => els.map((e) => e.dataset.uiId));
		check("顶栏顺序刷新后保留", persisted.indexOf(targetId) < persisted.indexOf(sourceId), persisted.join(","));
	}

	// ---- 手机视口（issue #920 第 6 条）：宽度、拆分上下堆叠、长按菜单 ----
	const mCtx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		deviceScaleFactor: 2,
	});
	const mPage = await mCtx.newPage();
	mPage.on("pageerror", (e) => console.error("[mobile pageerror]", e.message));
	await mPage.goto(URL);
	await waitForStablePage(mPage);
	let mobileOpened = false;
	const mPlug = mPage.locator('button.chip[aria-haspopup="menu"]').first();
	if (await mPlug.count()) {
		await mPlug.click();
		const mRow = mPage.locator(".pm-panel .pm-row-main", { hasText: /编辑器|Editor/ }).first();
		if (await mRow.count()) {
			await mRow.click();
			mobileOpened = true;
		}
	}
	if (!mobileOpened) {
		await mPage.locator(".plugin-topbar-more > button").first().click();
		const mRow = mPage.locator(".plugin-topbar-menu button", { hasText: /编辑器|Editor/ }).first();
		if (await mRow.count()) {
			await mRow.click();
			mobileOpened = true;
		}
	}
	check("手机视口能打开编辑器插件", mobileOpened);
	if (mobileOpened) {
		await mPage.waitForSelector(".vsc .vsc-tree .vsc-row", { timeout: 15000 });
		const mGeom = await mPage.evaluate(() => {
			const main = document.querySelector(".vsc-main");
			const group = document.querySelector(".vsc-group");
			return {
				main: main ? main.getBoundingClientRect().width : 0,
				group: group ? group.getBoundingClientRect().width : 0,
			};
		});
		check("手机视口单组铺满主区（0 宽回归）", mGeom.group >= mGeom.main - 24, JSON.stringify(mGeom));
		// 手机侧栏是抽屉：先点 ☰ 打开文件树
		await mPage.locator(".vsc-burger").click();
		await sleep(350);
		await mPage.locator(".vsc-row", { hasText: "README.md" }).first().click();
		await mPage.waitForSelector(".vsc-tab.active", { timeout: 10000 });
		const mTab = await mPage.locator(".vsc-tab.active").first().boundingBox();
		await mPage.evaluate(
			({ x, y }) => {
				const tab = document.querySelector(".vsc-tab.active");
				if (!tab) throw new Error("长按目标标签未找到");
				const base = {
					bubbles: true,
					cancelable: true,
					pointerType: "touch",
					pointerId: 77,
					isPrimary: true,
					clientX: x,
					clientY: y,
				};
				tab.dispatchEvent(new PointerEvent("pointerdown", base));
			},
			{ x: mTab.x + mTab.width / 2, y: mTab.y + mTab.height / 2 },
		);
		await sleep(700);
		check("手机长按标签弹出菜单", (await mPage.locator(".vsc-menu:not(.vsc-hidden)").count()) === 1);
		await mPage
			.locator(".vsc-menu button", { hasText: /向右拆分|Split Right/ })
			.first()
			.click();
		await sleep(450);
		const mDir = await mPage
			.locator(".vsc-split-row")
			.first()
			.evaluate((el) => getComputedStyle(el).flexDirection);
		check("窄屏左右拆分改为上下堆叠", mDir === "column", mDir);
		const mWidths = await mPage
			.locator(".vsc-group")
			.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
		check("手机分屏两组都有宽度", mWidths.length === 2 && mWidths.every((w) => w >= 300), mWidths.join(","));
	}
	await mCtx.close();

	// ---- 全局语言继承（issue #920）：英文界面下插件名与插件内文案都应是英文 ----
	const enCtx = await browser.newContext();
	await enCtx.addInitScript(() => {
		try {
			localStorage.setItem("pi-web-ui:lang", "en");
		} catch {}
	});
	const enPage = await enCtx.newPage();
	enPage.on("pageerror", (e) => console.error("[en pageerror]", e.message));
	await enPage.goto(URL);
	await waitForStablePage(enPage);
	const enPlugBtn = enPage.locator('button.chip[aria-haspopup="menu"]').first();
	await enPlugBtn.waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
	if ((await enPlugBtn.count()) === 0) {
		await enPage.locator(".plugin-topbar-more > button").first().click();
		await enPlugBtn.waitFor({ state: "attached", timeout: 5000 });
	}
	await enPlugBtn.click();
	const enRow = enPage.locator(".pm-panel .pm-row-main", { hasText: /^Editor$/ }).first();
	await enRow.waitFor({ timeout: 15000 });
	check("英文界面下插件标题跟随全局语言", (await enRow.count()) > 0);
	await enRow.click();
	await enPage.waitForSelector(".vsc .vsc-tree .vsc-row", { timeout: 15000 });
	const enFilesTab = await enPage.locator('.vsc .stab[data-pane="files"]').innerText();
	check("英文界面下插件内部标签是英文", enFilesTab.includes("Files"), enFilesTab);
	const enSave = await enPage.locator(".vsc-savebtn").innerText();
	check("英文界面下保存按钮是英文", enSave.includes("Save"), enSave);
	check("英文界面下不出现语言切换按钮", (await enPage.locator(".vsc-langbtn").count()) === 0);
	await enCtx.close();

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
