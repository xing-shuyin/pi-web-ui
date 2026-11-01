// Real Hub -> local device runtime -> executor -> built pi server -> SDK -> local HTTP model.
// Uses the shared build gate. Run: node --import tsx tests/device-bot-live-integration-test.mjs
// Regression: a second Bot hello used to reclaim the first disconnected Bot's
// ClientSession; its stale clientId snapshot aborted the task before SDK inference.
// PI_BOT_LIVE_READ_FIRST=1 proves the tool path independently of the sequential check.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDeviceHub } from "../server/device-center/main.ts";
import WebSocket from "ws";
import { ensureBuild } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
ensureBuild(root, "device-bot-live-integration");
const temp = await mkdtemp(join(tmpdir(), "pi-bot-live-"));
const project = join(temp, "project");
const coldProject = join(temp, "cold-project");
const agent = join(temp, "agent");
const data = join(temp, "data");
const requests = [];
let logs = "";
let child;
let hub;
let fixture;
let cookie;
let mode = "plain";
let lastRoom;
let control;
let coordinatorBotId;
let workerBotId;
let workerConversationId;
let coordinationFollowup = false;
const controlPackets = [];
const sentinel = "BOT_LIVE_READ_EVIDENCE_83f91";
const modelId = "bot-live-model";
const provider = "bot-live-fixture";

async function port() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const value = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return value >= 8900 ? value : port();
}
async function until(work, label, timeout = 45_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await work();
		if (value) return value;
		if (child && child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${logs}`);
		await delay(100);
	}
	throw new Error(`Timed out: ${label}; last room=${JSON.stringify(lastRoom)}; server=${logs}`);
}
async function api(origin, path, body, expected = 200, authenticated = true) {
	const response = await fetch(origin + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Origin: origin,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(authenticated && cookie ? { Cookie: cookie } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const raw = await response.text();
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${path}: HTTP ${response.status}: ${raw.slice(0, 400)}`);
	}
	assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
	return { value, response };
}
async function transcripts(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await transcripts(path)));
		else if (entry.name.endsWith(".jsonl")) found.push(await readFile(path, "utf8"));
	}
	return found;
}
function stream(response, delta, reason) {
	const chunk = (value, finish = null) => ({
		id: "chatcmpl-bot-live",
		object: "chat.completion.chunk",
		created: 1,
		model: modelId,
		choices: [{ index: 0, delta: value, finish_reason: finish }],
	});
	response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	for (const value of [chunk({ role: "assistant" }), chunk(delta), chunk({}, reason)]) {
		response.write(`data: ${JSON.stringify(value)}\n\n`);
	}
	response.end("data: [DONE]\n\n");
}
try {
	await Promise.all([mkdir(project), mkdir(coldProject), mkdir(agent), mkdir(data)]);
	await writeFile(join(project, "probe.txt"), sentinel);
	// A real disk Skill excluded by this Bot must not cause perpetual SDK reloads.
	const excludedSkill = join(agent, "skills", "bot-live-excluded");
	await mkdir(excludedSkill, { recursive: true });
	await writeFile(
		join(excludedSkill, "SKILL.md"),
		"---\nname: bot-live-excluded\ndescription: Excluded skill sentinel for Bot capability regression.\n---\nBOT_LIVE_EXCLUDED_SKILL_SECRET\n",
	);
	fixture = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw || "{}");
		requests.push({ url: request.url, authorization: request.headers.authorization, mode, body });
		if (mode === "api-error") {
			response.writeHead(401, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "BOT_LIVE_FIXTURE_AUTH_REJECTED", type: "invalid_api_key" } }));
			return;
		}
		const previousTool = body.messages?.findLast((message) => message.role === "tool");
		if (mode === "human-attention") {
			const user = body.messages?.findLast(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("Device task "),
			);
			const prompt =
				typeof user?.content === "string"
					? user.content
					: (user?.content ?? []).map((part) => part.text ?? "").join("\n");
			const taskData = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
			if (taskData.text === "HUMAN_OPTION_A" || body.messages?.at(-1)?.role === "tool") {
				stream(
					response,
					{ content: taskData.text === "HUMAN_OPTION_A" ? "HUMAN_ANSWER_RESUMED" : "HUMAN_WAITING_FOR_DECISION" },
					"stop",
				);
			} else {
				stream(
					response,
					{
						tool_calls: [
							{
								index: 0,
								id: "human-question",
								type: "function",
								function: {
									name: "device_collab",
									arguments: JSON.stringify({
										action: "conversation_attention",
										question: "Choose the rollout option: A or B?",
										attentionKind: "decision",
									}),
								},
							},
						],
					},
					"tool_calls",
				);
			}
			return;
		}
		if (mode === "coordination") {
			const user = body.messages?.findLast(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("Device task "),
			);
			const prompt =
				typeof user?.content === "string"
					? user.content
					: (user?.content ?? []).map((part) => part.text ?? "").join("\n");
			const worker = prompt?.includes(`"sourceBotId":"${workerBotId}"`);
			const result = prompt?.includes('"resultOfTaskId":');
			const last = body.messages?.at(-1);
			const guideLoaded = last?.role === "tool" && JSON.stringify(last.content).includes("execution_guide");
			const metricsLoaded = last?.role === "tool" && JSON.stringify(last.content).includes("context_metrics");
			if (worker || result || (last?.role === "tool" && !guideLoaded && !metricsLoaded)) {
				stream(
					response,
					{ content: worker ? "COORD_WORKER_VERIFIED" : result ? "COORD_RESULT_REVIEWED" : "COORD_DELEGATED" },
					"stop",
				);
			} else {
				const system = body.messages
					?.filter((message) => message.role === "system" || message.role === "developer")
					.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
					.join("\n");
				assert(system?.includes("configured primary Bot"), "primary coordination role reaches SDK system instructions");
				assert(!prompt?.includes("configured primary Bot"), "fixed policy is absent from task user messages");
				if (!guideLoaded && !metricsLoaded) {
					stream(
						response,
						{
							tool_calls: [
								{
									index: 0,
									id: "load-coordination-guide",
									type: "function",
									function: {
										name: "device_collab",
										arguments: JSON.stringify({ action: "execution_guide", topic: "coordination" }),
									},
								},
							],
						},
						"tool_calls",
					);
					return;
				}
				if (guideLoaded) {
					assert(
						JSON.stringify(last.content).includes("conversation_create"),
						"On-demand guide reaches model tool result",
					);
					stream(
						response,
						{
							tool_calls: [
								{
									index: 0,
									id: "inspect-context-metrics",
									type: "function",
									function: { name: "device_collab", arguments: JSON.stringify({ action: "context_metrics" }) },
								},
							],
						},
						"tool_calls",
					);
					return;
				}
				assert(JSON.stringify(last.content).includes("sourceBytes"), "Bound session context metrics reach model");
				assert(JSON.stringify(last.content).includes("processLocal"), "Metrics lifetime is explicit");
				const args = coordinationFollowup
					? {
							action: "conversation_send",
							conversationId: workerConversationId,
							message: "COORD_WORKER_FOLLOWUP",
							kind: "request",
							requestId: "coord-followup",
							idempotencyKey: "coord-followup",
						}
					: {
							action: "conversation_create",
							targetBotId: workerBotId,
							prompt: "COORD_WORKER_INITIAL",
							kind: "request",
							requestId: "coord-initial",
							idempotencyKey: "coord-initial",
						};
				stream(
					response,
					{
						tool_calls: [
							{
								index: 0,
								id: coordinationFollowup ? "coord-send" : "coord-create",
								type: "function",
								function: { name: "device_collab", arguments: JSON.stringify(args) },
							},
						],
					},
					"tool_calls",
				);
			}
			return;
		}
		if ((mode === "read" || mode === "denied-tool") && !previousTool) {
			stream(
				response,
				{
					tool_calls: [
						{
							index: 0,
							id: "call_bot_live_read",
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: "probe.txt" }) },
						},
					],
				},
				"tool_calls",
			);
		} else {
			stream(
				response,
				{
					content: previousTool ? `BOT_LIVE_TOOL_DONE ${JSON.stringify(previousTool.content)}` : "BOT_LIVE_PLAIN_DONE",
				},
				"stop",
			);
		}
	});
	const fixturePort = await port();
	await new Promise((resolve) => fixture.listen(fixturePort, "127.0.0.1", resolve));
	await writeFile(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: `http://127.0.0.1:${fixturePort}/v1`,
					api: "openai-completions",
					apiKey: "bot-live-known-test-key",
					models: [
						{
							id: modelId,
							name: "Isolated deterministic Bot fixture",
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
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: modelId }));
	const observer = join(temp, "observe-ws.mjs");
	await writeFile(
		observer,
		`import WebSocket from ${JSON.stringify(new URL("../node_modules/ws/wrapper.mjs", import.meta.url).href)};\nconst send = WebSocket.prototype.send;\nWebSocket.prototype.send = function(data, ...args) { try { const p = JSON.parse(String(data)); if (["hello", "switch_session", "transition_progress", "notice", "snapshot", "snapshot_delta", "error"].includes(p.type)) console.log("BOT_WIRE", JSON.stringify({ type:p.type, clientId:p.clientId ?? p.state?.clientId, conversationId:p.state?.conversationId, rev:p.state?.rev, sessionFile:p.state?.sessionFile, path:p.path, phase:p.phase, text:p.textEn ?? p.text, error:p.error ?? p.message })); } catch {} return send.call(this,data,...args); };`,
	);
	if (process.env.PI_BOT_LIVE_ERROR_STACKS === "1") {
		await writeFile(
			observer,
			(await readFile(observer, "utf8")) +
				`\nconst NativeError = globalThis.Error; NativeError.stackTraceLimit = 100; globalThis.Error = new Proxy(NativeError, { construct(target, args, newTarget) { const error = Reflect.construct(target, args, newTarget); if (String(args[0]).includes("Bot execution capability has been revoked")) process.stderr.write("BOT_REVOKED_STACK\\n" + error.stack + "\\n"); return error; } });\n`,
		);
	}
	const localPort = await port();
	const hubPort = await port();
	const localOrigin = `http://127.0.0.1:${localPort}`;
	const hubOrigin = `http://127.0.0.1:${hubPort}`;
	hub = await startDeviceHub({
		PI_DEVICE_HUB_PUBLIC_URL: hubOrigin,
		PI_DEVICE_HUB_PORT: String(hubPort),
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_DATA_DIR: join(temp, "hub"),
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
	});
	child = spawn(process.execPath, ["--import", pathToFileURL(observer).href, join(root, "dist/server/index.js")], {
		cwd: project,
		env: {
			...process.env,
			...(process.env.PI_BOT_LIVE_ERROR_STACKS === "1"
				? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(observer).href}` }
				: {}),
			PI_WEB_PORT: String(localPort),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: project,
			PI_WEB_DATA_DIR: data,
			PI_CODING_AGENT_DIR: agent,
			PI_WEB_SDK: "bundled",
			PI_WEB_PASSWORD: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_WEB_PRESET_CATALOG_URL: "off",
			PI_WEB_TOOL_LAZY_LOADING: "0",
			PI_WEB_QUIET: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const pipe of [child.stdout, child.stderr]) {
		pipe.on("data", (chunk) => {
			logs += chunk;
			if (process.env.PI_BOT_LIVE_ERROR_STACKS !== "1") logs = logs.slice(-24000);
		});
	}
	await until(
		async () =>
			fetch(`${localOrigin}/api/health`)
				.then((r) => r.ok)
				.catch(() => false),
		"pi health",
	);
	const registration = await api(
		hubOrigin,
		"/api/auth/register",
		{ username: "bot-live-owner", password: "bot-live-test-password-843" },
		201,
		false,
	);
	cookie = registration.response.headers.get("set-cookie")?.split(";")[0];
	assert.ok(cookie);
	const paired = await api(
		localOrigin,
		"/api/device-center/pair",
		{ hubUrl: hubOrigin, name: "Bot live isolated device" },
		200,
		false,
	);
	await api(hubOrigin, "/api/pair/approve", { code: paired.value.code });
	await api(localOrigin, "/api/device-center/poll", {}, 200, false);
	await api(localOrigin, "/api/device-center/execution", { allowExecution: true }, 200, false);
	const botInput = {
		name: "Bot live SDK",
		description: "Deterministic real SDK integration",
		systemPrompt: "Follow the task. The local model fixture controls the response.",
		cwd: project,
		model: { provider, modelId },
		tools: ["read", "bash"],
		skills: [],
		mcpServers: [],
		enabled: true,
	};
	let bot = (await api(localOrigin, "/api/device-center/local-bots", botInput, 200, false)).value.bot;
	assert.ok(bot?.id, "Real local Bot API returns a stable ID");
	await until(async () => {
		const { value } = await api(hubOrigin, "/api/bots");
		return value.bots.some((item) => item.id === bot.id && item.enabled);
	}, "Bot published to Hub");
	const { room } = (await api(hubOrigin, "/api/rooms", { name: "Bot live tasks", botIds: [bot.id] }, 201)).value;
	async function dispatch(taskMode, expectedStatus, conversationId, turn = "first") {
		mode = taskMode;
		const before = requests.length;
		const { value } = await api(
			hubOrigin,
			conversationId
				? `/api/rooms/${room.id}/conversations/${conversationId}/messages`
				: `/api/rooms/${room.id}/messages`,
			{
				text: `BOT_LIVE_${taskMode}_${turn}: ${taskMode === "read" ? "Read probe.txt, then report its exact content." : "Reply with the deterministic completion."}`,
				targetBotIds: [bot.id],
				idempotencyKey: `bot-live-${taskMode}-${conversationId ?? "new"}-${turn}`,
			},
		);
		const id = value.tasks[0].id;
		const task = await until(
			async () => {
				lastRoom = (await api(hubOrigin, `/api/rooms/${room.id}`)).value;
				const current = lastRoom.tasks.find((item) => item.id === id);
				return ["completed", "failed", "cancelled", "rejected"].includes(current?.status) && current;
			},
			`task ${taskMode} terminal`,
			process.env.PI_BOT_LIVE_TASK_TIMEOUT ? Number(process.env.PI_BOT_LIVE_TASK_TIMEOUT) : 90_000,
		);
		console.log(`Task ${taskMode}: ${JSON.stringify(task)}`);
		assert.equal(
			task.status,
			expectedStatus,
			`${taskMode}: ${JSON.stringify(task)}; requests=${requests.length - before}; server=${logs}`,
		);
		return { task, calls: requests.slice(before) };
	}
	const firstRead = process.env.PI_BOT_LIVE_READ_FIRST === "1" ? await dispatch("read", "completed") : undefined;
	const plain = await dispatch("plain", "completed");
	assert.match(plain.task.report, /BOT_LIVE_PLAIN_DONE/);
	assert.equal(plain.calls.length, 1);
	assert.equal(plain.calls[0].body.model, modelId);
	const taskMessage = plain.calls[0].body.messages.find(
		(message) => message.role === "user" && JSON.stringify(message.content).includes("Device task "),
	);
	const taskText =
		typeof taskMessage.content === "string"
			? taskMessage.content
			: taskMessage.content.map((part) => part.text ?? "").join("\n");
	const taskEnvelope = JSON.parse(taskText.slice(taskText.lastIndexOf("\n\n") + 2));
	assert.equal(taskEnvelope.taskState.currentTaskId, plain.task.id, "Dispatch carries structured task state");
	assert(taskEnvelope.taskState.objective.includes("BOT_LIVE_plain_first"));
	assert.doesNotMatch(
		JSON.stringify(plain.calls[0].body.messages),
		/BOT_LIVE_EXCLUDED_SKILL_SECRET|name="bot-live-excluded"/,
	);
	assert.equal(plain.calls[0].authorization, "Bearer bot-live-known-test-key");
	assert.ok(plain.calls[0].body.messages.some((message) => JSON.stringify(message).includes("BOT_LIVE_plain")));
	console.log("PASS real capability hello/new_chat/prompt -> SDK HTTP -> assistant -> Hub completion");
	assert.ok(plain.task.conversationId, "First task must create a persistent conversation");
	const beforeResume = JSON.parse(await readFile(join(data, "bot-execution-conversations.json"), "utf8"));
	const originalPath = beforeResume[plain.task.conversationId].path;
	const continued = await dispatch("plain", "completed", plain.task.conversationId, "follow-up");
	assert.equal(continued.task.resume, true);
	assert.equal(continued.task.conversationId, plain.task.conversationId);
	assert.match(continued.task.report, /BOT_LIVE_PLAIN_DONE/);
	assert.equal(continued.calls.length, 1);
	const continuedEnvelopeMessage = continued.calls[0].body.messages.findLast(
		(message) => message.role === "user" && JSON.stringify(message.content).includes("Device task "),
	);
	const continuedText =
		typeof continuedEnvelopeMessage.content === "string"
			? continuedEnvelopeMessage.content
			: continuedEnvelopeMessage.content.map((part) => part.text ?? "").join("\n");
	const continuedEnvelope = JSON.parse(continuedText.slice(continuedText.lastIndexOf("\n\n") + 2));
	assert.equal(
		continuedEnvelope.taskState.objective,
		taskEnvelope.taskState.objective,
		"Follow-up preserves original objective",
	);
	assert.equal(continuedEnvelope.taskState.currentTaskId, continued.task.id);
	assert.ok(
		continued.calls[0].body.messages.some(
			(message) => message.role === "assistant" && JSON.stringify(message.content).includes("BOT_LIVE_PLAIN_DONE"),
		),
		"Continued SDK inference must contain the previous assistant response",
	);
	console.log(
		"PASS same group conversation resumed persisted Bot transcript and supplied prior assistant history to SDK inference",
	);
	const third = await dispatch("plain", "completed", plain.task.conversationId, "third-turn");
	assert.equal(third.task.conversationId, plain.task.conversationId);
	const afterResume = JSON.parse(await readFile(join(data, "bot-execution-conversations.json"), "utf8"));
	assert.equal(afterResume[plain.task.conversationId].path, originalPath);
	const persisted = await readFile(originalPath, "utf8");
	for (const turn of ["first", "follow-up", "third-turn"]) assert.ok(persisted.includes(`BOT_LIVE_plain_${turn}`));
	console.log("PASS three distinct group turns persisted in the exact same transcript file");
	const contextRecords = persisted
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "custom_message" && entry.customType === "device-group-context")
		.map((entry) => JSON.parse(entry.content));
	assert.equal(contextRecords.length, 3, "Each turn persists its own context delivery");
	assert.equal(contextRecords[0].delivery.mode, "snapshot");
	assert.equal(contextRecords[1].delivery.mode, "delta");
	assert.equal(contextRecords[2].delivery.mode, "delta");
	const deliveredChunks = contextRecords
		.flatMap((context) => context.messages)
		.map((message) => JSON.stringify([message.id, message.textStart, message.textEnd, message.text]));
	assert.equal(new Set(deliveredChunks).size, deliveredChunks.length, "Retained history chunks are appended once");
	for (const turn of [plain, continued, third]) {
		const payload = JSON.stringify(turn.calls[0].body.messages);
		assert(payload.includes("snapshot") || payload.includes("delta"), "Context reaches the model request");
	}
	console.log("PASS context snapshots become persisted deltas on resumed turns without repeating history chunks");
	// Reload from an ordinary local UI after the first executor releases its capability.
	// A disposed Bot resource loader must never run under a revoked capability.
	control = new WebSocket(`${localOrigin.replace("http:", "ws:")}/ws`, { origin: localOrigin });
	control.on("message", (raw) => controlPackets.push(JSON.parse(String(raw))));
	await new Promise((resolve, reject) => {
		control.once("open", resolve);
		control.once("error", reject);
	});
	control.send(JSON.stringify({ type: "hello", clientId: "bot-live-local-reload-control", cwd: project }));
	await until(() => controlPackets.some((packet) => packet.type === "snapshot"), "ordinary local control hello");
	control.send(JSON.stringify({ type: "extensions_reload" }));
	await delay(400);
	assert.doesNotMatch(logs, /Unhandled Promise Rejection|Bot execution capability has been revoked/);
	const read = firstRead ?? (await dispatch("read", "completed"));
	assert.match(read.task.report, new RegExp(sentinel));
	assert.equal(read.calls.length, 2);
	assert.deepEqual(read.calls[0].body.tools.map((tool) => tool.function.name).sort(), ["bash", "read"]);
	assert.ok(
		read.calls[1].body.messages.some(
			(message) => message.role === "tool" && JSON.stringify(message.content).includes(sentinel),
		),
	);
	const text = (await transcripts(temp)).join("\n");
	assert.match(text, /BOT_LIVE_PLAIN_DONE/);
	assert.match(text, /"toolCall"/);
	assert.match(text, /"toolResult"/);
	assert.match(text, new RegExp(sentinel));
	console.log("PASS actual read tool execution and persisted SDK assistant/tool transcript");
	const failure = await dispatch("api-error", "failed");
	assert.ok(failure.calls.length >= 1, "Failure must originate from real SDK HTTP inference");
	assert.match(failure.task.report, /phase=model; category=model_auth/);
	assert.doesNotMatch(failure.task.report, /BOT_LIVE_FIXTURE_AUTH_REJECTED|bot-live-known-test-key/);
	assert.match((await transcripts(temp)).join("\n"), /BOT_LIVE_FIXTURE_AUTH_REJECTED/);
	console.log("PASS SDK provider rejection reaches failed Hub task");
	// A model cannot elevate its Bot capability by inventing a forbidden tool call.
	bot = (await api(localOrigin, "/api/device-center/local-bots", { ...bot, tools: ["bash"] }, 200, false)).value.bot;
	const denied = await dispatch("denied-tool", "completed");
	assert.deepEqual(
		denied.calls[0].body.tools.map((tool) => tool.function.name),
		["bash"],
	);
	assert.doesNotMatch(denied.task.report, new RegExp(sentinel));
	assert.ok(
		denied.calls[1].body.messages.some(
			(message) =>
				message.role === "tool" && /not found|not allowed|denied|unknown/i.test(JSON.stringify(message.content)),
		),
	);
	console.log("PASS fixture-forced forbidden read cannot escape Bot tool allowlist");
	assert.doesNotMatch(logs, /Unhandled Promise Rejection|Bot execution capability has been revoked/);
	// A disabled Bot cannot receive a new task; this must not reach the model.
	bot = (await api(localOrigin, "/api/device-center/local-bots", { ...bot, enabled: false }, 200, false)).value.bot;
	await until(
		async () => !(await api(hubOrigin, "/api/bots")).value.bots.some((item) => item.id === bot.id && item.enabled),
		"disabled Bot synchronized",
	);
	const beforeReject = requests.length;
	await api(
		hubOrigin,
		`/api/rooms/${room.id}/messages`,
		{ text: "Disabled Bot must reject", targetBotIds: [bot.id] },
		400,
	);
	assert.equal(requests.length, beforeReject);
	console.log("PASS disabled Bot rejection before model execution");
	mode = "coordination";
	async function coordinationBot(name) {
		return (
			await api(
				localOrigin,
				"/api/device-center/local-bots",
				{
					name,
					description: name,
					systemPrompt: "Follow the current group task.",
					cwd: project,
					model: { provider, modelId },
					tools: ["read", "device_collab"],
					skills: [],
					mcpServers: [],
					enabled: true,
				},
				200,
				false,
			)
		).value.bot;
	}
	const coordinator = await coordinationBot("Coordinator");
	const worker = await coordinationBot("Worker");
	coordinatorBotId = coordinator.id;
	workerBotId = worker.id;
	await until(async () => {
		const bots = (await api(hubOrigin, "/api/bots")).value.bots;
		return [coordinator.id, worker.id].every((id) => bots.some((entry) => entry.id === id && entry.enabled));
	}, "coordination Bots synchronized");
	const coordinationRoom = (
		await api(
			hubOrigin,
			"/api/rooms",
			{
				name: "Coordination",
				botIds: [coordinator.id, worker.id],
				primaryBotId: coordinator.id,
			},
			201,
		)
	).value.room;
	lastRoom = { room: coordinationRoom };
	const started = await api(hubOrigin, `/api/rooms/${coordinationRoom.id}/messages`, { text: "COORD_START" });
	const primaryConversationId = started.value.tasks[0].conversationId;
	await until(
		async () => {
			lastRoom = (await api(hubOrigin, `/api/rooms/${coordinationRoom.id}`)).value;
			return lastRoom.tasks.some(
				(task) =>
					task.botId === coordinator.id &&
					task.kind === "result" &&
					task.status === "completed" &&
					task.report?.includes("COORD_RESULT_REVIEWED"),
			);
		},
		"primary delegation and result review",
		90_000,
	);
	const delegated = lastRoom.tasks.find((task) => task.botId === worker.id);
	assert.equal(delegated.kind, "request");
	assert.equal(delegated.requestId, "coord-initial");
	assert.equal(delegated.sourceConversationId, primaryConversationId);
	workerConversationId = delegated.conversationId;
	const initialTaskCount = lastRoom.tasks.length;
	coordinationFollowup = true;
	await api(hubOrigin, `/api/rooms/${coordinationRoom.id}/messages`, { text: "COORD_FOLLOWUP" });
	await until(
		async () => {
			lastRoom = (await api(hubOrigin, `/api/rooms/${coordinationRoom.id}`)).value;
			return (
				lastRoom.tasks.length > initialTaskCount &&
				lastRoom.tasks.some(
					(task) =>
						task.botId === coordinator.id &&
						task.kind === "result" &&
						task.requestId === "coord-followup" &&
						task.status === "completed",
				)
			);
		},
		"follow-up resumes original worker and returns result",
		90_000,
	);
	const workerTasks = lastRoom.tasks.filter((task) => task.botId === worker.id);
	assert.equal(workerTasks.length, 2, "no duplicate assignments");
	assert(workerTasks.every((task) => task.conversationId === workerConversationId));
	assert(
		lastRoom.tasks
			.filter((task) => task.botId === coordinator.id)
			.every((task) => task.conversationId === primaryConversationId),
	);
	assert(lastRoom.tasks.every((task) => task.status === "completed"));
	console.log(
		"PASS: primary Bot delegates through real SDK tools, reviews returned results and resumes the original worker on follow-up",
	);
	mode = "human-attention";
	const questionTask = (
		await api(hubOrigin, `/api/rooms/${coordinationRoom.id}/messages`, { text: "HUMAN_QUESTION_START" })
	).value.tasks[0];
	const questionBase = `/api/rooms/${coordinationRoom.id}/conversations/${primaryConversationId}`;
	const pendingQuestion = await until(async () => {
		const detail = (await api(hubOrigin, questionBase)).value;
		const terminal = detail.tasks.find((task) => task.id === questionTask.id && task.status === "completed");
		return terminal && detail.conversation.attention;
	}, "Bot registers human question via real SDK tool");
	const waitingState = (await api(hubOrigin, `${questionBase}/task-state`)).value;
	assert.equal(waitingState.taskState.phase, "waiting");
	assert.equal(waitingState.taskState.blocker.attentionId, pendingQuestion.id);
	assert(waitingState.events.some((event) => event.type === "attention_requested"));
	assert.equal(pendingQuestion.kind, "decision");
	assert.equal(pendingQuestion.taskId, questionTask.id);
	assert.match(pendingQuestion.question, /rollout option/);
	const persistedHub = JSON.parse(await readFile(join(temp, "hub", "device-hub.json"), "utf8"));
	assert.equal(
		persistedHub.conversations.find((entry) => entry.id === primaryConversationId).attention.id,
		pendingQuestion.id,
	);
	const answerBody = { text: "HUMAN_OPTION_A", attentionId: pendingQuestion.id, idempotencyKey: "human-answer-retry" };
	const answer = (await api(hubOrigin, `${questionBase}/messages`, answerBody)).value;
	assert.equal(answer.task.conversationId, primaryConversationId);
	assert.equal(answer.task.resume, true);
	assert.equal((await api(hubOrigin, `${questionBase}/messages`, answerBody)).value.task.id, answer.task.id);
	await until(async () => {
		const detail = (await api(hubOrigin, questionBase)).value;
		assert.equal(detail.conversation.attention, undefined);
		return detail.tasks.some(
			(task) =>
				task.id === answer.task.id && task.status === "completed" && task.report?.includes("HUMAN_ANSWER_RESUMED"),
		);
	}, "human answer restores original SDK conversation");
	await api(hubOrigin, `${questionBase}/messages`, { ...answerBody, idempotencyKey: "stale-human-answer" }, 409);
	const resolvedState = (await api(hubOrigin, `${questionBase}/task-state`)).value;
	assert.equal(resolvedState.taskState.phase, "completed");
	assert.equal(resolvedState.taskState.blocker, undefined);
	assert.equal(
		resolvedState.taskState.decisions.filter((decision) => decision.attentionId === pendingQuestion.id).length,
		1,
	);
	assert.equal(resolvedState.events.filter((event) => event.type === "attention_resolved").length, 1);
	console.log(
		"PASS: SDK Bot question persists, human answer clears attention and resumes the same transcript exactly once",
	);
	mode = "plain";
	// Reuse the ordinary browser connection after all Bot executors released their
	// capabilities. A cold project must construct its real SDK runtime independently.
	async function ordinarySetCwd(path) {
		const start = controlPackets.length;
		control.send(JSON.stringify({ type: "set_cwd", path }));
		await until(() => {
			const packets = controlPackets.slice(start);
			const error = packets.find((packet) => packet.type === "error");
			assert.equal(error, undefined, `ordinary set_cwd ${path}: ${JSON.stringify(error)}; server=${logs}`);
			return packets.some(
				(packet) => ["snapshot", "snapshot_delta"].includes(packet.type) && packet.state.cwd === path,
			);
		}, `ordinary set_cwd ${path}`);
		console.log(`PASS ordinary set_cwd ${path}`);
	}
	await ordinarySetCwd(coldProject);
	await ordinarySetCwd(project);
	assert.doesNotMatch(logs, /Unhandled Promise Rejection|Bot execution capability has been revoked/);
	console.log("PASS device-bot-live-integration: real isolated Hub/device/SDK/model, no paid inference");
} catch (error) {
	console.error(
		`Bot live failure: ${error.stack}\nFixture requests: ${JSON.stringify(requests.map(({ url, mode, body }) => ({ url, mode, model: body.model, messages: body.messages?.map((m) => ({ role: m.role, content: m.role === "system" ? "[system prompt]" : m.content })), tools: body.tools?.map((t) => t.function.name) })))}\nServer log:\n${logs}`,
	);
	process.exitCode = 1;
} finally {
	control?.terminate();
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
		}
	}
	hub?.server.closeAllConnections();
	await hub?.close();
	if (fixture) {
		fixture.closeAllConnections();
		await new Promise((resolve) => fixture.close(resolve));
	}
	await rm(temp, { recursive: true, force: true });
}
