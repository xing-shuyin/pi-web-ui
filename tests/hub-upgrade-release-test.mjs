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
import {
	DIAGNOSTIC_LIMIT,
	createDiagnosticRedactor,
	summarizeUpgradeJob,
	summarizeLaunchctl,
	readLogTail,
	diagnosticCommand,
	observeUpgradeTerminal,
	submittedUpgradeJob,
} from "./lib/hub-upgrade-release.mjs";
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
	const redact = createDiagnosticRedactor(env);
	const report = {
		platform: process.platform,
		node: process.version,
		artifact: resolve(candidate),
		sha256: createHash("sha256")
			.update(await readFile(candidate))
			.digest("hex"),
		serviceName,
		checks: [],
		upgradeAttempts: [],
		state: "running",
		startedAt: new Date().toISOString(),
	};
	// This hash is derived from the candidate bytes, not from credentials or logs.
	const safeReport = () => ({ ...redact.json(report), sha256: report.sha256 });
	const checkpoint = async (name, details = {}) => {
		report.checks.push({ name, ...details });
		console.log(`[hub-release] ${name}`);
		await writeFile(join(output, "result.json"), JSON.stringify(safeReport(), null, 2));
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
		redact.remember(body);
		const response = await fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json", Connection: "close", ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
		});
		const result = await response.json();
		redact.remember(result);
		assert(response.ok, redact.text(`${path}: HTTP ${response.status}: ${JSON.stringify(result)}`));
		return { response, result };
	};
	const readJob = async () => {
		try {
			return JSON.parse(await readFile(join(dataDir, "hub-upgrade.json"), "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") return undefined;
			throw error;
		}
	};
	const browserUpgrade = async (page, expectedState) => {
		const previousJob = await readJob();
		const responsePromise = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/system/upgrade" && response.request().method() === "POST",
			{ timeout: 45_000 },
		);
		const [response] = await Promise.all([responsePromise, page.locator("#upgrade").click()]);
		const body = await response.json();
		const submittedJob = submittedUpgradeJob({
			status: response.status(),
			body,
			persistedJob: await readJob(),
			previousJobId: previousJob?.id,
			expectedState,
		});
		const attempt = { expectedState, httpStatus: response.status(), submittedJob };
		report.upgradeAttempts.push(attempt);
		await checkpoint("Browser upgrade submitted", { jobId: submittedJob.id, expectedState });
		return observeUpgradeTerminal({
			jobId: submittedJob.id,
			expectedState,
			readJob,
			readConnection: () =>
				page
					.locator("#connection")
					.textContent({ timeout: 1000 })
					.then((text) => text || "")
					.catch(() => "connection element unavailable"),
			onObservation: ({ job, connection }) => {
				attempt.lastJob = job;
				attempt.lastConnection = connection;
			},
		});
	};
	const collectFailureDiagnostics = async () => {
		const directory = join(output, "diagnostics");
		await mkdir(directory, { recursive: true });
		report.diagnostics = { directory: "diagnostics", files: [], errors: [] };
		const save = async (name, value) => {
			const safe = typeof value === "string" ? redact.text(value) : JSON.stringify(redact.json(value), null, 2);
			await writeFile(join(directory, name), Buffer.from(safe).subarray(0, DIAGNOSTIC_LIMIT));
			report.diagnostics.files.push(name);
		};
		const capture = async (name, action) => {
			try {
				await action();
			} catch (error) {
				report.diagnostics.errors.push({ name, error: redact.text(error.message) });
			}
		};
		// Learn credential values for redaction; never copy configuration or data.
		if (plan)
			await capture("redaction settings", async () => redact.remember(JSON.parse(await readFile(plan.config, "utf8"))));
		let job;
		await capture("upgrade job", async () => {
			job = await readJob();
			await save("upgrade-job.json", summarizeUpgradeJob(job));
		});
		await save("context.json", {
			platform: process.platform,
			node: process.version,
			nodeExecutable: process.execPath,
			uid: process.getuid?.(),
			serviceName,
			serviceManager: plan?.manager,
			npmCliPresent: existsSync(npm),
		});
		const logFiles = [
			...(plan
				? [
						["hub-stdout.log", join(plan.root, "stdout.log")],
						["hub-stderr.log", join(plan.root, "stderr.log")],
					]
				: []),
			["upgrade.log", join(dataDir, "hub-upgrade.log")],
			["upgrade-worker.log", join(dataDir, "hub-upgrade-worker.log")],
		];
		for (const [name, path] of logFiles)
			await capture(name, async () => {
				const tail = await readLogTail(path);
				await save(name, `${tail.truncated ? "[Earlier log content omitted]\n" : ""}${tail.text}`);
			});
		if (plan)
			await capture("service-runtime.log", async () => {
				const tail = await readLogTail(join(plan.root, "service-runtime.log"));
				const records = tail.text
					.split(/\r?\n/)
					.filter(Boolean)
					.map((line) => {
						try {
							const row = JSON.parse(line);
							return Object.fromEntries(
								["at", "event", "pid", "version", "code"]
									.filter((key) => ["string", "number"].includes(typeof row[key]))
									.map((key) => [key, row[key]]),
							);
						} catch {
							return { event: "unreadable runtime record" };
						}
					});
				await save("service-runtime.json", records);
			});
		await capture("commands.log", async () => {
			const tail = await readLogTail(join(output, "commands.log"));
			await writeFile(join(output, "commands.log"), Buffer.from(redact.text(tail.text)).subarray(0, DIAGNOSTIC_LIMIT));
		});
		const commands = [];
		const jobId = job?.id && /^[a-f0-9-]{36}$/.test(job.id) ? job.id : undefined;
		if (process.platform === "darwin") {
			const uid = process.getuid();
			for (const [role, label] of [
				["hub", `com.xingshuyin.${serviceName}`],
				...(jobId ? [["worker", `com.xingshuyin.pi-device-hub-update-${jobId}`]] : []),
			]) {
				for (const domain of ["gui", "user"])
					commands.push([`${role}-${domain}.json`, "launchctl", ["print", `${domain}/${uid}/${label}`], true]);
				commands.push([`${role}-submit-context.json`, "launchctl", ["list", label], true]);
			}
		} else if (process.platform === "linux") {
			for (const [role, unit] of [
				["hub", `${serviceName}.service`],
				...(jobId ? [["worker", `pi-device-hub-update-${jobId}.service`]] : []),
			]) {
				commands.push([
					`${role}-systemd.json`,
					"systemctl",
					[
						"--user",
						"show",
						unit,
						"--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MainPID,FragmentPath",
					],
				]);
				commands.push([
					`${role}-journal.json`,
					"journalctl",
					["--user", "-u", unit, "-n", "160", "--no-pager", "--output=short-iso"],
				]);
			}
		} else if (process.platform === "win32") {
			for (const [role, task] of [
				["hub", serviceName],
				...(jobId ? [["worker", `pi-device-hub-update-${jobId}`]] : []),
			]) {
				commands.push([
					`${role}-task.json`,
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`$ErrorActionPreference='Stop'; $t=Get-ScheduledTask -TaskName '${task}'; $i=$t|Get-ScheduledTaskInfo; [pscustomobject]@{State=[string]$t.State;LastTaskResult=$i.LastTaskResult;LastRunTime=$i.LastRunTime;NextRunTime=$i.NextRunTime}|ConvertTo-Json -Compress`,
					],
				]);
			}
		}
		for (const [name, file, args, launchctl] of commands)
			await capture(name, async () => {
				const result = await diagnosticCommand(file, args);
				if (launchctl) result.stdout = summarizeLaunchctl(result.stdout || "");
				await save(name, { command: [file, ...args], ...result });
			});
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
		redact.add(cookie);
		redact.add(cookie.slice(cookie.indexOf("=") + 1));
		const start = (await request("/api/pair/start", { name: "preserved-device" })).result;
		redact.add(start.code);
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
		const observedSuccess = await browserUpgrade(page, "succeeded");
		await page.screenshot({ path: join(output, "browser-upgrade-success.png"), fullPage: true });
		const secondHealth = (await request("/health")).result;
		assert.notEqual(secondHealth.bootId, firstHealth.bootId);
		assert.equal(secondHealth.version, candidateManifest.version);
		const successJob = (await request("/api/system/upgrade")).result.job;
		assert.equal(successJob.id, observedSuccess.id);
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
		const observedFailure = await browserUpgrade(page, "failed");
		await page.screenshot({ path: join(output, "browser-upgrade-failure.png"), fullPage: true });
		assert.equal((await request("/health")).result.bootId, secondHealth.bootId);
		const failedJob = (await request("/api/system/upgrade")).result.job;
		assert.equal(failedJob.id, observedFailure.id);
		assert.equal(failedJob.state, "failed");
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
		const observedRollback = await browserUpgrade(page, "failed");
		const rollbackJob = (await request("/api/system/upgrade")).result.job;
		assert.equal(rollbackJob.id, observedRollback.id);
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
		report.error = redact.text(error.stack || String(error));
		console.error(report.error);
		process.exitCode = 1;
	} finally {
		if (report.state === "failed")
			await collectFailureDiagnostics().catch((error) => {
				report.diagnosticsError = redact.text(error.message);
			});
		await browser?.close().catch(() => {});
		try {
			if (installed || (plan && existsSync(plan.config))) await cli.runHubCli(["uninstall"], { env, plan });
			if (plan) await rm(plan.root, { recursive: true, force: true });
		} catch (error) {
			report.cleanupError = redact.text(error.message);
			report.state = "failed";
			process.exitCode = 1;
		}
		report.completedAt = new Date().toISOString();
		await writeFile(join(output, "result.json"), JSON.stringify(safeReport(), null, 2));
		await writeFile(
			join(output, "result.md"),
			`# Hub 发布包升级验收\n\n状态：${report.state}\n\n平台：${report.platform} / Node ${report.node}\n\n候选包 SHA-256：\`${report.sha256}\`\n\n${report.checks.map((check) => `- ${check.name}`).join("\n")}\n\n${report.error ? `失败原因：\n\n\`\`\`\n${report.error}\n\`\`\`\n` : ""}${report.cleanupError ? `清理失败：${report.cleanupError}\n` : ""}`,
		);
		console.log(`[hub-release] ${report.state}: ${output}`);
		if (report.state === "passed") await rm(work, { recursive: true, force: true });
	}
}
