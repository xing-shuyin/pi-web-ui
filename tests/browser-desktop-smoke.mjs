import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

/** 手搓一个最小 zip（deflate）：用来给「安装 .crx」造夹具，不引额外依赖。 */
function zipEntries(entries) {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	const crc32 = (buf) => {
		let c = 0xffffffff;
		for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const locals = [];
	const central = [];
	let offset = 0;
	for (const [name, text] of Object.entries(entries)) {
		const nameBuf = Buffer.from(name, "utf8");
		const raw = Buffer.from(text, "utf8");
		const data = deflateRawSync(raw);
		const crc = crc32(raw);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(raw.length, 24);
		entry.writeUInt16LE(nameBuf.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBuf);
		offset += 30 + nameBuf.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** Cr24 v3 头 + zip 负载：和浏览器自己的 .crx 解析同形。 */
function crxFromZip(zip) {
	const header = Buffer.alloc(12);
	header.write("Cr24", 0, "latin1");
	header.writeUInt32LE(3, 4);
	header.writeUInt32LE(0, 8);
	return Buffer.concat([header, zip]);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = process.platform === "win32" ? "E:/tmp" : tmpdir();
await mkdir(tempRoot, { recursive: true });
const temporary = await mkdtemp(join(tempRoot, "pi-browser-smoke-"));
const servers = [];
let application;
const listen = async (html) => {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const port = server.address().port;
	assert.ok(port >= 8900, "test ports must be >=8900");
	return `http://127.0.0.1:${port}`;
};
try {
	const agentUrl = await listen(
		'<!doctype html><title>Agent fixture</title><h1>Agent</h1><textarea id="draft" aria-label="Agent draft"></textarea>',
	);
	const siteUrl = await listen(
		'<!doctype html><title>Browser fixture</title><h1>Browser</h1><input id="name" aria-label="Name"><input id="secret" type="password" aria-label="Secret"><button id="submit" onclick="document.querySelector(\"h1\").textContent=\"Submitted\"">Submit</button>',
	);
	const env = {
		...process.env,
		PI_WEB_DESKTOP_URL: agentUrl,
		PI_WEB_DATA_DIR: join(temporary, "agent-data"),
		PI_WEB_CWD: temporary,
	};
	delete env.ELECTRON_RUN_AS_NODE;
	// 预置一个已解压扩展：启动时靠 installed.json 恢复，无需走原生选目录对话框
	const extensionDir = join(temporary, "fixture-extension");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(
		join(extensionDir, "manifest.json"),
		JSON.stringify(
			{
				manifest_version: 3,
				name: "Smoke extension",
				version: "0.1.0",
				action: { default_popup: "popup.html" },
				options_ui: { page: "options.html", open_in_tab: true },
			},
			null,
			1,
		),
		"utf8",
	);
	await writeFile(
		join(extensionDir, "popup.html"),
		// 固定 240×320 的卡片：弹窗窗口应该贴着这个尺寸开（Chrome 的 popup 语义），不是固定的 400×560
		'<!doctype html><title>Smoke popup</title><style>body{margin:0}</style><div id="popup" style="width:240px;height:320px">popup body</div>',
		"utf8",
	);
	await writeFile(
		join(extensionDir, "options.html"),
		'<!doctype html><title>Smoke options</title><p id="options">options body</p>',
		"utf8",
	);
	// 第二个扩展：静态 declarativeNetRequest 规则（Electron 自己只存不拦，宿主用 webRequest 执行）
	const dnrDir = join(temporary, "dnr-extension");
	await mkdir(join(dnrDir, "rules"), { recursive: true });
	await writeFile(
		join(dnrDir, "manifest.json"),
		JSON.stringify(
			{
				manifest_version: 3,
				name: "DNR extension",
				version: "0.1.0",
				permissions: ["declarativeNetRequest"],
				host_permissions: ["<all_urls>"],
				declarative_net_request: { rule_resources: [{ id: "ads", enabled: true, path: "rules/ads.json" }] },
			},
			null,
			1,
		),
		"utf8",
	);
	await writeFile(
		join(dnrDir, "rules", "ads.json"),
		JSON.stringify([{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "blocked-path" } }]),
		"utf8",
	);
	await mkdir(join(temporary, "profile", "browser", "extensions"), { recursive: true });
	await writeFile(
		join(temporary, "profile", "browser", "extensions", "installed.json"),
		JSON.stringify(
			[
				{ path: extensionDir, enabled: true },
				{ path: dnrDir, enabled: true },
			],
			null,
			1,
		),
		"utf8",
	);
	application = await _electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [resolve(repo, "dist/desktop/main.js"), `--user-data-dir=${join(temporary, "profile")}`],
		env,
		timeout: 30_000,
	});
	assert.equal(
		await application.evaluate(({ app }) => app.getPath("userData")),
		join(temporary, "profile"),
		"desktop smoke must use an isolated profile",
	);
	await application.firstWindow();
	let shell;
	for (let attempt = 0; attempt < 100; attempt++) {
		shell = application
			.context()
			.pages()
			.find((page) => page.url().endsWith("/shell.html"));
		if (shell) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(shell, "trusted browser shell is present");
	const rendererErrors = [];
	shell.on("pageerror", (error) => rendererErrors.push(error.message));
	await shell.waitForFunction(() => !!window.piBrowserShell, { timeout: 15_000 });
	const call = (action, args) =>
		shell.evaluate(({ action, args }) => window.piBrowserShell.call(action, args), { action, args });
	await call("agent.connect", { url: agentUrl });
	const pages = application.context();
	const agent =
		pages.pages().find((page) => page.url().startsWith(agentUrl)) ??
		(await pages.waitForEvent("page", { predicate: (page) => page.url().startsWith(agentUrl), timeout: 15_000 }));
	await agent.waitForFunction(() => !!window.__piBrowser, { timeout: 15_000 });
	await agent.locator("#draft").fill("keep my Agent draft");
	const tabId = await call("tabs.create", { url: siteUrl });
	const site =
		pages.pages().find((page) => page.url().startsWith(siteUrl)) ??
		(await pages.waitForEvent("page", { predicate: (page) => page.url().startsWith(siteUrl), timeout: 15_000 }));
	await site.waitForLoadState("domcontentloaded");
	await site.locator("#name").fill("keep website input");
	const caller = (request) =>
		agent.evaluate((request) => window.__piBrowser.pageCall({ timeoutMs: 5000, ...request }), request);
	const state = await call("state");
	assert.ok(state.tabs.some((tab) => tab.id === tabId));
	assert.equal(
		await site.evaluate(() => typeof window.__piBrowser),
		"undefined",
		"ordinary website gets no controller bridge",
	);
	assert.equal(
		await site.evaluate(() => typeof window.piBrowserShell),
		"undefined",
		"ordinary website gets no storage API",
	);
	for (const mode of ["agent", "split", "browser"]) await call("mode", { mode });
	assert.equal(await site.locator("#name").inputValue(), "keep website input");
	assert.equal(await agent.locator("#draft").inputValue(), "keep my Agent draft");
	assert.equal((await caller({ op: "read", target: tabId, args: { what: "title" } })).ok, true);
	const missing = await caller({ op: "click", target: "missing-tab", args: { selector: "#submit" } });
	assert.equal(missing.ok, false, "missing explicit target does not fall back");
	const wait = await caller({ op: "wait", target: tabId, args: { text: "text that never appears" }, timeoutMs: 1000 });
	assert.equal(wait.ok, true);
	assert.equal(wait.result.found, null, "wait(text) reports a missing condition");
	assert.ok(wait.result.waitedMs >= 900, "wait(text) really waits before timing out");
	const shot = await caller({ op: "shot", target: tabId, args: { maxEdge: 640 } });
	assert.equal(shot.ok, true);
	assert.match(shot.result.image.dataUrl, /^data:image\//);
	assert.ok(shot.result.image.width <= 640 && shot.result.image.height <= 640);
	if (await call("passwords.available")) {
		await call("passwords.save", {
			entries: [
				{
					id: "fixture-login",
					name: "Fixture",
					url: siteUrl,
					username: "fixture-user",
					password: "fixture-value",
					createdAt: new Date(0).toISOString(),
				},
			],
		});
		const listed = await call("passwords.list");
		assert.equal("password" in listed[0], false, "the password list never ships plaintext");
		assert.equal(listed[0].hasPassword, true);
		await call("passwords.fill", { id: "fixture-login" });
		assert.equal(await site.locator("#name").inputValue(), "fixture-user");
		assert.equal(await site.locator("#secret").inputValue(), "fixture-value");
	}

	// 扩展管理：清单恢复 / 动作弹窗（chrome-extension:// 独立小窗）/ 停用 / 重载 / 移除不删目录
	const extensionEntries = await call("extensions.list");
	const fixture = extensionEntries.find((entry) => entry.name === "Smoke extension");
	assert.ok(fixture, "seeded unpacked extension is restored on boot");
	assert.equal(fixture.enabled, true);
	assert.equal(fixture.popup, "popup.html");
	assert.equal(fixture.options, "options.html");
	// 工具栏动作：electron-chrome-extensions 的 <browser-action-list> 真的渲染出按钮，
	// 点一下开的就是 chrome-extension://…/popup.html（和 Chrome 同一个语义）
	const actionList = shell.locator("browser-action-list");
	await actionList.waitFor({ state: "attached", timeout: 10_000 });
	let actionButtons = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		actionButtons = await shell.evaluate(() => {
			const list = document.querySelector("browser-action-list");
			return list?.shadowRoot ? list.shadowRoot.querySelectorAll(".action").length : 0;
		});
		if (actionButtons > 0) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(actionButtons > 0, "toolbar renders an extension action button");
	assert.equal(
		await shell.evaluate(() => {
			const list = document.querySelector("browser-action-list");
			return list?.getAttribute("partition") ?? "";
		}),
		"pi-browser",
		"action list is bound to the browser session partition",
	);
	// 点图标 = 开扩展 popup（库自己建窗，锚点在按钮上）
	await shell.evaluate(() => {
		const list = document.querySelector("browser-action-list");
		list?.shadowRoot?.querySelector(".action")?.click();
	});
	let actionPopup;
	for (let attempt = 0; attempt < 100; attempt++) {
		actionPopup = application.windows().find((win) => win.url().endsWith("/popup.html"));
		if (actionPopup) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(actionPopup, "clicking the toolbar action opens the extension popup");
	assert.match(actionPopup.url(), /^chrome-extension:\/\/[a-p]+\/popup\.html$/);
	// 工具栏动作图标的弹窗同样贴内容：库等 preferred-size 事件来定尺寸并显示，
	// 而扩展页不发这个事件 —— 宿主自己量完再亮，否则窗口卡在 25×25 且一直藏着
	let toolbarPopup;
	for (let attempt = 0; attempt < 60; attempt++) {
		toolbarPopup = await application.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/popup.html"));
			return win ? { size: win.getContentSize(), visible: win.isVisible() } : null;
		});
		if (toolbarPopup?.visible) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(toolbarPopup?.visible, "toolbar action popup is actually shown");
	assert.equal(toolbarPopup.size[0], 240, "toolbar action popup width follows the extension page content");
	assert.ok(
		toolbarPopup.size[1] >= 320 && toolbarPopup.size[1] <= 330,
		`toolbar action popup height follows the content (${toolbarPopup.size[1]})`,
	);
	await actionPopup.close();
	const popupCall = await call("extensions.openPopup", { path: extensionDir, anchor: { x: 900, y: 80 } });
	assert.equal(popupCall, true);
	let popup;
	for (let attempt = 0; attempt < 100; attempt++) {
		popup = application.windows().find((win) => win.url().startsWith("chrome-extension://"));
		if (popup) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(popup, "extension popup opens in its own window");
	assert.match(popup.url(), /^chrome-extension:\/\/[a-p]+\/popup\.html$/);
	// 尺寸贴着扩展页内容：夹具是 240×320 的固定卡片，两侧不能多出空白
	const popupSize = await application.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("/popup.html"));
		return win ? win.getContentSize() : null;
	});
	assert.ok(popupSize, "extension popup window is inspectable");
	assert.equal(popupSize[0], 240, "popup width follows the extension page content");
	assert.ok(popupSize[1] >= 320 && popupSize[1] <= 330, `popup height follows the content (${popupSize[1]})`);
	await popup.close();
	// 选项页（options_ui）开的是普通窗口，不复用弹窗
	assert.equal(await call("extensions.openOptions", { path: extensionDir, anchor: { x: 900, y: 80 } }), true);
	let optionsWindow;
	for (let attempt = 0; attempt < 100; attempt++) {
		optionsWindow = application.windows().find((win) => win.url().endsWith("/options.html"));
		if (optionsWindow) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(optionsWindow, "extension options open in their own window");
	assert.match(optionsWindow.url(), /^chrome-extension:\/\/[a-p]+\/options\.html$/);
	// chrome.windows.create → 真正独立的窗口（库把创建回调交给宿主，宿主开 BrowserWindow 并登记标签）
	assert.equal(
		await optionsWindow.evaluate(
			() =>
				new Promise((resolve) => {
					chrome.windows.create(
						{ url: chrome.runtime.getURL("options.html"), type: "popup", width: 420, height: 320, focused: false },
						(win) => resolve(typeof win?.id === "number" && win.id > 0),
					);
				}),
		),
		true,
		"chrome.windows.create returns a real window",
	);
	let createdWindow;
	for (let attempt = 0; attempt < 100; attempt++) {
		createdWindow = application.windows().find((win) => win !== optionsWindow && win.url().endsWith("/options.html"));
		if (createdWindow) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(createdWindow, "chrome.windows.create opens a separate Electron window");
	await createdWindow.close();
	await optionsWindow.close();
	// 右键菜单是原生 Menu：空菜单不应弹出（也避免冒烟卡在系统菜单上）
	assert.equal(await call("extensions.menu", { items: [], anchor: { x: 10, y: 10 } }), null);
	assert.equal(await call("extensions.toggle", { path: extensionDir, enabled: false }), false);
	const disabled = (await call("extensions.list")).find((entry) => entry.path === extensionDir);
	assert.equal(disabled.enabled, false, "disabled extension stays in the list");
	assert.equal(disabled.id, "", "disabled extension is no longer loaded");
	await assert.rejects(
		call("extensions.openPopup", { path: extensionDir, anchor: { x: 1, y: 1 } }),
		/Enable the extension/,
	);
	assert.equal(await call("extensions.toggle", { path: extensionDir, enabled: true }), true);
	assert.equal(await call("extensions.reload", { path: extensionDir }), true);
	assert.equal(await call("extensions.remove", { path: extensionDir }), true);
	const remaining = await call("extensions.list");
	assert.equal(
		remaining.some((entry) => entry.path === extensionDir),
		false,
		"removed extension disappears from the list",
	);
	assert.equal(remaining.length, 1, "the DNR fixture is still installed");
	assert.ok((await stat(extensionDir)).isDirectory(), "removing an extension never deletes the folder");
	// 用户自己选的解压目录一个文件都不能被改（兼容层只进我们自己的 crx 解包目录）
	assert.equal(
		await stat(join(extensionDir, "__pi-compat.js")).then(
			() => true,
			() => false,
		),
		false,
		"unpacked user folder stays untouched",
	);

	// 面板浮层：一块面板一个独立视图（panel.html），页面与 Agent 分栏不再被隐藏
	// ——以前是「临时隐藏内容区」，点开面板整窗变黑，这一节就是那条回归的守卫
	const panelInput = await site.locator("#name").inputValue();
	assert.equal(await call("panel", { open: true, panel: "extensions" }), true);
	let panelPage;
	for (let attempt = 0; attempt < 100; attempt++) {
		panelPage = pages.pages().find((page) => page.url().includes("/panel.html"));
		if (panelPage) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(panelPage, "extension panel opens in its own layer view");
	await panelPage.waitForSelector(".pb-extension-item", { timeout: 10_000 });
	assert.equal(await panelPage.locator(".pb-extension-item").count(), 1, "panel lists the installed extensions");
	const [layerBox, windowBox] = await Promise.all([
		panelPage.evaluate(() => ({ width: innerWidth, height: innerHeight })),
		application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()),
	]);
	assert.ok(layerBox.width <= 420, `panel layer is a small floating view, not the whole window (${layerBox.width}px)`);
	assert.ok(layerBox.height <= windowBox[1], "panel layer never grows past the window");
	assert.equal(
		await site.evaluate(() => document.visibilityState),
		"visible",
		"the page stays visible behind the panel instead of being hidden",
	);
	assert.equal(
		await site.locator("#name").inputValue(),
		panelInput,
		"the page keeps its content while the panel is open",
	);
	// 同一个面板再点一次就是收起（工具栏按钮本身是开关）
	assert.equal(await call("panel", { open: true, panel: "extensions" }), false);
	for (let attempt = 0; attempt < 100 && pages.pages().some((page) => page.url().includes("/panel.html")); attempt++)
		await new Promise((done) => setTimeout(done, 50));
	assert.equal(
		pages.pages().some((page) => page.url().includes("/panel.html")),
		false,
		"toggling the panel closes its layer again",
	);

	// declarativeNetRequest 静态规则：Electron 自己只存不拦，宿主翻译成 session.webRequest 真正生效
	const blockedUrl = `${siteUrl}/blocked-path`;
	await assert.rejects(
		site.goto(blockedUrl, { timeout: 10_000 }),
		/ERR_BLOCKED_BY_CLIENT|net::ERR/,
		"static DNR rule blocks the request",
	);
	assert.equal(await call("extensions.toggle", { path: dnrDir, enabled: false }), false);
	await new Promise((done) => setTimeout(done, 500));
	const unblocked = await site.goto(blockedUrl, { timeout: 10_000 });
	assert.equal(unblocked?.status(), 200, "disabling the extension stops blocking");
	assert.equal(await call("extensions.toggle", { path: dnrDir, enabled: true }), true);
	await new Promise((done) => setTimeout(done, 500));
	await assert.rejects(
		site.goto(blockedUrl, { timeout: 10_000 }),
		/ERR_BLOCKED_BY_CLIENT|net::ERR/,
		"re-enabling the extension restores the rule",
	);

	// .crx 安装会挂兼容层：SW 里用了 Electron 缺的 chrome.windows 也能活，页面里补上 fontSettings 等
	const compatSource = join(temporary, "compat-extension");
	await mkdir(compatSource, { recursive: true });
	const compatFiles = {
		"manifest.json": JSON.stringify(
			{
				manifest_version: 3,
				name: "Compat extension",
				version: "0.0.1",
				background: { service_worker: "sw.js" },
				action: { default_popup: "popup.html" },
				options_ui: { page: "options.html" },
				content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"], run_at: "document_start" }],
			},
			null,
			1,
		),
		"sw.js":
			'chrome.windows.onRemoved.addListener(() => {});\nchrome.runtime.onMessage.addListener((message, sender, reply) => {\n\tif (message && message.type === "ping") {\n\t\treply({ ok: true });\n\t\treturn true;\n\t}\n});\n',
		"popup.html":
			'<!doctype html><title>compat popup</title><p id="compat">compat popup body</p><script src="popup.js"></script>',
		// storage.sync 在 Electron 里没有后端：库把它映射到 local，兼容层再兜一次底
		"popup.js":
			'chrome.storage.sync.set({ compatKey: "compatValue" }, () => { chrome.storage.sync.get("compatKey", (value) => { document.getElementById("compat").textContent = "sync:" + value.compatKey; }); });',
		"options.html": '<!doctype html><title>compat options</title><p id="compat">compat options body</p>',
		"cs.js": 'document.documentElement.dataset.compatContentScript = "1";',
	};
	for (const [name, content] of Object.entries(compatFiles)) await writeFile(join(compatSource, name), content, "utf8");
	const crxPath = join(temporary, "compat-extension.crx");
	await writeFile(crxPath, crxFromZip(zipEntries(compatFiles)));
	const compatInstall = await call("extensions.installCrx", { path: crxPath });
	assert.equal(compatInstall.name, "Compat extension");
	const extensionsRoot = join(temporary, "profile", "browser", "extensions");
	const crxDir = (await readdir(extensionsRoot)).find((name) => name.startsWith("crx-"));
	assert.ok(crxDir, "crx is extracted into its own directory");
	const crxRoot = join(extensionsRoot, crxDir);
	const patchedManifest = JSON.parse(await readFile(join(crxRoot, "manifest.json"), "utf8"));
	assert.equal(patchedManifest.background.service_worker, "__pi-sw.js", "compat wraps the MV3 service worker");
	assert.deepEqual(patchedManifest.content_scripts[0].js, ["__pi-compat.js", "cs.js"]);
	assert.ok(
		(await readFile(join(crxRoot, "options.html"), "utf8")).includes("/__pi-compat.js"),
		"compat is injected into extension pages",
	);
	// 扩展页面能拿到库提供的命名空间与兼容层补的成员
	assert.equal(await call("extensions.openOptions", { path: crxRoot, anchor: { x: 700, y: 90 } }), true);
	let compatWindow;
	for (let attempt = 0; attempt < 100; attempt++) {
		compatWindow = application.windows().find((win) => win.url().endsWith("/options.html"));
		if (compatWindow) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(compatWindow, "extension options window opens");
	assert.match(compatWindow.url(), /^chrome-extension:\/\/[a-p]+\/options\.html$/);
	// electron-chrome-extensions 接管的命名空间（Electron 原生没有）
	assert.equal(
		await compatWindow.evaluate(() => typeof chrome.windows?.getAll),
		"function",
		"chrome.windows comes from electron-chrome-extensions",
	);
	assert.equal(
		await compatWindow.evaluate(() => typeof chrome.contextMenus?.create),
		"function",
		"chrome.contextMenus comes from electron-chrome-extensions",
	);
	// 兼容层仍然负责库没盖的那几个 tabs 成员（chrome 顶层被 freeze，成员可以补）
	assert.equal(
		await compatWindow.evaluate(() => typeof chrome.tabs?.captureVisibleTab),
		"function",
		"compat fills the tabs members the library leaves out",
	);
	assert.equal(
		await compatWindow.evaluate(() => document.getElementById("compat")?.textContent),
		"compat options body",
	);
	// captureVisibleTab 不再是空实现：宿主截图 → data URL（先回到浏览器模式并激活那个网页标签）
	await call("mode", { mode: "browser" });
	await call("tabs.activate", { id: tabId });
	await new Promise((done) => setTimeout(done, 300));
	const captureShot = await compatWindow.evaluate(
		() =>
			new Promise((resolve) => {
				chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 }, (value) => resolve(value));
			}),
	);
	assert.ok(
		typeof captureShot === "string" && captureShot.startsWith("data:image/jpeg;base64,") && captureShot.length > 500,
		"captureVisibleTab returns a real screenshot",
	);
	await compatWindow.close();
	// 内容脚本也活着（页面能拿到标记）
	await call("tabs.create", { url: siteUrl });
	let compatSite;
	for (let attempt = 0; attempt < 100; attempt++) {
		compatSite = pages
			.pages()
			.filter((page) => page.url().startsWith(siteUrl))
			.at(-1);
		if (
			compatSite &&
			(await compatSite.evaluate(() => !!document.documentElement.dataset.compatContentScript).catch(() => false))
		)
			break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.equal(await compatSite.evaluate(() => document.documentElement.dataset.compatContentScript), "1");
	assert.equal(await call("extensions.remove", { path: crxRoot }), true);

	const webAgentUrl = `${agentUrl}/web-agent`;
	const webAgentTabId = await call("tabs.create", { url: webAgentUrl });
	let webAgent;
	for (let attempt = 0; attempt < 100; attempt++) {
		webAgent = pages.pages().find((page) => page.url() === webAgentUrl);
		if (webAgent) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(webAgent);
	await webAgent.waitForFunction(() => !!window.__piBrowser);
	assert.equal(await webAgent.evaluate(() => typeof window.piBrowserShell), "undefined");
	assert.equal(
		(
			await webAgent.evaluate(
				(target) => window.__piBrowser.pageCall({ op: "read", target, args: { what: "title" }, timeoutMs: 5000 }),
				tabId,
			)
		).ok,
		true,
	);
	await call("tabs.close", { id: webAgentTabId });
	await call("tabs.activate", { id: tabId });

	const documentPath = join(temporary, "smoke-document.md");
	await writeFile(documentPath, "original document", "utf8");
	await assert.rejects(call("files.read", { path: documentPath }), /file picker/);
	await application.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, documentPath);
	await call("files.open", { category: "office" });
	assert.equal((await call("files.read", { path: documentPath })).content, "original document");
	await call("files.save", { path: documentPath, content: "saved document" });
	assert.equal(await readFile(documentPath, "utf8"), "saved document");
	await call("tabs.activate", { id: tabId });

	await call("settings.save", { settings: { aiControl: false } });
	assert.equal((await caller({ op: "click", target: tabId, args: { selector: "#submit" } })).ok, false);
	await call("settings.save", { settings: { aiControl: true } });
	// 自定义新标签页 / 主题：工具路径（page-call → design.*）改完立刻生效，预览必须真有截图
	const designStatus = await caller({ op: "design.status" });
	assert.deepEqual(
		designStatus.result.map((entry) => entry.kind),
		["newtab", "theme"],
	);
	assert.equal((await caller({ op: "design.get", args: { kind: "newtab" } })).result.starter, true);
	const saveNewTab = await caller({
		op: "design.save",
		args: {
			kind: "newtab",
			content:
				'<!doctype html><meta charset="utf-8"><title>Smoke new tab</title><body style="margin:0;background:rgb(3,4,5)"><h1 id="probe">custom newtab</h1></body>',
		},
		timeoutMs: 10000,
	});
	assert.equal(saveNewTab.ok, true, `design.save newtab: ${saveNewTab.error ?? ""}`);
	const customTabId = await call("tabs.create", { url: "newtab" });
	const customUrl = (await call("state")).tabs.find((tab) => tab.id === customTabId)?.url ?? "";
	assert.ok(customUrl.endsWith("/custom/newtab.html"), `new tab opens the custom page: ${customUrl}`);
	let customPage;
	for (let attempt = 0; attempt < 100; attempt++) {
		customPage = pages.pages().find((page) => page.url().includes("/custom/newtab.html"));
		if (customPage) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(customPage, "custom new tab page is a real view");
	await customPage.waitForFunction(() => !!window.piBrowserShell, { timeout: 5000 });
	assert.equal(await customPage.textContent("#probe"), "custom newtab");
	const preview = await caller({ op: "design.preview", args: { kind: "newtab" }, timeoutMs: 30000 });
	assert.equal(preview.ok, true, `design.preview: ${preview.error ?? ""}`);
	assert.ok(preview.result.image.dataUrl.startsWith("data:image/jpeg;base64,"));
	assert.ok(preview.result.image.width >= 320, "preview returns a real screenshot");
	const saveTheme = await caller({
		op: "design.save",
		args: { kind: "theme", content: ":root { --pb-smoke-probe: 7; }" },
	});
	assert.equal(saveTheme.ok, true, `design.save theme: ${saveTheme.error ?? ""}`);
	await shell.waitForTimeout(300);
	assert.equal(
		await shell.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pb-smoke-probe").trim()),
		"7",
		"theme override reaches the shell",
	);
	assert.equal(
		await customPage.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--pb-smoke-probe").trim(),
		),
		"7",
		"theme override reaches internal tabs",
	);
	assert.equal((await caller({ op: "design.reset", args: { kind: "newtab" } })).ok, true);
	assert.equal((await caller({ op: "design.reset", args: { kind: "theme" } })).ok, true);
	const resetStatus = await caller({ op: "design.status" });
	assert.ok(
		resetStatus.result.every((entry) => entry.custom === false),
		"reset removes both custom files",
	);
	await call("tabs.activate", { id: tabId });
	// Agent 页的 openOptions 走 pi-browser:open-options → 外壳开设置面板；
	// 面板开在自己的浮层视图里（panel.html?panel=settings），不再是外壳文档里的 dialog
	assert.equal((await caller({ op: "openOptions" })).ok, true);
	let settingsPanel;
	for (let attempt = 0; attempt < 100; attempt++) {
		settingsPanel = pages.pages().find((page) => page.url().includes("/panel.html?panel=settings"));
		if (settingsPanel) break;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.ok(settingsPanel, "openOptions opens the settings panel in its own layer view");
	await settingsPanel.waitForSelector("form", { timeout: 5000 });
	await settingsPanel.waitForSelector(".pb-design textarea", { timeout: 5000 });
	assert.deepEqual(rendererErrors, [], "the shell logs no renderer errors while panels open");
	// Esc 由面板页自己接（视图不是模态 dialog，收不到 cancel）：收起时这块视图当场被销毁，
	// 所以这一下不等回执——等回执本身就是竞态，页面先没了，promise 只会报 Target closed
	await settingsPanel
		.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
		.catch(() => {});
	for (let attempt = 0; attempt < 100 && pages.pages().some((page) => page.url().includes("/panel.html")); attempt++)
		await new Promise((done) => setTimeout(done, 50));
	assert.equal(
		pages.pages().some((page) => page.url().includes("/panel.html")),
		false,
		"Esc closes the settings panel layer",
	);
	await call("mode", { mode: "split" });
	await shell.waitForTimeout(200);
	const screenshot = await application.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
		const window = BrowserWindow.getAllWindows()[0];
		window.show();
		window.focus();
		const [width, height] = window.getSize();
		const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width, height } });
		const source = sources.find((entry) => entry.id === window.getMediaSourceId());
		return source && !source.thumbnail.isEmpty()
			? source.thumbnail.toDataURL()
			: (await window.capturePage()).toDataURL();
	});
	const screenshotPath = resolve(tempRoot, "pi-browser-desktop-smoke.png");
	await writeFile(screenshotPath, Buffer.from(screenshot.split(",")[1], "base64"));
	console.log(
		JSON.stringify(
			{
				ok: true,
				checks: [
					"native app startup",
					"three modes preserve views",
					"native bridge to webpage",
					"website isolation",
					"explicit target failure",
					"text wait timeout",
					"vision screenshot",
					"AI control toggle",
					"custom new tab + theme (save/preview/reset)",
					"extension restore/list shape",
					"extension action popup window",
					"extension options window",
					"extension disable/enable/reload/remove",
					"extension panel layer keeps the page visible",
					"crx compat shim (SW + pages + content scripts)",
					"Web Agent opened as a browser tab",
					"native file grants and save",
					"native browser settings entry",
				],
				screenshot: screenshotPath,
			},
			null,
			2,
		),
	);
} finally {
	await application?.close().catch(() => {});
	await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
	await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
