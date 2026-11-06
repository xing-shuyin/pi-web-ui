#!/usr/bin/env node
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";

const argSrv = process.argv.slice(2).find((a) => /^wss?:\/\//.test(a));
const SERVER = argSrv || "{{SERVER}}";
const TOKEN = process.env.PI_TUNNEL_TOKEN || "{{TOKEN}}";
const sockMap = new Map();
const ts = () => new Date().toTimeString().slice(0, 8);
const CLI_VER = "p16";
const SELF_PATH = process.argv[1] ? path.resolve(process.argv[1]) : "";
const CFG_FILE = path.join(homedir(), ".pi-tunnel-cli.json");
let piPath = "";
let taskBusy = false;

if (typeof WebSocket === "undefined") {
	console.error(`需要 Node >= 22 (全局 WebSocket)。当前 ${process.version}`);
	process.exit(1);
}

function selfUpdate(newVer) {
	if (!SELF_PATH || !fs.existsSync(SELF_PATH)) {
		console.log("[tunnel] 自更新跳过：无法定位自身文件");
		return;
	}
	const httpUrl = SERVER.replace(/^ws/, "http") + "/cli?token=" + encodeURIComponent(TOKEN);
	const req = http.get(httpUrl, (r) => {
		let code = "";
		r.on("data", (c) => (code += c));
		r.on("end", () => {
			try {
				if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
				if (!code.includes("CLI_VER") || code.length < 1000) throw new Error("内容校验失败");
				const tmp = SELF_PATH + ".tmp";
				fs.writeFileSync(tmp, code);
				fs.renameSync(tmp, SELF_PATH);
				console.log(`[tunnel] CLI ${CLI_VER} → ${newVer} 更新完成，2s 后退出重启加载新版…`);
				setTimeout(() => process.exit(0), 2000);
			} catch (e) {
				console.log("[tunnel] 自动更新失败，继续用当前版:", e.message);
			}
		});
	});
	req.on("error", (e) => console.log("[tunnel] 自动更新失败，继续用当前版:", e.message));
	req.setTimeout(15000, () => {
		req.destroy();
		console.log("[tunnel] 自动更新超时，继续用当前版");
	});
}

let cfg = { fsRead: true, fsWrite: false, whitelist: ["~/Downloads"] };
try {
	Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, "utf8")));
} catch {}
cfg.whitelist = (cfg.whitelist || []).map((p) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p));
cfg.whitelist = [...new Set(cfg.whitelist)];
const saveCfg = () => {
	try {
		fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
	} catch {}
};

const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);
function isRestrictedBrowsePath(targetPath) {
	if (!targetPath || typeof targetPath !== "string") return true;
	const norm = targetPath.trim().replace(/\\/g, "/");
	const blockedPrefixes = ["/etc", "/proc", "/sys", "/dev", "/var", "/root", "/boot", "/bin", "/sbin", "/usr"];
	if (norm === "/" || blockedPrefixes.some((p) => norm === p || norm.startsWith(p + "/"))) {
		return true;
	}
	const resolved = path.resolve(targetPath);
	const home = path.resolve(homedir());
	if (resolved === home || resolved.startsWith(home + path.sep)) return false;
	const plat = process.platform;
	if (plat === "darwin" && (resolved === "/Volumes" || resolved.startsWith("/Volumes/"))) return false;
	if (plat === "linux" && /^\/(media|mnt)($|\/)/.test(resolved)) return false;
	if (plat === "win32") {
		const isDrive = /^[a-zA-Z]:\\?/.test(resolved);
		const winSys = process.env.SystemRoot ? path.resolve(process.env.SystemRoot) : "C:\\Windows";
		if (resolved.toLowerCase().startsWith(winSys.toLowerCase())) return true;
		if (isDrive) return false;
	}
	if (blockedPrefixes.some((p) => resolved === p || resolved.startsWith(p + "/"))) return true;
	if (resolved === "/" || resolved === path.parse(resolved).root) return true;
	return true;
}
const inWhitelist = (p) => {
	const rp = path.resolve(p);
	return cfg.whitelist.some((w) => {
		const rw = path.resolve(w);
		return rp === rw || rp.startsWith(rw + path.sep);
	});
};
const json = (res, code, obj) => {
	try {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	} catch {}
};

const auditBuf = [];
const audit = (op, detail) => auditBuf.push({ ts: Date.now(), op, detail: String(detail).slice(0, 300) });

let devCache = null,
	devAt = 0;
function listDevices(cb) {
	if (devCache && Date.now() - devAt < 30000) return cb(null, devCache);
	const plat = os.platform();
	const out = { platform: plat, usb: [], disks: [] };
	const fin = () => {
		devCache = out;
		devAt = Date.now();
		cb(null, out);
	};
	const dfDisks = (done) =>
		execFile("df", ["-kP"], { timeout: 8000, maxBuffer: 1e6 }, (e, so) => {
			if (!e)
				for (const line of so.split("\n").slice(1)) {
					const c = line.trim().split(/\s+/);
					if (c.length >= 9) {
						const mnt = c.slice(8).join(" ");
						if (/^\/Volumes\//.test(mnt) || /\/media\/|\/mnt\//.test(mnt)) {
							out.disks.push({
								mount: mnt,
								totalGB: +(c[1] / 1048576).toFixed(1),
								usedGB: +(c[2] / 1048576).toFixed(1),
							});
						}
					}
				}
			done();
		});
	if (plat === "darwin") {
		execFile("system_profiler", ["SPUSBDataType", "-json"], { timeout: 12000, maxBuffer: 8e6 }, (_e, so) => {
			try {
				const j = JSON.parse(so);
				const walk = (items) =>
					(items ?? []).forEach((it) => {
						if (it._name && !/Bus$/i.test(it._name)) out.usb.push({ name: it._name, vendor: it.vendor_id ?? "" });
						if (it._items) walk(it._items);
					});
				for (const k of Object.keys(j)) walk(j[k]?._items);
			} catch {}
			dfDisks(fin);
		});
	} else if (plat === "linux") {
		execFile("lsusb", { timeout: 8000 }, (e, so) => {
			if (!e)
				out.usb = so
					.split("\n")
					.filter(Boolean)
					.map((l) => ({ name: l.split(/:\s+/).pop() ?? l }));
			dfDisks(fin);
		});
	} else {
		execFile(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \"$($_.DeviceID)|$([math]::Round($_.Size/1GB,1))|$([math]::Round($_.FreeSpace/1GB,1))\" }",
			],
			{ timeout: 12000 },
			(e, so) => {
				if (!e)
					for (const l of so.split("\n").filter(Boolean)) {
						const [mount, total, free] = l.split("|");
						out.disks.push({ mount, totalGB: +total, freeGB: +free });
					}
				fin();
			},
		);
	}
}

let ctrlPort = 0;
const ctrlSrv = http.createServer((req, res) => {
	if (req.headers["x-tunnel-token"] !== TOKEN) return json(res, 403, { error: "unauthorized" });
	const u = new URL(req.url, "http://local");
	try {
		if (u.pathname === "/health") {
			return json(res, 200, {
				ok: true,
				name: os.hostname(),
				os: `${os.platform()} ${os.release()} ${os.arch()}`,
				fsRead: !!cfg.fsRead,
				fsWrite: !!cfg.fsWrite,
				whitelist: cfg.whitelist,
			});
		}
		if (!cfg.fsRead) return json(res, 403, { error: "文件读取能力未开启（面板授权）" });
		if (u.pathname === "/fs/list") {
			const p = path.resolve(expandHome(u.searchParams.get("path") || homedir()));
			if (!inWhitelist(p)) {
				audit("fs.list.denied", p);
				return json(res, 403, { error: "path 不在白名单内" });
			}
			const entries = fs
				.readdirSync(p, { withFileTypes: true })
				.slice(0, 2000)
				.map((e) => {
					let size = 0,
						mtime = 0;
					try {
						const st = fs.statSync(path.join(p, e.name));
						size = st.size;
						mtime = st.mtimeMs;
					} catch {}
					return { name: e.name, dir: e.isDirectory(), size, mtime };
				});
			audit("fs.list", p);
			return json(res, 200, { path: p, entries });
		}
		if (u.pathname === "/fs/read") {
			const p = path.resolve(expandHome(u.searchParams.get("path")));
			if (!inWhitelist(p)) {
				audit("fs.read.denied", p);
				return json(res, 403, { error: "path 不在白名单内" });
			}
			const st = fs.statSync(p);
			if (st.isDirectory()) return json(res, 400, { error: "是目录，用 /fs/list" });
			if (st.size > 4 * 1024 * 1024) return json(res, 413, { error: "文件超 4MB（P2 支持大文件）" });
			audit("fs.read", p);
			return json(res, 200, { path: p, size: st.size, b64: fs.readFileSync(p).toString("base64") });
		}
		if (u.pathname === "/fs/write" && req.method === "POST") {
			if (!cfg.fsWrite) {
				audit("fs.write.denied", u.searchParams.get("path") || "");
				return json(res, 403, { error: "写开关未开启（面板授权）" });
			}
			let body = "";
			req.on("data", (c) => {
				body += c;
				if (body.length > 6 * 1024 * 1024) req.destroy();
			});
			req.on("end", () => {
				try {
					const { path: p, b64 } = JSON.parse(body || "{}");
					const rp = path.resolve(expandHome(p || ""));
					if (!inWhitelist(rp)) {
						audit("fs.write.denied", rp);
						return json(res, 403, { error: "path 不在白名单内" });
					}
					fs.writeFileSync(rp, Buffer.from(b64 || "", "base64"));
					audit("fs.write", rp);
					return json(res, 200, { ok: true, path: rp, size: Buffer.from(b64 || "", "base64").length });
				} catch (e) {
					return json(res, 400, { error: String(e.message || e) });
				}
			});
			return;
		}
		if (u.pathname === "/fs/browse") {
			if (!cfg.fsRead) {
				audit("fs.browse.denied", "");
				return json(res, 403, { error: "读开关未开启" });
			}
			const raw = u.searchParams.get("path") || "~";
			try {
				const p = path.resolve(expandHome(raw));
				if (isRestrictedBrowsePath(p)) {
					audit("fs.browse.denied", raw);
					return json(res, 403, { error: "系统保留或非允许目录禁止浏览" });
				}
				const dirs = fs
					.readdirSync(p, { withFileTypes: true })
					.filter((e) => e.isDirectory() && !e.name.startsWith("."))
					.map((e) => e.name)
					.sort();
				audit("fs.browse", raw);
				return json(res, 200, { path: p, parent: path.dirname(p), home: homedir(), dirs });
			} catch (e) {
				audit("fs.browse.denied", raw);
				return json(res, 400, { error: String(e.code || e.message || e) });
			}
		}
		if (u.pathname === "/sys/hw") {
			audit("sys.hw", "");
			const run = (cmd, args) =>
				new Promise((r) => execFile(cmd, args, { timeout: 5000 }, (e, so) => r(e ? "" : String(so).trim())));
			const dfRoot = async () => {
				const df = await run("df", ["-k", "/"]);
				const l2 = (df.split("\n")[1] || "").trim().split(/\s+/);
				const total = +l2[1],
					avail = +l2[3];
				return total ? `已用 ${((total - avail) / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} GB` : "";
			};
			(async () => {
				const plat = process.platform;
				const cpus = os.cpus();
				let model = "",
					osv = "",
					disk = "";
				try {
					if (plat === "darwin") {
						model = await run("sysctl", ["-n", "hw.model"]);
						osv = "macOS " + (await run("sw_vers", ["-productVersion"]));
						disk = await dfRoot();
					} else if (plat === "linux") {
						model = await run("cat", ["/sys/class/dmi/id/product_name"]);
						osv =
							(await run("cat", ["/etc/os-release"]).then((s) => (s.match(/PRETTY_NAME="(.*)"/) || [])[1])) ||
							os.release();
						disk = await dfRoot();
					} else {
						model =
							(await run("wmic", ["csproduct", "get", "name"]).then(
								(s) =>
									(s || "")
										.split("\n")
										.map((l) => l.trim())
										.filter(Boolean)[1],
							)) || "";
						osv = "Windows " + os.release();
					}
				} catch {}
				return json(res, 200, {
					model,
					osv,
					arch: os.arch(),
					cpu: (cpus[0]?.model || "").trim() || plat,
					cores: cpus.length,
					memGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
					disk,
					uptimeH: Math.round(os.uptime() / 360) / 10,
					load: os.loadavg().map((n) => Math.round(n * 100) / 100),
				});
			})();
			return;
		}
		if (u.pathname === "/task" && req.method === "POST") {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				let prompt = "",
					tools = "read,grep,glob",
					env = {},
					timeoutS = 300,
					model = "",
					mesh = false,
					msgId = "",
					from = "";
				try {
					const j = JSON.parse(body || "{}");
					prompt = String(j.prompt ?? "").slice(0, 4000);
					tools = String(j.tools ?? "read,grep,glob");
					env = j.env && typeof j.env === "object" ? j.env : {};
					timeoutS = Math.min(Math.max(+j.timeoutS || 300, 30), 900);
					model = String(j.model ?? "");
					mesh = !!j.mesh;
					msgId = String(j.msgId ?? "");
					from = String(j.from ?? "");
				} catch {}
				if (!prompt.trim()) return json(res, 400, { error: "prompt 为空" });
				if (!/^[a-z_,*+.-]+$/i.test(tools)) return json(res, 400, { error: "tools 非法" });
				const requestedTools = tools
					.split(",")
					.map((s) => s.trim().toLowerCase())
					.filter(Boolean);
				const writeTools = ["bash", "edit", "write", "patch"];
				const readTools = ["read", "grep", "glob", "find"];
				if (!cfg.fsWrite && requestedTools.some((t) => writeTools.includes(t))) {
					return json(res, 403, { error: "设备未开启写入/命令执行能力（fsWrite=false）" });
				}
				if (!cfg.fsRead && requestedTools.some((t) => readTools.includes(t))) {
					return json(res, 403, { error: "设备未开启读取能力（fsRead=false）" });
				}
				if (!piPath) piPath = detectPiSync();
				if (!piPath) return json(res, 400, { error: "设备未安装 pi agent（更新常驻命令以安装）" });
				if (taskBusy) return json(res, 429, { error: "已有任务在执行（设备端串行）" });
				const allowEnv = {};
				for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
					if (typeof env[k] === "string" && env[k]) allowEnv[k] = env[k];
				}
				console.log(
					`[task] 收到 prompt=${!!prompt} tools=${tools} model=${model || "-"} envKeys=${Object.keys(env).join(",") || "-"} allow=${Object.keys(allowEnv).join(",") || "-"}`,
				);
				audit("task.run", `${tools} | ${prompt.slice(0, 60)}`);
				const agentDir = path.join(homedir(), ".pi-tunnel-agent");
				const spawnEnv = { ...process.env, ...allowEnv };
				spawnEnv.PATH = path.dirname(process.execPath) + path.delimiter + (spawnEnv.PATH || "");
				if (model && allowEnv.OPENAI_BASE_URL && allowEnv.OPENAI_API_KEY) {
					try {
						fs.mkdirSync(agentDir, { recursive: true });
						const mj = {
							providers: {
								tunnel: {
									baseUrl: allowEnv.OPENAI_BASE_URL,
									api: "openai-completions",
									apiKey: allowEnv.OPENAI_API_KEY,
									models: [{ id: model }],
								},
							},
						};
						fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(mj, null, 2), { mode: 0o600 });
						spawnEnv.PI_CODING_AGENT_DIR = agentDir;
						try {
							const gh = new URL(allowEnv.OPENAI_BASE_URL).hostname;
							const np = [process.env.NO_PROXY, process.env.no_proxy, gh].filter(Boolean).join(",");
							spawnEnv.NO_PROXY = np;
							spawnEnv.no_proxy = np;
						} catch {}
						delete spawnEnv.HTTP_PROXY;
						delete spawnEnv.HTTPS_PROXY;
						delete spawnEnv.http_proxy;
						delete spawnEnv.https_proxy;
						spawnEnv.PI_SKIP_VERSION_CHECK = "1";
						console.log("[task] models.json 已写入", agentDir, "| NO_PROXY=", spawnEnv.NO_PROXY, "| HTTP_PROXY 已清除");
					} catch (e) {
						console.log("[task] models.json 写失败:", e.message);
					}
				}
				taskBusy = true;
				let meshSessionId = "";
				const sessionFile = path.join(homedir(), ".pi-tunnel-agent", "session.json");
				if (mesh) {
					try {
						meshSessionId = String(JSON.parse(fs.readFileSync(sessionFile, "utf8")).sessionId || "");
					} catch {}
				}
				const args = ["-ne", "-p", prompt, "--mode", "json", "--tools", tools];
				if (!mesh) args.push("--no-session");
				if (mesh && meshSessionId) {
					args.push("--session", meshSessionId);
				}
				if (model && spawnEnv.PI_CODING_AGENT_DIR) args.push("--model", "tunnel/" + model);
				const isJs = piPath.endsWith(".js");
				const cmd = isJs ? process.execPath : piPath;
				const runArgs = isJs ? [piPath, ...args] : args;
				const t0 = Date.now();
				const child = spawn(cmd, runArgs, { env: spawnEnv, cwd: homedir(), stdio: ["ignore", "pipe", "pipe"] });
				let outBuf = "",
					errBuf = "";
				child.stdout.on("data", (d) => {
					outBuf += d;
					if (outBuf.length > 2e6) outBuf = outBuf.slice(-1e6);
				});
				child.stderr.on("data", (d) => {
					errBuf += d;
					if (errBuf.length > 4e5) errBuf = errBuf.slice(-2e5);
				});
				const killT = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
				}, timeoutS * 1000);
				let settled = false;
				const extractFinalText = () => {
					let last = "";
					for (const line of outBuf.split("\n")) {
						if (!line.trim().startsWith("{")) continue;
						try {
							const e = JSON.parse(line);
							const msg = e.type === "message_end" ? e.message : null;
							if (msg?.role === "assistant" && Array.isArray(msg.content)) {
								const t = msg.content
									.filter((c) => c.type === "text")
									.map((c) => c.text || "")
									.join("")
									.trim();
								if (t) last = t;
							}
						} catch {}
					}
					return last;
				};
				const persistSessionId = () => {
					if (meshSessionId) return;
					try {
						const sDir = path.join(agentDir, "sessions");
						const found = [];
						const walk = (d) => {
							for (const e of fs.readdirSync(d, { withFileTypes: true })) {
								const p = path.join(d, e.name);
								if (e.isDirectory()) walk(p);
								else if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(e.name))
									found.push({
										p,
										m: fs.statSync(p).mtimeMs,
										id: e.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)[0],
									});
							}
						};
						walk(sDir);
						found.sort((a, b) => b.m - a.m);
						if (found[0]) {
							fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
							fs.writeFileSync(
								sessionFile,
								JSON.stringify({ sessionId: found[0].id, updatedAt: new Date().toISOString() }, null, 2),
								{ mode: 0o600 },
							);
							console.log("[task] mesh session 已持久化", found[0].id);
						}
					} catch (e) {
						console.log("[task] session 抓取失败:", e.message);
					}
				};
				const finish = (ok) => {
					if (settled) return;
					settled = true;
					clearTimeout(killT);
					taskBusy = false;
					if (mesh && msgId) {
						const text = ok ? extractFinalText() : "";
						if (!meshSessionId) persistSessionId();
						try {
							if (wsRef?.readyState === 1)
								wsRef.send(
									JSON.stringify({
										t: "msg-res",
										msgId,
										from,
										to: from,
										ok,
										text,
										ms: Date.now() - t0,
										err: ok ? "" : errBuf.slice(-300),
									}),
								);
						} catch {}
					}
					json(res, ok ? 200 : 500, { ok, ms: Date.now() - t0, output: outBuf.slice(-40000), err: errBuf.slice(-500) });
				};
				child.on("exit", () => finish(!!outBuf));
				child.on("error", () => finish(false));
			});
			return;
		}
		if (u.pathname === "/session" && req.method === "GET") {
			const f = path.join(homedir(), ".pi-tunnel-agent", "session.json");
			let snap = { exists: false, sessionId: null, updatedAt: null, size: 0 };
			try {
				const st = fs.statSync(f);
				const j = JSON.parse(fs.readFileSync(f, "utf8"));
				snap = {
					exists: true,
					sessionId: j.sessionId || null,
					updatedAt: j.updatedAt || st.mtime.toISOString(),
					size: st.size,
				};
			} catch {}
			return json(res, 200, { ok: true, session: snap });
		}
		if (u.pathname === "/session/reset" && req.method === "POST") {
			const f = path.join(homedir(), ".pi-tunnel-agent", "session.json");
			let old = null;
			try {
				old = JSON.parse(fs.readFileSync(f, "utf8")).sessionId || null;
			} catch {}
			try {
				fs.rmSync(f, { force: true });
			} catch {}
			audit("session.reset", old ? `删除 mesh 会话 ${old}` : "无会话");
			return json(res, 200, { ok: true, removed: old });
		}
		if (u.pathname === "/devices") {
			audit("devices.enum", os.platform());
			return listDevices((err, d) => json(res, err ? 500 : 200, err ? { error: err } : d));
		}
		return json(res, 404, { error: "not found" });
	} catch (e) {
		return json(res, 500, { error: String(e.message || e) });
	}
});

let wsRef = null;
let reconnectDelay = 5000;
let hbTimer = null,
	hbAlive = true;
function startHeartbeat(ws) {
	clearInterval(hbTimer);
	hbAlive = true;
	hbTimer = setInterval(() => {
		if (ws.readyState !== 1) {
			clearInterval(hbTimer);
			return;
		}
		if (!hbAlive) {
			console.log("[tunnel] 心跳超时，判定连接僵尸，强制重连");
			try {
				ws.terminate();
			} catch {}
			return;
		}
		hbAlive = false;
		try {
			ws.send(JSON.stringify({ t: "ping" }));
		} catch {}
	}, 25000);
}
function connect() {
	let url;
	try {
		url = new URL(SERVER.replace(/^http/, "ws") + "/agent?token=" + TOKEN);
	} catch {
		console.error(`URL 非法: SERVER=${JSON.stringify(SERVER)} TOKEN=${JSON.stringify(TOKEN)}`);
		process.exit(1);
	}
	const ws = new WebSocket(url);
	wsRef = ws;
	const connectGuard = setTimeout(() => {
		if (ws.readyState !== 0) return;
		console.log(`[tunnel ${ts()}] connect 10s 无响应，废弃本次连接重来`);
		try {
			ws.close();
		} catch {}
		setTimeout(() => {
			if (ws.readyState === 0) {
				console.log(`[tunnel ${ts()}] 废弃未生效，退出由 launchd 重拉`);
				process.exit(0);
			}
		}, 3_000);
	}, 10_000);
	ws.onopen = () => {
		clearTimeout(connectGuard);
		reconnectDelay = 5000;
		console.log(`[tunnel ${ts()}] 已连接 ${SERVER} @ ${os.hostname()}（控制API :${ctrlPort}）`);
		ws.send(
			JSON.stringify({
				t: "hello",
				name: process.env.PI_TUNNEL_NAME || os.hostname(),
				os: `${os.platform()} ${os.release()} ${os.arch()}`,
				ctrlPort,
				ver: CLI_VER,
			}),
		);
		startHeartbeat(ws);
	};
	ws.onmessage = (ev) => {
		let m;
		try {
			m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
		} catch {
			return;
		}
		if (m.t === "pong") {
			hbAlive = true;
			return;
		}
		if (m.t === "ver" && typeof m.v === "string" && Number(m.v.slice(1)) > Number(CLI_VER.slice(1))) selfUpdate(m.v);
		if (m.t === "connect") {
			const s = net.connect({ host: m.host, port: m.port }, () => ws.send(JSON.stringify({ t: "open", id: m.id })));
			s.on("data", (d) => ws.send(JSON.stringify({ t: "data", id: m.id, b64: d.toString("base64") })));
			s.on("end", () => ws.send(JSON.stringify({ t: "end", id: m.id })));
			s.on("error", (e) => ws.send(JSON.stringify({ t: "err", id: m.id, msg: String(e.code || e.message || e) })));
			s.on("close", () => {
				ws.send(JSON.stringify({ t: "close", id: m.id }));
				sockMap.delete(m.id);
			});
			sockMap.set(m.id, s);
		} else if (m.t === "data") sockMap.get(m.id)?.write(Buffer.from(m.b64, "base64"));
		else if (m.t === "end") sockMap.get(m.id)?.end();
		else if (m.t === "close") {
			sockMap.get(m.id)?.destroy();
			sockMap.delete(m.id);
		} else if (m.t === "config") {
			if (Array.isArray(m.whitelist))
				cfg.whitelist = m.whitelist.map((p) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p));
			if (typeof m.fsRead === "boolean") cfg.fsRead = m.fsRead;
			if (typeof m.fsWrite === "boolean") cfg.fsWrite = m.fsWrite;
			saveCfg();
			console.log(`[tunnel] 配置已更新: fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length} 项`);
		} else if (m.t === "ctrl") {
			const reqOpts = {
				host: "127.0.0.1",
				port: ctrlPort,
				path: m.url,
				method: m.method || "GET",
				headers: { "X-Tunnel-Token": TOKEN },
			};
			if (m.body) {
				reqOpts.headers["content-type"] = "application/json";
				reqOpts.headers["content-length"] = Buffer.byteLength(m.body);
			}
			const rq = http.request(reqOpts, (r) => {
				let body = "";
				r.on("data", (d) => (body += d));
				r.on("end", () => {
					try {
						ws.send(JSON.stringify({ t: "ctrl-resp", rid: m.rid, status: r.statusCode, body: JSON.parse(body) }));
					} catch {}
				});
			});
			rq.on("error", () => {
				try {
					ws.send(JSON.stringify({ t: "ctrl-resp", rid: m.rid, status: 500, body: { error: "ctrl unreachable" } }));
				} catch {}
			});
			if (m.body) rq.write(m.body);
			rq.end();
		} else if (m.t === "uninstall") {
			if (taskBusy) {
				try {
					ws.send(JSON.stringify({ t: "ctrl-resp-notify", note: "任务执行中，稍后再卸载" }));
				} catch {}
			}
			audit("cli.uninstall", os.platform());
			try {
				if (ws.readyState === 1) ws.send(JSON.stringify({ t: "audit", items: auditBuf.splice(0) }));
			} catch {}
			const home = homedir();
			const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 8000 }, () => r()));
			const rm = (f) => {
				try {
					fs.rmSync(f, { force: true, recursive: true });
				} catch {}
			};
			const stopPersist =
				process.platform === "darwin"
					? run("launchctl", ["bootout", `gui/${process.getuid()}/com.pi-tunnel.cli`])
							.then(() => run("launchctl", ["bootout", `gui/${process.getuid()}/com.gxg.pi-tunnel`]))
							.then(() => rm(path.join(home, "Library/LaunchAgents/com.pi-tunnel.cli.plist")))
							.then(() => rm(path.join(home, "Library/LaunchAgents/com.gxg.pi-tunnel.plist")))
					: process.platform === "win32"
						? run("schtasks", ["/Delete", "/TN", "pi-tunnel", "/F"])
						: run("systemctl", ["--user", "stop", "pi-tunnel-cli"])
								.then(() => run("systemctl", ["--user", "disable", "pi-tunnel-cli"]))
								.then(() => rm(path.join(home, ".config/systemd/user/pi-tunnel-cli.service")))
								.then(() => run("systemctl", ["--user", "daemon-reload"]));
			stopPersist.finally(() => {
				rm(path.join(home, "pi-tunnel-cli.mjs"));
				rm(CFG_FILE);
				rm(path.join(home, "pi-agent"));
				rm(path.join(home, ".pi-tunnel-agent"));
				console.log("[tunnel] 已卸载（常驻+文件+pi agent 残留），退出");
				try {
					ws.close();
				} catch {}
				setTimeout(() => process.exit(0), 400);
			});
			return;
		} else if (m.t === "kicked") {
			reconnectDelay = 60000;
			console.log("[tunnel] 此设备有新实例接管，60s 后重连");
			try {
				ws.close();
			} catch {}
			return;
		}
	};
	ws.onclose = (ev) => {
		clearTimeout(connectGuard);
		clearInterval(hbTimer);
		console.log(`[tunnel ${ts()}] 断开(${ev.code ?? ""}) ${reconnectDelay / 1000}s后重连`);
		for (const s of sockMap.values()) s.destroy();
		sockMap.clear();
		setTimeout(connect, reconnectDelay);
	};
	ws.onerror = () => {};
}

setInterval(() => {
	if (auditBuf.length && wsRef && wsRef.readyState === 1) {
		wsRef.send(JSON.stringify({ t: "audit", items: auditBuf.splice(0) }));
	}
}, 5000);

// pi 探测：launchd PATH 精简，which/npm 不可用——从当前 node 路径推导（npm global bin 与 node 同目录是主流形态）
function detectPiSync() {
	const nodeDir = path.dirname(process.execPath);
	const candidates = [
		path.join(nodeDir, process.platform === "win32" ? "pi.cmd" : "pi"),
		"/usr/local/bin/pi",
		"/opt/homebrew/bin/pi",
		path.join(homedir(), ".local/bin/pi"),
		path.join(homedir(), "pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
	];
	try {
		const npmAbs = path.join(nodeDir, process.platform === "win32" ? "npm.cmd" : "npm");
		if (fs.existsSync(npmAbs)) {
			const prefix = execFileSync(npmAbs, ["prefix", "-g"], { timeout: 5000 }).toString().trim();
			if (prefix) candidates.push(path.join(prefix, process.platform === "win32" ? "pi.cmd" : "pi"));
		}
	} catch {}
	for (const c of candidates) {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {}
	}
	return "";
}
(async () => {
	const tryRun = (cmd, args) =>
		new Promise((r) => execFile(cmd, args, { timeout: 5000 }, (e, so) => r(e ? "" : String(so).trim())));
	try {
		let p = await tryRun("which", ["pi"]);
		if (!p && process.platform === "win32") p = (await tryRun("where", ["pi"])).split("\n")[0].trim();
		if (!p && process.platform !== "win32") {
			const npmAbs = path.join(path.dirname(process.execPath), "npm");
			try {
				fs.accessSync(npmAbs, fs.constants.X_OK);
				const prefix = await tryRun(npmAbs, ["prefix", "-g"]);
				if (prefix) {
					const cand = prefix + "/bin/pi";
					try {
						fs.accessSync(cand, fs.constants.X_OK);
						p = cand;
					} catch {}
				}
			} catch {}
		}
		if (!p) p = detectPiSync();
		piPath = p || "";
	} catch {
		piPath = "";
	}
	if (piPath) console.log(`[pi] agent 就绪: ${piPath}`);
	ctrlSrv.listen(0, "127.0.0.1", () => {
		ctrlPort = ctrlSrv.address().port;
		console.log(
			`[ctrl] 控制API监听 127.0.0.1:${ctrlPort}（fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length}）`,
		);
		connect();
	});
})();
