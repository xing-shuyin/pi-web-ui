/** Real production server + Hub + WebSocket + Chrome, zero model tokens. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(CHROME_PATH, "Chrome required for group ecosystem UI regression");
ensureBuild(root, "group-ecosystem-live");
const temp = await mkdtemp(join(tmpdir(), "group-ecosystem-live-"));
const dataDir = join(temp, "data"),
	cwd = join(temp, "workspace");
const artifacts = join(root, "artifacts/group-ecosystem");
await Promise.all([mkdir(dataDir), mkdir(cwd), mkdir(artifacts, { recursive: true })]);
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
assert.ok(port >= 8900);
const base = `http://127.0.0.1:${port}`;
const child = spawn(
	process.execPath,
	["dist/server/index.js", "--port", String(port), "--data-dir", dataDir, "--cwd", cwd],
	{
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		env: {
			...process.env,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: cwd,
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_PRESET_CATALOG_URL: "off",
			PI_WEB_SDK: "bundled",
		},
	},
);
let output = "",
	browser,
	ws;
child.stdout.on("data", (chunk) => {
	output += String(chunk);
});
child.stderr.on("data", (chunk) => {
	output += String(chunk);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await sleep(100);
	}
	throw new Error(`Timeout: ${label}`);
}
async function json(path, body) {
	const response = await fetch(`${base}/api/device-center/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Origin: base, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const result = await response.json();
	assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
	return result;
}
try {
	await until(async () => {
		try {
			return (await fetch(`${base}/api/health`)).ok;
		} catch {
			return false;
		}
	}, "server health");
	await json("chat-status");
	const { bot } = await json("local-bots", {
		name: "Ecosystem worker",
		description: "preserved",
		systemPrompt: "before",
		cwd,
		tools: ["read"],
		skills: [],
		mcpServers: [],
		enabled: true,
	});
	const { room } = await json("rooms", { name: "Ecosystem live group", botIds: [bot.id] });
	ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
	const messages = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "group-ecosystem-live" }));
	const graph = {
		id: "group_live_graph",
		name: "Group live graph",
		nodes: [
			{
				id: "input",
				title: "local input",
				role: "trigger",
				x: 0,
				y: 0,
				width: 240,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				status: "idle",
				config: { payload: "GROUP_ECOSYSTEM_LIVE" },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		status: "idle",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	ws.send(JSON.stringify({ type: "canvas_save", graph, baseRev: 0, requestId: "save-live" }));
	await until(
		() => messages.some((msg) => msg.type === "canvas_graph_state" && msg.requestId === "save-live"),
		"production canvas save ACK",
	);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(base);
	await page.locator(".dg-side-row", { hasText: "Ecosystem live group" }).waitFor({ timeout: 30000 });
	await page.locator(".dg-side-row", { hasText: "Ecosystem live group" }).click();
	const canvas = page
		.locator(".group-ecosystem-panel")
		.filter({ has: page.locator("summary", { hasText: /群画布|Group canvas/ }) });
	await canvas.locator("summary").click();
	await canvas.locator("select option[value='group_live_graph']").waitFor({ state: "attached" });
	await canvas.locator("select").selectOption(graph.id);
	await canvas.locator("input").fill(cwd);
	await canvas.getByRole("button", { name: /保存群引用|Save group reference/ }).click();
	await until(
		async () => (await json(`rooms/${room.id}`)).room.canvasBinding?.graphId === graph.id,
		"Hub group canvas binding",
	);
	assert.equal(
		messages.some((msg) => msg.type === "canvas_node_event" && msg.graphId === graph.id),
		false,
		"binding must not execute",
	);
	await canvas.getByRole("button", { name: /启动绑定画布|Run bound canvas/ }).click();
	await until(
		() => messages.some((msg) => msg.type === "canvas_node_event" && msg.graphId === graph.id && msg.event === "done"),
		"production UI -> WS -> CanvasOrchestrator done",
	);
	const preset = page
		.locator(".group-ecosystem-panel")
		.filter({ has: page.locator("summary", { hasText: /Bot 配置与预设|Bot configuration and presets/ }) });
	await preset.locator("summary").click();
	await preset.locator("p", { hasText: "Ecosystem worker · v1" }).waitFor();
	await preset.locator("textarea").fill(JSON.stringify({ systemPrompt: "saved through real group UI" }));
	await preset.getByRole("button", { name: /保存为新 revision|Save new revision/ }).click();
	await until(async () => (await json(`local-bots/${bot.id}`)).bot.revision === 2, "Bot new revision persisted");
	const saved = (await json(`local-bots/${bot.id}`)).bot;
	assert.deepEqual(saved.tools, ["read"]);
	assert.equal(saved.cwd, cwd);
	assert.equal(saved.description, "preserved");
	assert.equal(saved.systemPrompt, "saved through real group UI");
	await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
	assert.deepEqual(errors, []);
	await writeFile(
		join(artifacts, "result.json"),
		JSON.stringify(
			{
				result: "PASS",
				verifiedAt: new Date().toISOString(),
				productionServerSha256: createHash("sha256")
					.update(await readFile(join(root, "dist/server/index.js")))
					.digest("hex"),
				transport: "production index + HTTP + private Hub + WS + real Chrome; zero model tokens",
				checks: [
					"group reference persisted in Hub",
					"reference does not execute",
					"explicit UI launch reaches CanvasOrchestrator",
					"real local config GET",
					"UI saves new revision and preserves omitted grants/cwd",
					"390px no horizontal overflow",
					"no browser page errors",
				],
			},
			null,
			2,
		),
	);
	console.log(
		"PASS group ecosystem: real HTTP/Hub/production WS/Chrome canvas run and Bot preset new revision; zero model tokens",
	);
} catch (error) {
	await writeFile(join(artifacts, "failure.log"), `${error.stack}\n${output}`);
	throw error;
} finally {
	await browser?.close();
	ws?.terminate();
	child.kill();
	await Promise.race([
		new Promise((resolve) => {
			if (child.exitCode !== null) resolve();
			else child.once("exit", resolve);
		}),
		sleep(3000),
	]);
	await rm(temp, { recursive: true, force: true });
}
