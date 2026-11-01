/** Real isolated server + Hub + pi SDK + Chrome; only the HTTP model is deterministic.
 * Parent builds dist first. This test never builds or mocks an executor.
 * Run: node tests/device-group-expansion-live-test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
await access(join(root, "dist/server/index.js"));
assert.ok(CHROME_PATH, "Real Chrome required; set PI_WEB_CHROME");
const { startDeviceHub } = await import("../dist/server/device-center/main.js");
const artifacts = join(root, "artifacts/group-expansion", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(artifacts, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "pi-group-expansion-"));
const data = join(temp, "data"),
	agent = join(temp, "agent"),
	workspace = join(temp, "workspace"),
	hubData = join(temp, "hub");
for (const dir of [data, agent, workspace]) await mkdir(dir, { recursive: true });
const hash = (text) => createHash("sha256").update(text).digest("hex");
const originalReport =
	"EXPANSION_REPORT_BEGIN\n" +
	"完整报告跨分片🌍 read/write evidence 0123456789\n".repeat(2600) +
	"EXPANSION_REPORT_END";
assert.ok(Buffer.byteLength(originalReport) > 64 * 1024);
const report = {
	model: "Deterministic OpenAI HTTP SSE; real SDK executor",
	checks: [],
	http: [],
	requests: [],
	frames: [],
	errors: [],
	reportBytes: Buffer.byteLength(originalReport),
	reportHash: hash(originalReport),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let hub,
	fixture,
	proxy,
	child,
	browser,
	page,
	base,
	hubBase,
	room,
	bot,
	hubCookie = "",
	serverLog = "",
	scenario = "",
	stage = 0,
	releaseModel;
report.dist = await Promise.all(
	[
		"server/device-center/executor.js",
		"server/device-center/connector.js",
		"server/device-center/runtime.js",
		"server/device-center/relay.js",
		"server/device-center/hub.js",
		"server/agent-service.js",
	].map(async (name) => {
		const path = join(root, "dist", name);
		return { name, modifiedAt: (await stat(path)).mtime.toISOString(), sha256: hash(await readFile(path)) };
	}),
);
report.webBuild = {
	modifiedAt: (await stat(join(root, "web/dist/index.html"))).mtime.toISOString(),
	sha256: hash(await readFile(join(root, "web/dist/index.html"))),
};
let blockNetwork = false;
let refuseReportUploads = false;
const sockets = new Set();
const wsServer = new WebSocketServer({ noServer: true });
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
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const value = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return value >= 8900 ? value : port();
}
async function api(url, body, { cookie = hubCookie, status } = {}) {
	const response = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			origin: new URL(url).origin,
			...(cookie ? { cookie } : {}),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (url.endsWith("/api/auth/register")) hubCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
	const value = await response.json();
	if (status === undefined) assert.ok(response.ok, `${response.status} ${url}: ${JSON.stringify(value)}`);
	else assert.equal(response.status, status, `${url}: ${JSON.stringify(value)}`);
	return value;
}
function delta(response, value, finish = null) {
	response.write(
		`data: ${JSON.stringify({ id: `expansion-${scenario}-${stage}`, object: "chat.completion.chunk", created: 1, model: "expansion", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
	);
}
function end(response, text) {
	delta(response, { content: text });
	delta(response, {}, "stop");
	response.end("data: [DONE]\n\n");
}
function tool(response, name, args) {
	delta(response, {
		tool_calls: [
			{
				index: 0,
				id: `call_${scenario}_${stage}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			},
		],
	});
	delta(response, {}, "tool_calls");
	response.end("data: [DONE]\n\n");
}
async function taskByText(text) {
	return (await api(`${hubBase}/api/rooms/${room.id}`)).tasks.find((task) => task.text === text);
}
async function completed(text) {
	return waitFor(async () => {
		const task = await taskByText(text);
		if (task && ["failed", "cancelled", "rejected"].includes(task.status))
			throw new Error(`${text}: ${JSON.stringify(task)}`);
		return task?.status === "completed" && task;
	}, `${text} completion`);
}
async function send(text, planOnly = false) {
	scenario = text;
	stage = 0;
	await api(`${hubBase}/api/rooms/${room.id}/messages`, {
		text,
		targetBotIds: [bot.id],
		planOnly,
		idempotencyKey: text,
	});
	return waitFor(() => taskByText(text), `${text} created`);
}
async function journal(task) {
	let cursor,
		items = [];
	for (let n = 0; n < 100; n++) {
		const result = await api(
			`${hubBase}/api/rooms/${room.id}/tasks/${task.id}/journal?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		items.push(...result.items);
		if (!result.hasMore) return items;
		assert.ok(result.nextCursor && result.nextCursor !== cursor, "journal cursor advances");
		cursor = result.nextCursor;
	}
	throw new Error("Journal pagination did not terminate");
}
async function check(name, fn) {
	try {
		const evidence = await fn();
		report.checks.push({ name, status: "passed", ...evidence });
	} catch (error) {
		report.checks.push({ name, status: "failed", error: error.stack ?? String(error) });
		console.error(name, error);
		if (page)
			await page
				.screenshot({ path: join(artifacts, `failure-${report.checks.length}.png`), fullPage: true })
				.catch(() => {});
	} finally {
		blockNetwork = false;
		releaseModel?.();
		if (page)
			await page
				.locator(".gtd-close")
				.click({ timeout: 500 })
				.catch(() => {});
	}
}
function detach() {
	blockNetwork = true;
	for (const socket of sockets) socket.terminate();
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
				last = body.messages?.at(-1);
			report.requests.push({
				scenario,
				stage,
				lastRole: last?.role,
				toolResult: last?.role === "tool" ? last.content : undefined,
				available: (body.tools ?? []).map((item) => item.function.name),
			});
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			delta(response, { role: "assistant", content: "" });
			const turn = stage++;
			if (scenario === "EXPANSION_REPORT" || scenario === "EXPANSION_REPORT_RETRY") end(response, originalReport);
			else if (scenario === "EXPANSION_JOURNAL") {
				if (turn === 0) tool(response, "read", { path: "seed.txt" });
				else if (turn === 1)
					tool(response, "write", { path: "journal-written.txt", content: "REAL_SDK_JOURNAL_WRITE" });
				else end(response, "EXPANSION_JOURNAL_DONE");
			} else if (scenario === "EXPANSION_PLAN") {
				if (turn === 0) tool(response, "write", { path: "plan-blocked.txt", content: "MUST_NEVER_EXIST" });
				else if (turn === 1)
					tool(response, "bash", { command: "printf MUST_NEVER_EXIST > plan-shell-blocked.txt", timeout: 5 });
				else if (turn === 2)
					tool(response, "plan_update", {
						steps: [{ id: "implement", title: "Write approved artifact once", status: "pending" }],
					});
				else end(response, "EXPANSION_PLAN_READY");
			} else if (scenario === "EXPANSION_APPROVED") {
				if (turn === 0) tool(response, "write", { path: "plan-approved.txt", content: "APPROVED_REAL_WRITE_ONCE" });
				else end(response, "EXPANSION_APPROVED_DONE");
			} else if (scenario === "EXPANSION_RECONNECT") {
				delta(response, { content: "EXPANSION_RECONNECT_STARTED " });
				await new Promise((resolve) => {
					releaseModel = resolve;
				});
				end(response, "EXPANSION_RECONNECT_DONE");
			} else throw new Error(`Unknown scenario ${scenario}`);
		} catch (error) {
			report.errors.push(String(error));
			response.end();
		}
	});
	const fixturePort = await port();
	await new Promise((resolve) => fixture.listen(fixturePort, "127.0.0.1", resolve));
	const modelPort = fixture.address().port;
	await writeFile(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				expansion: {
					baseUrl: `http://127.0.0.1:${modelPort}/v1`,
					api: "openai-completions",
					apiKey: "deterministic-fixture",
					models: [
						{
							id: "expansion",
							name: "Deterministic expansion fixture",
							reasoning: false,
							input: ["text"],
							contextWindow: 256000,
							maxTokens: 64000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "expansion", defaultModel: "expansion", packages: [] }),
	);
	await writeFile(
		join(data, "client-state.json"),
		JSON.stringify({
			version: 1,
			settings: {
				model: { provider: "expansion", modelId: "expansion" },
				toolApprovalEnabled: false,
				toolLazyLoading: false,
				terminalBash: false,
				disabledTools: [],
			},
		}),
	);
	await writeFile(join(workspace, "seed.txt"), "REAL_SDK_READ_SEED");
	const hubPort = await port(),
		servicePort = await port(),
		proxyPort = await port();
	hubBase = `http://127.0.0.1:${hubPort}`;
	base = `http://127.0.0.1:${servicePort}`;
	hub = await startDeviceHub({
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_PORT: String(hubPort),
		PI_DEVICE_HUB_PUBLIC_URL: hubBase,
		PI_DEVICE_HUB_DATA_DIR: hubData,
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
	});
	proxy = createServer((request, response) => {
		if (refuseReportUploads && request.url?.endsWith("/report") && request.method === "POST") {
			report.http.push({ method: request.method, url: request.url, status: 503, injected: true });
			request.resume();
			response
				.writeHead(503, { "content-type": "application/json" })
				.end(JSON.stringify({ error: "Deterministic report transport outage" }));
			return;
		}
		const upstream = httpRequest(
			`${hubBase}${request.url}`,
			{
				method: request.method,
				headers: {
					...request.headers,
					host: new URL(hubBase).host,
					...(request.headers.origin ? { origin: hubBase } : {}),
				},
			},
			(result) => {
				let errorBody = "";
				result.on("data", (part) => {
					if (result.statusCode >= 400) errorBody += part;
				});
				result.on("end", () =>
					report.http.push({
						method: request.method,
						url: request.url,
						status: result.statusCode,
						...(errorBody ? { error: errorBody.slice(0, 2000) } : {}),
					}),
				);
				response.writeHead(result.statusCode, result.headers);
				result.pipe(response);
			},
		);
		upstream.on("error", () => {
			response.writeHead(502).end();
		});
		request.pipe(upstream);
	});
	proxy.on("upgrade", (request, socket, head) => {
		if (blockNetwork) {
			socket.destroy();
			return;
		}
		const upstream = new WebSocket(`${hubBase.replace("http", "ws")}${request.url}`, {
			headers: {
				...request.headers,
				host: new URL(hubBase).host,
				...(request.headers.origin ? { origin: hubBase } : {}),
			},
		});
		upstream.on("error", () => socket.destroy());
		upstream.once("open", () =>
			wsServer.handleUpgrade(request, socket, head, (downstream) => {
				sockets.add(upstream);
				sockets.add(downstream);
				for (const [from, to, direction] of [
					[downstream, upstream, "device-to-hub"],
					[upstream, downstream, "hub-to-device"],
				]) {
					from.on("message", (bytes, binary) => {
						try {
							const frame = JSON.parse(bytes.toString());
							report.frames.push({
								direction,
								type: frame.type,
								taskId: frame.taskId ?? frame.claim?.taskId,
								status: frame.status,
								phase: frame.phase,
								toolName: frame.toolName,
								callId: frame.callId,
								...(frame.type === "task_claim_result" ? { claimResult: frame } : {}),
								at: Date.now(),
							});
						} catch {}
						if (to.readyState === WebSocket.OPEN) to.send(bytes, { binary });
					});
					from.on("close", () => {
						sockets.delete(from);
						to.terminate();
					});
					from.on("error", () => to.terminate());
				}
			}),
		);
	});
	await new Promise((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
	report.ports = { service: servicePort, hub: hubPort, proxy: proxyPort, model: modelPort };
	await api(`${hubBase}/api/auth/register`, { username: "expansion-owner", password: "isolated-expansion-fixture" });
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
				PI_WEB_HUB_ADMIN_TOKEN: "expansion-admin",
				PI_WEB_TOOL_LAZY_LOADING: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout.on("data", (value) => {
		serverLog += value;
	});
	child.stderr.on("data", (value) => {
		serverLog += value;
	});
	await waitFor(async () => {
		if (child.exitCode !== null) throw new Error(serverLog);
		try {
			return (await fetch(`${base}/api/health`)).ok;
		} catch {
			return false;
		}
	}, "server health");
	const paired = await api(
		`${base}/api/device-center/pair`,
		{ hubUrl: `http://127.0.0.1:${proxyPort}`, name: "Expansion live device" },
		{ cookie: "" },
	);
	await api(`${hubBase}/api/pair/approve`, { code: paired.code });
	await api(`${base}/api/device-center/poll`, {}, { cookie: "" });
	await api(`${base}/api/device-center/execution`, { allowExecution: true }, { cookie: "" });
	({ bot } = await api(
		`${base}/api/device-center/local-bots`,
		{
			name: "Expansion live Bot",
			description: "Real SDK expansion E2E",
			cwd: workspace,
			systemPrompt: "Use native tools as requested.",
			enabled: true,
			model: { provider: "expansion", modelId: "expansion" },
			tools: ["read", "write", "bash", "plan_update"],
			skills: [],
			mcpServers: [],
		},
		{ cookie: "" },
	));
	await waitFor(
		async () => (await api(`${hubBase}/api/bots`)).bots.some((item) => item.id === bot.id),
		"Bot registration",
	);
	({ room } = await api(`${hubBase}/api/rooms`, {
		name: "Expansion live group",
		botIds: [bot.id],
		primaryBotId: bot.id,
	}));
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
	page.on("pageerror", (error) => report.errors.push(String(error)));
	await page.goto(base);
	await page.locator(".dg-side-row", { hasText: "Expansion live group" }).waitFor({ timeout: 30000 });
	await page.locator(".dg-side-row", { hasText: "Expansion live group" }).click();
	await check("Full >64KiB UTF-8 report API and Chrome SHA256", async () => {
		await send("EXPANSION_REPORT");
		const task = await completed("EXPANSION_REPORT");
		let text = "",
			count = 0,
			meta;
		for (; count < 100; count++) {
			const result = await api(
				`${hubBase}/api/rooms/${room.id}/tasks/${task.id}/report?offset=${Buffer.byteLength(text)}&limit=32768`,
			);
			meta = result.meta;
			assert.equal(typeof result.text, "string");
			text += result.text;
			if (!result.hasMore) break;
			assert.equal(result.nextOffset, Buffer.byteLength(text), "report byte offset advances exactly");
		}
		assert.ok(meta.complete);
		assert.ok(count > 0, "multiple report chunks");
		assert.equal(meta.sha256, hash(originalReport));
		assert.equal(hash(text), hash(originalReport));
		assert.equal(text, originalReport);
		await page
			.getByRole("button", { name: /^(详情|Details)$/ })
			.last()
			.click();
		await page.getByRole("button", { name: /任务完整报告|Full Report Log/ }).click();
		await page.locator(".gtd-report-text").filter({ hasText: "EXPANSION_REPORT_BEGIN" }).waitFor({ timeout: 30000 });
		for (let n = 0; n < 100; n++) {
			const more = page.getByRole("button", { name: /加载更多报告内容|Load more report/ });
			if (!(await more.count())) break;
			await more.click();
			await page.waitForTimeout(150);
		}
		assert.equal(hash(await page.locator(".gtd-report-text").textContent()), hash(originalReport));
		await page.screenshot({ path: join(artifacts, "01-full-report.png"), fullPage: true });
		await page.locator(".gtd-close").click();
		return { taskId: task.id, chunks: count + 1, sha256: meta.sha256, screenshot: "01-full-report.png" };
	});
	await check("Real read/write start/end persisted in journal", async () => {
		await send("EXPANSION_JOURNAL");
		const task = await completed("EXPANSION_JOURNAL");
		assert.equal(await readFile(join(workspace, "journal-written.txt"), "utf8"), "REAL_SDK_JOURNAL_WRITE");
		const entries = await waitFor(async () => {
			const events = await journal(task);
			return events.some((event) => event.toolName === "write" && event.type === "tool_end") && events;
		}, "journal end persistence");
		report.journal = entries;
		for (const toolName of ["read", "write"]) {
			const starts = entries.filter((event) => event.toolName === toolName && event.type === "tool_start"),
				ends = entries.filter((event) => event.toolName === toolName && event.type === "tool_end");
			assert.equal(starts.length, 1);
			assert.equal(ends.length, 1);
			assert.ok(starts[0].toolCallId, "lifecycle retains stable tool call identity");
			assert.equal(starts[0].toolCallId, ends[0].toolCallId);
			assert.ok(starts[0].sequence < ends[0].sequence);
		}
		const dir = join(hubData, "task-journals", hash(task.id).slice(0, 32));
		const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
		const persisted = (await Promise.all(files.map((name) => readFile(join(dir, name), "utf8"))))
			.join("\n")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		for (const event of entries.filter((item) => ["tool_start", "tool_end"].includes(item.type)))
			assert.ok(persisted.some((item) => item.id === event.id));
		return {
			taskId: task.id,
			entries: entries.map(({ type, toolName, toolCallId }) => ({ type, toolName, toolCallId })),
			persistedSegments: files.length,
		};
	});
	await check("Plan guard -> real plan_update ready -> human approve -> one write", async () => {
		scenario = "EXPANSION_PLAN";
		stage = 0;
		await page.locator(".group-plan-toggle").click();
		const planRequest = page.waitForRequest(
			(request) => request.url().includes(`/rooms/${room.id}/messages`) && request.method() === "POST",
		);
		const input = page.locator("textarea:visible").last();
		await input.fill("EXPANSION_PLAN");
		await input.press("Enter");
		const planBody = (await planRequest).postDataJSON();
		report.planRequest = planBody;
		assert.equal(planBody.planOnly, true, "ChatInput carries planOnly through GroupConversation");
		await page.locator(".group-plan-toggle").click();
		const task = await completed("EXPANSION_PLAN");
		report.planTask = task;
		for (const name of ["plan-blocked.txt", "plan-shell-blocked.txt", "plan-approved.txt"])
			await assert.rejects(readFile(join(workspace, name)), { code: "ENOENT" });
		const results = report.requests
			.filter((item) => item.scenario === "EXPANSION_PLAN" && item.toolResult)
			.map((item) => JSON.stringify(item.toolResult));
		assert.ok(
			results.some(
				(text) => /plan|planning|计划/i.test(text) && /denied|blocked|reject|禁止|拒绝|not allowed/i.test(text),
			),
			`Real guard rejection missing: ${results.join("\n")}`,
		);
		assert.equal(task.plan?.state, "ready");
		assert.equal(task.plan.steps[0]?.title, "Write approved artifact once");
		scenario = "EXPANSION_APPROVED";
		stage = 0;
		const approvePath = `/tasks/${task.id}/approve-plan`;
		const approvedResponse = page.waitForResponse(
			(response) => response.url().includes(approvePath) && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: /^(开始实施|Start Execution)$/ }).click({ timeout: 30000 });
		const response = await approvedResponse;
		const approved = await response.json();
		report.approval = { status: response.status(), body: approved };
		assert.ok(response.ok(), `human approval through Chrome succeeds: ${JSON.stringify(approved)}`);
		await api(`${hubBase}/api/rooms/${room.id}/tasks/${task.id}/approve-plan`, {}, { status: 409 });
		const next = await waitFor(async () => {
			const detail = await api(`${hubBase}/api/rooms/${room.id}`);
			const item = detail.tasks.find((entry) => entry.id === approved.nextTaskId);
			if (item?.status === "failed") throw new Error(JSON.stringify(item));
			return item?.status === "completed" && item;
		}, "approved implementation");
		assert.equal(await readFile(join(workspace, "plan-approved.txt"), "utf8"), "APPROVED_REAL_WRITE_ONCE");
		const events = await journal(next);
		assert.equal(events.filter((item) => item.type === "tool_start" && item.toolName === "write").length, 1);
		assert.equal(events.filter((item) => item.type === "tool_end" && item.toolName === "write").length, 1);
		assert.equal(
			report.requests.filter((item) => item.scenario === "EXPANSION_APPROVED" && item.stage === 0).length,
			1,
		);
		await page.screenshot({ path: join(artifacts, "02-approved-plan.png"), fullPage: true });
		return {
			planTaskId: task.id,
			implementationTaskId: next.id,
			steps: task.plan.steps,
			screenshot: "02-approved-plan.png",
		};
	});
	await check("Real WS detach/reconnect claim and durable outbox replay without rerun", async () => {
		const task = await send("EXPANSION_RECONNECT");
		await waitFor(() => releaseModel, "model running");
		const before = report.frames.length;
		const active = JSON.parse(await readFile(join(data, "task-active-leases.json"), "utf8"));
		report.leasesBeforeDetach = active;
		assert.ok(
			active.some((entry) => entry.taskId === task.id),
			JSON.stringify(active),
		);
		detach();
		await waitFor(() => sockets.size === 0, "proxy sockets fully detached");
		blockNetwork = false;
		await waitFor(
			() => report.frames.slice(before).some((frame) => frame.type === "task_claim" && frame.taskId === task.id),
			"reconnect task claim",
		);
		const claimFrame = await waitFor(
			() => report.frames.slice(before).find((frame) => frame.type === "task_claim_result" && frame.taskId === task.id),
			"claim result",
		);
		assert.equal(claimFrame.claimResult.accepted, true, JSON.stringify(claimFrame.claimResult));
		detach();
		releaseModel();
		const pending = await waitFor(async () => {
			try {
				const items = JSON.parse(await readFile(join(data, "task-recovery-outbox.json"), "utf8"));
				return items.find((item) => item.taskId === task.id && item.status === "completed");
			} catch {
				return false;
			}
		}, "offline durable completed outbox");
		assert.ok(pending.fingerprint);
		assert.ok(pending.report.includes("EXPANSION_RECONNECT_DONE"));
		assert.notEqual(
			(await taskByText("EXPANSION_RECONNECT")).status,
			"completed",
			"Hub has not yet received offline completion",
		);
		blockNetwork = false;
		const done = await completed("EXPANSION_RECONNECT");
		await waitFor(
			async () =>
				!JSON.parse(await readFile(join(data, "task-recovery-outbox.json"), "utf8")).some(
					(item) => item.taskId === task.id,
				),
			"outbox ACK removal",
		);
		assert.equal(done.attemptId, task.attemptId);
		assert.ok(
			report.frames.some((frame) => frame.type === "task_result_ack" && frame.taskId === task.id),
			"replayed terminal result acknowledged by real Hub",
		);
		assert.equal(
			report.requests.filter((item) => item.scenario === "EXPANSION_RECONNECT").length,
			1,
			"exactly one real model execution",
		);
		assert.equal(
			(await api(`${hubBase}/api/rooms/${room.id}`)).tasks.filter((item) => item.text === "EXPANSION_RECONNECT").length,
			1,
		);
		return { taskId: task.id, attemptId: done.attemptId, outboxFingerprint: pending.fingerprint };
	});
	await check("Full report durable outbox retries HTTP 503 after completion", async () => {
		refuseReportUploads = true;
		try {
			await send("EXPANSION_REPORT_RETRY");
			const task = await completed("EXPANSION_REPORT_RETRY");
			const scopeRoot = join(data, "task-report-outboxes");
			const scope = (await readdir(scopeRoot))[0];
			const scopeDir = join(scopeRoot, scope);
			const outboxPath = join(scopeDir, "outbox.json");
			const entries = JSON.parse(await readFile(outboxPath, "utf8")).entries;
			const pending = entries.find((entry) => entry.id === task.id);
			assert.ok(pending?.uploadPending, "full report remains pending independently of completed task");
			assert.equal(pending.sha256, hash(originalReport));
			assert.equal(
				hash(await readFile(join(scopeDir, "task-reports", pending.reportRef, "full-report.txt"))),
				hash(originalReport),
			);
			assert.ok(report.http.some((request) => request.injected && request.url.includes(task.id)));
			refuseReportUploads = false;
			await waitFor(
				async () => (await api(`${hubBase}/api/rooms/${room.id}/tasks/${task.id}/report`)).meta.complete,
				"heartbeat report retry",
				45000,
			);
			let text = "";
			for (let n = 0; n < 100; n++) {
				const chunk = await api(
					`${hubBase}/api/rooms/${room.id}/tasks/${task.id}/report?offset=${Buffer.byteLength(text)}&limit=32768`,
				);
				text += chunk.text;
				if (!chunk.hasMore) break;
			}
			assert.equal(hash(text), hash(originalReport));
			await waitFor(
				async () =>
					!JSON.parse(await readFile(outboxPath, "utf8")).entries.find((entry) => entry.id === task.id)?.uploadPending,
				"full report receipt clears upload pending",
			);
			return { taskId: task.id, sha256: hash(text) };
		} finally {
			refuseReportUploads = false;
		}
	});
	report.status =
		report.checks.length === 5 && report.checks.every((item) => item.status === "passed") && report.errors.length === 0
			? "passed"
			: "failed";
} catch (error) {
	report.status = "failed";
	report.failure = error.stack ?? String(error);
	console.error(error);
} finally {
	releaseModel?.();
	blockNetwork = false;
	if (room) report.final = await api(`${hubBase}/api/rooms/${room.id}`).catch((error) => ({ error: String(error) }));
	for (const name of ["task-active-leases.json", "task-recovery-outbox.json", "task-report-outbox.json"])
		report[name] = await readFile(join(data, name), "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => null);
	await browser?.close();
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
		}
	}
	for (const socket of sockets) socket.terminate();
	wsServer.close();
	for (const server of [proxy, fixture])
		if (server) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	await hub?.close();
	await writeFile(join(artifacts, "server.log"), serverLog);
	await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
	await rm(temp, { recursive: true, force: true });
	if (report.status !== "passed") process.exitCode = 1;
	console.log(JSON.stringify({ status: report.status, checks: report.checks, artifacts }, null, 2));
}
