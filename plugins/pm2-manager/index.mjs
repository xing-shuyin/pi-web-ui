import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * pm2 的 JS 入口候选（按优先级）。全部是「用 process.execPath 直接跑」的候选：
 * npm 全局装的包必然落在 node 前缀下的 node_modules/pm2/bin/pm2，
 * 于是不需要 shell、不需要 PATH、Windows 上也不碰 .cmd 垫片。
 * @param {{ execPath?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {Array<{ bin: string, source: string }>}
 */
export function pm2EntryCandidates({ execPath, env = {} } = {}) {
	const out = [];
	const push = (bin, source) => {
		if (typeof bin === "string" && bin.trim() && !out.some((c) => c.bin === bin)) out.push({ bin, source });
	};
	const explicit = typeof env.PI_WEB_PM2 === "string" ? env.PI_WEB_PM2.trim() : "";
	if (explicit) push(explicit, "env:PI_WEB_PM2");
	if (typeof execPath === "string" && execPath) {
		const prefix = dirname(execPath);
		push(join(prefix, "node_modules", "pm2", "bin", "pm2"), "node-prefix");
		push(join(prefix, "..", "lib", "node_modules", "pm2", "bin", "pm2"), "node-prefix-unix");
	}
	if (typeof env.APPDATA === "string" && env.APPDATA.trim()) {
		push(join(env.APPDATA.trim(), "npm", "node_modules", "pm2", "bin", "pm2"), "npm-appdata");
	}
	const pathVal = typeof env.PATH === "string" ? env.PATH : typeof env.Path === "string" ? env.Path : "";
	if (pathVal) {
		const delimiter = process.platform === "win32" ? ";" : ":";
		for (const d of pathVal.split(delimiter)) {
			const dir = d.trim();
			if (!dir) continue;
			push(join(dir, "node_modules", "pm2", "bin", "pm2"), "path-node-modules");
			push(join(dir, "..", "lib", "node_modules", "pm2", "bin", "pm2"), "path-lib-node-modules");
		}
	}
	return out;
}

export const INSTALL_COMMAND = "npm i -g pm2";

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
	return String(text ?? "").replace(ANSI_RE, "");
}

export function parsePm2List(raw) {
	const list = Array.isArray(raw) ? raw : Array.isArray(raw?.apps) ? raw.apps : [];
	const out = [];
	for (const a of list) {
		if (!a || typeof a !== "object") continue;
		const env = a.pm2_env && typeof a.pm2_env === "object" ? a.pm2_env : {};
		const monit = a.monit && typeof a.monit === "object" ? a.monit : {};
		const name = typeof a.name === "string" && a.name ? a.name : "";
		if (!name) continue;
		out.push({
			name,
			status: typeof env.status === "string" ? env.status : "unknown",
			pid: Number.isFinite(Number(a.pid)) ? Number(a.pid) : 0,
			cpu: Number.isFinite(Number(monit.cpu)) ? Number(monit.cpu) : 0,
			memory: Number.isFinite(Number(monit.memory)) ? Number(monit.memory) : 0,
			restarts: Number.isFinite(Number(env.restart_time)) ? Number(env.restart_time) : 0,
			startedAt: Number.isFinite(Number(env.pm_uptime)) ? Number(env.pm_uptime) : 0,
			script: typeof env.pm_exec_path === "string" ? env.pm_exec_path : String(env.script ?? ""),
			cwd: typeof env.pm_cwd === "string" ? env.pm_cwd : "",
			mode: typeof env.exec_mode === "string" ? env.exec_mode : "fork",
		});
	}
	return out;
}

export function parsePm2ListOutput(text) {
	const clean = stripAnsi(text).trim();
	const starts = [];
	for (let i = 0; i < clean.length && starts.length < 32; i++) {
		const c = clean[i];
		if (c === "[" || c === "{") starts.push(i);
	}
	for (const from of starts) {
		try {
			return parsePm2List(JSON.parse(clean.slice(from)));
		} catch {}
	}
	return [];
}

export function formatBytes(bytes) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatUptime(startedAt, now = Date.now()) {
	const ms = Number(now) - Number(startedAt);
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function formatAppStatus(app, now = Date.now()) {
	if (!app || typeof app !== "object") return "";
	const parts = [String(app.status ?? "unknown")];
	if (app.status === "online") {
		parts.push(`CPU ${Number(app.cpu) || 0}%`);
		parts.push(`内存 ${formatBytes(app.memory)}`);
	}
	if (Number(app.restarts) > 0) parts.push(`↻${Number(app.restarts)}`);
	if (app.status === "online" && app.startedAt) parts.push(formatUptime(app.startedAt, now));
	return parts.join(" · ");
}

export function formatAppLine(app, now = Date.now()) {
	return [
		`- ${app.name} [${app.status}]`,
		`pid=${app.pid || "-"}`,
		`cpu=${Number(app.cpu) || 0}%`,
		`mem=${formatBytes(app.memory)}`,
		`restarts=${Number(app.restarts) || 0}`,
		`uptime=${app.status === "online" ? formatUptime(app.startedAt, now) : "-"}`,
		app.script ? `script=${app.script}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

const OUTPUT_CAP = 6000;
const PM2_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

function run(cmd, args, { timeoutMs = 20_000 } = {}) {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
			(err, stdout, stderr) => {
				resolve({
					ok: !err,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					error: err ? String(err.message ?? err) : "",
				});
			},
		);
	});
}

function resolveNpmCli() {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {}
	const guessed = join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
	return existsSync(guessed) ? guessed : null;
}

function clip(text, cap = OUTPUT_CAP) {
	const s = String(text ?? "");
	if (s.length <= cap) return s;
	const head = s.slice(0, Math.floor(cap * 0.7));
	const tail = s.slice(-Math.floor(cap * 0.25));
	return `${head}\n…（省略 ${s.length - head.length - tail.length} 字符）…\n${tail}`;
}

export default {
	activate(host) {
		const st = {
			pm2: { installed: false, bin: "", version: "", error: "" },
			apps: [],
			settings: {},
		};

		const readSettings = () => {
			let raw = {};
			try {
				raw = host.getSettings?.() ?? {};
			} catch {
				raw = {};
			}
			st.settings = {
				pm2Bin: typeof raw.pm2Bin === "string" ? raw.pm2Bin.trim() : "",
			};
			return st.settings;
		};
		readSettings();
		host.onSettingsChanged?.(() => {
			readSettings();
			void detectPm2();
			void refreshApps();
		});

		let inFlightDetect = null;
		const NEGATIVE_TTL_MS = 5 * 60 * 1000;
		let lastNegativeAt = 0;
		async function detectPm2({ deep = true } = {}) {
			if (inFlightDetect) return inFlightDetect;
			if (deep && !st.pm2.installed && Date.now() - lastNegativeAt < NEGATIVE_TTL_MS) {
				return st.pm2;
			}
			inFlightDetect = (async () => {
				try {
					const candidates = [];
					if (st.settings.pm2Bin) candidates.push({ bin: st.settings.pm2Bin, source: "settings" });
					candidates.push(...pm2EntryCandidates({ execPath: process.execPath, env: process.env }));
					const local = candidates.filter((c) => c.bin && existsSync(c.bin));
					const probe = [...local];
					if (deep && local.length === 0) {
						const npmCli = resolveNpmCli();
						if (npmCli) {
							const r = await run(process.execPath, [npmCli, "root", "-g"], { timeoutMs: 20_000 });
							const root = r.stdout.trim().split(/\r?\n/).pop() ?? "";
							if (root) probe.push({ bin: join(root, "pm2", "bin", "pm2"), source: "npm-root" });
						}
					}
					for (const c of probe) {
						if (!c.bin || !existsSync(c.bin)) continue;
						const r = await run(process.execPath, [c.bin, "-v"], { timeoutMs: 15_000 });
						const version = stripAnsi(`${r.stdout}${r.stderr}`).trim();
						if (r.ok && version) {
							st.pm2 = { installed: true, bin: c.bin, version, error: "" };
							lastNegativeAt = 0;
							return st.pm2;
						}
					}
					st.pm2 = {
						installed: false,
						bin: "",
						version: "",
						error: "未找到 pm2（可一键安装：" + INSTALL_COMMAND + "）",
					};
					lastNegativeAt = Date.now();
					return st.pm2;
				} finally {
					inFlightDetect = null;
				}
			})();
			return inFlightDetect;
		}

		async function pm2(args, opts) {
			if (!st.pm2.installed) {
				const d = await detectPm2();
				if (!d.installed) return { ok: false, output: "", error: d.error };
			}
			const r = await run(process.execPath, [st.pm2.bin, ...args], { timeoutMs: PM2_TIMEOUT_MS, ...opts });
			return {
				ok: r.ok,
				output: stripAnsi(r.ok ? r.stdout || r.stderr : r.stderr || r.stdout || r.error).trim(),
				error: r.ok ? "" : stripAnsi(r.stderr || r.error).trim(),
			};
		}

		async function listApps() {
			const r = await pm2(["jlist"]);
			if (!r.ok) return [];
			return parsePm2ListOutput(r.output);
		}

		async function installPm2() {
			const npmCli = resolveNpmCli();
			if (!npmCli) return { ok: false, output: "", error: "找不到 npm CLI，请手动执行：" + INSTALL_COMMAND };
			const r = await run(process.execPath, [npmCli, "i", "-g", "pm2"], { timeoutMs: INSTALL_TIMEOUT_MS });
			const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
			lastNegativeAt = 0;
			await detectPm2();
			if (!st.pm2.installed) {
				return {
					ok: false,
					output: clip(out),
					error: `安装后仍未找到 pm2，请检查 npm 全局 bin 是否在 PATH：${INSTALL_COMMAND}`,
				};
			}
			return { ok: true, output: clip(out || `pm2 ${st.pm2.version} 已安装`), error: "" };
		}

		let lastRefreshAt = 0;
		const REFRESH_CACHE_TTL_MS = 2500;

		async function refreshApps(force = false) {
			const now = Date.now();
			if (!force && lastRefreshAt && now - lastRefreshAt < REFRESH_CACHE_TTL_MS) {
				return st.apps;
			}
			st.apps = st.pm2.installed ? await listApps() : [];
			lastRefreshAt = Date.now();
			return st.apps;
		}

		const offTool = host.registerAgentTool({
			name: "pm2",
			label: "pm2 进程管家",
			description:
				"Run and supervise long-lived processes with pm2: list status, start a service under a name, " +
				"stop/restart/delete it, read its logs, or install pm2 when missing. One pm2 record per process " +
				"keeps every instance visible and stoppable after the shell exits.",
			promptSnippet: "supervise long-lived services and background tasks",
			promptGuidelines: [
				"Use action=start for every background or long-lived process (dev server, watcher, debug instance); never detach one with nohup, a trailing &, Windows start, Start-Process or a detached spawn",
				"Call action=list before launching another copy of the same service, and action=delete the instances you no longer need",
				"Read a supervised process's output with action=logs rather than leaving it unobserved",
			],
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["list", "start", "stop", "restart", "delete", "logs", "describe", "install", "version"],
						description: "The pm2 action to perform.",
					},
					name: {
						type: "string",
						description:
							"App name (required by stop/restart/delete/logs/describe; 'all' allowed for stop/restart/delete)",
					},
					script: { type: "string", description: "start: entry file or binary to run (e.g. server.js, npm, python)" },
					args: {
						type: "array",
						items: { type: "string" },
						description: "start: arguments passed to the script (e.g. ['run','dev'] for npm)",
					},
					cwd: { type: "string", description: "start: working directory for the app" },
					interpreter: { type: "string", description: "start: interpreter override (e.g. bash, python)" },
					lines: { type: "number", description: "logs: number of lines, default 60, max 500" },
				},
				required: ["action"],
			},
			async execute(_toolCallId, params) {
				const p = params && typeof params === "object" ? params : {};
				const action = String(p.action ?? "");
				const name = typeof p.name === "string" ? p.name.trim() : "";
				const needName = () => (!name ? `action=${action} 需要 name 参数。` : "");

				if (action === "install") {
					const r = await installPm2();
					await refreshApps(true);
					return r.ok
						? `pm2 已安装：${st.pm2.version}\n${clip(r.output, 1200)}`
						: `安装失败：${r.error}\n${clip(r.output, 1200)}`;
				}
				if (action === "version" || action === "list") {
					if (!st.pm2.installed) await detectPm2();
					if (action === "version") {
						return st.pm2.installed
							? `pm2 ${st.pm2.version}（入口 ${st.pm2.bin}）`
							: `pm2 未安装。可用 action=install 安装，或手动 ${INSTALL_COMMAND}。`;
					}
					const apps = await listApps();
					st.apps = apps;
					if (!apps.length) return "pm2 当前没有托管任何应用。";
					return apps.map((a) => formatAppLine(a)).join("\n");
				}
				if (action === "start") {
					const script = typeof p.script === "string" ? p.script.trim() : "";
					if (!script) return "action=start 需要 script 参数（入口文件或可执行名，如 server.js / npm）。";
					const appName =
						name ||
						script
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop()
							?.replace(/\.[^.]+$/, "") ||
						"app";
					const argv = ["start", script, "--name", appName];
					if (typeof p.interpreter === "string" && p.interpreter.trim())
						argv.push("--interpreter", p.interpreter.trim());
					if (typeof p.cwd === "string" && p.cwd.trim()) argv.push("--cwd", p.cwd.trim());
					const extra = Array.isArray(p.args) ? p.args.map(String).filter((s) => s !== "") : [];
					if (extra.length) argv.push("--", ...extra);
					const r = await pm2(argv);
					await refreshApps(true);
					return r.ok
						? `已用 pm2 托管 ${appName}：\n${clip(r.output, 1500)}`
						: `启动失败：${r.error || r.output}\n命令：pm2 ${argv.join(" ")}`;
				}
				if (action === "logs") {
					const miss = needName();
					if (miss) return miss;
					const n = Math.min(500, Math.max(1, Number(p.lines) || 60));
					const r = await pm2(["logs", name, "--nostream", "--lines", String(n)]);
					return r.ok ? clip(r.output) : `读取日志失败：${r.error}`;
				}
				if (action === "describe") {
					const miss = needName();
					if (miss) return miss;
					const r = await pm2(["describe", name]);
					return r.ok ? clip(r.output, 3000) : `查询失败：${r.error}`;
				}
				if (action === "stop" || action === "restart" || action === "delete") {
					const miss = needName();
					if (miss) return miss;
					const r = await pm2([action, name]);
					await refreshApps(true);
					return r.ok ? `已 ${action} ${name}：\n${clip(r.output, 800)}` : `操作失败：${r.error || r.output}`;
				}
				return `未知 action：${action || "(空)"}。可用：list/start/stop/restart/delete/logs/describe/install/version。`;
			},
		});

		const statusPayload = async (force = false) => {
			if (!st.pm2.installed) await detectPm2({ deep: true });
			await refreshApps(force);
			return {
				ok: true,
				installed: st.pm2.installed,
				version: st.pm2.version,
				bin: st.pm2.bin,
				error: st.pm2.error,
				installCommand: INSTALL_COMMAND,
				apps: st.apps,
				platform: process.platform,
			};
		};
		const offStatus = host.route("GET", "/status", (_req, res) => {
			void statusPayload().then((payload) => res.json(payload));
		});
		const offInstall = host.route("POST", "/install", (_req, res) => {
			void installPm2()
				.then(() => statusPayload(true))
				.then((payload) => res.json(payload))
				.catch((err) => res.json({ ok: false, error: String(err?.message ?? err) }));
		});
		const offAction = host.route("POST", "/action", (req, res) => {
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const action = String(body.action ?? "");
			const name = String(body.name ?? "");
			const argv = ["logs", "describe"].includes(action)
				? [
						action,
						name,
						...(action === "logs" ? ["--nostream", "--lines", String(Math.min(500, Number(body.lines) || 60))] : []),
					]
				: [action, name];
			if (!["stop", "restart", "delete", "logs", "describe"].includes(action) || !name) {
				res.json({ ok: false, error: "非法操作" });
				return;
			}
			void pm2(argv)
				.then(async (r) => {
					const payload = await statusPayload(true);
					res.json({ ...payload, ok: r.ok, output: clip(r.output, 4000), error: r.ok ? "" : r.error });
				})
				.catch((err) => res.json({ ok: false, error: String(err?.message ?? err) }));
		});
		void (async () => {
			await detectPm2({ deep: false });
			await refreshApps();
			host.log(
				`pm2-manager activated（pm2 ${st.pm2.installed ? st.pm2.version : "未安装"}，平台 ${process.platform}）`,
			);
		})();

		return () => {
			for (const off of [offTool, offStatus, offInstall, offAction]) {
				try {
					off?.();
				} catch {}
			}
			host.log("pm2-manager deactivated");
		};
	},
};
