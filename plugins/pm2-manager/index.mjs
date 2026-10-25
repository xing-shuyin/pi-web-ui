/**
 * pm2-manager 服务端入口 —— 用 pm2 统一托管「AI 起的后台任务」。
 *
 * 解决的现场问题：AI 调试时用 `nohup` / 尾部 `&` / `start /b` 起一堆后台实例，
 * 既不在任何列表里，也停不干净，CPU 被吃满（本机实测一次遗留 12 个 server 实例）。
 *
 * 两件事：
 *  1. **提示词引导**：注册单个 action 式 `pm2` 工具，description/snippet/guidelines 三处
 *     告诉模型「长期任务走 pm2 更省心」，不必猜；
 *  2. **同一面板**：宿主「后台任务」面板里就地内嵌一块「pm2 托管的应用」
 *     （`ui["tasks.panel"]` + `kind="view"`，与宿主自己 diff 出来的裸进程列表共存）；
 *     **不再**给每个应用注册 `registerBackgroundTask` —— 那会让同一个应用在面板里列两遍。
 *
 * 刻意**不接管** bash：本插件只提供工具与面板（想看就查、想管就管），不对 AI 的命令
 * 做任何拦截或追加提示 —— 是否把进程交给 pm2 由模型与用户自行决定。
 *
 * 跨平台：pm2 是 npm 全局包，三平台一致；调用一律走「process.execPath + pm2 的 JS 入口」
 * （`node_modules/pm2/bin/pm2`），避开 Windows 上 `pm2` 是 `.cmd` 垫片、execFile 直接跑会
 * EINVAL，以及服务化运行时 PATH 里没有全局 bin 的坑。Windows 唯一不支持的是 `pm2 startup`
 * 开机自启（官方限制），本插件不碰自启。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// ════════════════════════════════════════════════════════════════════════════
// 纯函数区（原 lib.mjs）：无副作用、可离线单测，单测直接从本文件 import。
// 刻意**内联**而不是单独成文件 —— 宿主 plugins_reload 只给 index.mjs 加
// `?e=<epoch>` 缓存击穿，被 index 静态 import 的兄弟模块会命中 Node 模块缓存，
// 改了不生效（必须重启服务），内联后改完 reload 即生效。
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// 1. pm2 可执行入口候选（跨平台）
// ────────────────────────────────────────────────────────────────────────────

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
		// Unix 下全局包常在 <prefix>/../lib/node_modules（fnm/nvm 布局）
		push(join(prefix, "..", "lib", "node_modules", "pm2", "bin", "pm2"), "node-prefix-unix");
	}
	// Windows 官方 npm 默认全局安装路径：%APPDATA%\npm\node_modules\pm2\bin\pm2
	if (typeof env.APPDATA === "string" && env.APPDATA.trim()) {
		push(join(env.APPDATA.trim(), "npm", "node_modules", "pm2", "bin", "pm2"), "npm-appdata");
	}
	// PATH 环境变量中的候选（fnm / nvm / pnpm / yarn / 系统 bin 等全局 node_modules 目录）
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

/** pm2 缺失时给用户/模型看的安装命令（npm 全局装；跨平台一致）。 */
export const INSTALL_COMMAND = "npm i -g pm2";

// ────────────────────────────────────────────────────────────────────────────
// 2. pm2 jlist 解析与展示格式化
// ────────────────────────────────────────────────────────────────────────────

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** 去掉 ANSI 颜色码（pm2 输出带色，进模型上下文前必须清掉）。 */
export function stripAnsi(text) {
	return String(text ?? "").replace(ANSI_RE, "");
}

/** 归一化 pm2 describe/jlist 的原始对象数组。 */
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

/** `pm2 jlist` 的 stdout → 归一化列表。
 *  容错：输出前面可能带 `[PM2] …` 之类的噪声行，于是从每个 `[`/`{` 起点依次试 JSON.parse，
 *  第一个解析成功的就采信（纯 JSON 输出时就是第一个字符）。 */
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
		} catch {
			/* 换下一个起点 */
		}
	}
	return [];
}

/** 字节 → 人类可读（面板/状态行用）。 */
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

/** 运行时长 → `3h12m` / `45s` / `2d4h`。 */
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

/** 后台任务面板里的一行状态：`online · CPU 12% · 内存 180MB · ↻2 · 3h12m`。 */
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

/** 给模型看的一行摘要（工具 list 的紧凑输出）。 */
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

/** 工具/面板输出上限（字符）：防 pm2 logs 把上下文撑爆。 */
const OUTPUT_CAP = 6000;
/** 单条 pm2 命令超时。 */
const PM2_TIMEOUT_MS = 30_000;
/** 全局安装 pm2 的超时（npm 可能要几十秒）。 */
const INSTALL_TIMEOUT_MS = 180_000;

/** execFile 的 Promise 包装（永不抛错，统一回结构）。 */
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

/** 找到能用的 npm CLI（优先 require 解析 npm 包内的 cli.js，免 shell；退回 node 前缀布局）。 */
function resolveNpmCli() {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {
		/* 继续找 */
	}
	const guessed = join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
	return existsSync(guessed) ? guessed : null;
}

/** 截断长输出（保留头尾，中间标注省略量）。 */
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
			/** pm2 探测结果：{installed, bin, version, error} */
			pm2: { installed: false, bin: "", version: "", error: "" },
			/** 最近一次同步出的应用列表（面板/工具共用，省一次 jlist）。 */
			apps: [],
			settings: {},
		};

		// ── 设置 ───────────────────────────────────────────────────────────
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

		// ── pm2 探测与调用 ─────────────────────────────────────────────────
		let inFlightDetect = null;
		// 「未安装」结论的负缓存 TTL：客户端面板每 3s 轮询 /status，未安装机器上
		// 每次 deep 探测都要起一次 `npm root -g` 子进程（Windows 上每次数百 ms～
		// 秒级 CPU/磁盘）——结论缓存一段时间；安装动作会主动清缓存立即重探。
		const NEGATIVE_TTL_MS = 5 * 60 * 1000;
		let lastNegativeAt = 0;
		/**
		 * 逐个候选入口试跑 `-v`：成功即认定安装。
		 * `deep:false`（激活时）只查本地已知布局，**不起任何子进程**——没装 pm2 的机器
		 * 启动时零开销；`deep:true` 才去问 `npm root -g`（要起子进程，按需触发）。
		 */
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
						// 全局 npm 根（node 前缀之外的布局，如系统 npm / nvm 的当前版本）
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

		/** 跑一条 pm2 命令。未安装时直接回失败（不 spawn）。 */
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

		/** 拉当前应用列表（jlist）。 */
		async function listApps() {
			const r = await pm2(["jlist"]);
			if (!r.ok) return [];
			return parsePm2ListOutput(r.output);
		}

		/** 全局安装 pm2（npm 全局装；跨平台一致，不需要 shell）。 */
		async function installPm2() {
			const npmCli = resolveNpmCli();
			if (!npmCli) return { ok: false, output: "", error: "找不到 npm CLI，请手动执行：" + INSTALL_COMMAND };
			const r = await run(process.execPath, [npmCli, "i", "-g", "pm2"], { timeoutMs: INSTALL_TIMEOUT_MS });
			const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
			lastNegativeAt = 0; // 刚装完立即重探，不吃「未安装」负缓存
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

		/** 当前应用列表（带 2.5s TTL 缓存防面板高频轮询开销；变更时传 force=true 强制刷新）。 */
		async function refreshApps(force = false) {
			const now = Date.now();
			if (!force && lastRefreshAt && now - lastRefreshAt < REFRESH_CACHE_TTL_MS) {
				return st.apps;
			}
			st.apps = st.pm2.installed ? await listApps() : [];
			lastRefreshAt = Date.now();
			return st.apps;
		}

		// ── AI 工具：单个 action 式 `pm2` ──────────────────────────────────
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

		// ── HTTP 路由（面板用）─────────────────────────────────────────────
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
		// ── 启动：探测 + 周期同步 ─────────────────────────────────────────
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
				} catch {
					/* ignore */
				}
			}
			host.log("pm2-manager deactivated");
		};
	},
};
