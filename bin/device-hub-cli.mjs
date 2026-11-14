import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { request } from "node:http";
import {
	mkdirSync,
	appendFileSync,
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	existsSync,
	rmdirSync,
	readdirSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { setTimeout as delay, setImmediate as yieldImmediate } from "node:timers/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HUB_HELP = `Usage: pi-web-ui hub [install|start|stop|restart|status|uninstall|update|https] [options]
Without a command, run in the foreground (Ctrl+C to stop).
Options: --host HOST --port PORT --public-url URL --data-dir PATH
         --allow-registration[=true|false] --https[=auto|off|external] --help
Public Linux installs configure trusted HTTPS and certificate renewal automatically.
Use --https=external with your own HTTPS proxy, or --https=off to retain HTTP.
hub https [--public-url https://ADDRESS] upgrades an existing Hub without re-pairing devices.
install saves configuration, enables login autostart and starts the Hub.
update installs the latest Hub package in a managed release directory, restarts and verifies it.
If the new release cannot start, the previous service definition is restored.
Other lifecycle commands use the saved configuration; status accepts --json.
Close registration after the first account: hub restart --allow-registration=false
Only that saved setting changes; all other settings are retained.
Registration is disabled unless explicitly enabled. Foreground mode also accepts PI_DEVICE_HUB_*.
Service: systemd --user (Linux), launchd user agent (macOS), logon scheduled task (Windows).
Linux boot without login requires an administrator to enable linger for your user.
uninstall stops and removes the service; Hub account/device data is retained.`;
const ENTRY = fileURLToPath(new URL("./pi-device-hub.mjs", import.meta.url));
const TASK = "pi-device-hub";
const UNIT = "pi-device-hub.service";
const flags = { "--host": "HOST", "--port": "PORT", "--public-url": "PUBLIC_URL", "--data-dir": "DATA_DIR" };
const optionalEnv = [
	"DEVICE_DOMAIN",
	"PATH_ACCESS",
	"PORTAL_PORTS",
	"UPDATE_SOURCE",
	"SERVICE_NAME",
	"LEGACY_ORIGINS",
	"HTTPS",
];

export function parseHubArgs(argv, env = process.env) {
	const args = [...argv];
	const command = args[0] && !args[0].startsWith("-") ? args.shift() : "foreground";
	if (
		!["foreground", "install", "start", "stop", "restart", "status", "uninstall", "update", "https"].includes(command)
	)
		throw new Error(`Unknown Hub command: ${command}`);
	const values = {};
	let https;
	if (command === "status" && args.length === 1 && args[0] === "--json") return { command, json: true };
	if (command === "restart" && args.length === 1 && /^--allow-registration=(true|false)$/.test(args[0]))
		return { command, registration: args[0].endsWith("=true") ? "1" : "0" };
	for (let i = 0; i < args.length; i++) {
		const [key, ...rest] = args[i].split("=");
		if (key === "--help" || key === "-h") return { command, help: true };
		if (key === "--https" && command === "install") {
			https = rest.length ? rest.join("=") : "auto";
			if (!["auto", "off", "external"].includes(https)) throw new Error("--https expects auto, off or external");
			continue;
		}
		if (!["foreground", "install"].includes(command) && !(command === "https" && key === "--public-url"))
			throw new Error(`${command} accepts no options`);
		if (key === "--allow-registration") {
			const value = rest.length ? rest.join("=") : "true";
			if (!["true", "false"].includes(value)) throw new Error("--allow-registration expects true or false");
			values.ALLOW_REGISTRATION = value === "true" ? "1" : "0";
			continue;
		}
		if (!flags[key]) throw new Error(`Unknown Hub option: ${key}`);
		const value = rest.length ? rest.join("=") : args[++i];
		if (!value || value.startsWith("--") || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid value for ${key}`);
		values[flags[key]] = value;
	}
	if (command === "https") return { command, publicUrl: values.PUBLIC_URL };
	if (!["foreground", "install"].includes(command)) return { command };
	const settings = {};
	https ??= env.PI_DEVICE_HUB_HTTPS;
	if (https !== undefined && !["auto", "off", "external", "managed"].includes(https))
		throw new Error("Invalid PI_DEVICE_HUB_HTTPS setting");
	for (const key of [...Object.values(flags), ...optionalEnv]) {
		const value = values[key] ?? env[`PI_DEVICE_HUB_${key}`];
		if (value !== undefined) settings[`PI_DEVICE_HUB_${key}`] = value;
	}
	settings.PI_DEVICE_HUB_HOST ??= "127.0.0.1";
	if (https) settings.PI_DEVICE_HUB_HTTPS = https;
	settings.PI_DEVICE_HUB_PORT ??= "8790";
	settings.PI_DEVICE_HUB_DATA_DIR = resolve(settings.PI_DEVICE_HUB_DATA_DIR ?? join(homedir(), ".pi-device-hub"));
	settings.PI_DEVICE_HUB_ALLOW_REGISTRATION =
		values.ALLOW_REGISTRATION ?? (command === "foreground" && env.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1" ? "1" : "0");
	validateSettings(settings);
	return { command, settings, ...(https ? { https } : {}) };
}

function validateSettings(settings) {
	for (const value of Object.values(settings))
		if (typeof value !== "string" || /[\x00-\x1f]/.test(value)) throw new Error("Invalid Hub configuration value");
	if (!settings.PI_DEVICE_HUB_HOST) throw new Error("Hub host must not be empty");
	const port = settings.PI_DEVICE_HUB_PORT;
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid Hub port");
	if (!settings.PI_DEVICE_HUB_PUBLIC_URL) throw new Error("--public-url (or PI_DEVICE_HUB_PUBLIC_URL) is required");
	const url = new URL(settings.PI_DEVICE_HUB_PUBLIC_URL);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.origin !== settings.PI_DEVICE_HUB_PUBLIC_URL ||
		url.username ||
		url["pass" + "word"]
	)
		throw new Error("--public-url (or PI_DEVICE_HUB_PUBLIC_URL) must be a canonical HTTP(S) root origin");
}

const xml = (s) =>
	String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
export const windowsArg = (s) =>
	`"${String(s)
		.replace(/(\\*)"/g, '$1$1\\"')
		.replace(/(\\+)$/g, "$1$1")}"`;
const systemdArg = (s) =>
	`"${String(s)
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/%/g, "%%")
		.replace(/\$/g, () => "$$")}"`;

export function hubServicePlan({
	platform = process.platform,
	home = homedir(),
	env = process.env,
	node = process.execPath,
	entry = ENTRY,
	uid = process.getuid?.(),
	user = env.USERNAME,
} = {}) {
	const serviceName = env.PI_DEVICE_HUB_SERVICE_NAME || "pi-device-hub";
	if (!/^pi-device-hub(?:-[a-z0-9-]{1,48})?$/.test(serviceName)) throw new Error("Invalid Hub service name");
	const taskName = serviceName;
	const unitName = `${serviceName}.service`;
	const labelName = `com.xingshuyin.${serviceName}`;
	const root =
		platform === "win32"
			? join(env.APPDATA || join(home, "AppData", "Roaming"), `${serviceName}-cli`)
			: join(home, ".config", `${serviceName}-cli`);
	const config = join(root, "service.json");
	const args = [entry, "--service-config", config];
	const serviceOptions = { platform, home, env, node, uid, user };
	const UNIT = unitName,
		TASK = taskName,
		LABEL = labelName;
	if (platform === "linux")
		return {
			root,
			config,
			serviceOptions,
			file: join(home, ".config", "systemd", "user", UNIT),
			content: `[Unit]\nDescription=pi device Hub\nAfter=network.target\n\n[Service]\nExecStart=${[node, ...args].map(systemdArg).join(" ")}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
			manager: "systemctl",
			commands: {
				install: [
					["--user", "daemon-reload"],
					["--user", "enable", "--now", UNIT],
				],
				start: [["--user", "start", UNIT]],
				stop: [["--user", "stop", UNIT]],
				restart: [["--user", "restart", UNIT]],
				update: [
					["--user", "daemon-reload"],
					["--user", "restart", UNIT],
				],
				status: [["--user", "show", UNIT, "--property=ActiveState,SubState,UnitFileState"]],
				uninstall: [["--user", "disable", "--now", UNIT]],
			},
		};
	if (platform === "darwin") {
		const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
		const target = `gui/${uid}/${LABEL}`;
		return {
			root,
			config,
			file,
			serviceOptions,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${[node, ...args].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>StandardOutPath</key><string>${xml(join(root, "stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(join(root, "stderr.log"))}</string></dict></plist>\n`,
			manager: "launchctl",
			commands: {
				install: [["bootstrap", `gui/${uid}`, file]],
				start: [["bootstrap", `gui/${uid}`, file]],
				stop: [["bootout", target]],
				restart: [
					["bootout", target],
					["bootstrap", `gui/${uid}`, file],
				],
				update: [
					["bootout", target],
					["bootstrap", `gui/${uid}`, file],
				],
				status: [["print", target]],
				uninstall: [["bootout", target]],
			},
		};
	}
	if (platform === "win32") {
		if (!user) throw new Error("Cannot determine Windows task user");
		const identity = env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
		return {
			root,
			config,
			serviceOptions,
			file: join(root, "task.xml"),
			content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(identity)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(identity)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(windowsArg).join(" "))}</Arguments></Exec></Actions></Task>`,
			manager: "schtasks.exe",
			commands: {
				install: [
					["/Create", "/TN", TASK, "/XML", join(root, "task.xml")],
					["/Run", "/TN", TASK],
				],
				start: [["/Run", "/TN", TASK]],
				stop: [["/End", "/TN", TASK]],
				restart: [
					["/End", "/TN", TASK],
					["/Run", "/TN", TASK],
				],
				update: [
					["/End", "/TN", TASK],
					["/Create", "/TN", TASK, "/XML", join(root, "task.xml"), "/F"],
					["/Run", "/TN", TASK],
				],
				status: [["/Query", "/TN", TASK, "/V", "/FO", "LIST"]],
				uninstall: [
					["/End", "/TN", TASK],
					["/Delete", "/TN", TASK, "/F"],
				],
			},
		};
	}
	throw new Error(`Unsupported Hub service platform: ${platform}`);
}

function nativePhase(inspect, now) {
	const deadline = now() + 30000;
	return (file, args) => {
		const remaining = Math.floor(deadline - now());
		if (remaining <= 0) throw new Error("Hub native operation exceeded its 30s deadline");
		return inspect(file, args, { encoding: "utf8", windowsHide: true, timeout: remaining, killSignal: "SIGKILL" });
	};
}

async function yieldForCancellation(signal) {
	await yieldImmediate(undefined, { signal });
	await yieldImmediate(undefined, { signal });
	signal?.throwIfAborted();
}

export function assertServiceAbsent(plan, inspect = spawnSync, now = () => performance.now()) {
	const native = nativePhase(inspect, now);
	const result = native(
		plan.manager,
		plan.manager === "systemctl"
			? ["--user", "show", plan.commands.status?.[0]?.[2] ?? UNIT, "--property=LoadState", "--value"]
			: plan.commands.status[0],
	);
	if (result.error) throw result.error;
	if (plan.manager === "systemctl" && result.status === 0 && result.stdout.trim() === "not-found") return;
	if (plan.manager === "launchctl" && result.status !== 0 && /Could not find service/i.test(result.stderr)) return;
	if (plan.manager === "schtasks.exe") {
		const statusArgs = plan.commands.status?.[0];
		const taskName = (statusArgs ? statusArgs[statusArgs.indexOf("/TN") + 1] : TASK).replace(/'/g, "''");
		const script = `$s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $null=$s.GetFolder('\\').GetTask('${taskName}'); exit 0 } catch { if ($_.Exception.HResult -eq -2147024894) { exit 3 }; exit 4 }`;
		const check = native("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		if (!check.error && check.status === 3) return;
	}
	throw new Error("Hub service already exists or service absence could not be verified. Refusing to overwrite.");
}

export function assertPortAvailable(settings) {
	return new Promise((done, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(
			{ host: settings.PI_DEVICE_HUB_HOST, port: Number(settings.PI_DEVICE_HUB_PORT), exclusive: true },
			() => server.close((error) => (error ? reject(error) : done())),
		);
	});
}

export function probeHub(settings, signal) {
	signal?.throwIfAborted();
	return new Promise((done) => {
		const host =
			settings.PI_DEVICE_HUB_HOST === "::"
				? "::1"
				: settings.PI_DEVICE_HUB_HOST === "0.0.0.0"
					? "127.0.0.1"
					: settings.PI_DEVICE_HUB_HOST;
		const req = request(
			{
				signal,
				host,
				port: Number(settings.PI_DEVICE_HUB_PORT),
				path: "/health",
				headers: { Host: new URL(settings.PI_DEVICE_HUB_PUBLIC_URL).host },
				timeout: 1000,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
					if (body.length > 8192) req.destroy();
				});
				res.on("error", () => done(null));
				res.on("end", () => {
					try {
						const health = JSON.parse(body);
						done(
							res.statusCode === 200 && health.service === "pi-device-hub" && health.status === "ok" ? health : null,
						);
					} catch {
						done(null);
					}
				});
			},
		);
		req.on("socket", (socket) => {
			const rejectSelfConnection = () => {
				// A client ephemeral port can equal the stopped Hub's port (TCP self-connect).
				if (
					socket.localPort &&
					socket.localPort === socket.remotePort &&
					socket.localAddress === socket.remoteAddress
				) {
					socket.once("close", () => done(null));
					socket.resetAndDestroy();
				}
			};
			if (socket.connecting) socket.once("connect", rejectSelfConnection);
			else rejectSelfConnection();
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => done(null));
		req.end();
	});
}

async function waitForHub(settings, signal) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		const health = await probeHub(settings, signal);
		signal?.throwIfAborted();
		if (health) {
			if (
				health.instanceId !== settings.PI_DEVICE_HUB_INSTANCE_ID ||
				health.allowRegistration !== (settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1")
			)
				throw new Error("Hub health does not match the saved instance/configuration");
			return;
		}
		await delay(250, undefined, { signal });
	}
	throw new Error("Hub did not become healthy within 15 seconds; service configuration retained for diagnosis");
}

export function runManager(
	file,
	args,
	inspect = spawnSync,
	now = () => performance.now(),
	pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50),
) {
	const native = nativePhase(inspect, now);
	if (file === "launchctl" && ["bootout", "bootstrap"].includes(args[0])) {
		const target = args[0] === "bootout" ? args[1] : `${args[1]}/${basename(args[2], ".plist")}`;
		const state = native(file, ["print", target]);
		if (state.error) throw state.error;
		if (state.status === 0 && args[0] === "bootstrap") return "Hub is already loaded";
		if (state.status !== 0) {
			if (!/Could not find service/i.test(state.stderr))
				throw new Error(state.stderr || "Could not inspect launchd job");
			if (args[0] === "bootout") return "Hub is already stopped";
		}
	}
	if (file === "schtasks.exe" && args[0] === "/End") {
		// Stop must also cancel queued instances; /Run with IgnoreNew can otherwise keep the old action.
		const taskName = args[args.indexOf("/TN") + 1].replace(/'/g, "''");
		file = "powershell.exe";
		args = [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); $t=$f.GetTask('${taskName}'); if ($t.State -in @(2,4) -or $t.GetInstances(0).Count -gt 0) { $t.Stop(0) }; $clock=[Diagnostics.Stopwatch]::StartNew(); while ($true) { $t=$f.GetTask('${taskName}'); if ($t.State -in @(1,3) -and $t.GetInstances(0).Count -eq 0) { break }; if ($clock.ElapsedMilliseconds -ge 25000) { throw 'Hub scheduled task did not stop within 25s' }; Start-Sleep -Milliseconds 50 }`,
		];
	}
	const result = native(file, args);
	if (result.error || result.status !== 0)
		throw new Error(
			`${file} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`,
		);
	if (file === "launchctl" && args[0] === "bootout") {
		while (true) {
			const state = native(file, ["print", args[1]]);
			if (state.error) throw state.error;
			if (state.status !== 0) {
				if (/Could not find service/i.test(state.stderr)) break;
				throw new Error(state.stderr || "Could not confirm launchd job removal");
			}
			pause();
		}
	}
	return result.stdout?.trim();
}
export function acquireHubLock(
	root,
	{
		pid = process.pid,
		machine = hostname(),
		alive = (ownerPid) => {
			try {
				process.kill(ownerPid, 0);
				return true;
			} catch (error) {
				return error.code !== "ESRCH";
			}
		},
	} = {},
) {
	const lock = join(root, "lifecycle.lock");
	const token = randomUUID();
	const ownerFile = `owner-${token}.json`;
	try {
		mkdirSync(lock);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const files = readdirSync(lock);
		if (files.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(files[0]))
			throw new Error(`Hub lifecycle lock has unknown ownership: ${lock}`);
		const previousPath = join(lock, files[0]);
		const previous = JSON.parse(readFileSync(previousPath, "utf8"));
		if (
			previous.hostname !== machine ||
			!Number.isSafeInteger(previous.pid) ||
			previous.pid <= 0 ||
			previous.token !== files[0].slice(6, -5) ||
			alive(previous.pid)
		)
			throw new Error(`Hub lifecycle operation is locked by PID ${previous.pid}: ${lock}`);
		unlinkSync(previousPath);
		rmdirSync(lock);
		mkdirSync(lock);
	}
	const path = join(lock, ownerFile);
	try {
		writeFileSync(path, JSON.stringify({ pid, hostname: machine, token, createdAt: new Date().toISOString() }), {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		rmdirSync(lock);
		throw error;
	}
	return () => {
		unlinkSync(path);
		rmdirSync(lock);
	};
}

export async function runHubCliEntry(argv = process.argv.slice(2), options = {}) {
	if (!["install", "start", "stop", "restart", "status", "uninstall"].includes(argv[0]))
		return runHubCli(argv, options);
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Hub CLI cancelled; installed configuration is retained"));
	const onMessage = (message) => {
		if (message && typeof message === "object" && !Array.isArray(message) && message.type === "cancel-hub-operation")
			abort();
	};
	process.on("SIGTERM", abort);
	process.on("SIGINT", abort);
	process.on("message", onMessage);
	try {
		return await runHubCli(argv, { ...options, signal: controller.signal });
	} finally {
		process.off("SIGTERM", abort);
		process.off("SIGINT", abort);
		process.off("message", onMessage);
	}
}

function atomicWrite(path, content) {
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

export async function runHubCli(
	argv = process.argv.slice(2),
	{
		env = process.env,
		plan: suppliedPlan,
		run = runManager,
		inspect = spawnSync,
		log = console.log,
		foreground = runForeground,
		upgrade,
		httpsSetup,
		signal,
	} = {},
) {
	signal?.throwIfAborted();
	if (argv[0] === "--service-config") {
		if (argv.length !== 2) throw new Error("Invalid service configuration arguments");
		let hubPort;
		const record = (event, error) => {
			try {
				const at = new Date().toISOString();
				let tcp;
				if (
					process.platform === "win32" &&
					error?.code === "EADDRINUSE" &&
					Number.isInteger(error.port) &&
					error.port >= 1 &&
					error.port <= 65535
				) {
					try {
						const result = inspect(
							"powershell.exe",
							[
								"-NoProfile",
								"-NonInteractive",
								"-Command",
								`$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -LocalPort ${error.port} -ErrorAction SilentlyContinue | Select-Object -First 32 | ForEach-Object { [pscustomobject]@{state=[int]$_.State;pid=[int]$_.OwningProcess} }); ConvertTo-Json -InputObject $rows -Compress`,
							],
							{ encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 8192 },
						);
						if (result.status === 0) {
							const rows = JSON.parse(result.stdout);
							if (Array.isArray(rows))
								tcp = rows
									.slice(0, 32)
									.filter(
										(row) =>
											Number.isInteger(row?.state) &&
											row.state >= 1 &&
											row.state <= 12 &&
											Number.isSafeInteger(row?.pid) &&
											row.pid >= 0,
									)
									.map(({ state, pid }) => ({ state, pid }));
						}
					} catch {}
				}
				appendFileSync(
					join(dirname(resolve(argv[1])), "service-runtime.log"),
					`${JSON.stringify({
						at,
						event,
						pid: process.pid,
						version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
						...(error ? { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "STARTUP_FAILED" } : {}),
						...(Number.isInteger(error?.port) && error.port >= 1 && error.port <= 65535 ? { port: error.port } : {}),
						...(hubPort ? { hubPort } : {}),
						...(typeof error?.syscall === "string" && /^[a-z_]{1,32}$/.test(error.syscall)
							? { syscall: error.syscall }
							: {}),
						...(["127.0.0.1", "::1", "0.0.0.0", "::"].includes(error?.address) ? { address: error.address } : {}),
						...(tcp ? { tcp } : {}),
					})}\n`,
					{ mode: 0o600 },
				);
			} catch {}
		};
		record("starting");
		try {
			const settings = JSON.parse(readFileSync(argv[1], "utf8"));
			validateSettings(settings);
			hubPort = Number(settings.PI_DEVICE_HUB_PORT);
			const hub = await foreground({ ...settings, PI_DEVICE_HUB_SERVICE_CONFIG: resolve(argv[1]) });
			record("ready");
			return hub;
		} catch (error) {
			record("failed", error);
			throw error;
		}
	}
	const parsed = parseHubArgs(argv, env);
	if (parsed.help) return log(HUB_HELP);
	if (parsed.command === "foreground") return foreground(parsed.settings);
	const plan = suppliedPlan ?? hubServicePlan({ env });
	const command = parsed.command;
	const configureHttps = async () => {
		const { enableHubHttps } = await import("./hub-https.mjs");
		return (httpsSetup ?? enableHubHttps)({
			plan,
			publicUrl: parsed.publicUrl,
			run,
			probe: (settings) => probeHub(settings, signal),
			wait: (settings, restoring) => waitForHub(settings, restoring ? undefined : signal),
			signal,
			log,
		});
	};
	if (command === "https") {
		const release = acquireHubLock(plan.root);
		try {
			return await configureHttps();
		} finally {
			release();
		}
	}
	if (command === "update") {
		const performUpgrade = upgrade ?? (await import("./hub-upgrade.mjs")).updateInstalledHub;
		return performUpgrade({ plan, env, log, signal });
	}
	if (command === "status") {
		const installed = existsSync(plan.config);
		const settings = installed ? JSON.parse(readFileSync(plan.config, "utf8")) : undefined;
		const health = settings ? await probeHub(settings, signal) : null;
		signal?.throwIfAborted();
		const result = {
			schemaVersion: 1,
			service: "pi-device-hub",
			installed,
			running: !!health,
			owned: !!health && health.instanceId === settings?.PI_DEVICE_HUB_INSTANCE_ID,
			instanceId: settings?.PI_DEVICE_HUB_INSTANCE_ID ?? null,
			host: settings?.PI_DEVICE_HUB_HOST ?? null,
			port: settings ? Number(settings.PI_DEVICE_HUB_PORT) : null,
			publicUrl: settings?.PI_DEVICE_HUB_PUBLIC_URL ?? null,
			allowRegistration: settings ? settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1" : null,
			registration: {
				configured: settings ? settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1" : null,
				active: health?.allowRegistration ?? null,
			},
			dataDir: settings?.PI_DEVICE_HUB_DATA_DIR ?? null,
			configPath: plan.config,
			health,
		};
		log(parsed.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
		return result;
	}
	mkdirSync(plan.root, { recursive: true, mode: 0o700 });
	const releaseLock = acquireHubLock(plan.root);
	try {
		if (command === "install") {
			if (existsSync(plan.config) || existsSync(plan.file))
				throw new Error(
					`Hub service configuration already exists at ${plan.config}. Inspect with 'hub status --json'; recover with 'hub start' or 'hub restart'. To replace configuration, 'hub uninstall' first (data retained).`,
				);
			assertServiceAbsent(plan, inspect);
			await yieldForCancellation(signal);
			await assertPortAvailable(parsed.settings);
			signal?.throwIfAborted();
			parsed.settings.PI_DEVICE_HUB_INSTANCE_ID = randomUUID();
			mkdirSync(resolve(plan.file, ".."), { recursive: true });
			atomicWrite(plan.config, `${JSON.stringify(parsed.settings, null, 2)}\n`);
			atomicWrite(
				plan.file,
				process.platform === "win32" ? Buffer.from(`\uFEFF${plan.content}`, "utf16le") : plan.content,
			);
		} else if (!existsSync(plan.config))
			throw new Error("Hub service is not installed. Run pi-web-ui hub install first.");
		signal?.throwIfAborted();
		if (parsed.registration !== undefined) {
			const settings = JSON.parse(readFileSync(plan.config, "utf8"));
			validateSettings(settings);
			settings.PI_DEVICE_HUB_ALLOW_REGISTRATION = parsed.registration;
			atomicWrite(plan.config, `${JSON.stringify(settings, null, 2)}\n`);
		}
		let serviceMissing = false;
		if (command === "uninstall") {
			try {
				assertServiceAbsent(plan, inspect);
				serviceMissing = true;
			} catch {}
		}
		await yieldForCancellation(signal);
		for (const args of serviceMissing ? [] : plan.commands[command]) {
			signal?.throwIfAborted();
			const output = run(plan.manager, args);
			await yieldForCancellation(signal);
			signal?.throwIfAborted();
			if (output) log(output);
		}
		if (command === "uninstall") {
			if (existsSync(plan.file)) unlinkSync(plan.file);
			if (plan.manager === "systemctl") run(plan.manager, ["--user", "daemon-reload"]);
			unlinkSync(plan.config);
		}
		if (["install", "start", "restart", "update"].includes(command)) {
			const settings = JSON.parse(readFileSync(plan.config, "utf8"));
			await waitForHub(settings, signal);
		}
		if (command === "install" && !["off", "external"].includes(parsed.https)) {
			const { automaticHttps } = await import("./hub-https.mjs");
			if (parsed.https === "auto" || automaticHttps(parsed.settings.PI_DEVICE_HUB_PUBLIC_URL)) await configureHttps();
		}
		log(`Hub ${command} completed.${command === "uninstall" ? " Account/device data retained." : ""}`);
	} catch (error) {
		throw new Error(
			`${signal?.aborted ? signal.reason?.message || "Hub CLI cancelled" : error.message}\nHub configuration: ${plan.config}. Inspect: hub status --json; retry: hub restart. Windows scheduled tasks require Task Scheduler permissions; access denied means installation failed. Configuration is retained; hub uninstall removes it while retaining Hub data.`,
		);
	} finally {
		releaseLock();
	}
}

async function runForeground(settings) {
	const { startDeviceHub } = await import("../dist/server/device-center/main.js");
	const bootId = randomUUID();
	const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	const hub = await startDeviceHub({
		...settings,
		PI_DEVICE_HUB_BOOT_ID: bootId,
		PI_DEVICE_HUB_PACKAGE_ROOT: fileURLToPath(new URL("../", import.meta.url)),
	});
	hub.app.get("/health", (_req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json({
			schemaVersion: 1,
			service: "pi-device-hub",
			status: "ok",
			version,
			bootId,
			instanceId: settings.PI_DEVICE_HUB_INSTANCE_ID ?? null,
			publicUrl: settings.PI_DEVICE_HUB_PUBLIC_URL,
			port: Number(settings.PI_DEVICE_HUB_PORT),
			allowRegistration: settings.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1",
		});
	});
	let closing = false;
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			if (closing) return;
			closing = true;
			void hub.close().then(
				() => process.exit(0),
				(error) => {
					console.error(error.message);
					process.exit(1);
				},
			);
		});
	return hub;
}
