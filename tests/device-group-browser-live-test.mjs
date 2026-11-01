/** Real server/SDK/Hub/Chrome E2E. HTTP model is a deterministic model double, not a real LLM.
 * Run: node tests/device-group-browser-live-test.mjs
 * PI_WEB_SMOKE_PREBUILT=1 reuses a previously built dist.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts/group-live-browser");
await mkdir(artifacts, { recursive: true });
assert.ok(CHROME_PATH, "Real Chrome required; set PI_WEB_CHROME");
ensureBuild(root, "device-group-browser-live");
const { startDeviceHub } = await import("../dist/server/device-center/main.js");
let hubCookie = "";
const temp = await mkdtemp(join(tmpdir(), "pi-group-browser-"));
const data = join(temp, "data"),
	agent = join(temp, "agent"),
	workspace = join(temp, "workspace");
for (const path of [data, agent, workspace]) await mkdir(path, { recursive: true });
const report = {
	model: "Deterministic HTTP OpenAI SSE model double; real pi SDK executor",
	checks: [],
	requests: [],
	errors: [],
};
let hub,
	fixture,
	child,
	browser,
	page,
	serverLog = "",
	releaseProgress;
let scenario = "GROUP_BROWSER_STREAM";
let getDetail;
const progressGate = new Promise((resolve) => {
	releaseProgress = resolve;
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 60000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const value = await fn();
		if (value) return value;
		await sleep(150);
	}
	throw new Error(`Timeout: ${label}`);
}
async function port() {
	const s = createServer();
	await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
	const p = s.address().port;
	await new Promise((resolve) => s.close(resolve));
	return p >= 8900 ? p : port();
}
async function json(url, body, token) {
	const response = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			origin: new URL(url).origin,
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(token && hubCookie ? { cookie: hubCookie } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (url.endsWith("/api/auth/register")) hubCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
	const result = await response.json();
	assert.ok(response.ok, `${response.status} ${url}: ${JSON.stringify(result)}`);
	return result;
}
function chunk(response, delta, finish = null) {
	response.write(
		`data: ${JSON.stringify({ id: "group-browser", object: "chat.completion.chunk", created: 1, model: "group-browser", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
	);
}
function end(response, delta, reason = "stop") {
	chunk(response, delta);
	chunk(response, {}, reason);
	response.end("data: [DONE]\n\n");
}
function tool(response, name, args) {
	end(
		response,
		{
			tool_calls: [
				{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
			],
		},
		"tool_calls",
	);
}
async function shot(name) {
	await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
try {
	fixture = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		if (!request.url?.includes("chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		try {
			const body = JSON.parse(raw),
				messages = body.messages ?? [];
			const user = [...messages].reverse().find((m) => m.role === "user");
			const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
			const last = messages.at(-1),
				available = (body.tools ?? []).map((t) => t.function?.name);
			report.requests.push({
				text,
				lastRole: last?.role,
				available,
				toolResult: last?.role === "tool" ? last.content : undefined,
			});
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			chunk(response, { role: "assistant", content: "" });
			if (last?.role === "tool") {
				end(response, { content: `GROUP_BROWSER_DONE ${last.content}` });
			} else if (scenario === "GROUP_BROWSER_QUESTION") {
				assert.ok(available.includes("ask_user_question"), "SDK must expose native question tool");
				tool(response, "ask_user_question", {
					questions: [
						{
							id: "browser_choice",
							header: "Browser live question",
							question: "GROUP_BROWSER_NATIVE_QUESTION: choose the browser answer",
							options: [
								{ label: "Browser answer", description: "Confirm through real UI", recommended: true },
								{ label: "Other answer" },
							],
						},
					],
				});
			} else if (scenario === "GROUP_BROWSER_APPROVAL") {
				tool(response, "write", { path: "browser-approved.txt", content: "GROUP_BROWSER_APPROVED_WRITE" });
			} else {
				chunk(response, { content: "GROUP_BROWSER_PROGRESS_VISIBLE " });
				await progressGate;
				end(response, { content: "GROUP_BROWSER_STREAM_FINISHED" });
			}
		} catch (error) {
			report.errors.push(String(error));
			response.end();
		}
	});
	await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
	await writeFile(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				"group-browser": {
					baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`,
					api: "openai-completions",
					apiKey: "deterministic-fixture",
					models: [
						{
							id: "group-browser",
							name: "Deterministic browser model double",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "group-browser", defaultModel: "group-browser", packages: [] }),
	);
	await writeFile(
		join(data, "client-state.json"),
		JSON.stringify({
			version: 1,
			settings: {
				model: { provider: "group-browser", modelId: "group-browser" },
				toolApprovalEnabled: true,
				toolLazyLoading: false,
				terminalBash: false,
				disabledTools: [],
			},
		}),
	);
	await writeFile(
		join(data, "approval-rules.json"),
		JSON.stringify([
			{
				id: "custom.group-browser",
				enabled: true,
				tools: ["write"],
				field: "path",
				match: "contains",
				value: "browser-approved.txt",
				action: "ask",
				label: "Browser one-time approval",
				labelEn: "Browser one-time approval",
			},
		]),
	);
	const hubPort = await port();
	const hubBase = `http://127.0.0.1:${hubPort}`;
	hub = await startDeviceHub({
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_PORT: String(hubPort),
		PI_DEVICE_HUB_PUBLIC_URL: hubBase,
		PI_DEVICE_HUB_DATA_DIR: join(temp, "hub"),
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
	});
	await json(`${hubBase}/api/auth/register`, { username: "browser-live-owner", password: "browser-live-password-123" });
	const servicePort = await port(),
		base = `http://127.0.0.1:${servicePort}`;
	report.ports = { service: servicePort, hub: hubPort, model: fixture.address().port };
	child = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(root, "dist/server/resolve-global-sdk.js")).href,
			join(root, "dist/server/index.js"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_WEB_PORT: String(servicePort),
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_CWD: workspace,
				PI_WEB_DATA_DIR: data,
				PI_CODING_AGENT_DIR: agent,
				PI_WEB_SDK: "bundled",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_PLUGIN_CATALOG_INSTALL: "0",
				PI_WEB_TOKEN: "",
				PI_WEB_HUB_ADMIN_TOKEN: "browser-admin",
				PI_WEB_TOOL_LAZY_LOADING: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout.on("data", (v) => {
		serverLog += v;
	});
	child.stderr.on("data", (v) => {
		serverLog += v;
	});
	await waitFor(async () => {
		if (child.exitCode !== null) throw new Error(serverLog);
		try {
			return (await fetch(`${base}/api/health`)).ok;
		} catch {
			return false;
		}
	}, "server health");
	const paired = await json(`${base}/api/device-center/pair`, { hubUrl: hubBase, name: "Browser live device" });
	await json(`${hubBase}/api/pair/approve`, { code: paired.code }, "account");
	await json(`${base}/api/device-center/poll`, {});
	await json(`${base}/api/device-center/execution`, { allowExecution: true });
	const { bot } = await json(`${base}/api/device-center/local-bots`, {
		name: "Browser live Bot",
		description: "Real SDK browser E2E",
		cwd: workspace,
		systemPrompt: "Follow the task using the requested native tools.",
		enabled: true,
		model: { provider: "group-browser", modelId: "group-browser" },
		tools: ["ask_user_question", "write"],
		skills: [],
		mcpServers: [],
	});
	await waitFor(
		async () => (await json(`${hubBase}/api/bots`, undefined, "browser-account")).bots.some((b) => b.id === bot.id),
		"Bot registration",
	);
	const { room } = await json(
		`${hubBase}/api/rooms`,
		{ name: "Browser live group", botIds: [bot.id], primaryBotId: bot.id },
		"browser-account",
	);
	const detail = () => json(`${hubBase}/api/rooms/${room.id}`, undefined, "browser-account");
	getDetail = detail;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
	page.on("pageerror", (e) => report.errors.push(String(e)));
	await page.goto(base);
	await page.locator(".dg-side-row", { hasText: "Browser live group" }).waitFor({ timeout: 30000 });
	await page.locator(".dg-side-row", { hasText: "Browser live group" }).click();
	async function send(text) {
		scenario = text;
		const input = page.locator("textarea:visible").last();
		await input.fill(text);
		await input.press("Enter");
	}
	await send("GROUP_BROWSER_STREAM");
	await page.getByText("GROUP_BROWSER_PROGRESS_VISIBLE", { exact: false }).last().waitFor({ timeout: 60000 });
	const streaming = await detail();
	assert.ok(
		streaming.tasks.some((t) => !["completed", "failed", "cancelled"].includes(t.status)),
		"Progress must be visible before terminal task status",
	);
	await shot("01-progress-before-completion");
	report.checks.push({
		name: "Real SDK streamed progress visible before completion",
		status: "passed",
		tasks: streaming.tasks.map((t) => ({ id: t.id, status: t.status })),
	});
	releaseProgress();
	await waitFor(async () => (await detail()).tasks.some((t) => t.status === "completed"), "stream completion");
	await send("GROUP_BROWSER_QUESTION");
	const card = page.locator("section.gd-card").filter({ hasText: "GROUP_BROWSER_NATIVE_QUESTION" });
	await card.waitFor({ timeout: 60000 });
	await shot("02-native-question-pending");
	await card.getByRole("radio", { name: /Browser answer/ }).check();
	await card.getByRole("button", { name: /提交|Submit/ }).click();
	await card.waitFor({ state: "detached", timeout: 30000 });
	const questionTask = await waitFor(async () => {
		const task = (await detail()).tasks.find((t) => t.text === "GROUP_BROWSER_QUESTION");
		return task && ["completed", "failed", "cancelled", "rejected"].includes(task.status) && task;
	}, "question terminal status");
	const questionPassed =
		questionTask.status === "completed" &&
		report.requests.some((r) => r.toolResult && JSON.stringify(r.toolResult).includes("Browser answer"));
	await shot("03-question-answered-terminal");
	report.checks.push({
		name: "Native ask_user_question answered in browser and SDK completed",
		status: questionPassed ? "passed" : "failed",
		task: questionTask,
	});
	await send("GROUP_BROWSER_APPROVAL");
	const approval = page
		.locator("section.gd-card")
		.filter({ hasText: /工具审批|Tool approval/ })
		.filter({ hasText: "write" });
	await approval.waitFor({ timeout: 60000 });
	await assert.rejects(readFile(join(workspace, "browser-approved.txt")), { code: "ENOENT" });
	await shot("04-one-time-approval-pending");
	await approval.getByRole("button", { name: /批准本次|Approve once/ }).click();
	await approval.waitFor({ state: "detached", timeout: 30000 });
	await waitFor(
		async () => (await detail()).tasks.some((t) => t.text === "GROUP_BROWSER_APPROVAL" && t.status === "completed"),
		"approved task completion",
	);
	assert.equal(await readFile(join(workspace, "browser-approved.txt"), "utf8"), "GROUP_BROWSER_APPROVED_WRITE");
	await shot("05-approved-completed");
	report.checks.push({ name: "One-time native tool approval gates actual SDK write", status: "passed" });
	report.final = await detail();
	report.status = report.checks.every((check) => check.status === "passed") ? "passed" : "failed";
	if (report.status === "failed") process.exitCode = 1;
} catch (error) {
	report.status = "failed";
	report.failure = error.stack ?? String(error);
	if (getDetail) report.final = await getDetail().catch((e) => ({ error: String(e) }));
	process.exitCode = 1;
	if (page) {
		await shot("failure").catch(() => {});
		await writeFile(
			join(artifacts, "failure-page.txt"),
			await page
				.locator("body")
				.innerText()
				.catch(() => ""),
		);
	}
	console.error(error);
} finally {
	releaseProgress();
	await browser?.close();
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
		}
	}
	await hub?.close();
	fixture?.closeAllConnections();
	if (fixture) await new Promise((r) => fixture.close(r));
	await writeFile(join(artifacts, "server.log"), serverLog);
	await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
	await rm(temp, { recursive: true, force: true });
	console.log(JSON.stringify({ status: report.status, checks: report.checks, artifacts }, null, 2));
}
