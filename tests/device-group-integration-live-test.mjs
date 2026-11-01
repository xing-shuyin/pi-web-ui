// Independent Hub -> real connector relay -> real pi runtime -> real Git.
// Requires the parent's completed dist build; never builds or contacts a model.
// Accepted delivery metadata is an explicit test fixture, not a claimed Bot run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts/group-expansion");
const temp = await mkdtemp(join(tmpdir(), "pi-group-integration-live-"));
const devices = ["author", "target"].map((role) => ({
	role,
	project: join(temp, role, "project"),
	agent: join(temp, role, "agent"),
	data: join(temp, role, "data"),
	logs: "",
}));
const evidence = [];
const failures = [];
let hub;
let browser;
let page;
let cookie;
let origin;
let accountId;
let room;
let base;
let delivered;
const [author, target] = devices;
function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}
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
async function request(url, path, body, authenticated = true) {
	const response = await fetch(url + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Origin: url,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(authenticated && cookie ? { Cookie: cookie } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(90_000),
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 500)}`);
	}
	evidence.push({ method: body === undefined ? "GET" : "POST", path, status: response.status, data });
	return { response, data };
}
async function api(url, path, body, expected = 200, authenticated = true) {
	const result = await request(url, path, body, authenticated);
	assert.equal(result.response.status, expected, `${path}: ${JSON.stringify(result.data)}`);
	return result.data;
}
function snapshot(cwd) {
	return {
		head: git(cwd, "rev-parse", "HEAD"),
		branch: git(cwd, "symbolic-ref", "--short", "HEAD"),
		tree: git(cwd, "write-tree"),
		status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
	};
}
async function scenario(name, work) {
	try {
		await work();
		console.log(`PASS ${name}`);
		evidence.push({ assertion: name, passed: true });
	} catch (error) {
		failures.push({ name, error: error.stack ?? String(error) });
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
// Only metadata is seeded through the Hub's serialized store. Integration RPCs
// and Git execution are never replaced, imported directly, or monkey patched.
async function fixture(label, commit = delivered, branch = `int-${label}`) {
	git(target.project, "branch", branch, base);
	const conversationId = randomUUID();
	const deliveryId = randomUUID();
	await hub.store.transact((draft) => {
		draft.conversations.push({
			id: conversationId,
			accountId,
			roomId: room.id,
			botId: author.bot.id,
			deviceId: author.deviceId,
			botRevision: author.bot.revision,
			name: `Authorized integration fixture: ${label}`,
			dispatchDepth: 0,
			latestTaskId: `authorized-fixture-${label}`,
			rootTaskId: `authorized-fixture-${label}`,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		draft.deliveries.push({
			id: deliveryId,
			accountId,
			roomId: room.id,
			conversationId,
			botId: author.bot.id,
			taskId: `authorized-fixture-${label}`,
			repository: join(temp, "origin.git"),
			baseCommit: base,
			commit,
			branch: "work",
			summary: "Explicit metadata fixture; no LLM execution is claimed",
			checks: [],
			limitations: ["Fixture delivery metadata; HTTP integration and Git are real"],
			createdAt: Date.now(),
		});
	});
	const path = `/api/rooms/${room.id}/conversations/${conversationId}`;
	const review = async (verdict) =>
		api(origin, `${path}/reviews`, {
			idempotencyKey: randomUUID(),
			deliveryId,
			commit,
			verdict,
			summary: `Explicit test user ${verdict} exact SHA`,
		});
	await review("accepted");
	return { path, deliveryId, commit, branch, review };
}
async function prepare(f) {
	const { integration } = await api(origin, `${f.path}/integrations`, {
		deliveryId: f.deliveryId,
		targetBotId: target.bot.id,
		targetBranch: f.branch,
	});
	assert.equal(integration.status, "prepared");
	assert.equal(integration.commit, f.commit);
	assert.equal(integration.expectedTargetSha, base);
	return integration;
}
async function verify(f, integration) {
	const { integration: verified } = await api(origin, `${f.path}/integrations/${integration.id}/verify`, {
		commands: ["node check.cjs"],
	});
	assert.equal(verified.status, "verified");
	assert.equal(verified.validationCommands[0].status, "passed");
	assert.equal(verified.validationCommands[0].exitCode, 0);
	assert.match(verified.validationCommands[0].output, /LIVE_INTEGRATION_CHECK_OK/);
	assert.match(verified.validationCommands[0].output, /integration-worktrees/);
	return verified;
}
async function apply(f, integration) {
	return request(origin, `${f.path}/integrations/${integration.id}/apply`, {
		expectedTargetSha: integration.expectedTargetSha,
	});
}
async function cancel(f, integration) {
	const { integration: cancelled } = await api(origin, `${f.path}/integrations/${integration.id}/cancel`, {});
	assert.equal(cancelled.status, "cancelled");
}
async function rejected(f, integration, pattern, expectedStatus) {
	const result = await apply(f, integration);
	assert.equal(git(target.project, "rev-parse", f.branch), base, "Rejected apply must not move target ref");
	// Check persisted detail as well: the public HTTP error must preserve the
	// actionable reason rather than hiding runtime rejection behind generic 500.
	const { integrations } = await api(origin, `${f.path}/integrations`);
	const persisted = integrations.find((it) => it.id === integration.id);
	assert.match(result.data.error ?? persisted.error ?? "", pattern);
	if (pattern.source.includes("checked out")) assert.equal(persisted.status, "failed");
	assert.equal(result.response.status, expectedStatus);
}

try {
	await mkdir(artifacts, { recursive: true });
	await readFile(join(root, "dist/server/index.js"));
	const originRepo = join(temp, "origin.git");
	git(temp, "init", "--bare", originRepo);
	for (const d of devices) {
		await mkdir(d.agent, { recursive: true });
		await mkdir(d.data, { recursive: true });
		await mkdir(join(temp, d.role), { recursive: true });
		git(temp, "clone", originRepo, d.project);
		git(d.project, "config", "user.name", "Integration Fixture");
		git(d.project, "config", "user.email", "integration-fixture@local");
		git(d.project, "config", "core.autocrlf", "false");
	}
	await writeFile(join(author.project, "sum.cjs"), "module.exports = (a, b) => a - b;\n");
	await writeFile(
		join(author.project, "check.cjs"),
		"const assert = require('node:assert/strict'); assert.equal(require('./sum.cjs')(2,3),5); console.log('LIVE_INTEGRATION_CHECK_OK', process.cwd());\n",
	);
	git(author.project, "add", ".");
	git(author.project, "commit", "-m", "baseline");
	git(author.project, "branch", "-M", "main");
	base = git(author.project, "rev-parse", "HEAD");
	git(author.project, "push", "origin", "main");
	git(author.project, "checkout", "-b", "work");
	await writeFile(join(author.project, "sum.cjs"), "module.exports = (a, b) => a + b;\n");
	git(author.project, "commit", "-am", "exact accepted delivery");
	delivered = git(author.project, "rev-parse", "HEAD");
	git(author.project, "push", "origin", "work");
	git(target.project, "fetch", "origin");
	git(target.project, "checkout", "-b", "main", "origin/main");
	git(target.project, "checkout", "-b", "operator-work");
	const hubPort = await port();
	origin = `http://127.0.0.1:${hubPort}`;
	const { startDeviceHub } = await import("../dist/server/device-center/main.js");
	hub = await startDeviceHub({
		...process.env,
		PI_DEVICE_HUB_PORT: String(hubPort),
		PI_DEVICE_HUB_HOST: "127.0.0.1",
		PI_DEVICE_HUB_PUBLIC_URL: origin,
		PI_DEVICE_HUB_DATA_DIR: join(temp, "hub"),
		PI_DEVICE_HUB_ALLOW_REGISTRATION: "1",
	});
	const registration = await request(origin, "/api/auth/register", {
		username: "integration-fixture-user",
		password: "isolated-integration-fixture-password",
	});
	assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
	cookie = registration.response.headers.get("set-cookie").split(";")[0];
	accountId = hub.store.snapshot().accounts[0].id;
	for (const d of devices) {
		d.port = await port();
		d.origin = `http://127.0.0.1:${d.port}`;
		d.child = spawn(process.execPath, ["dist/server/index.js"], {
			cwd: root,
			env: {
				...process.env,
				PI_WEB_PORT: String(d.port),
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_CWD: d.project,
				PI_WEB_DATA_DIR: d.data,
				PI_CODING_AGENT_DIR: d.agent,
				PI_WEB_SDK: "bundled",
				PI_WEB_TOKEN: "",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				PI_WEB_AUTO_OPEN: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		d.child.stdout.on("data", (chunk) => (d.logs += chunk));
		d.child.stderr.on("data", (chunk) => (d.logs += chunk));
		await until(async () => {
			try {
				return (await fetch(`${d.origin}/api/health`)).ok;
			} catch {
				return false;
			}
		}, `${d.role} server ready`);
		const paired = await api(d.origin, "/api/device-center/pair", { hubUrl: origin, name: d.role }, 200, false);
		await api(origin, "/api/pair/approve", { code: paired.code });
		await api(d.origin, "/api/device-center/poll", {}, 200, false);
		await api(d.origin, "/api/device-center/execution", { allowExecution: true }, 200, false);
		d.bot = (
			await api(
				d.origin,
				"/api/device-center/local-bots",
				{
					name: `${d.role} fixture Bot`,
					cwd: d.project,
					description: "Authorized deterministic integration fixture",
					systemPrompt: "Fixture metadata only; do not run inference",
					tools: [],
					skills: [],
					mcpServers: [],
					enabled: true,
				},
				200,
				false,
			)
		).bot;
		await until(async () => {
			const published = (await api(origin, "/api/bots")).bots.find((it) => it.id === d.bot.id);
			if (!published) return false;
			d.bot = published;
			d.deviceId = published.deviceId;
			return true;
		}, `${d.role} Bot published`);
		await until(
			async () => (await api(origin, "/api/devices")).devices.find((it) => it.id === d.deviceId)?.online,
			`${d.role} relay online`,
		);
	}
	room = (
		await api(origin, "/api/rooms", { name: "Live integration fixture", botIds: devices.map((d) => d.bot.id) }, 201)
	).room;
	const operatorBefore = snapshot(target.project);
	const operatorFile = await readFile(join(target.project, "sum.cjs"), "utf8");
	await scenario("HTTP prepare -> real runtime verify -> unoccupied branch CAS", async () => {
		const f = await fixture("success");
		const integration = await prepare(f);
		assert.equal(git(target.project, "rev-parse", f.branch), base);
		await verify(f, integration);
		const result = await apply(f, integration);
		assert.equal(result.response.status, 200, JSON.stringify(result.data));
		const applied = result.data.integration;
		assert.equal(applied.status, "applied");
		assert.equal(git(target.project, "rev-parse", f.branch), applied.newCommitSha);
		assert.equal(
			git(target.project, "rev-parse", `${f.branch}^{tree}`),
			git(author.project, "rev-parse", `${delivered}^{tree}`),
		);
		assert.equal(git(target.project, "rev-parse", `${f.branch}^1`), base);
		assert.equal(git(target.project, "rev-parse", `${f.branch}^2`), delivered);
		assert.deepEqual(snapshot(target.project), operatorBefore);
		assert.equal(await readFile(join(target.project, "sum.cjs"), "utf8"), operatorFile);
		assert.equal(git(target.project, "worktree", "list", "--porcelain").includes(integration.id), false);
	});
	for (const linked of [false, true])
		await scenario(
			`${linked ? "linked" : "main"} checked-out target rejects with 409 switch-away guidance`,
			async () => {
				const f = await fixture(linked ? "linked" : "checkout");
				const path = join(temp, "linked-target");
				if (linked) git(target.project, "worktree", "add", path, f.branch);
				else git(target.project, "checkout", f.branch);
				const before = snapshot(linked ? path : target.project);
				const integration = await prepare(f);
				await verify(f, integration);
				let applied = false;
				let switched = false;
				try {
					await rejected(f, integration, /checked out.*switch away/i, 409);
					assert.deepEqual(snapshot(linked ? path : target.project), before);
					if (linked) git(target.project, "worktree", "remove", path);
					else git(target.project, "checkout", "operator-work");
					switched = true;
					const result = await apply(f, integration);
					assert.equal(
						result.response.status,
						200,
						`Same integration must be retryable after switching away: ${JSON.stringify(result.data)}`,
					);
					assert.equal(result.data.integration.status, "applied");
					assert.equal(git(target.project, "rev-parse", f.branch), result.data.integration.newCommitSha);
					assert.equal(
						git(target.project, "rev-parse", `${f.branch}^{tree}`),
						git(author.project, "rev-parse", `${delivered}^{tree}`),
					);
					applied = true;
				} finally {
					if (!switched) {
						assert.deepEqual(snapshot(linked ? path : target.project), before);
						if (linked) git(target.project, "worktree", "remove", path);
						else git(target.project, "checkout", "operator-work");
					}
					if (!applied) await cancel(f, integration);
				}
			},
		);
	await scenario("revoked accepted review rejects stale prepared integration", async () => {
		const f = await fixture("revoked");
		const integration = await prepare(f);
		await verify(f, integration);
		await f.review("changes_requested");
		try {
			await rejected(f, integration, /accepted review|invalidated/i, 400);
		} finally {
			await cancel(f, integration);
		}
	});
	await scenario("new delivery invalidates old exact SHA acceptance", async () => {
		const f = await fixture("superseded");
		const integration = await prepare(f);
		await verify(f, integration);
		await hub.store.transact((draft) => {
			const old = draft.deliveries.find((it) => it.id === f.deliveryId);
			draft.deliveries.push({ ...old, id: randomUUID(), commit: base, createdAt: Date.now() });
		});
		try {
			await rejected(f, integration, /latest delivery/i, 400);
		} finally {
			await cancel(f, integration);
		}
	});
	await scenario("target SHA movement rejects CAS without overwriting new ref", async () => {
		const f = await fixture("moved");
		const integration = await prepare(f);
		await verify(f, integration);
		git(target.project, "update-ref", `refs/heads/${f.branch}`, delivered, base);
		try {
			const result = await apply(f, integration);
			assert.equal(git(target.project, "rev-parse", f.branch), delivered);
			const { integrations } = await api(origin, `${f.path}/integrations`);
			assert.equal(integrations.find((it) => it.id === integration.id).status, "failed");
			assert.match(integrations.find((it) => it.id === integration.id).error, /moved from/);
			assert.match(result.data.error, /moved from/);
			assert.equal(result.response.status, 409, JSON.stringify(result.data));
		} finally {
			await cancel(f, integration);
		}
	});
	await scenario("custom merge driver rejected before external command execution", async () => {
		git(author.project, "checkout", "-b", "unsafe-driver", base);
		await writeFile(join(author.project, ".gitattributes"), "*.cjs merge=unsafe-fixture\n");
		git(author.project, "add", ".gitattributes");
		git(author.project, "commit", "-m", "custom driver refusal fixture");
		const driverCommit = git(author.project, "rev-parse", "HEAD");
		git(author.project, "push", "origin", "unsafe-driver");
		git(target.project, "fetch", "origin");
		const f = await fixture("driver");
		git(target.project, "update-ref", `refs/heads/${f.branch}`, driverCommit, base);
		const result = await request(origin, `${f.path}/integrations`, {
			deliveryId: f.deliveryId,
			targetBotId: target.bot.id,
			targetBranch: f.branch,
		});
		assert.equal(result.response.status, 422, JSON.stringify(result.data));
		assert.match(result.data.error, /Custom filter\/merge driver.*forbidden/);
		assert.equal(git(target.project, "rev-parse", f.branch), driverCommit);
		const { integrations } = await api(origin, `${f.path}/integrations`);
		assert.equal(integrations.at(-1).status, "failed");
		assert.match(integrations.at(-1).error, /Custom filter\/merge driver.*forbidden/);
		await cancel(f, integrations.at(-1));
	});
	if (CHROME_PATH)
		await scenario("Chrome GroupIntegration explicit prepare verify confirm", async () => {
			const f = await fixture("browser");
			browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
			page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
			page.setDefaultTimeout(15000);
			page.on("pageerror", (error) => evidence.push({ browserError: String(error) }));
			await page.goto(target.origin);
			const setup = page.locator(".modal-backdrop .modal-close");
			await setup.first().waitFor({ timeout: 10000 });
			await setup.first().click();
			await page.locator(".modal-backdrop").waitFor({ state: "detached" });
			await page.locator(".dg-side-row", { hasText: room.name }).waitFor({ timeout: 30000 });
			await page.locator(".dg-side-row", { hasText: room.name }).click();
			await page.locator(".gd-panel > summary").click();
			await page.locator(".gd-content > label input[type=checkbox]").uncheck();
			const card = page
				.locator("section.gd-conversation")
				.filter({ hasText: "Authorized integration fixture: browser" });
			await card.waitFor();
			const pipeline = card.locator(".gi-panel");
			await pipeline.locator(":scope > summary").click();
			await pipeline.locator("select").selectOption(target.bot.id);
			await pipeline.locator(".gi-prepare-form input[type=text]").fill(f.branch);
			await pipeline.getByRole("button", { name: /准备隔离集成|Prepare Isolated Integration/ }).click();
			await pipeline.getByText("prepared", { exact: true }).waitFor({ timeout: 30000 });
			await page.screenshot({ path: join(artifacts, "integration-browser-prepared.png"), fullPage: true });
			await pipeline.getByPlaceholder(/自定义验证命令|Custom command/).fill("node check.cjs");
			await pipeline.getByRole("button", { name: /运行所选命令|Run Selected/ }).click();
			await pipeline.getByText("verified", { exact: true }).waitFor({ timeout: 30000 });
			await pipeline.getByText(/LIVE_INTEGRATION_CHECK_OK/).waitFor();
			await page.screenshot({ path: join(artifacts, "integration-browser-verified.png"), fullPage: true });
			await pipeline.getByRole("button", { name: /确认合并写入|Confirm & Merge into/ }).click();
			await pipeline.getByText("applied", { exact: true }).waitFor({ timeout: 30000 });
			await page.screenshot({ path: join(artifacts, "integration-browser-applied.png"), fullPage: true });
			const { integrations } = await api(origin, `${f.path}/integrations`);
			assert.equal(integrations.at(-1).status, "applied");
			assert.equal(git(target.project, "rev-parse", f.branch), integrations.at(-1).newCommitSha);
			assert.equal(
				git(target.project, "rev-parse", `${f.branch}^{tree}`),
				git(author.project, "rev-parse", `${delivered}^{tree}`),
			);
		});
	else evidence.push({ skipped: "Chrome unavailable; HTTP/relay/runtime/Git checks remain required" });
	assert.deepEqual(snapshot(target.project), operatorBefore);
	assert.equal(await readFile(join(target.project, "sum.cjs"), "utf8"), operatorFile);
	assert.deepEqual(snapshot(author.project).status, "");
	assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
	console.log("PASS live group integration HTTP/relay/runtime/Git pipeline");
} catch (error) {
	failures.push({ name: "suite", error: error.stack ?? String(error) });
	console.error(error.stack ?? error);
	process.exitCode = 1;
} finally {
	if (failures.length && page)
		await page.screenshot({ path: join(artifacts, "integration-browser-final.png"), fullPage: true }).catch(() => {});
	await browser?.close();
	for (const d of devices) {
		if (d.child && d.child.exitCode === null && d.child.signalCode === null) {
			d.child.kill("SIGTERM");
			await Promise.race([new Promise((resolve) => d.child.once("exit", resolve)), delay(5000)]);
			if (d.child.exitCode === null && d.child.signalCode === null) {
				d.child.kill("SIGKILL");
				await new Promise((resolve) => d.child.once("exit", resolve));
			}
		}
		await writeFile(join(artifacts, `integration-${d.role}-server.log`), d.logs).catch(() => {});
	}
	hub?.server.closeAllConnections();
	await hub?.close();
	await writeFile(
		join(artifacts, "integration-live-report.json"),
		JSON.stringify(
			{ fixture: "Explicit accepted delivery metadata; no LLM", base, delivered, evidence, failures },
			null,
			2,
		),
	).catch(() => {});
	await rm(temp, { recursive: true, force: true });
}
