import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
	rmSync,
	openSync,
	closeSync,
	readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireHubLock, hubServicePlan, runManager, probeHub, windowsArg } from "./device-hub-cli.mjs";
import { readFileSyncRetry, writeAtomicFileSync } from "./lib/atomic-file.mjs";

const SELF = fileURLToPath(import.meta.url);
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;
export const jobPathFor = (dataDir) => join(resolve(dataDir), "hub-upgrade.json");
export function readUpgradeJob(path) {
	let text;
	try {
		text = readFileSyncRetry(path);
	} catch (error) {
		// 没有任务文件是正常情况；但 EPERM/EBUSY 这类瞬时占用已被 readFileSyncRetry 退避过，不再兜。
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	const job = JSON.parse(text);
	if (
		job.schemaVersion !== 1 ||
		typeof job.id !== "string" ||
		!/^[a-f0-9-]{36}$/.test(job.id) ||
		!["queued", "running", "succeeded", "failed"].includes(job.state)
	)
		throw new Error("Invalid Hub upgrade job");
	return job;
}
export function writeUpgradeJob(path, job) {
	// Windows 杀毒/索引器会短暂占用刚写完的文件，rename 报 EPERM/EBUSY 是瞬时状态：走 atomic-file 的退避重试。
	writeAtomicFileSync(path, `${JSON.stringify(job, null, 2)}\n`, {
		nonce: `${process.pid}.${randomUUID()}`,
		mode: 0o600,
		fsync: true,
	});
}
function planForJob(job) {
	const env = { ...process.env, PI_DEVICE_HUB_SERVICE_NAME: job.serviceName ?? "pi-device-hub" };
	if (job.serviceConfigPath === undefined) return hubServicePlan({ env });
	if (typeof job.serviceConfigPath !== "string" || !isAbsolute(job.serviceConfigPath))
		throw new Error("Invalid Hub service configuration path in upgrade job");
	const config = resolve(job.serviceConfigPath);
	const root = dirname(config);
	// Native workers inherit the service manager's environment, not the submitting CLI's HOME/APPDATA.
	const plan = hubServicePlan(
		process.platform === "win32" ? { env: { ...env, APPDATA: dirname(root) } } : { env, home: dirname(dirname(root)) },
	);
	if (resolve(plan.config) !== config) throw new Error("Upgrade job configuration is not a Hub service path");
	return plan;
}
function installedSettings(plan, job) {
	if (!existsSync(plan.config)) throw new Error("Hub service is not installed; install it before updating");
	const settings = JSON.parse(readFileSync(plan.config, "utf8"));
	if (
		job &&
		(settings.PI_DEVICE_HUB_INSTANCE_ID !== job.instanceId ||
			(settings.PI_DEVICE_HUB_SERVICE_NAME ?? "pi-device-hub") !== (job.serviceName ?? "pi-device-hub") ||
			resolve(settings.PI_DEVICE_HUB_DATA_DIR) !== dirname(resolve(job.path)))
	)
		throw new Error("Upgrade job does not belong to this installed Hub");
	return settings;
}

export function execute(file, args, { timeout = 10 * 60_000, logPath, env = process.env, signal } = {}) {
	return new Promise((resolveCommand, reject) => {
		let output = "";
		const fd = logPath ? openSync(logPath, "a", 0o600) : undefined;
		let child;
		try {
			child = spawn(file, args, { env, signal, windowsHide: true, stdio: ["ignore", fd ?? "pipe", fd ?? "pipe"] });
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			return reject(error);
		}
		if (fd !== undefined) closeSync(fd);
		for (const stream of [child.stdout, child.stderr])
			stream?.on("data", (chunk) => {
				output = (output + chunk).slice(-8192);
			});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Hub upgrade command timed out"));
		}, timeout);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolveCommand(output.trim());
			else
				reject(
					new Error(
						`Hub upgrade command failed (${code ?? signal})${logPath ? `; see ${logPath}` : `: ${output.trim()}`}`,
					),
				);
		});
	});
}
export function independentWorkerPlan(
	jobPath,
	{
		platform = process.platform,
		node = process.execPath,
		worker = SELF,
		id = randomUUID(),
		uid = process.getuid?.() ?? 0,
	} = {},
) {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Hub upgrade worker id");
	const args = [worker, "--run", resolve(jobPath)];
	if (platform === "linux")
		return {
			file: "systemd-run",
			args: ["--user", "--collect", `--unit=pi-device-hub-update-${id}`, "--property=Type=exec", node, ...args],
		};
	if (platform === "darwin") {
		if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("Invalid Hub upgrade worker uid");
		const label = `com.xingshuyin.pi-device-hub-update-${id}`;
		const plist = join(dirname(resolve(jobPath)), `${label}.plist`);
		const log = join(dirname(resolve(jobPath)), "hub-upgrade-worker.log");
		const xml = (value) =>
			String(value).replace(
				/[<>&"']/g,
				(c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c],
			);
		return {
			file: "launchctl",
			args: ["bootstrap", `gui/${uid}`, plist],
			target: `gui/${uid}/${label}`,
			definition: {
				path: plist,
				content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${[node, ...args].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><true/><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`,
			},
		};
	}
	if (platform === "win32") {
		const task = `pi-device-hub-update-${id}`;
		const quote = (s) => `'${s.replace(/'/g, "''")}'`;
		const winArg = (s) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
		const script = `$ErrorActionPreference='Stop'; $a=New-ScheduledTaskAction -Execute ${quote(node)} -Argument ${quote(args.map(winArg).join(" "))}; $s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Settings $s -User $u -RunLevel Limited -Force | Out-Null; Start-ScheduledTask -TaskName ${quote(task)};`;
		return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], task };
	}
	throw new Error(`Hub updates are unsupported on ${platform}`);
}
export async function launchUpgradeJob(
	path,
	{ plan, run = execute, probe = probeHub, sleep = delay, ...options } = {},
) {
	const job = readUpgradeJob(path);
	if (!job || job.state !== "queued") throw new Error("Hub upgrade job is not queued");
	plan ??= planForJob(job);
	const settings = installedSettings(plan, { ...job, path });
	const health = await probe(settings);
	if (!health || health.instanceId !== job.instanceId || health.bootId !== job.fromBootId)
		throw new Error("Hub process changed before upgrade submission");
	const launch = independentWorkerPlan(path, { ...options, id: job.id });
	let definitionCreated = false;
	let submissionAttempted = false;
	try {
		if (launch.definition) {
			writeFileSync(launch.definition.path, launch.definition.content, { flag: "wx", mode: 0o600 });
			definitionCreated = true;
		}
		submissionAttempted = true;
		await run(launch.file, launch.args, { timeout: 30_000 });
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const current = readUpgradeJob(path);
			if (current?.id !== job.id) throw new Error("Hub upgrade job changed during submission");
			if (current.state === "failed") throw new Error(current.error || "Hub upgrade worker failed to start");
			if (current.state !== "queued") return;
			await sleep(100);
		}
		throw new Error("Hub upgrade worker did not start; inspect the system service manager");
	} catch (error) {
		if (submissionAttempted) {
			try {
				if (launch.target) {
					await run(launch.file, ["bootout", launch.target], { timeout: 30_000 });
				} else if (launch.task) {
					// Windows 分支没有 launch.target：Register-ScheduledTask 成功但 Start/worker
					// 没起来时，worker 不会执行 cleanupUpgradeWorker，计划任务会永久残留。
					await run("schtasks.exe", ["/Delete", "/TN", launch.task, "/F"], { timeout: 10_000 });
				}
			} catch {}
		}
		throw error;
	} finally {
		if (definitionCreated) rmSync(launch.definition.path, { force: true });
	}
}
function npmCli(node = process.execPath) {
	const candidates = [
		join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
		join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
	];
	const path = candidates.find(existsSync);
	if (!path) throw new Error("npm is required beside Node to update the Hub; install Node with npm and retry");
	return path;
}
async function installRelease(
	root,
	{ source = `${PACKAGE.name}@latest`, executeCommand = execute, env = process.env, logPath } = {},
) {
	const release = join(root, "releases", randomUUID());
	mkdirSync(release, { recursive: true, mode: 0o700 });
	try {
		await executeCommand(
			process.execPath,
			[
				npmCli(),
				"install",
				"--prefix",
				release,
				"--omit=dev",
				"--omit=optional",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
				source,
			],
			{ env, logPath },
		);
		const rootPath = join(release, "node_modules", PACKAGE.name);
		const pkg = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8"));
		if (pkg.name !== PACKAGE.name || typeof pkg.version !== "string")
			throw new Error("Installed Hub package identity does not match");
		const entry = join(rootPath, "bin/pi-device-hub.mjs");
		if (!existsSync(entry) || !existsSync(join(rootPath, "dist/server/device-center/main.js")))
			throw new Error("Installed package is missing the standalone Hub build");
		await executeCommand(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`await import(${JSON.stringify(pathToFileURL(join(rootPath, "dist/server/device-center/main.js")).href)})`,
			],
			{ env, logPath, timeout: 30_000 },
		);
		return { root: release, entry, version: pkg.version };
	} catch (error) {
		rmSync(release, { recursive: true, force: true });
		throw error;
	}
}
export async function waitForRelease(
	settings,
	{ version, fromBootId, legacy = false, probe = probeHub, timeout = 30_000, sleep = delay } = {},
) {
	const deadline = Date.now() + timeout;
	let observed = "unreachable";
	while (Date.now() < deadline) {
		const health = await probe(settings);
		observed = health
			? `instance=${health.instanceId === settings.PI_DEVICE_HUB_INSTANCE_ID ? "expected" : "other"}, registration=${health.allowRegistration === (settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1") ? "expected" : "other"}, version=${typeof health.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(health.version) && health.version.length <= 80 ? health.version : "missing/invalid"}, boot=${typeof health.bootId !== "string" ? "missing" : health.bootId === fromBootId ? "unchanged" : "changed"}`
			: "unreachable";
		if (
			health &&
			health.instanceId === settings.PI_DEVICE_HUB_INSTANCE_ID &&
			health.allowRegistration === (settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1") &&
			(legacy || (health.version === version && typeof health.bootId === "string" && health.bootId !== fromBootId))
		)
			return health;
		await sleep(250);
	}
	throw new Error(
		`Updated Hub did not start with expected version ${version}; old healthy processes do not count as a successful upgrade; last health: ${observed}`,
	);
}
export async function queryWindowsHubTcp(settings, { run = execute, timeout = 10_000, signal } = {}) {
	const port = Number(settings.PI_DEVICE_HUB_PORT);
	const host = settings.PI_DEVICE_HUB_HOST;
	if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof host !== "string" || !host)
		throw new Error("Invalid Windows Hub TCP endpoint");
	const quote = (s) => `'${s.replace(/'/g, "''")}'`;
	try {
		if (signal?.aborted) throw new Error("Cancelled");
		// CIM returns an empty array for no matches and throws on provider/query failures.
		const output = await run(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $literal=$null; if ([Net.IPAddress]::TryParse(${quote(host)}, [ref]$literal)) { $addresses=@($literal) } else { $addresses=@([Net.Dns]::GetHostAddresses(${quote(host)})) }; if ($addresses.Count -eq 0) { throw 'Hub host has no addresses' }; $keys=@($addresses | ForEach-Object { if ($_.IsIPv4MappedToIPv6) { $_.MapToIPv4().ToString() } else { $_.ToString() } }); $has4=@($keys | Where-Object { $_ -notmatch ':' }).Count -gt 0; $any4=$keys -contains '0.0.0.0'; $any6=$keys -contains '::'; $rows=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'LocalPort = ${port}' -ErrorAction Stop | Where-Object { $ip=[Net.IPAddress]::Parse($_.LocalAddress); if ($ip.IsIPv4MappedToIPv6) { $ip=$ip.MapToIPv4() }; $key=$ip.ToString(); $any6 -or ($any4 -and $ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) -or ($keys -contains $key) -or $key -eq '::' -or ($has4 -and $key -eq '0.0.0.0') } | Select-Object -First 32 | ForEach-Object { if ($null -eq $_.State -or $null -eq $_.OwningProcess) { throw 'Invalid TCP resource' }; [pscustomobject]@{state=[int]$_.State;pid=[long]$_.OwningProcess} }); ConvertTo-Json -InputObject $rows -Compress`,
			],
			{ timeout, signal },
		);
		if (signal?.aborted) throw new Error("Cancelled");
		const rows = JSON.parse(output);
		if (
			!Array.isArray(rows) ||
			rows.some(
				(row) =>
					!row || !Number.isSafeInteger(row.state) || row.state < 1 || !Number.isSafeInteger(row.pid) || row.pid < 0,
			)
		)
			throw new Error("Invalid TCP resource result");
		return rows.map(({ state, pid }) => ({ state, pid }));
	} catch {
		throw new Error(
			signal?.aborted ? "Windows Hub TCP handoff cancelled" : "Could not query Windows Hub TCP resources",
		);
	}
}
export async function waitForWindowsHubPort(
	settings,
	{ query = queryWindowsHubTcp, now = () => performance.now(), sleep = delay, signal, onState = () => {} } = {},
) {
	const deadline = now() + 4 * 60_000;
	let rows = [];
	let previousState;
	while (now() < deadline) {
		if (signal?.aborted) throw new Error("Windows Hub TCP handoff cancelled");
		const remaining = deadline - now();
		if (remaining <= 0) break;
		rows = await query(settings, { timeout: Math.min(10_000, remaining), signal });
		if (signal?.aborted) throw new Error("Windows Hub TCP handoff cancelled");
		if (now() >= deadline) break;
		const snapshot = JSON.stringify([...rows].sort((a, b) => a.state - b.state || a.pid - b.pid));
		if (snapshot !== previousState) {
			try {
				onState(rows);
			} catch {}
			previousState = snapshot;
		}
		if (rows.length === 0) return;
		const remainingSleep = deadline - now();
		if (remainingSleep <= 0) break;
		await sleep(Math.min(1000, remainingSleep), undefined, { signal });
	}
	throw new Error(
		`Windows Hub TCP resources did not drain within 4 minutes; state/pid=${JSON.stringify(rows.slice(0, 32))}`,
	);
}
function recordWindowsServiceFailure(plan, candidate, logPath, run) {
	if (plan.manager !== "schtasks.exe") return;
	try {
		const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
		const statusArgs = plan.commands.status[0];
		const taskIndex = statusArgs.indexOf("/TN");
		if (taskIndex < 0 || typeof statusArgs[taskIndex + 1] !== "string") throw new Error("Missing Hub task name");
		const task = statusArgs[taskIndex + 1];
		const expectedArgs = [candidate.entry, "--service-config", plan.config].map(windowsArg).join(" ");
		const output = run("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask(${quote(task)}); $a=$t.Definition.Actions.Item(1); [pscustomobject]@{state=[int]$t.State; instances=[int]$t.GetInstances(0).Count; lastTaskResult=[long]$t.LastTaskResult; expectedNode=($a.Path -eq ${quote(plan.serviceOptions?.node ?? process.execPath)}); expectedArguments=($a.Arguments -eq ${quote(expectedArgs)})} | ConvertTo-Json -Compress`,
		]);
		const status = JSON.parse(output);
		const record = { event: "windows-task-before-rollback" };
		for (const key of ["state", "instances", "lastTaskResult"])
			if (Number.isSafeInteger(status[key])) record[key] = status[key];
		for (const key of ["expectedNode", "expectedArguments"])
			if (typeof status[key] === "boolean") record[key] = status[key];
		appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	} catch {
		try {
			appendFileSync(logPath, '{"event":"windows-task-before-rollback","available":false}\n', { mode: 0o600 });
		} catch {}
	}
}
function retainWorkingReleases(plan, candidate, previousFile) {
	const releases = join(plan.root, "releases");
	if (resolve(dirname(candidate.root)) !== resolve(releases)) return;
	const activePath = join(plan.root, "active-release.json");
	let previous;
	try {
		previous = JSON.parse(readFileSync(activePath, "utf8")).current;
	} catch {}
	const previousText = previousFile.toString(process.platform === "win32" ? "utf16le" : "utf8");
	const knownPrevious =
		typeof previous === "string" && resolve(dirname(previous)) === resolve(releases) && previousText.includes(previous);
	writeUpgradeJob(activePath, { current: candidate.root, ...(knownPrevious ? { previous } : {}) });
	if (!knownPrevious) return;
	for (const entry of readdirSync(releases, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
		const path = join(releases, entry.name);
		if (path !== candidate.root && path !== previous) rmSync(path, { recursive: true, force: true });
	}
}
export async function runUpgradeJob(
	path,
	{
		plan,
		install = installRelease,
		run = runManager,
		probe = probeHub,
		wait = waitForRelease,
		portQuery = queryWindowsHubTcp,
		now = () => performance.now(),
		sleep = delay,
		signal,
		source = process.env.PI_DEVICE_HUB_UPDATE_SOURCE,
		log = console.log,
		readJob = readUpgradeJob,
		writeJob = writeUpgradeJob,
	} = {},
) {
	let job = readJob(path);
	if (!job || job.state !== "queued") throw new Error("Hub upgrade job is not queued");
	plan ??= planForJob(job);
	const update = (patch) => {
		const current = readJob(path);
		if (current?.id !== job.id) throw new Error("Hub upgrade job was replaced");
		job = { ...job, ...patch, updatedAt: Date.now() };
		writeJob(path, job);
	};
	let releaseLock;
	let previousFile;
	let changed = false;
	let verifiedHealthy = false;
	let candidate;
	const logPath = join(dirname(path), "hub-upgrade.log");
	const restart = async (settings, signal) => {
		for (const args of plan.commands.update) {
			await run(plan.manager, args);
			if (plan.manager === "schtasks.exe" && args[0] === "/End")
				await waitForWindowsHubPort(settings, {
					query: portQuery,
					now,
					sleep,
					signal,
					onState: (rows) =>
						appendFileSync(
							logPath,
							`[tcp-handoff] ${new Date().toISOString()} port=${Number(settings.PI_DEVICE_HUB_PORT)} state/pid=${JSON.stringify(rows.slice(0, 32))}\n`,
						),
				});
		}
	};
	try {
		const settings = installedSettings(plan, { ...job, path });
		releaseLock = acquireHubLock(plan.root);
		update({ state: "running", phase: "installing" });
		const before = await probe(settings);
		if (!before || before.instanceId !== job.instanceId || (before.bootId ?? "legacy") !== job.fromBootId)
			throw new Error("Hub ownership or process changed before upgrade");
		previousFile = readFileSync(plan.file);
		writeFileSync(join(plan.root, "service.previous"), previousFile, { mode: 0o600 });
		writeFileSync(logPath, `Hub upgrade ${job.id}\n`, { mode: 0o600 });
		candidate = await install(plan.root, { source: settings.PI_DEVICE_HUB_UPDATE_SOURCE ?? source, logPath });
		if (plan.manager === "schtasks.exe") {
			const rows = await portQuery(settings, { timeout: 10_000, signal });
			appendFileSync(
				logPath,
				`[tcp-preflight] ${new Date().toISOString()} port=${Number(settings.PI_DEVICE_HUB_PORT)} state/pid=${JSON.stringify(rows.slice(0, 32))}\n`,
			);
		}
		update({ phase: "restarting", targetVersion: candidate.version });
		const next = hubServicePlan({ ...plan.serviceOptions, entry: candidate.entry });
		const temp = `${plan.file}.${job.id}.tmp`;
		writeFileSync(temp, process.platform === "win32" ? Buffer.from(`\uFEFF${next.content}`, "utf16le") : next.content, {
			mode: 0o600,
		});
		renameSync(temp, plan.file);
		changed = true;
		await restart(settings, signal);
		const health = await wait(settings, { version: candidate.version, fromBootId: job.fromBootId, probe });
		// 新版本已经探活成功：从这一刻起任何异常都不允许再触发回滚（见 catch 里的 verifiedHealthy 分支）。
		verifiedHealthy = true;
		try {
			retainWorkingReleases(plan, candidate, previousFile);
		} catch (error) {
			log(`Hub release cleanup deferred: ${error.message}`);
		}
		try {
			update({ state: "succeeded", phase: "completed", version: health.version, bootId: health.bootId });
		} catch (ledgerError) {
			// 成功路径的记账写失败（Windows 撞杀毒/服务句柄 EPERM）只降级记日志——
			// 让它抛出去会落进回滚分支，把刚验证健康的新版服务换回旧版。
			log(`Hub upgraded, but state write deferred (${ledgerError?.message ?? ledgerError})`);
		}
		log(`Hub upgraded to ${health.version}`);
		return job;
	} catch (error) {
		let reason = error instanceof Error ? error.message : String(error);
		// 回滚是「把旧服务救回来」，而给任务文件记状态只是记账。记账写不进去（Windows 上 rename 撞上杀毒/服务
		// 句柄就是 EPERM）绝不能把回滚本身拖掉：先恢复服务，元数据一律降级为尽力而为。
		const record = (patch) => {
			try {
				update(patch);
			} catch (metadataError) {
				log(`Hub upgrade state write deferred (${metadataError?.message ?? metadataError})`);
			}
		};
		if (verifiedHealthy) {
			// 升级已被探活验证：此时无论是记账还是收尾出错，都不该把健康的新版回滚掉。
			record({ state: "succeeded", phase: "completed", error: undefined });
			log(`Hub upgrade verified healthy; skipping rollback after late failure: ${reason}`);
			throw new Error(reason);
		}
		if (changed && previousFile) {
			recordWindowsServiceFailure(plan, candidate, logPath, run);
			record({ phase: "rolling-back" });
			try {
				const restore = `${plan.file}.${job.id}.rollback`;
				writeFileSync(restore, previousFile, { mode: 0o600 });
				renameSync(restore, plan.file);
				const settings = installedSettings(plan, { ...job, path });
				await restart(settings);
				await wait(settings, {
					version: job.fromVersion,
					fromBootId: job.fromBootId,
					legacy: job.fromVersion === "legacy",
					probe,
				});
				reason += "; previous Hub service restored";
			} catch (rollbackError) {
				reason += `; rollback failed: ${rollbackError.message}. Inspect hub status --json and hub-upgrade.log`;
			}
		}
		record({ state: "failed", phase: "failed", error: reason.slice(0, 4096) });
		throw new Error(job.error ?? reason);
	} finally {
		releaseLock?.();
	}
}
export async function updateInstalledHub({ plan = hubServicePlan(), log = console.log, ...options } = {}) {
	const settings = installedSettings(plan);
	const lockRoot = join(settings.PI_DEVICE_HUB_DATA_DIR, "hub-upgrade-submission");
	mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
	const releaseSubmission = acquireHubLock(lockRoot);
	try {
		const health = await (options.probe ?? probeHub)(settings);
		if (!health || health.instanceId !== settings.PI_DEVICE_HUB_INSTANCE_ID)
			throw new Error("A running Hub owned by the installed service is required before updating");
		const path = jobPathFor(settings.PI_DEVICE_HUB_DATA_DIR);
		const current = readUpgradeJob(path);
		if (current && ["queued", "running"].includes(current.state) && Date.now() - current.createdAt < UPGRADE_TIMEOUT_MS)
			throw new Error("Hub upgrade is already in progress");
		const now = Date.now();
		writeUpgradeJob(path, {
			schemaVersion: 1,
			id: randomUUID(),
			state: "queued",
			phase: "queued",
			createdAt: now,
			updatedAt: now,
			instanceId: health.instanceId,
			fromVersion: health.version ?? "legacy",
			fromBootId: health.bootId ?? "legacy",
			requestedBy: "local-cli",
			serviceConfigPath: resolve(plan.config),
			...(settings.PI_DEVICE_HUB_SERVICE_NAME ? { serviceName: settings.PI_DEVICE_HUB_SERVICE_NAME } : {}),
		});
		return await runUpgradeJob(path, { ...options, plan, log });
	} finally {
		releaseSubmission();
	}
}

export async function cleanupUpgradeWorker(path, { platform = process.platform, run = execute, ...options } = {}) {
	const job = readUpgradeJob(path);
	if (!job) return;
	if (platform === "darwin") {
		const launch = independentWorkerPlan(path, { ...options, platform, id: job.id });
		rmSync(launch.definition.path, { force: true });
		await run(launch.file, ["bootout", launch.target], { timeout: 10_000 });
	} else if (platform === "win32") {
		await run("schtasks.exe", ["/Delete", "/TN", `pi-device-hub-update-${job.id}`, "/F"], { timeout: 10_000 });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
	const [mode, path, ...extra] = process.argv.slice(2);
	try {
		if (!["--launch", "--run"].includes(mode) || !path || extra.length)
			throw new Error("Invalid Hub upgrade worker arguments");
		if (mode === "--launch") await launchUpgradeJob(resolve(path));
		else await runUpgradeJob(resolve(path));
	} catch (error) {
		console.error(`[hub-upgrade] ${error.message}`);
		process.exitCode = 1;
	} finally {
		if (mode === "--run") {
			try {
				await cleanupUpgradeWorker(path);
			} catch {}
		}
	}
}
