// Real React + directory browser + local Bot persistence; only capability catalogs are fixtures.
// Parent builds dist once. This test NEVER starts a build, including when invoked directly.
// Run: node tests/local-bots-browser-test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild, PREBUILT_ENV } from "./lib/ensure-build.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
async function waitFor(check, label, timeout = 45_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function reservePort() {
	const listener = createServer();
	await new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const port = listener.address().port;
	await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
	return port >= 8900 ? port : reservePort();
}
async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 5000);
	try {
		await exited;
	} finally {
		clearTimeout(timer);
	}
}
async function assertNoOverflow(page, label) {
	const overflow = await page.evaluate(() => {
		const viewport = document.documentElement.clientWidth;
		const form = document.querySelector(".dc-bot-editor");
		const outside = [...form.querySelectorAll("input, textarea, button, fieldset")]
			.filter((element) => {
				const box = element.getBoundingClientRect();
				return box.width > 0 && (box.left < -1 || box.right > viewport + 1);
			})
			.map((element) => `${element.tagName}.${element.className}`);
		return {
			document: document.documentElement.scrollWidth > viewport + 1,
			form: form.scrollWidth > form.clientWidth + 1,
			outside,
		};
	});
	assert.deepEqual(overflow, { document: false, form: false, outside: [] }, `${label} must fit horizontally`);
}
async function main() {
	if (!CHROME_PATH) {
		console.log("SKIP local-bots-browser: Chrome unavailable (set PI_WEB_CHROME)");
		return;
	}
	const previous = process.env[PREBUILT_ENV];
	process.env[PREBUILT_ENV] = "1";
	try {
		ensureBuild(repo, "local-bots-browser");
	} finally {
		if (previous === undefined) delete process.env[PREBUILT_ENV];
		else process.env[PREBUILT_ENV] = previous;
	}
	const root = await mkdtemp(join(tmpdir(), "pi-local-bots-browser-"));
	let server;
	let browser;
	let serverLog = "";
	try {
		const work = join(root, "work");
		const project = join(work, "review-project");
		const home = join(root, "home");
		const agent = join(root, "agent");
		for (const path of [project, home, agent]) await mkdir(path, { recursive: true });
		const port = await reservePort();
		const origin = `http://127.0.0.1:${port}`;
		server = spawn(process.execPath, [join(repo, "dist/server/index.js")], {
			cwd: work,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				APPDATA: join(home, "AppData", "Roaming"),
				LOCALAPPDATA: join(home, "AppData", "Local"),
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(port),
				PI_WEB_CWD: work,
				PI_WEB_DATA_DIR: join(root, "pi-data"),
				PI_CODING_AGENT_DIR: agent,
				PI_WEB_SDK: "bundled",
				PI_WEB_TOKEN: "",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_PLUGIN_CATALOG_INSTALL: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		server.on("error", (error) => (serverLog += `\n${error.message}`));
		for (const stream of [server.stdout, server.stderr])
			stream.on("data", (chunk) => (serverLog = (serverLog + chunk).slice(-24_000)));
		await waitFor(async () => {
			assert.equal(server.exitCode, null, `Isolated server exited: ${serverLog}`);
			try {
				return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
			} catch {
				return false;
			}
		}, "isolated server health");
		const skillPath = join(project, ".pi", "skills", "review", "SKILL.md");
		const fixture = {
			cwd: work,
			defaultCwd: work,
			models: [
				{
					id: "regression/vendor/review-reasoner",
					name: "Review Reasoner",
					provider: "regression",
					reasoning: true,
					vision: true,
				},
				{ id: "quick-reader", name: "Quick Reader", provider: "secondary", reasoning: false, vision: false },
			],
			tools: [
				{ id: "read", name: "Read files", description: "Inspect source and documentation" },
				{ id: "edit", name: "Edit files", description: "Apply precise changes" },
			],
			skills: [
				{ id: skillPath, name: "Review guide", description: "Project review checklist", path: skillPath },
				{ id: "/fixture/other/SKILL.md", name: "Release guide" },
			],
			mcpServers: [
				{ id: "docs-regression", name: "Documentation", description: "Search reference material" },
				{ id: "issues-regression", name: "Issue tracker", status: "not_loaded" },
				{ id: "disabled-regression", name: "Disabled archive", status: "disabled" },
			],
			projects: [{ path: project }],
		};
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
		context.setDefaultTimeout(30_000);
		await context.addInitScript(() => {
			localStorage.setItem("pi-web-ui:lang", "en");
			localStorage.setItem("pi_web_setup_dismissed", "1");
		});
		let optionsRequests = 0;
		let failNextCatalog = false;
		let slowCatalog = null;
		await context.route(/\/api\/device-center\/local-bot-options(?:\?|$)/, async (route) => {
			optionsRequests++;
			if (failNextCatalog) {
				failNextCatalog = false;
				await route.fulfill({ json: { error: "Catalog fixture temporarily unavailable" } });
				return;
			}
			if (slowCatalog) {
				const gate = slowCatalog;
				slowCatalog = null;
				gate.started();
				await gate.release;
				await route
					.fulfill({ json: { ...fixture, tools: [{ id: "stale-only", name: "Stale tool" }] } })
					.catch(() => {});
				return;
			}
			const cwd = new URL(route.request().url()).searchParams.get("cwd") || work;
			await route.fulfill({ json: { ...fixture, cwd } });
		});
		const page = await context.newPage();
		const errors = [];
		const expectedUnpairedErrors = [];
		const promptPackets = [];
		const directoryPackets = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (message.type() !== "error") return;
			const url = message.location().url;
			// The unpaired device center loads its hidden groups view, whose rooms API
			// intentionally returns 409. Keep this single known non-Bot diagnostic explicit.
			if (url === `${origin}/api/device-center/rooms` && message.text().includes("409 (Conflict)")) {
				expectedUnpairedErrors.push(message.text());
				return;
			}
			errors.push(`${message.text()} ${url}`);
		});
		page.on("websocket", (socket) =>
			socket.on("framesent", ({ payload }) => {
				try {
					const packet = JSON.parse(String(payload));
					if (["prompt", "steer", "follow_up"].includes(packet.type)) promptPackets.push(packet);
					if (packet.type === "complete_path") directoryPackets.push(packet);
				} catch {
					/* WebSocket control frames have no JSON body. */
				}
			}),
		);
		await page.goto(`${origin}/?view=devices`);
		await page.locator("#root .app").waitFor();
		await page.locator(".status-conn.ok").waitFor();
		if (await page.locator(".dc-nav-item").filter({ hasText: "Connection settings" }).count()) {
			await page.locator(".dc-nav-item").filter({ hasText: "Connection settings" }).click();
		}
		const bots = page.locator(".dc-bots");
		await bots.getByRole("button", { name: "New Bot", exact: true }).click();
		const form = bots.locator(".dc-bot-editor");
		await form.getByLabel("Name", { exact: true }).fill("Source Review Bot");
		await form
			.getByLabel("Description", { exact: true })
			.fill("Review source changes with project guidance and documentation.");
		await form
			.getByLabel("System prompt", { exact: true })
			.fill("Inspect evidence, explain findings, and propose focused fixes.");
		await waitFor(
			() =>
				form
					.locator("#local-bot-cwd")
					.inputValue()
					.then((value) => value === work),
			"initial catalog cwd",
		);
		await form.getByRole("tab", { name: "Runtime", exact: true }).click();
		// Browse a real child directory over the real application's WebSocket.
		await form.locator(".universal-path-browse-btn").click();
		const picker = page.locator(".project-picker");
		await picker.waitFor({ state: "visible" });
		assert.equal(await picker.evaluate((element) => element.closest("dialog")?.open), true);
		const pickerBox = await picker.boundingBox();
		assert.ok(pickerBox);
		assert.equal(
			await picker.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30));
			}),
			true,
			"Directory picker must receive pointer input above the modal drawer",
		);
		await page.keyboard.press("Escape");
		await picker.waitFor({ state: "hidden" });
		assert.equal(await form.isVisible(), true, "Escape closes only the directory picker");
		await form.locator(".universal-path-browse-btn").click();
		await picker.waitFor({ state: "visible" });
		await picker
			.locator(".cwd-enter")
			.filter({ hasText: /^review-project$/ })
			.click();
		await picker.locator(".cwd-picker-input").waitFor();
		await waitFor(
			() =>
				picker
					.locator(".cwd-picker-input")
					.inputValue()
					.then((value) => normalize(value) === normalize(project)),
			"directory navigation",
		);
		await picker.locator(".tool-pick").click();
		await picker.waitFor({ state: "hidden" });
		await waitFor(
			() =>
				form
					.locator("#local-bot-cwd")
					.inputValue()
					.then((value) => normalize(value) === normalize(project)),
			"selected Bot cwd",
		);
		assert.ok(directoryPackets.length > 0, "Directory picker must browse through the real WS transport");
		await form.locator('button[aria-haspopup="dialog"]').click();
		const models = page.getByRole("dialog", { name: "Model", exact: true });
		await models.locator(".dd-search").fill("Review Reasoner");
		await models.locator(".dd-item").filter({ hasText: "Review Reasoner" }).click();
		await models.waitFor({ state: "hidden" });
		assert.equal(await form.locator('button[aria-haspopup="dialog"]').innerText(), "Review Reasoner");
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		const catalogs = form.locator(".dc-bot-catalog");
		assert.equal(await catalogs.count(), 3);
		for (const [index, query, label, rejected] of [
			[0, "Inspect source", "Read files", "Edit files"],
			[1, "review checklist", "Review guide", "Release guide"],
			[2, "docs-regression", "Documentation", "Issue tracker"],
		]) {
			await form.locator(".dc-bot-catalog-tabs button").nth(index).click();
			const catalog = catalogs.nth(index);
			await waitFor(() => catalog.getByRole("checkbox", { name: new RegExp(label) }).count(), `${label} catalog`);
			await catalog.getByRole("searchbox").fill(query);
			assert.equal(
				await catalog.getByRole("checkbox", { name: new RegExp(rejected) }).count(),
				0,
				"Search must filter unrelated entries",
			);
			await catalog.getByRole("checkbox", { name: new RegExp(label) }).check();
			await catalog.getByRole("searchbox").fill("");
			assert.equal(await catalog.getByRole("checkbox", { name: new RegExp(label) }).isChecked(), true);
			assert.equal(await catalog.getByRole("checkbox", { name: new RegExp(rejected) }).isChecked(), false);
		}
		assert.equal(
			await catalogs
				.nth(2)
				.getByRole("checkbox", { name: /Disabled archive/ })
				.isDisabled(),
			true,
		);
		await catalogs
			.nth(2)
			.getByText(/Connect this server in MCP settings/)
			.waitFor();
		await form.locator(".dc-bot-catalog-tabs button").nth(1).click();
		// Filtered bulk selection must select only the currently visible results.
		await catalogs.nth(1).getByRole("button", { name: "Clear", exact: true }).click();
		await catalogs.nth(1).getByRole("searchbox").fill("Review guide");
		await catalogs.nth(1).getByRole("button", { name: "Select results", exact: true }).click();
		await catalogs.nth(1).getByRole("searchbox").fill("");
		assert.equal(await catalogs.nth(1).locator('input[type="checkbox"]:checked').count(), 1);
		await form.locator(".dc-bot-catalog-tabs button").nth(0).click();
		// Bulk selection must use catalog IDs, and Clear must reset even filtered selections.
		await catalogs.nth(0).getByRole("button", { name: "Select all", exact: true }).click();
		assert.equal(await catalogs.nth(0).locator('input[type="checkbox"]:checked').count(), 2);
		await catalogs.nth(0).getByRole("button", { name: "Clear", exact: true }).click();
		assert.equal(await catalogs.nth(0).locator('input[type="checkbox"]:checked').count(), 0);
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Read files/ })
			.check();
		await assertNoOverflow(page, "desktop");
		await bots.scrollIntoViewIfNeeded();
		const desktop = await page.screenshot({ fullPage: true, animations: "disabled" });
		await page.setViewportSize({ width: 390, height: 844 });
		await assertNoOverflow(page, "narrow");
		await form.getByRole("tab", { name: "Runtime", exact: true }).click();
		await form.locator('button[aria-haspopup="dialog"]').click();
		await models.locator(".dd-search").waitFor();
		const modelBounds = await models.boundingBox();
		assert.ok(modelBounds.x >= 0 && modelBounds.x + modelBounds.width <= 391, "Model portal fits narrow viewport");
		await models.locator(".dd-search").press("Escape");
		await models.waitFor({ state: "hidden" });
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		await catalogs.nth(0).scrollIntoViewIfNeeded();
		const narrow = await page.screenshot({ fullPage: true, animations: "disabled" });
		const savedResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/device-center/local-bots" && response.request().method() === "POST",
		);
		await form.getByRole("button", { name: "Save", exact: true }).click();
		const saved = await savedResponse;
		assert.equal(saved.status(), 200, await saved.text());
		const submitted = saved.request().postDataJSON();
		assert.equal(normalize(submitted.cwd), normalize(project));
		assert.deepEqual(submitted.model, { provider: "regression", modelId: "vendor/review-reasoner" });
		assert.deepEqual(submitted.tools, ["read"]);
		assert.deepEqual(submitted.skills, [skillPath]);
		assert.deepEqual(submitted.mcpServers, ["docs-regression"]);
		const savedBot = (await saved.json()).bot;
		assert.ok(savedBot.id && savedBot.revision, "Real registry must assign Bot identity and revision");
		const persisted = await (await context.request.get(`${origin}/api/device-center/local-bots`)).json();
		assert.deepEqual(
			persisted.bots.find((bot) => bot.id === savedBot.id),
			savedBot,
			"Save must persist in the real registry",
		);
		await form.waitFor({ state: "hidden" });
		await bots.getByRole("button", { name: /Source Review Bot/ }).click();
		await waitFor(
			() =>
				form
					.locator('button[aria-haspopup="dialog"]')
					.innerText()
					.then((text) => text === "Review Reasoner"),
			"saved model restored",
		);
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		for (const [index, label] of [
			[0, "Read files"],
			[1, "Review guide"],
			[2, "Documentation"],
		]) {
			await form.locator(".dc-bot-catalog-tabs button").nth(index).click();
			assert.equal(
				await catalogs
					.nth(index)
					.getByRole("checkbox", { name: new RegExp(label) })
					.isChecked(),
				true,
				"Saved selections must reopen checked",
			);
		}
		let releaseCatalog;
		let markStarted;
		const started = new Promise((resolve) => {
			markStarted = resolve;
		});
		slowCatalog = {
			started: markStarted,
			release: new Promise((resolve) => {
				releaseCatalog = resolve;
			}),
		};
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		await form.locator(".dc-bot-catalog-tabs button").nth(0).click();
		await form.locator(".dc-bot-options-status button").click();
		await started;
		await waitFor(() => form.locator(".dc-bot-options-status button").isDisabled(), "catalog loading state");
		assert.equal(
			await catalogs.nth(0).getByRole("checkbox", { name: /^read/ }).isChecked(),
			true,
			"Loading retains stored permission IDs",
		);
		await form.getByRole("tab", { name: "Runtime", exact: true }).click();
		await form.locator("#local-bot-cwd").fill(work);
		await form.locator("#local-bot-cwd").press("Tab");
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Read files/ })
			.waitFor();
		releaseCatalog();
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Read files/ })
			.waitFor();
		failNextCatalog = true;
		await form.locator(".dc-bot-options-status button").click();
		await form.locator(".dc-bot-options-status [role=alert]").waitFor();
		assert.equal(await catalogs.nth(0).getByRole("checkbox", { name: /^read/ }).isChecked(), true);
		await catalogs.nth(0).getByRole("checkbox", { name: /^read/ }).click();
		assert.equal(
			await catalogs.nth(0).getByRole("checkbox").count(),
			0,
			"Unavailable saved permissions remain removable after failure",
		);
		assert.equal(await form.getByLabel("Name", { exact: true }).inputValue(), "Source Review Bot");
		await form.locator(".dc-bot-options-status button").click();
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Read files/ })
			.waitFor();
		assert.equal(
			await catalogs
				.nth(0)
				.getByRole("checkbox", { name: /Read files/ })
				.isChecked(),
			false,
		);
		assert.equal(
			await catalogs
				.nth(0)
				.getByRole("checkbox", { name: /Stale tool/ })
				.count(),
			0,
		);
		await form.getByRole("tab", { name: "Runtime", exact: true }).click();
		// Edit permissions and explicitly return to the inherited model.
		await form.locator('button[aria-haspopup="dialog"]').click();
		await models.getByRole("button", { name: "Inherit default model", exact: true }).click();
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Read files/ })
			.uncheck();
		await catalogs
			.nth(0)
			.getByRole("checkbox", { name: /Edit files/ })
			.check();
		await form.locator(".dc-bot-catalog-tabs button").nth(1).click();
		await catalogs.nth(1).getByRole("button", { name: "Clear", exact: true }).click();
		await form.locator(".dc-bot-catalog-tabs button").nth(2).click();
		await catalogs
			.nth(2)
			.getByRole("checkbox", { name: /Issue tracker/ })
			.check();
		await form.getByRole("tab", { name: "Identity and prompt", exact: true }).click();
		await form.getByLabel("Name", { exact: true }).fill("Updated Review Bot");
		const editResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/device-center/local-bots" && response.request().method() === "POST",
		);
		await form.getByRole("button", { name: "Save", exact: true }).click();
		const edited = await editResponse;
		assert.equal(edited.status(), 200, await edited.text());
		const editPayload = edited.request().postDataJSON();
		assert.equal(editPayload.id, savedBot.id);
		assert.equal(editPayload.revision, savedBot.revision);
		assert.equal(editPayload.model, undefined, "Inherit omits explicit model");
		assert.deepEqual(editPayload.tools, ["edit"]);
		assert.deepEqual(editPayload.skills, []);
		assert.deepEqual(editPayload.mcpServers, ["docs-regression", "issues-regression"]);
		await form.waitFor({ state: "hidden" });
		await bots.getByRole("button", { name: /Updated Review Bot/ }).click();
		assert.equal(await form.locator('button[aria-haspopup="dialog"]').innerText(), "Inherit default model");
		await form.getByRole("tab", { name: "Capabilities", exact: true }).click();
		await form.locator(".dc-bot-catalog-tabs button").nth(0).click();
		await waitFor(
			() =>
				catalogs
					.nth(0)
					.getByRole("checkbox", { name: /Edit files/ })
					.count(),
			"edited catalog restored",
		);
		assert.equal(
			await catalogs
				.nth(0)
				.getByRole("checkbox", { name: /Edit files/ })
				.isChecked(),
			true,
		);
		assert.equal(
			await catalogs
				.nth(0)
				.getByRole("checkbox", { name: /Read files/ })
				.isChecked(),
			false,
		);
		assert.equal(await catalogs.nth(1).locator('input[type="checkbox"]:checked').count(), 0);
		assert.equal(await catalogs.nth(2).locator('input[type="checkbox"]:checked').count(), 2);
		page.once("dialog", (dialog) => dialog.accept());
		const deletedResponse = page.waitForResponse(
			(response) => new URL(response.url()).pathname === `/api/device-center/local-bots/${savedBot.id}/delete`,
		);
		await form.getByRole("button", { name: "Delete", exact: true }).click();
		const deleted = await deletedResponse;
		assert.equal(deleted.status(), 200, await deleted.text());
		await form.waitFor({ state: "hidden" });
		const afterDelete = await (await context.request.get(`${origin}/api/device-center/local-bots`)).json();
		assert.equal(afterDelete.bots.length, 0, "Real registry removes the edited Bot");
		assert.ok(optionsRequests >= 2, "Catalog must reload for the chosen directory");
		assert.deepEqual(promptPackets, [], "This regression must never submit an inference request");
		assert.deepEqual(
			errors,
			[],
			"Real app must have no page or console errors beyond the documented unpaired rooms 409",
		);
		if (expectedUnpairedErrors.length)
			console.log("NOTE: unpaired device center rooms endpoint returned its expected 409; no other browser errors");
		// One report contains both unmodified real-app viewport captures.
		const report = join(repo, "reports", "local-bots-picker.png");
		await mkdir(dirname(report), { recursive: true });
		const sheet = await context.newPage();
		await sheet.setViewportSize({ width: 1900, height: 1200 });
		await sheet.setContent(
			`<body style="margin:0;padding:20px;background:#111827;color:#e5e7eb;font:16px system-ui"><h2>Local Bots · desktop and narrow viewport</h2><div style="display:flex;align-items:flex-start;gap:20px"><div><p>Desktop · 1440px</p><img width="1440" src="data:image/png;base64,${desktop.toString("base64")}"></div><div><p>Narrow · 390px</p><img width="390" src="data:image/png;base64,${narrow.toString("base64")}"></div></div></body>`,
		);
		await sheet.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
		await sheet.screenshot({ path: report, fullPage: true });
		console.log(
			`PASS local-bots-browser: real path/model pickers, searchable catalogs, persisted IDs, desktop/narrow layout, zero inference; ${report}`,
		);
	} catch (error) {
		console.error(serverLog);
		throw error;
	} finally {
		await browser?.close();
		await stopChild(server);
		await rm(root, { recursive: true, force: true });
	}
}
await main();
