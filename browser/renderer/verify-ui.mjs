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
	let settings = { searchEngine: "bing", newTabOpenMode: "current", agentUrl: state.agentUrl };
	const listeners = [];
	window.__calls = [];
	setTimeout(() => {
		window.piBrowserShell = {
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
				if (action === "extensions.list") return [{ id: "ext", name: "Test extension", version: "1.0" }];
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
		window.piDesktop = { window: { minimize() {}, toggleMaximize() {}, close() {} } };
	}, 200);
});
try {
	await page.goto("http://127.0.0.1:8994/shell.html");
	await page.locator(".pb-tab").first().waitFor();
	assert.equal(await page.locator(".pb-chrome").evaluate((node) => node.getBoundingClientRect().height), 88);
	assert.equal(
		await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
		"rgba(0, 0, 0, 0)",
	);
	await page.getByRole("button", { name: "Split", exact: true }).click();
	await page.locator(".pb-split-control").waitFor({ state: "visible" });
	await page.locator(".pb-address input").fill("test query & emoji");
	await page.locator(".pb-address input").press("Enter");
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some(
				(call) =>
					call.action === "navigate" && call.args.url === "https://www.bing.com/search?q=test%20query%20%26%20emoji",
			),
		),
	);
	await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
	await page.locator("dialog[open]").waitFor();
	assert.equal(await page.locator("dialog script, dialog img").count(), 0);
	await page.getByRole("button", { name: /Work <script>/ }).click();
	assert.ok(await page.getByRole("button", { name: /Example <img/ }).isVisible());
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("New bookmark");
	await page.getByLabel("URL", { exact: true }).fill("https://new.example.com");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByRole("button", { name: /New bookmark/ }).waitFor();
	await page.keyboard.press("Escape");
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "overlay" && call.args.open === false)),
	);
	await page.evaluate(() => window.__focusAddress());
	await page.waitForFunction(() => document.activeElement === document.querySelector(".pb-address input"));
	await page.evaluate(() => window.__openOptions());
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
	await page.getByRole("button", { name: "Load unpacked extension", exact: true }).click();
	assert.ok(await page.evaluate(() => window.__calls.some((call) => call.action === "extensions.load")));
	await page.getByRole("button", { name: "Save", exact: true }).click();
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some((call) => call.action === "settings.save" && call.args.settings.searchEngine === "google"),
		),
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Downloads", exact: true }).click();
	await page.getByText("Report.txt", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Open", exact: true }).click();
	assert.ok(
		await page.evaluate(() => window.__calls.some((call) => call.action === "download.open" && call.args.id === "dl")),
	);
	await page.goto("http://127.0.0.1:8994/newtab.html");
	await page.locator(".pb-quick-link").first().waitFor();
	assert.equal(await page.locator(".pb-quick-links img,.pb-quick-links script").count(), 0);
	await page.locator(".pb-search input").fill("hello world");
	await page.locator(".pb-search input").press("Enter");
	assert.ok(
		await page.evaluate(() =>
			window.__calls.some((call) => call.action === "navigate" && call.args.url.endsWith("hello%20world")),
		),
	);
	await page.setViewportSize({ width: 520, height: 900 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.goto("http://127.0.0.1:8994/office.html?path=C:/table.csv");
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
		"PASS: shell 88px/transparent, delayed preload, modes/ratio, address search, overlay, escaped bookmarks/history, add bookmark, settings, downloads, responsive newtab, vault add/delete, extensions load, permissions, native focus/options events, CSV edit/save, actual deflated DOCX/XLSX/PPTX preview.",
	);
} finally {
	await browser.close();
	await server.close();
}
