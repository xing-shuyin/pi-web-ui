// Real independent Hub + two isolated pi services + deterministic HTTP inference.
// Run only after an explicit build: node tests/device-project-collaboration-test.mjs
// No paid model, mocked device_collab, or inferred test success. Same-host devices
// exercise the network/runtime boundary, not physical Windows/macOS interoperability.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureBuild, PREBUILT_ENV } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// The helper validates existing dist; this script must never build a shared tree.
process.env[PREBUILT_ENV] = "1";
ensureBuild(root, "device-project-collaboration");
const { startDeviceHub } = await import(pathToFileURL(join(root, "dist/server/device-center/main.js")).href);
const temp = await mkdtemp(join(tmpdir(), "pi-project-collab-"));
const remote = join(temp, "origin.git");
const integration = join(temp, "integration");
const devices = ["dev", "review"].map((role) => ({
	role,
	project: join(temp, role, "project"),
	agent: join(temp, role, "agent"),
	data: join(temp, role, "data"),
	logs: "",
	requests: [],
}));
let hub;
let hubEnv;
let fixture;
let cookie;
let room;
let devConversation;
let reviewConversation;
let phase;
let step = 0;
let baseCommit;
let firstCommit;
let secondCommit;
let currentDelivery;
const evidence = [];
const provider = "project-collab-fixture";
const modelId = "deterministic-project-model";

function command(cwd, executable, args, expected = 0) {
	const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
	assert.equal(result.error, undefined, `${executable}: ${result.error}`);
	assert.equal(result.status, expected, `${executable} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}
const git = (cwd, ...args) => command(cwd, "git", args);
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
async function until(work, label, timeout = 90_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await work();
		if (value) return value;
		for (const device of devices)
			if (device.child && (device.child.exitCode !== null || device.child.signalCode !== null))
				throw new Error(`${device.role} exited: ${device.logs}`);
		await delay(100);
	}
	throw new Error(`Timed out: ${label}`);
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
	const value = await response.json();
	assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
	return { value, response };
}
function stream(response, tool, args) {
	const toolId = `call_${phase}_${step}`;
	const delta = tool
		? {
				tool_calls: [
					{ index: 0, id: toolId, type: "function", function: { name: tool, arguments: JSON.stringify(args) } },
				],
			}
		: { content: `PROJECT_COLLAB_${phase}_DONE` };
	response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	for (const [content, finish] of [
		[{ role: "assistant" }, null],
		[delta, null],
		[{}, tool ? "tool_calls" : "stop"],
	])
		response.write(
			`data: ${JSON.stringify({ id: toolId, object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`,
		);
	response.end("data: [DONE]\n\n");
}
function fixtureAction(device) {
	if (phase === "develop-no-delivery") return [];
	if (step === 0) return ["read", { path: "sum.cjs" }];
	if (step === 1) {
		const shell =
			device.role === "dev"
				? `node "${join(temp, phase === "develop-first" ? "first.cjs" : "fix.cjs").replaceAll("\\", "/")}"`
				: `git fetch origin && git checkout --detach ${phase === "review-first" ? firstCommit : secondCommit} && node check.cjs`;
		return ["bash", { command: shell }];
	}
	if (step === 2 || step === 3) {
		if (device.role === "dev")
			return [
				"device_collab",
				{
					action: "conversation_deliver",
					roomId: room.id,
					sourceBotId: device.bot.id,
					conversationId: devConversation,
					repository: remote.replaceAll("\\", "/"),
					baseCommit,
					commit: git(device.project, "rev-parse", "HEAD"),
					branch: "work",
					summary: `${phase} implementation`,
					checks: [
						{
							command: "node check.cjs",
							status: phase === "develop-first" ? "failed" : "passed",
							result: "Bot reported local check; independently verified by harness",
							exitCode: phase === "develop-first" ? 1 : 0,
						},
					],
					limitations: ["Same-host isolated services; physical Windows/macOS interoperability untested"],
					idempotencyKey: `delivery-${phase}`,
				},
			];
		return [
			"device_collab",
			{
				action: "conversation_review",
				roomId: room.id,
				sourceBotId: device.bot.id,
				conversationId: devConversation,
				deliveryId: currentDelivery.id,
				commit: phase === "review-first" ? firstCommit : secondCommit,
				verdict: phase === "review-first" ? "changes_requested" : "accepted",
				summary:
					phase === "review-first"
						? `Actual node check.cjs failed at ${firstCommit}: sum subtracts`
						: `Actual node check.cjs passed at ${secondCommit}`,
				idempotencyKey: `review-${phase}`,
			},
		];
	}
	return [];
}
async function detail() {
	return (await api(hub.origin, `/api/rooms/${room.id}/conversations/${devConversation}`)).value;
}
async function dispatch(device, name, conversationId) {
	phase = name;
	step = 0;
	const before = device.requests.length;
	const path = conversationId
		? `/api/rooms/${room.id}/conversations/${conversationId}/messages`
		: `/api/rooms/${room.id}/messages`;
	const body = {
		text: `PROJECT_COLLAB_${name}: execute the deterministic tool sequence, then report.`,
		targetBotIds: [device.bot.id],
		idempotencyKey: `dispatch-${name}`,
	};
	const first = (await api(hub.origin, path, body)).value;
	const task = first.tasks[0];
	assert.ok(task.conversationId);
	if (device.role === "dev") devConversation ??= task.conversationId;
	else reviewConversation ??= task.conversationId;
	// Repeat actual HTTP sends. The same task/conversation must be returned.
	const duplicate = (await api(hub.origin, path, body)).value;
	assert.equal(duplicate.tasks[0].id, task.id);
	assert.equal(duplicate.tasks[0].conversationId, task.conversationId);
	const completed = await until(async () => {
		const state = (await api(hub.origin, `/api/rooms/${room.id}`)).value;
		const found = state.tasks.find((item) => item.id === task.id);
		return ["completed", "failed", "cancelled", "rejected"].includes(found?.status) && found;
	}, name);
	assert.equal(completed.status, "completed", JSON.stringify(completed));
	assert.match(completed.report, new RegExp(`PROJECT_COLLAB_${name}_DONE`));
	const calls = device.requests.slice(before);
	assert.equal(calls.length, name === "develop-no-delivery" ? 1 : 5, `${name}: expected SDK request count`);
	for (const tool of ["read", "bash", "device_collab"])
		assert.ok(calls[0].tools.some((entry) => entry.function.name === tool));
	if (name !== "develop-no-delivery") {
		const bashResult = calls[2].messages.findLast((message) => message.role === "tool");
		const output = JSON.stringify(bashResult?.content);
		if (name.endsWith("first")) {
			assert.match(output, /AssertionError/);
			assert.match(output, /(?:exited|exit code|exitCode|code)[^0-9]{0,20}1/i, "Actual bash result must report exit 1");
		} else {
			assert.match(output, /PROJECT_CHECK_OK/);
			assert.doesNotMatch(output, /AssertionError|Command exited with code [1-9]/);
		}
	}
	for (const call of calls.slice(1)) {
		const result = call.messages.findLast((message) => message.role === "tool");
		assert.ok(result, "SDK must receive actual tool result");
		if (call === calls[3] || call === calls[4])
			assert.doesNotMatch(
				JSON.stringify(result.content),
				/isError|Unsupported device_collab|Missing device_collab|not allowed|Forbidden|Invalid /i,
			);
	}
	if (conversationId) {
		assert.equal(completed.conversationId, conversationId);
		assert.equal(completed.resume, true);
		assert.ok(
			calls[0].messages.some(
				(message) =>
					message.role === "assistant" &&
					JSON.stringify(message.content).includes(
						device.role === "dev" ? "PROJECT_COLLAB_develop-no-delivery_DONE" : "PROJECT_COLLAB_review-first_DONE",
					),
			),
			"Resumed inference includes original assistant transcript",
		);
	}
	return completed;
}
try {
	await Promise.all(
		devices.flatMap((d) => [
			mkdir(d.project, { recursive: true }),
			mkdir(d.agent, { recursive: true }),
			mkdir(d.data, { recursive: true }),
		]),
	);
	git(temp, "init", "--bare", remote);
	for (const device of devices) {
		git(temp, "clone", remote, device.project);
		git(device.project, "config", "user.email", "fixture@example.invalid");
		git(device.project, "config", "user.name", "Project fixture");
		git(device.project, "config", "core.autocrlf", "false");
	}
	const dev = devices[0];
	const reviewer = devices[1];
	await writeFile(join(dev.project, "sum.cjs"), "module.exports = (a, b) => a + b;\n");
	await writeFile(
		join(dev.project, "check.cjs"),
		"const assert = require('node:assert/strict'); assert.equal(require('./sum.cjs')(2, 3), 5); console.log('PROJECT_CHECK_OK');\n",
	);
	git(dev.project, "add", ".");
	git(dev.project, "commit", "-m", "baseline");
	git(dev.project, "push", "origin", "HEAD:main");
	baseCommit = git(dev.project, "rev-parse", "HEAD");
	git(dev.project, "checkout", "-b", "work");
	git(reviewer.project, "fetch", "origin");
	git(reviewer.project, "checkout", "--detach", baseCommit);
	for (const [file, operator] of [
		["first.cjs", "-"],
		["fix.cjs", "+"],
	])
		await writeFile(
			join(temp, file),
			`const fs = require('node:fs'); const {spawnSync} = require('node:child_process');\nfunction run(exe,args) {const r=spawnSync(exe,args,{stdio:'inherit'}); if(r.status!==0)process.exit(r.status??1);}\nfs.writeFileSync('sum.cjs', ${JSON.stringify(`module.exports = (a, b) => a ${operator} b;\n`)});\nrun('git',['add','sum.cjs']); run('git',['commit','-m',${JSON.stringify(file)}]); run('git',['push','origin','HEAD:work']); run(process.execPath,['check.cjs']);\n`,
		);
	fixture = createServer(async (request, response) => {
		try {
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw);
			const device = devices.find((item) => request.url.startsWith(`/${item.role}/`));
			assert.ok(device, `Unexpected model URL ${request.url}`);
			assert.equal(body.model, modelId);
			assert.equal(device.role, phase.startsWith("develop") ? "dev" : "review");
			device.requests.push(body);
			const [tool, args] = fixtureAction(device);
			stream(response, tool, args);
			step++;
		} catch (error) {
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: error.message } }));
		}
	});
	const fixturePort = await port();
	await new Promise((resolve) => fixture.listen(fixturePort, "127.0.0.1", resolve));
	const hubPort = await port();
	const hubOrigin = `http://127.0.0.1:${hubPort}`;
	hubEnv = {
		PI_DEVICE_HUB_PUBLIC_URL: hubOrigin,
		PI_DEVICE_HUB_PORT: String(hubPort),
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_DATA_DIR: join(temp, "hub"),
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
	};
	hub = await startDeviceHub(hubEnv);
	hub.origin = hubOrigin;
	const registration = await api(
		hub.origin,
		"/api/auth/register",
		{ username: "project-fixture-owner", password: "project-fixture-password-90817" },
		201,
		false,
	);
	cookie = registration.response.headers.get("set-cookie")?.split(";")[0];
	assert.ok(cookie);
	for (const device of devices) {
		await writeFile(
			join(device.agent, "models.json"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: `http://127.0.0.1:${fixturePort}/${device.role}/v1`,
						api: "openai-completions",
						apiKey: "fixture-local-only",
						models: [
							{
								id: modelId,
								name: "Local project fixture",
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
			join(device.agent, "settings.json"),
			JSON.stringify({ defaultProvider: provider, defaultModel: modelId }),
		);
		const localPort = await port();
		device.origin = `http://127.0.0.1:${localPort}`;
		device.child = spawn(process.execPath, [join(root, "dist/server/index.js")], {
			cwd: device.project,
			env: {
				...process.env,
				PI_WEB_PORT: String(localPort),
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_CWD: device.project,
				PI_WEB_DATA_DIR: device.data,
				PI_CODING_AGENT_DIR: device.agent,
				PI_WEB_SDK: "bundled",
				PI_WEB_PASSWORD: "",
				PI_WEB_TOKEN: "",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_PRESET_CATALOG_URL: "off",
				PI_WEB_TOOL_LAZY_LOADING: "0",
				PI_WEB_QUIET: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const pipe of [device.child.stdout, device.child.stderr])
			pipe.on("data", (chunk) => {
				device.logs = (device.logs + chunk).slice(-32000);
			});
		await until(
			() =>
				fetch(`${device.origin}/api/health`)
					.then((r) => r.ok)
					.catch(() => false),
			`${device.role} health`,
		);
		const paired = (
			await api(
				device.origin,
				"/api/device-center/pair",
				{ hubUrl: hub.origin, name: `Project ${device.role} device` },
				200,
				false,
			)
		).value;
		await api(hub.origin, "/api/pair/approve", { code: paired.code });
		await api(device.origin, "/api/device-center/poll", {}, 200, false);
		await api(device.origin, "/api/device-center/execution", { allowExecution: true }, 200, false);
		device.bot = (
			await api(
				device.origin,
				"/api/device-center/local-bots",
				{
					name: `Project ${device.role}`,
					description: "Real isolated project collaboration fixture",
					systemPrompt: "Execute the task using the provided tools. Fixture controls deterministic tool calls.",
					cwd: device.project,
					model: { provider, modelId },
					tools: ["read", "bash", "device_collab"],
					skills: [],
					mcpServers: [],
					enabled: true,
				},
				200,
				false,
			)
		).value.bot;
		await until(
			async () =>
				(await api(hub.origin, "/api/bots")).value.bots.some((bot) => bot.id === device.bot.id && bot.enabled),
			`${device.role} published`,
		);
	}
	const publishedBots = (await api(hub.origin, "/api/bots")).value.bots;
	assert.notEqual(
		publishedBots.find((bot) => bot.id === dev.bot.id).deviceId,
		publishedBots.find((bot) => bot.id === reviewer.bot.id).deviceId,
	);
	room = (
		await api(hub.origin, "/api/rooms", { name: "Project delivery review", botIds: devices.map((d) => d.bot.id) }, 201)
	).value.room;
	await dispatch(dev, "develop-no-delivery");
	const noDelivery = await detail();
	assert.equal(noDelivery.conversation.status, "completed");
	assert.equal(noDelivery.deliveries.length, 0);
	assert.equal(
		noDelivery.conversation.latestReview,
		undefined,
		"Execution completion without delivery is not acceptance",
	);
	await dispatch(dev, "develop-first", devConversation);
	firstCommit = git(dev.project, "rev-parse", "HEAD");
	assert.notEqual(firstCommit, baseCommit);
	assert.equal(git(temp, "--git-dir", remote, "rev-parse", "refs/heads/work"), firstCommit);
	command(dev.project, process.execPath, ["check.cjs"], 1);
	let state = await detail();
	assert.equal(state.deliveries.length, 1, "Repeated actual deliver tool call must not append another delivery");
	assert.equal(state.reviews.length, 0, "Completed execution with a delivery is not acceptance");
	assert.equal(state.conversation.latestReview, undefined);
	currentDelivery = state.deliveries[0];
	assert.equal(currentDelivery.commit, firstCommit);
	assert.equal(currentDelivery.checks[0].source, "bot_reported");
	assert.equal(currentDelivery.checks[0].status, "failed");
	await api(
		hub.origin,
		`/api/rooms/${room.id}/conversations/${devConversation}/reviews`,
		{
			idempotencyKey: "negative-wrong-sha",
			deliveryId: currentDelivery.id,
			commit: baseCommit,
			verdict: "accepted",
			summary: "Must reject review for a different commit",
		},
		400,
	);
	assert.equal((await detail()).reviews.length, 0, "Rejected wrong SHA cannot append acceptance");
	await dispatch(reviewer, "review-first");
	assert.equal(git(reviewer.project, "rev-parse", "HEAD"), firstCommit);
	assert.match(await readFile(join(reviewer.project, "sum.cjs"), "utf8"), /a - b/);
	command(reviewer.project, process.execPath, ["check.cjs"], 1);
	state = await detail();
	assert.equal(state.reviews.length, 1);
	assert.equal(state.reviews[0].verdict, "changes_requested");
	assert.equal(state.reviews[0].commit, firstCommit);
	const beforeResume = JSON.parse(await readFile(join(dev.data, "bot-execution-conversations.json"), "utf8"))[
		devConversation
	].path;
	await dispatch(dev, "develop-fix", devConversation);
	secondCommit = git(dev.project, "rev-parse", "HEAD");
	assert.notEqual(secondCommit, firstCommit);
	assert.equal(git(dev.project, "rev-parse", "HEAD^"), firstCommit);
	assert.equal(git(temp, "--git-dir", remote, "rev-parse", "refs/heads/work"), secondCommit);
	assert.match(command(dev.project, process.execPath, ["check.cjs"]), /PROJECT_CHECK_OK/);
	state = await detail();
	assert.equal(state.deliveries.length, 2);
	assert.equal(state.conversation.latestReview, undefined, "Prior changes_requested does not review a new commit");
	currentDelivery = state.deliveries[1];
	assert.equal(currentDelivery.commit, secondCommit);
	assert.equal(currentDelivery.checks[0].source, "bot_reported");
	await dispatch(reviewer, "review-final", reviewConversation);
	assert.equal(git(reviewer.project, "rev-parse", "HEAD"), secondCommit);
	assert.equal(await readFile(join(reviewer.project, "sum.cjs"), "utf8"), "module.exports = (a, b) => a + b;\n");
	assert.match(command(reviewer.project, process.execPath, ["check.cjs"]), /PROJECT_CHECK_OK/);
	state = await detail();
	assert.equal(state.reviews.length, 2, "Repeated actual review tool call is idempotent");
	assert.equal(state.reviews[1].verdict, "accepted");
	assert.equal(state.reviews[1].commit, secondCommit);
	assert.equal(state.reviews[1].deliveryId, currentDelivery.id);
	assert.equal(
		JSON.parse(await readFile(join(dev.data, "bot-execution-conversations.json"), "utf8"))[devConversation].path,
		beforeResume,
	);
	for (const device of devices) {
		const id = device.role === "dev" ? devConversation : reviewConversation;
		const mapping = JSON.parse(await readFile(join(device.data, "bot-execution-conversations.json"), "utf8"));
		const transcript = await readFile(mapping[id].path, "utf8");
		for (const marker of device.role === "dev" ? ["develop-first", "develop-fix"] : ["review-first", "review-final"])
			assert.ok(transcript.includes(`PROJECT_COLLAB_${marker}`));
		for (const tool of ["read", "bash", "device_collab"]) assert.ok(transcript.includes(`"${tool}"`));
		assert.match(transcript, /"toolResult"/);
	}
	git(dev.project, "worktree", "add", "--detach", integration, baseCommit);
	git(integration, "merge", "--ff-only", secondCommit);
	assert.equal(git(integration, "rev-parse", "HEAD"), secondCommit);
	assert.match(command(integration, process.execPath, ["check.cjs"]), /PROJECT_CHECK_OK/);
	assert.equal(git(integration, "status", "--porcelain"), "");
	const acceptedHistory = structuredClone({ deliveries: state.deliveries, reviews: state.reviews });
	const hubOriginAfterRestart = hub.origin;
	hub.server.closeAllConnections();
	await hub.close();
	hub = await startDeviceHub(hubEnv);
	hub.origin = hubOriginAfterRestart;
	state = await detail();
	assert.deepEqual(state.deliveries, acceptedHistory.deliveries, "Real Hub restart preserves delivery history");
	assert.deepEqual(state.reviews, acceptedHistory.reviews, "Real Hub restart preserves exact review records");
	assert.equal(state.conversation.latestReview.verdict, "accepted");
	evidence.push({
		baseCommit,
		firstCommit,
		secondCommit,
		firstReviewExitCode: 1,
		finalReviewExitCode: 0,
		integrationExitCode: 0,
		deliveryCount: state.deliveries.length,
		reviewCount: state.reviews.length,
	});
	console.log(`PASS device-project-collaboration ${JSON.stringify(evidence)}`);
	console.log(
		"Scope: two independent same-host services, real Hub/SDK/tools/Git; no physical Windows/macOS interoperability claim.",
	);
} catch (error) {
	console.error(error.stack);
	for (const device of devices)
		console.error(
			`${device.role}: ${device.logs}\nRequests: ${JSON.stringify(device.requests.map((body) => body.messages?.filter((message) => message.role !== "system")))}`,
		);
	process.exitCode = 1;
} finally {
	for (const device of devices) {
		const child = device.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) continue;
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
