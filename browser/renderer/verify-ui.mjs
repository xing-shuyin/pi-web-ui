import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
function archive(entries) {
	const locals = [];
	const directory = [];
	let offset = 0;
	for (const [name, text] of Object.entries(entries)) {
		const n = Buffer.from(name);
		const raw = Buffer.from(text);
		const data = deflateRawSync(raw);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(8, 8);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(raw.length, 22);
		header.writeUInt16LE(n.length, 26);
		locals.push(header, n, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(n.length, 28);
		central.writeUInt32LE(offset, 42);
		directory.push(central, n);
		offset += header.length + n.length + data.length;
	}
	const d = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(d.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, d, end]).toString("base64");
}
const root = fileURLToPath(new URL(".", import.meta.url));
const server = await createServer({
	root,
	base: "./",
	server: { host: "127.0.0.1", port: 8994, strictPort: true, fs: { allow: [resolve(root, "../..")] } },
	configFile: false,
});
const executablePath = [
	process.env.BROWSER_EXECUTABLE,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
]
	.filter(Boolean)
	.find(existsSync);
await server.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
	const state = {
		mode: "browser",
		splitRatio: 0.5,
		activeTabId: "a",
		tabs: [
			{
				id: "a",
				url: "https://example.com",
				title: "Example page",
				loading: false,
				canGoBack: true,
				canGoForward: false,
				internal: false,
			},
			{
				id: "b",
				url: "newtab",
				title: "New tab",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				internal: true,
			},
		],
		agentUrl: "http://127.0.0.1:3000",
		agentReady: true,
	};
	let bookmarks = [
		{
			name: "Work <script>alert(1)</script>",
			type: "folder",
			children: [{ name: "Example <img src=x onerror=alert(1)>", type: "link", url: "https://example.com" }],
		},
	];
	let extensions = [
		{
			id: "ext",
			name: "Test extension",
			version: "1.0",
			path: "C:/extensions/test",
			enabled: true,
			popup: "popup.html",
			options: "options.html",
		},
	];
	let settings = { searchEngine: "bing", newTabOpenMode: "current", agentUrl: state.agentUrl };
	const listeners = [];
	window.__calls = [];
	setTimeout(() => {
		window.piBrowserShell = {
			// 与 browser/preload.cts 的 filePath 同形：渲染层只能靠它拿拖入文件的真实路径
			filePath: () => "C:/mock-extension.crx",
			onState(callback) {
				listeners.push(callback);
				return () => {};
			},
			onOpenOptions(callback) {
				window.__openOptions = callback;
			},
			onFocusAddress(callback) {
				window.__focusAddress = callback;
			},
			async call(action, args = {}) {
				window.__calls.push({ action, args });
				if (action === "state") return structuredClone(state);
				if (action === "bookmarks.list") return structuredClone(bookmarks);
				if (action === "bookmarks.save") {
					bookmarks = args.bookmarks;
					return true;
				}
				if (action === "settings.get") return { ...settings };
				if (action === "settings.save") {
					settings = { ...settings, ...args.settings };
					return settings;
				}
				if (action === "history.list")
					return [{ url: "https://example.com", title: "Recent <script>boom</script>", visitedAt: Date.now() }];
				if (action === "downloads.list")
					return [
						{
							id: "dl",
							filename: "Report.txt",
							state: "completed",
							path: "C:/Report.txt",
							receivedBytes: 512,
							totalBytes: 512,
						},
					];
				if (action === "passwords.available") return true;
				if (action === "passwords.list") return [];
				if (action === "scripts.list") return [];
				if (action === "extensions.list") return structuredClone(extensions);
				if (action === "extensions.reload") return true;
				if (action === "extensions.openPopup") return true;
				if (action === "extensions.openOptions") return true;
				// 原生右键菜单在浏览器里假不了：直接返回「选项」，验证菜单选择能接回真实动作
				if (action === "extensions.menu") return window.__menuChoice || "options";
				if (action === "extensions.load") return { id: "ext-unpacked", name: "Unpacked extension", version: "2.0" };
				if (action === "extensions.installCrx") return { id: "ext-crx", name: "Crx extension", version: "3.0" };
				if (action === "extensions.toggle") {
					extensions = extensions.map((entry) =>
						entry.path === args.path ? { ...entry, enabled: args.enabled === true } : entry,
					);
					return args.enabled === true;
				}
				if (action === "extensions.remove") {
					extensions = extensions.filter((entry) => entry.path !== args.path);
					return true;
				}
				if (action === "mode") state.mode = args.mode;
				if (action === "tabs.activate") state.activeTabId = args.id;
				if (action === "tabs.close") state.tabs = state.tabs.filter((tab) => tab.id !== args.id);
				if (action === "splitRatio") state.splitRatio = args.ratio;
				if (action === "files.read")
					return {
						ok: true,
						path: args.path,
						name: "table.csv",
						ext: ".csv",
						isText: true,
						content: 'Name,Note\r\nAlpha,"comma, quoted"\r\nBeta,"line\nwrap"',
						size: 100,
					};
				if (action === "files.save") return { ok: true, path: "C:/saved.csv", name: "saved.csv" };
				for (const callback of listeners) callback(structuredClone(state));
				return true;
			},
		};
		// 与 common.ts 的 window.piDesktop.window 声明一致（缺一个方法就会让整块 shell 模块抛错、连标签都不渲染）
		window.piDesktop = {
			platform: "win32",
			window: {
				minimize() {},
				toggleMaximize() {},
				close() {},
				async isMaximized() {
					return false;
				},
				onMaximizedChange() {
					return () => {};
				},
			},
		};
	}, 200);
});
try {
	await page.goto("http://127.0.0.1:8994/shell.html");
	await page.locator(".pb-tab").first().waitFor();
	assert.equal(await page.locator(".pb-tab").count(), 2);
	// 现在的 chrome 是单行 40px，body 必须保持透明（上下由原生 WebContentsView 铺）
	assert.equal(await page.locator(".pb-chrome").evaluate((node) => node.getBoundingClientRect().height), 40);
	assert.equal(
		await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
		"rgba(0, 0, 0, 0)",
	);

	// 模式按钮：browser → split，chrome 让出左半并显示分栏线
	await page.locator(".pb-tool-btn").first().click();
	await page.locator(".pb-split-divider").waitFor({ state: "visible" });
	const splitBox = await page.locator(".pb-chrome").evaluate((node) => node.getBoundingClientRect());
	assert.ok(splitBox.left > 0 && splitBox.width < (await page.evaluate(() => innerWidth)));
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "mode" && call.args.mode === "split")),
	);

	// Ctrl+L：搜索浮层 → 回车直达搜索页
	await page.keyboard.press("Control+l");
	await page.locator(".pb-search-overlay.pb-open").waitFor();
	await page.locator(".pb-search-input").fill("test query & emoji");
	await page.locator(".pb-search-input").press("Enter");
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some(
				(call) =>
					call.action === "navigate" && call.args.url === "https://www.bing.com/search?q=test%20query%20%26%20emoji",
			),
		),
	);
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "overlay" && call.args.open === true)),
	);

	// 原生菜单「聚焦地址栏」走同一条桥，Esc 关闭并归还 overlay
	await page.evaluate(() => window.__focusAddress());
	await page.locator(".pb-search-overlay.pb-open").waitFor();
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !document.querySelector(".pb-search-overlay.pb-open"));
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "overlay" && call.args.open === false)),
	);

	// 拖入 .crx：由 preload 取路径，交给主进程安装
	await page.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(["crx"], "mock-extension.crx", { type: "application/x-chrome-extension" }));
		for (const type of ["dragover", "drop"])
			document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
	await page.waitForFunction(() =>
		window.__calls.some(
			(call) => call.action === "extensions.installCrx" && call.args.path === "C:/mock-extension.crx",
		),
	);
	assert.equal(await page.locator(".pb-drop-hint").count(), 0);

	// 面板浮层：外壳只向宿主请一块视图（`panel` 动作），面板自己画在 panel.html 里——
	// 原生视图盖在页面之上，页面与 Agent 分栏照常可见，不再隐藏内容区
	await page.evaluate(() => window.__openOptions());
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some(
				(call) => call.action === "panel" && call.args.open === true && call.args.panel === "settings",
			),
		),
		"the native options menu asks the host for the settings panel layer",
	);
	// 工具栏扩展按钮（等同 Chrome 的扩展菜单）走的也是这条：外壳不再自己挂 dialog
	await page.getByRole("button", { name: "Extensions", exact: true }).click();
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some(
				(call) => call.action === "panel" && call.args.open === true && call.args.panel === "extensions",
			),
		),
	);
	assert.equal(await page.locator("dialog[open]").count(), 0, "the shell mounts no panel dialog itself");
	// 徽标只算「已启用」的那几个
	await page.waitForFunction(() => document.querySelector(".pb-tool-btn-count")?.textContent === "1");

	// 设置面板本体：同一份 panels.ts，画在自己的浮层视图里
	await page.goto("http://127.0.0.1:8994/panel.html?panel=settings");
	await page.locator("dialog[open]").waitFor();
	// 浮层不是模态：没有遮罩（`::backdrop` 只属于 showModal）
	assert.equal(await page.locator("dialog[open]").evaluate((node) => node.matches(":modal")), false);
	await page.getByLabel("Search engine").selectOption("google");
	await page.getByLabel("Allow AI screenshots", { exact: true }).uncheck();
	await page.getByRole("button", { name: "Add credential", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("Test account");
	await page.getByLabel("URL", { exact: true }).fill("https://accounts.example.com");
	await page.getByLabel("Username", { exact: true }).fill("alice");
	await page.getByLabel("Password", { exact: true }).fill("test-credential");
	await page.locator(".pb-editor-inline").getByRole("button", { name: "Save", exact: true }).click();
	await page.getByText("Test account", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Delete credential", exact: true }).click();
	await page.getByText("No saved credentials", { exact: true }).waitFor();
	// 设置里只留一个入口，扩展的启停/移除都在独立面板里
	await page.getByRole("button", { name: "Manage extensions", exact: true }).waitFor();
	// 设置表单的保存键排在凭据编辑器之前（后者此刻是收起的）
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some(
				(call) =>
					call.action === "settings.save" &&
					call.args.settings.searchEngine === "google" &&
					call.args.settings.allowShot === false,
			),
		),
	);
	// Esc 由面板页自己接（非模态 dialog 收不到 cancel），收起时通知宿主销毁这块视图
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !document.querySelector("dialog[open]"));
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "panel" && call.args.open === false)),
		"closing a panel asks the host to drop its layer view",
	);

	// 扩展面板：一行一个扩展，点整行就开它自己的页面（先开页、再收起面板）
	const openExtensionsPanel = async () => {
		await page.goto("http://127.0.0.1:8994/panel.html?panel=extensions");
		await page.locator("dialog[open]").waitFor();
		await page.getByText("Test extension", { exact: true }).waitFor();
	};
	await openExtensionsPanel();
	await page.getByRole("checkbox", { name: "Disable this extension: Test extension", exact: true }).click();
	await page.getByRole("checkbox", { name: "Enable this extension: Test extension", exact: true }).waitFor();
	assert.ok(
		await page
			.locator(".pb-extension-item")
			.first()
			.evaluate((row) => row.classList.contains("pb-extension-off")),
	);
	await page.getByRole("checkbox", { name: "Enable this extension: Test extension", exact: true }).click();
	await page.getByRole("checkbox", { name: "Disable this extension: Test extension", exact: true }).waitFor();
	assert.equal(
		await page
			.locator(".pb-extension-item")
			.first()
			.evaluate((row) => row.classList.contains("pb-extension-off")),
		false,
	);
	// 点整行 = 点工具栏上的动作图标：开它自己的弹窗（锚点在行右下角），面板自己收起
	await page.locator(".pb-extension-open").first().click();
	assert.ok(
		await page.evaluate(() => {
			const call = window.__calls.find((entry) => entry.action === "extensions.openPopup");
			return !!call && Number.isFinite(call.args.anchor.x) && Number.isFinite(call.args.anchor.y);
		}),
	);
	await page.waitForFunction(() => !document.querySelector("dialog[open]"));
	// 行尾「更多操作」和右键是同一张原生菜单：重载 / 选项 / 移除都在这里
	await openExtensionsPanel();
	await page.evaluate(() => (window.__menuChoice = "reload"));
	await page.locator(".pb-extension-more").first().click();
	assert.ok(await page.evaluate(() => window.__calls.some((call) => call.action === "extensions.reload")));
	await page.evaluate(() => (window.__menuChoice = "options"));
	await page.locator(".pb-extension-item").first().click({ button: "right" });
	assert.ok(
		await page.evaluate(() => {
			const call = window.__calls.find((entry) => entry.action === "extensions.menu");
			return !!call && call.args.items.some((item) => item.id === "options");
		}),
	);
	await page.waitForFunction(() => window.__calls.some((call) => call.action === "extensions.openOptions"));
	// 菜单里选「选项」也会先收起面板（与点整行一致）
	await page.waitForFunction(() => !document.querySelector("dialog[open]"));
	// 安装入口在底部：两个按钮各自落到 extensions.load / extensions.installCrx
	await openExtensionsPanel();
	await page.getByRole("button", { name: "Load unpacked extension", exact: true }).click();
	await page.getByRole("button", { name: "Install .crx extension", exact: true }).click();
	assert.ok(await page.evaluate(() => window.__calls.some((call) => call.action === "extensions.load")));
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some((call) => call.action === "extensions.installCrx" && call.args.path === undefined),
		),
	);
	// 移除：只改清单，列表立刻变空
	await page.evaluate(() => (window.__menuChoice = "remove"));
	await page.locator(".pb-extension-more").first().click();
	await page.getByText("No extensions installed yet.", { exact: true }).waitFor();
	assert.ok(await page.evaluate(() => window.__calls.some((call) => call.action === "extensions.remove")));

	// 新标签页：收藏行不注入外部内容，搜索直达
	await page.goto("http://127.0.0.1:8994/newtab.html");
	// 假体是 +200ms 才挂到 window 上的，先等桥就绪再交互
	await page.waitForFunction(() => typeof window.piBrowserShell !== "undefined");
	await page.locator(".unified-bar").waitFor();
	assert.equal(await page.locator(".unified-flow-row img, .unified-flow-row script").count(), 0);
	await page.locator(".unified-bar input").fill("hello world");
	await page.locator(".unified-bar input").press("Enter");
	await page.waitForFunction(
		() =>
			window.__calls.some(
				(call) => call.action === "navigate" && String(call.args?.url ?? "").endsWith("hello%20world"),
			),
		undefined,
		{ timeout: 10000 },
	);

	// 书签面板：XSS 文本只当文本；新增书签；Esc 归还 overlay
	await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
	await page.locator("dialog[open]").waitFor();
	// 恶意书名/网址只当日志文本渲染，不产生 script/img 元素
	assert.equal(await page.locator("dialog script, dialog img").count(), 0);
	const panel = page.locator("dialog[open]");
	await panel.getByRole("button", { name: /Work <script>/ }).click();
	assert.ok(await panel.getByRole("button", { name: /Example <img/ }).isVisible());
	await panel.getByRole("button", { name: "Add", exact: true }).click();
	await panel.getByLabel("Name", { exact: true }).fill("New bookmark");
	await panel.getByLabel("URL", { exact: true }).fill("https://new.example.com");
	await panel.getByRole("button", { name: "Save", exact: true }).click();
	await panel.getByRole("button", { name: /New bookmark/ }).waitFor();
	await page.keyboard.press("Escape");
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "overlay" && call.args.open === false)),
	);

	// 下载面板：打开已完成下载
	await page.getByRole("button", { name: "Downloads", exact: true }).click();
	await page.getByText("Report.txt", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Open", exact: true }).click();
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "download.open" && call.args.id === "dl")),
	);
	await page.keyboard.press("Escape");

	// 窄窗口不横向溢出
	await page.setViewportSize({ width: 520, height: 900 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

	// CSV 编辑保存
	await page.goto("http://127.0.0.1:8994/office.html?path=C:/table.csv");
	await page.waitForFunction(() => typeof window.piBrowserShell !== "undefined");
	await page.locator(".pb-sheet tbody input").first().waitFor();
	assert.equal(await page.locator(".pb-sheet tbody tr").count(), 3);
	assert.equal(await page.locator(".pb-sheet tbody tr").nth(1).locator("input").nth(1).inputValue(), "comma, quoted");
	await page.locator(".pb-sheet tbody input").first().fill("Updated");
	await page.getByRole("button", { name: "Save file", exact: true }).click();
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some((call) => call.action === "files.save" && call.args.content.startsWith("Updated,Note")),
		),
	);

	// 真实 deflate 的 DOCX/XLSX/PPTX 预览
	const docx = archive({
		"word/document.xml": '<w:document xmlns:w="w"><w:p><w:r><w:t>Actual document</w:t></w:r></w:p></w:document>',
	});
	const xlsx = archive({
		"xl/workbook.xml":
			'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheet name="Actual sheet" r:id="r1"/></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
		"xl/sharedStrings.xml": "<sst><si><t>Shared text</t></si></sst>",
		"xl/worksheets/sheet1.xml": '<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></worksheet>',
	});
	const pptx = archive({
		"ppt/slides/slide2.xml": "<slide><p><t>Second</t></p></slide>",
		"ppt/slides/slide1.xml": "<slide><p><t>First</t></p></slide>",
	});
	const previews = await page.evaluate(
		async ({ docx, xlsx, pptx }) => {
			const formats = await import("/office-formats.ts");
			return {
				doc: await formats.readOfficePreview(docx, ".docx"),
				sheet: await formats.readOfficePreview(xlsx, ".xlsx"),
				slides: await formats.readOfficePreview(pptx, ".pptx"),
			};
		},
		{ docx, xlsx, pptx },
	);
	assert.equal(previews.doc.paragraphs[0], "Actual document");
	assert.deepEqual(previews.sheet.sheets[0], { name: "Actual sheet", rows: [["Shared text", "", "42"]] });
	assert.deepEqual(previews.slides.slides, [["First"], ["Second"]]);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: shell 40px/transparent, split divider, search overlay + focus-address bridge, crx drop install, settings (engine/screenshots/vault), extensions panel (icon badge/toggle/reload/popup/options menu/remove/install), overlay release, escaped bookmarks, downloads, responsive newtab, CSV edit/save, actual deflated DOCX/XLSX/PPTX preview.",
	);
} finally {
	await browser.close();
	await server.close();
}
