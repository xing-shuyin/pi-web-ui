import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

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
		await call("passwords.fill", { id: "fixture-login" });
		assert.equal(await site.locator("#name").inputValue(), "fixture-user");
		assert.equal(await site.locator("#secret").inputValue(), "fixture-value");
	}

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
	assert.equal((await caller({ op: "openOptions" })).ok, true);
	await shell
		.getByRole("dialog")
		.waitFor({ timeout: 5000 })
		.catch(async (error) => {
			console.error(
				JSON.stringify({
					rendererErrors,
					shell: await shell.evaluate(() => ({
						url: location.href,
						dialogs: [...document.querySelectorAll("dialog")].map((node) => ({
							open: node.open,
							display: getComputedStyle(node).display,
						})),
						optionsBridge: typeof window.piBrowserShell?.onOpenOptions,
					})),
				}),
			);
			throw error;
		});
	await shell.evaluate(() =>
		document.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true })),
	);
	await shell.getByRole("dialog").waitFor({ state: "hidden" });
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
