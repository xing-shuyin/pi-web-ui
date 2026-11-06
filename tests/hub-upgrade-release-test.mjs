#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
const args = process.argv.slice(2);
const option = (key) => {
	const i = args.indexOf(key);
	return i < 0 ? undefined : args[i + 1];
};
const candidate = option("--candidate");
if (!candidate)
	throw new Error(
		"Usage: node tests/hub-upgrade-release-test.mjs --candidate FILE.tgz [--baseline pi-web-ui@VERSION] [--output DIR] [--background]",
	);
const output = resolve(
	option("--output") || (await mkdtemp(join(process.env.PI_HUB_TEST_TMP || tmpdir(), "hub-release-results-"))),
);
await mkdir(output, { recursive: true });
if (args.includes("--background")) {
	const fd = openSync(join(output, "acceptance.log"), "a");
	const nextArgs = args.filter((arg) => arg !== "--background");
	if (!option("--output")) nextArgs.push("--output", output);
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...nextArgs], {
		detached: true,
		windowsHide: true,
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	child.unref();
	console.log(JSON.stringify({ pid: child.pid, output }));
} else {
	const npm = [
		join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
		join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
	].find(existsSync);
	if (!npm) throw new Error("npm is required beside Node");
	const work = await mkdtemp(join(process.env.PI_HUB_TEST_TMP || tmpdir(), "hub-service-smoke-"));
	const serviceName = `pi-device-hub-smoke-${randomUUID().slice(0, 8)}`;
	const env = {
		...process.env,
		PI_DEVICE_HUB_SERVICE_NAME: serviceName,
		PI_DEVICE_HUB_UPDATE_SOURCE: resolve(candidate),
	};
	const report = {
		platform: process.platform,
		node: process.version,
		artifact: resolve(candidate),
		sha256: createHash("sha256")
			.update(await readFile(candidate))
			.digest("hex"),
		serviceName,
		checks: [],
		state: "running",
		startedAt: new Date().toISOString(),
	};
	const checkpoint = async (name, details = {}) => {
		report.checks.push({ name, ...details });
		console.log(`[hub-release] ${name}`);
		await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
	};
	const run = (argv, { cwd = work, timeout = 10 * 60_000 } = {}) =>
		new Promise((done, reject) => {
			const fd = openSync(join(output, "commands.log"), "a");
			const child = spawn(process.execPath, argv, { cwd, env, windowsHide: true, stdio: ["ignore", fd, fd] });
			closeSync(fd);
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("Acceptance command timed out; see commands.log"));
			}, timeout);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) done();
				else reject(new Error(`Acceptance command exited ${code}; see commands.log`));
			});
		});
	let cli,
		plan,
		installed = false,
		browser;
	const dataDir = join(work, "data");
	await mkdir(dataDir);
	const portServer = createServer();
	await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
	const port = portServer.address().port;
	await new Promise((done) => portServer.close(done));
	const base = `http://127.0.0.1:${port}`;
	let cookie = "";
	const request = async (path, body, headers = {}) => {
		const response = await fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json", Connection: "close", ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
		});
		const result = await response.json();
		assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
		return { response, result };
	};
	try {
		await checkpoint("Installing the exact candidate tarball and the published baseline");
		const candidatePrefix = join(work, "candidate"),
			baselinePrefix = join(work, "baseline");
		for (const [prefix, source] of [
			[candidatePrefix, resolve(candidate)],
			[baselinePrefix, option("--baseline") || "pi-web-ui@latest"],
		])
			await run([
				npm,
				"install",
				"--prefix",
				prefix,
				"--ignore-scripts",
				"--omit=dev",
				"--omit=optional",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
				source,
			]);
		const root = join(candidatePrefix, "node_modules/pi-web-ui"),
			baselineRoot = join(baselinePrefix, "node_modules/pi-web-ui");
		const candidateManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		const baselineManifest = JSON.parse(await readFile(join(baselineRoot, "package.json"), "utf8"));
		report.candidateVersion = candidateManifest.version;
		report.baselineVersion = baselineManifest.version;
		cli = await import(pathToFileURL(join(root, "bin/device-hub-cli.mjs")));
		plan = cli.hubServicePlan({ env, entry: join(baselineRoot, "bin/pi-device-hub.mjs") });
		await cli.runHubCli(
			[
				"install",
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--public-url",
				base,
				"--data-dir",
				dataDir,
				"--allow-registration",
			],
			{ env, plan },
		);
		installed = true;
		const registration = await request("/api/auth/register", {
			username: "release-owner",
			["pass" + "word"]: randomUUID(),
		});
		cookie = registration.response.headers.get("set-cookie").split(";")[0];
		const start = (await request("/api/pair/start", { name: "preserved-device" })).result;
		await request("/api/pair/approve", { code: start.code });
		const paired = (await request("/api/pair/poll", { pollToken: start.pollToken })).result;
		const botId = `bot-${randomUUID()}`;
		const botsResponse = await fetch(base + "/api/agent/bots", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": paired.deviceId,
				Authorization: `Bearer ${paired.credential}`,
			},
			body: JSON.stringify({
				bots: [{ id: botId, name: "preserved-bot", description: "", enabled: true, revision: 1 }],
			}),
		});
		assert(botsResponse.ok, "Baseline device registration failed");
		await botsResponse.text();
		const room = (await request("/api/rooms", { name: "Upgrade preservation", botIds: [botId] })).result.room;
		const baselineHealth = (await request("/health")).result;
		await checkpoint("Published baseline is running as a real service; account, device, Bot and group exist", {
			version: baselineManifest.version,
		});
		await run([join(root, "bin/pi-web-ui.mjs"), "hub", "update"]);
		const firstHealth = (await request("/health")).result;
		assert.equal(firstHealth.version, candidateManifest.version);
		assert.equal(typeof firstHealth.bootId, "string");
		assert.notEqual(firstHealth.bootId, baselineHealth.bootId);
		assert.equal(firstHealth.instanceId, baselineHealth.instanceId);
		assert((await request("/api/devices")).result.devices.some((device) => device.id === paired.deviceId));
		assert((await request("/api/rooms")).result.rooms.some((value) => value.id === room.id));
		await checkpoint("Legacy published service upgraded to the exact candidate; identity, login and data preserved", {
			version: firstHealth.version,
			bootId: firstHealth.bootId,
		});

		browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH || undefined });
		const context = await browser.newContext();
		const split = cookie.indexOf("=");
		await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }]);
		const page = await context.newPage();
		page.on("dialog", (dialog) => dialog.accept());
		await page.goto(base);
		await page.locator("#upgrade").waitFor({ state: "visible" });
		await page.locator("#upgrade").click();
		await page.waitForFunction(() => document.querySelector("#connection")?.textContent.includes("升级成功"), null, {
			timeout: 10 * 60_000,
		});
		await page.screenshot({ path: join(output, "browser-upgrade-success.png"), fullPage: true });
		const secondHealth = (await request("/health")).result;
		assert.notEqual(secondHealth.bootId, firstHealth.bootId);
		assert.equal(secondHealth.version, candidateManifest.version);
		const successJob = (await request("/api/system/upgrade")).result.job;
		assert.equal(successJob.state, "succeeded");
		assert.equal(successJob.version, candidateManifest.version);
		assert.equal(successJob.bootId, secondHealth.bootId);
		await checkpoint("Browser one-click update completed under the real service manager", {
			jobId: successJob.id,
			bootId: secondHealth.bootId,
		});
		await page.waitForTimeout(1600);
		await page.goto(base);
		await page.locator("#upgrade").waitFor({ state: "visible" });
		const saved = JSON.parse(await readFile(plan.config, "utf8"));
		await writeFile(
			plan.config,
			JSON.stringify({ ...saved, PI_DEVICE_HUB_UPDATE_SOURCE: join(work, "missing-release.tgz") }),
		);
		await page.locator("#upgrade").click();
		await page.waitForFunction(() => document.querySelector("#connection")?.textContent.includes("升级失败"), null, {
			timeout: 10 * 60_000,
		});
		await page.screenshot({ path: join(output, "browser-upgrade-failure.png"), fullPage: true });
		assert.equal((await request("/health")).result.bootId, secondHealth.bootId);
		assert.equal((await request("/api/system/upgrade")).result.job.state, "failed");
		await checkpoint("Package installation failure is visible to the user; old Hub stays online");

		const broken = join(work, "broken");
		await mkdir(broken, { recursive: true });
		for (const entry of await readdir(root))
			if (entry !== "node_modules") await cp(join(root, entry), join(broken, entry), { recursive: true });
		const mainPath = join(broken, "dist/server/device-center/main.js");
		const mainSource = await readFile(mainPath, "utf8");
		const replaced = mainSource.replace(
			/(export async function startDeviceHub\([^\n]*\) \{)/,
			'$1\nthrow new Error("Synthetic release startup failure");',
		);
		assert.notEqual(replaced, mainSource, "Broken-release startup injection failed");
		await writeFile(mainPath, replaced);
		const brokenManifest = JSON.parse(await readFile(join(broken, "package.json"), "utf8"));
		brokenManifest.version = "0.0.0-hub-smoke-broken";
		await writeFile(join(broken, "package.json"), JSON.stringify(brokenManifest));
		await run([npm, "pack", "--ignore-scripts", "--pack-destination", work], { cwd: broken });
		const brokenTar = join(
			work,
			(await readdir(work)).find((name) => name.endsWith("hub-smoke-broken.tgz")),
		);
		await writeFile(plan.config, JSON.stringify({ ...saved, PI_DEVICE_HUB_UPDATE_SOURCE: brokenTar }));
		await page.goto(base);
		await page.locator("#upgrade").click();
		await page.waitForFunction(() => document.querySelector("#connection")?.textContent.includes("升级失败"), null, {
			timeout: 10 * 60_000,
		});
		const rollbackJob = (await request("/api/system/upgrade")).result.job;
		assert.equal(rollbackJob.state, "failed");
		assert.match(rollbackJob.error, /previous Hub service restored/);
		const rollbackHealth = (await request("/health")).result;
		assert.equal(rollbackHealth.version, candidateManifest.version);
		assert.notEqual(rollbackHealth.bootId, secondHealth.bootId);
		assert((await request("/api/rooms")).result.rooms.some((value) => value.id === room.id));
		await page.screenshot({ path: join(output, "browser-upgrade-rollback.png"), fullPage: true });
		await checkpoint("Broken release was actually started, rejected, and rolled back; group data preserved");
		report.state = "passed";
	} catch (error) {
		report.state = "failed";
		report.error = error.stack || String(error);
		console.error(report.error);
		process.exitCode = 1;
	} finally {
		await browser?.close();
		try {
			if (installed || (plan && existsSync(plan.config))) await cli.runHubCli(["uninstall"], { env, plan });
			if (plan) await rm(plan.root, { recursive: true, force: true });
		} catch (error) {
			report.cleanupError = error.message;
			report.state = "failed";
			process.exitCode = 1;
		}
		report.completedAt = new Date().toISOString();
		await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
		await writeFile(
			join(output, "result.md"),
			`# Hub 发布包升级验收\n\n状态：${report.state}\n\n平台：${report.platform} / Node ${report.node}\n\n候选包 SHA-256：\`${report.sha256}\`\n\n${report.checks.map((check) => `- ${check.name}`).join("\n")}\n\n${report.error ? `失败原因：\n\n\`\`\`\n${report.error}\n\`\`\`\n` : ""}${report.cleanupError ? `清理失败：${report.cleanupError}\n` : ""}`,
		);
		console.log(`[hub-release] ${report.state}: ${output}`);
		if (report.state === "passed") await rm(work, { recursive: true, force: true });
	}
}
