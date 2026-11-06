import net from "node:net";
import os from "node:os";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadWs() {
	const tries = [];
	if (process.env.PI_TUNNEL_WS) tries.push(process.env.PI_TUNNEL_WS);
	try {
		const hostRequire = createRequire(process.argv[1] || import.meta.url);
		tries.push(hostRequire.resolve("ws"));
	} catch {}
	tries.push("ws");
	for (const spec of tries) {
		try {
			return require(spec);
		} catch {}
	}
	throw new Error("pi-tunnel: 找不到 ws 库（设 PI_TUNNEL_WS=<ws包路径>）");
}

export function safeTokenEqual(candidate, expected) {
	if (typeof candidate !== "string" || typeof expected !== "string" || !expected || !candidate) return false;
	try {
		const a = crypto.createHash("sha256").update(candidate).digest();
		const b = crypto.createHash("sha256").update(expected).digest();
		return crypto.timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

export const WRITE_EXEC_TOOLS = ["bash", "edit", "write", "patch"];
export const READ_TOOLS = ["read", "grep", "glob", "find"];

export function validateTaskTools(toolsStr, caps = { fsRead: true, fsWrite: false }) {
	const tools = String(toolsStr || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const hasWrite = tools.some((t) => WRITE_EXEC_TOOLS.includes(t));
	const hasRead = tools.some((t) => READ_TOOLS.includes(t));
	if (hasWrite && !caps.fsWrite) {
		return { ok: false, error: "设备未开启写入/命令执行能力（fsWrite=false）" };
	}
	if (hasRead && !caps.fsRead) {
		return { ok: false, error: "设备未开启读取能力（fsRead=false）" };
	}
	return { ok: true, tools };
}

export function sanitizeMeshTo(to) {
	if (typeof to !== "string") return "";
	const s = to.trim();
	return /^[a-zA-Z0-9_-]+$/.test(s) ? s : "";
}

export function isRestrictedBrowsePath(targetPath, homeDir = os.homedir()) {
	if (!targetPath || typeof targetPath !== "string") return true;
	const norm = targetPath.trim().replace(/\\/g, "/");

	const blockedPrefixes = ["/etc", "/proc", "/sys", "/dev", "/var", "/root", "/boot", "/bin", "/sbin", "/usr"];
	if (norm === "/" || blockedPrefixes.some((p) => norm === p || norm.startsWith(p + "/"))) {
		return true;
	}

	const resolved = path.resolve(targetPath);
	const home = path.resolve(homeDir);

	if (resolved === home || resolved.startsWith(home + path.sep)) {
		return false;
	}

	const plat = process.platform;
	if (plat === "darwin" && (resolved === "/Volumes" || resolved.startsWith("/Volumes/"))) {
		return false;
	}
	if (plat === "linux" && /^\/(media|mnt)($|\/)/.test(resolved)) {
		return false;
	}
	if (plat === "win32") {
		const isDrivePath = /^[a-zA-Z]:\\?/.test(resolved);
		const winSys = process.env.SystemRoot ? path.resolve(process.env.SystemRoot) : "C:\\Windows";
		if (resolved.toLowerCase().startsWith(winSys.toLowerCase())) return true;
		if (isDrivePath) return false;
	}

	if (blockedPrefixes.some((p) => resolved === p || resolved.startsWith(p + "/"))) {
		return true;
	}
	if (resolved === "/" || resolved === path.parse(resolved).root) return true;

	return true;
}

export function parseSocksConnect(buf) {
	if (buf.length < 7 || buf[0] !== 5 || buf[1] !== 1) return null;
	const atyp = buf[3];
	if (atyp === 1) return { host: Array.from(buf.slice(4, 8)).join("."), port: buf.readUInt16BE(8) };
	if (atyp === 3) {
		const n = buf[4];
		if (buf.length < 5 + n + 2) return null;
		return { host: buf.slice(5, 5 + n).toString(), port: buf.readUInt16BE(5 + n) };
	}
	return null;
}
export function detectLanIp() {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address))
				return a.address;
		}
	}
	return "";
}
export function escHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
	);
}
function socksReply(c, code) {
	c.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

export function sanitizeHostHeader(rawHost, fallback = "127.0.0.1:8765") {
	const h = typeof rawHost === "string" ? rawHost.trim() : "";
	return /^[a-zA-Z0-9.:_-]+$/.test(h) ? h : fallback;
}

export default {
	async activate(host) {
		const { WebSocketServer } = loadWs();
		const wsPort = Number(host.getSettings().wsPort ?? 8765);
		const socksPort = Number(host.getSettings().socksPort ?? 1080);
		let token = host.storage.get("token");
		if (!token) {
			token = crypto.randomBytes(16).toString("hex");
			host.storage.set("token", token);
		}

		const state = {
			agents: new Map(),
			activeAgentId: null,
			conns: new Map(),
			nextId: 1,
			nextAid: 1,
			totalServed: 0,
			lastNotifyAt: 0,
			ctrlPending: new Map(),
		};
		let ctrlSeq = 0;
		const readBodyJson = (req) =>
			new Promise((resolve) => {
				if (req.body !== undefined) return resolve(req.body ?? {});
				let b = "";
				req.on("data", (c) => {
					b += c;
				});
				req.on("end", () => {
					try {
						resolve(JSON.parse(b || "{}"));
					} catch {
						resolve({});
					}
				});
				req.on("error", () => resolve({}));
			});
		const deviceCtrl = (aid, url, opts = {}, timeoutMs = 8000) =>
			new Promise((resolve) => {
				const ag = agentById(aid);
				if (!ag) return resolve({ status: 503, body: { error: "设备不在线" } });
				if (!ag.ver)
					return resolve({
						status: 400,
						body: { error: "该设备 CLI 为旧版，不支持此操作——请在面板「设备常驻化」重新安装后重试" },
					});
				const rid = crypto.randomUUID();
				const timer = setTimeout(() => {
					state.ctrlPending.delete(rid);
					resolve({ status: 504, body: { error: "设备响应超时" } });
				}, timeoutMs);
				state.ctrlPending.set(rid, {
					aid,
					resolve: (v) => {
						clearTimeout(timer);
						resolve(v);
					},
				});
				toAgent(aid, { t: "ctrl", rid, url, method: opts.method || "GET", body: opts.body });
			});
		const loadModelProviders = () => {
			const home = os.homedir();
			const rd = (p) => {
				try {
					return JSON.parse(fs.readFileSync(p, "utf8"));
				} catch {
					return {};
				}
			};
			return {
				providers: rd(path.join(home, ".pi/agent/models.json"))?.providers ?? {},
				keys: rd(path.join(home, ".pi/agent/provider-keys.json")),
			};
		};
		const providerKey = (keys, prov) => {
			const kv = keys?.[prov]?.keys?.[0];
			return typeof kv === "string" ? kv : kv?.apiKey || kv?.value || kv?.key || "";
		};
		const devReachableBase = (url) =>
			!url
				? ""
				: url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)((?::\d+)?)/i, (_m, sch, _h, port) =>
						lanIp ? `${sch}${lanIp}${port}` : url,
					);
		const buildModelChannel = (providers, keys, prov, pdef, fullModel, source) => {
			if (!pdef) return { error: `未知 provider：${prov}` };
			if (pdef.api !== "openai-completions")
				return { error: `provider ${prov} 为 ${pdef.api} 型——设备端暂仅支持 openai-completions 型注入` };
			const apiKey = providerKey(keys, prov);
			if (!apiKey) return { error: `provider ${prov} 在 provider-keys.json 中无可用 key` };
			const base = devReachableBase(pdef.baseUrl);
			if (!base) return { error: `provider ${prov} 的 baseUrl 无法换算为设备可达地址（本机无内网 IP？）` };
			return {
				env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: apiKey },
				model: fullModel.split("/").slice(1).join("/") || fullModel,
				source,
				baseUrl: base,
			};
		};
		const resolveModelEnv = (wantModel = "") => {
			try {
				const { providers, keys } = loadModelProviders();
				if (wantModel) {
					const prov = wantModel.split("/")[0];
					return buildModelChannel(providers, keys, prov, providers[prov], wantModel, "override");
				}
				try {
					const manual = JSON.parse(host.storage.get("modelEnv") || "null");
					if (manual?.baseUrl && manual?.apiKey && manual?.model)
						return {
							env: { OPENAI_BASE_URL: manual.baseUrl, OPENAI_API_KEY: manual.apiKey },
							model: manual.model,
							source: "manual",
							baseUrl: manual.baseUrl,
						};
				} catch {}
				const isLocalBase = (u) => /^(https?:\/\/)(127\.0\.0\.1|localhost)/i.test(u || "");
				const order = Object.entries(providers).sort((a, b) =>
					isLocalBase(a[1]?.baseUrl) === isLocalBase(b[1]?.baseUrl) ? 0 : isLocalBase(a[1]?.baseUrl) ? -1 : 1,
				);
				for (const [prov, pdef] of order) {
					if (!pdef?.models?.[0]?.id) continue;
					const r = buildModelChannel(providers, keys, prov, pdef, `${prov}/${pdef.models[0].id}`, "auto");
					if (!r.error) return r;
				}
			} catch {}
			return null;
		};
		const auditRing = [];
		let devCfg = {};
		try {
			devCfg = JSON.parse(host.storage.get("devcfg") || "{}");
		} catch {}
		const saveDevCfg = () => host.storage.set("devcfg", JSON.stringify(devCfg));
		const capsOf = (name) => devCfg[name] ?? { fsRead: true, fsWrite: false, whitelist: ["~/Downloads"] };
		const agentById = (aid) => {
			const a = state.agents.get(aid);
			return a && a.ws.readyState === 1 ? a : null;
		};
		const activeAgent = () => agentById(state.activeAgentId);
		const toAgent = (aid, obj) => {
			const a = state.agents.get(aid);
			if (a && a.ws.readyState === 1) a.ws.send(JSON.stringify(obj));
		};
		const pickAnyOnline = () => {
			for (const [id, a] of state.agents) if (a.ws.readyState === 1) return id;
			return null;
		};
		const ensureActive = () => {
			if (agentById(state.activeAgentId)) return;
			state.activeAgentId = pickAnyOnline();
			if (state.activeAgentId) {
				const nm = state.agents.get(state.activeAgentId)?.name || state.activeAgentId;
				notifyDebounced("info", `网络隧道：出口设备已切换到 ${nm}`);
			}
		};
		const CLI_VER_PUBLISH = "p16";
		const lanIp = detectLanIp();

		const hostHasToken = () => {
			if (process.env.PI_WEB_TOKEN && process.env.PI_WEB_TOKEN.trim()) return true;
			try {
				const cfgPath = path.join(os.homedir(), ".pi-web", "config.json");
				if (fs.existsSync(cfgPath)) {
					const j = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
					if (typeof j?.token === "string" && j.token.trim()) return true;
				}
			} catch {}
			return false;
		};

		const statusSnapshot = (opts = {}) => {
			const includeToken = opts.includeToken ?? hostHasToken();
			return {
				running,
				rev: "c1-p3",
				lanIp,
				agentOnline: !!activeAgent(),
				activeAgentId: state.activeAgentId,
				devices: [...state.agents.entries()].map(([id, a]) => ({
					id,
					name: a.name || id,
					os: a.os || "",
					online: a.ws.readyState === 1,
					since: a.since,
					ctrlPort: a.ctrlPort ?? 0,
					ver: a.ver || "",
					caps: capsOf(a.name || id),
				})),
				activeConns: state.conns.size,
				totalServed: state.totalServed,
				tokenPrefix: `${token.slice(0, 4)}…`,
				token: includeToken ? token : "",
				tokenRedacted: !includeToken,
				wsPort,
				socksPort,
			};
		};
		const cliCode = (req) => {
			let code = fs.readFileSync(path.join(__dirname, "assets", "cli.mjs"), "utf8");
			const safeHost = sanitizeHostHeader(req?.headers?.host, `${lanIp || "127.0.0.1"}:${wsPort}`);
			const safeToken = /^[a-zA-Z0-9_-]+$/.test(token) ? token : "";
			return code.replaceAll("{{TOKEN}}", safeToken).replaceAll("{{SERVER}}", `ws://${safeHost}`);
		};
		const notifyDebounced = (level, text) => {
			const now = Date.now();
			if (now - state.lastNotifyAt < 30_000) return;
			state.lastNotifyAt = now;
			try {
				host.notify(level, text);
			} catch {}
		};

		const tnlDeny = (res) => {
			res.writeHead(401, { "content-type": "text/plain" });
			res.end("unauthorized");
		};
		const tnlAuthed = (_req, url) => {
			try {
				return safeTokenEqual(url.searchParams.get("token"), token);
			} catch {
				return false;
			}
		};

		const httpSrv = http.createServer((req, res) => {
			const url = new URL(req.url, "http://local");
			if (url.pathname === "/cli") {
				if (!tnlAuthed(req, url)) return tnlDeny(res);
				res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
				return res.end(cliCode(req));
			}
			if (url.pathname === "/status") {
				if (!tnlAuthed(req, url)) return tnlDeny(res);
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify(statusSnapshot({ includeToken: true })));
			}
			if (url.pathname === "/pi-pkg") {
				if (!tnlAuthed(req, url)) return tnlDeny(res);
				try {
					const pkg = fs.readFileSync(path.join(__dirname, "assets", "pi-agent.tgz"));
					res.writeHead(200, { "content-type": "application/gzip", "content-length": pkg.length });
					return res.end(pkg);
				} catch {
					res.writeHead(404, { "content-type": "text/plain" });
					return res.end("pi-agent.tgz not found");
				}
			}
			res.end("pi-tunnel plugin server\n");
		});
		const wss = new WebSocketServer({ noServer: true });
		httpSrv.on("upgrade", (req, sock, head) => {
			const url = new URL(req.url, "http://local");
			if (url.pathname !== "/agent" || !safeTokenEqual(url.searchParams.get("token"), token)) {
				sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				return sock.destroy();
			}
			wss.handleUpgrade(req, sock, head, (ws) => {
				const aid = `a${state.nextAid++}`;
				state.agents.set(aid, { ws, name: "", os: "", since: Date.now() });
				if (!agentById(state.activeAgentId)) state.activeAgentId = aid;
				ws.on("message", (raw) => {
					let m;
					try {
						m = JSON.parse(raw.toString());
					} catch {
						return;
					}
					const e = state.conns.get(m.id);
					if (["open", "data", "end", "err", "close"].includes(m.t) && e && e.aid !== aid) {
						auditRing.push({
							ts: Date.now(),
							device: state.agents.get(aid)?.name || aid,
							op: "socks.conn.hijack_denied",
							detail: `attempted ${m.t} on conn ${m.id} owned by ${e.aid}`,
						});
						return;
					}
					switch (m.t) {
						case "ping": {
							const pa = state.agents.get(aid);
							if (pa) {
								try {
									pa.ws.send(JSON.stringify({ t: "pong" }));
								} catch {}
							}
							break;
						}
						case "hello": {
							const a = state.agents.get(aid);
							if (a) {
								a.name = String(m.name ?? "");
								a.os = String(m.os ?? "");
								a.ctrlPort = Number(m.ctrlPort) || 0;
								a.ver = String(m.ver || "");
							}
							const twin = [...state.agents.entries()].find(
								([oid, oa]) => oid !== aid && oa.name && oa.name === a?.name && oa.ws.readyState === 1,
							);
							if (twin) {
								const [oid, oa] = twin;
								const newFull = a.ctrlPort > 0 && !(oa.ctrlPort > 0);
								if (!newFull) {
									try {
										ws.send(JSON.stringify({ t: "kicked", reason: "同名设备已有功能更全的实例在线" }));
									} catch {}
									try {
										ws.close();
									} catch {}
									state.agents.delete(aid);
									break;
								}
								try {
									oa.ws.send(JSON.stringify({ t: "kicked", by: aid }));
								} catch {}
								try {
									oa.ws.close();
								} catch {}
								state.agents.delete(oid);
								for (const [cid2, e2] of state.conns) {
									if (e2.aid !== oid) continue;
									try {
										e2.c.destroy();
									} catch {}
									state.conns.delete(cid2);
								}
							}
							try {
								notifyDebounced("info", `网络隧道：设备 ${a?.name || aid}（${a?.os || "未知系统"}）已就绪`);
							} catch {}
							if (!agentById(state.activeAgentId)) state.activeAgentId = aid;
							if (devCfg[a.name] && !a.cfgSent) {
								a.cfgSent = true;
								toAgent(aid, { t: "config", ...devCfg[a.name] });
							}
							if (meshEnabled() && meshWatcher && a?.name) {
								const nm = meshAgentName(a.name);
								meshRegistry(nm, a.name, true);
								meshScanInbox(nm);
							}
							try {
								ws.send(JSON.stringify({ t: "ver", v: CLI_VER_PUBLISH }));
							} catch {}
							break;
						}
						case "audit": {
							const nm = state.agents.get(aid)?.name || aid;
							const items = Array.isArray(m.items) ? m.items.slice(0, 50) : [];
							const now = Date.now();
							for (const it of items) {
								if (!it || typeof it !== "object") continue;
								const rawTs = Number(it.ts);
								const ts = Number.isFinite(rawTs) && rawTs > 0 && rawTs <= now ? rawTs : now;
								const op = String(it.op ?? "").slice(0, 64);
								const detail = String(it.detail ?? "").slice(0, 500);
								if (op) auditRing.push({ ts, device: nm, op, detail });
							}
							if (auditRing.length > 500) auditRing.splice(0, auditRing.length - 500);
							break;
						}
						case "open":
							if (e && e.aid === aid && !e.replied) {
								e.replied = true;
								socksReply(e.c, 0);
							}
							break;
						case "data":
							if (e && e.aid === aid) e.c.write(Buffer.from(m.b64, "base64"));
							break;
						case "end":
							if (e && e.aid === aid) e.c.end();
							break;
						case "err":
							if (e && e.aid === aid) {
								auditRing.push({
									ts: Date.now(),
									device: state.agents.get(aid)?.name || aid,
									op: "socks.connect.fail",
									detail: String(m.msg || "").slice(0, 200) + " → " + (e.lastTarget ?? ""),
								});
								if (!e.replied) {
									e.replied = true;
									socksReply(e.c, 5);
								}
								e.c.destroy();
							}
							break;
						case "close":
							if (e && e.aid === aid) {
								e.c.destroy();
								state.conns.delete(m.id);
							}
							break;
						case "ctrl-resp": {
							const p = state.ctrlPending.get(m.rid);
							if (p && p.aid === aid) {
								state.ctrlPending.delete(m.rid);
								p.resolve({ status: m.status ?? 500, body: m.body ?? {} });
							}
							break;
						}
						case "msg-res": {
							const pm = meshPending.get(m.msgId);
							if (!pm || pm.targetAid !== aid) {
								auditRing.push({
									ts: Date.now(),
									device: state.agents.get(aid)?.name || aid,
									op: "mesh.reply.denied",
									detail: `unsolicited or aid mismatch msgId=${m.msgId}`,
								});
								break;
							}
							clearTimeout(pm.timer);
							meshPending.delete(m.msgId);

							const dn = state.agents.get(aid)?.name || aid;
							const nm = pm.from || meshAgentName(dn);
							const to = pm.to;
							const text = m.ok
								? String(m.text || "").slice(0, 8000) || "（设备端无文本回复）"
								: `任务失败：${String(m.err || "未知错误").slice(0, 300)}`;
							if (to) meshDeliver(to, nm, text, m.msgId);
							auditRing.push({
								ts: Date.now(),
								device: dn,
								op: "mesh.reply",
								detail: `${m.msgId} → ${to} | ${text.slice(0, 60)}`,
							});
							try {
								const f = meshRegistryFile(nm);
								if (fs.existsSync(f)) {
									const j = JSON.parse(fs.readFileSync(f, "utf8"));
									j.activity = { lastActivityAt: new Date().toISOString() };
									j.offline = false;
									fs.writeFileSync(f, JSON.stringify(j, null, 2));
								}
							} catch {}
							break;
						}
					}
				});
				ws.on("close", () => {
					const a = state.agents.get(aid);
					const nm = a?.name || aid;
					state.agents.delete(aid);
					for (const [cid, e] of state.conns) {
						if (e.aid !== aid) continue;
						try {
							e.c.destroy();
						} catch {}
						state.conns.delete(cid);
					}
					ensureActive();
					notifyDebounced("warning", `网络隧道：设备 ${nm} 已断开`);
					if (meshEnabled() && meshWatcher) meshRegistry(meshAgentName(nm), nm, false);
				});
				ws.on("error", () => {});
			});
		});

		const socksSrv = net.createServer((c) => {
			c.on("error", () => {});
			let stage = 0;
			c.on("data", (buf) => {
				if (stage === 0) {
					if (buf[0] !== 5) return c.destroy();
					c.write(Buffer.from([5, 0]));
					stage = 1;
					return;
				}
				c.removeAllListeners("data");
				const req = parseSocksConnect(buf);
				if (!req) {
					socksReply(c, 7);
					return c.destroy();
				}
				const ag = activeAgent();
				console.log(
					`[tunnel] SOCKS CONNECT ${req.host}:${req.port} active=${state.activeAgentId} agentReady=${ag ? 1 : 0} agents=${state.agents.size}`,
				);
				if (!ag) {
					socksReply(c, 5);
					return c.destroy();
				}
				const aid = state.activeAgentId;
				const cid = `c${state.nextId++}`;
				state.totalServed++;
				state.conns.set(cid, { c, replied: false, aid });
				c.on("data", (d) => toAgent(aid, { t: "data", id: cid, b64: d.toString("base64") }));
				c.on("close", () => {
					state.conns.delete(cid);
					toAgent(aid, { t: "close", id: cid });
				});
				toAgent(aid, { t: "connect", id: cid, host: req.host, port: req.port });
			});
		});

		const MESH_DIR = path.join(os.homedir(), ".pi", "agent", "messenger");
		const meshPending = new Map();
		const meshQueue = [];
		let meshBusy = false;
		let meshWatcher = null;
		function meshEnabled() {
			return host.storage.get("meshEnabled") === "1";
		}
		const meshAgentName = (devName) =>
			"Remote" +
			String(devName || "")
				.replace(/\.local$/i, "")
				.split(/[-_\s]+/)
				.filter(Boolean)
				.map((w) => w[0].toUpperCase() + w.slice(1))
				.join("");
		const meshRegistryFile = (nm) => path.join(MESH_DIR, "registry", `${nm}.json`);
		function meshRegistry(nm, devName, online) {
			try {
				fs.mkdirSync(path.join(MESH_DIR, "registry"), { recursive: true });
				const f = meshRegistryFile(nm);
				if (!online) {
					if (fs.existsSync(f)) {
						const j = JSON.parse(fs.readFileSync(f, "utf8"));
						j.offline = true;
						fs.writeFileSync(f, JSON.stringify(j, null, 2));
					}
					return;
				}
				fs.writeFileSync(
					f,
					JSON.stringify(
						{
							name: nm,
							pid: process.pid,
							sessionId: `mesh:${devName}`,
							cwd: os.homedir(),
							model: "tunnel",
							startedAt: new Date().toISOString(),
							isHuman: false,
							session: { toolCalls: 0, tokens: 0, filesModified: [] },
							activity: { lastActivityAt: new Date().toISOString() },
							device: devName,
							offline: false,
						},
						null,
						2,
					),
				);
			} catch {}
		}
		function meshDeliver(to, fromName, text, replyTo) {
			const safeTo = sanitizeMeshTo(to);
			if (!safeTo) return false;
			try {
				const dir = path.join(MESH_DIR, "inbox", safeTo);
				fs.mkdirSync(dir, { recursive: true });
				const msg = {
					id: crypto.randomUUID(),
					from: fromName,
					to: safeTo,
					text,
					timestamp: new Date().toISOString(),
					replyTo: replyTo ?? null,
				};
				fs.writeFileSync(
					path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`),
					JSON.stringify(msg, null, 2),
				);
				return true;
			} catch {
				return false;
			}
		}
		async function meshDrain() {
			if (meshBusy) return;
			meshBusy = true;
			try {
				while (meshQueue.length) {
					const item = meshQueue.shift();
					const { file, msg, nm } = item;
					let targetAid = null,
						devName = null;
					try {
						devName = JSON.parse(fs.readFileSync(meshRegistryFile(nm), "utf8")).device || null;
					} catch {}
					if (devName)
						for (const [id, a] of state.agents)
							if (a?.name === devName) {
								targetAid = id;
								break;
							}
					if (!targetAid) {
						meshQueue.unshift(item);
						break;
					}
					const me = resolveModelEnv();
					if (!me || me.error) {
						meshDeliver(msg.from, nm, `投递失败：模型通道无法解析${me?.error ? "：" + me.error : ""}`, msg.id);
						try {
							fs.renameSync(file, file + ".done");
						} catch {}
						continue;
					}
					const msgId = msg.id || crypto.randomUUID();
					const payload = JSON.stringify({
						mesh: true,
						msgId,
						from: msg.from,
						prompt: String(msg.text ?? ""),
						tools: "read,grep",
						env: me.env,
						model: me.model,
						timeoutS: 600,
					});
					auditRing.push({
						ts: Date.now(),
						device: devName,
						op: "mesh.deliver",
						detail: `from=${msg.from} | ${String(msg.text ?? "").slice(0, 60)}`,
					});
					const d = await deviceCtrl(targetAid, "/task", { method: "POST", body: payload }, 65_000);
					if (d.status === 200) {
						try {
							fs.renameSync(file, file + ".done");
						} catch {}
						meshPending.set(msgId, {
							targetAid,
							to: msg.from,
							from: nm,
							timer: setTimeout(() => {
								meshPending.delete(msgId);
								meshDeliver(msg.from, nm, "任务超时（10min）——设备端可能仍在执行，结果将被丢弃。", msgId);
							}, 600_000),
						});
					} else {
						meshDeliver(
							msg.from,
							nm,
							`投递失败：设备返回 ${d.status} ${JSON.stringify(d.body ?? {}).slice(0, 200)}`,
							msgId,
						);
						try {
							fs.renameSync(file, file + ".done");
						} catch {}
					}
				}
			} finally {
				meshBusy = false;
			}
		}
		function meshEnqueueFile(fp, nm) {
			try {
				const msg = JSON.parse(fs.readFileSync(fp, "utf8"));
				if (msg?.to && msg?.from && typeof msg.text === "string") meshQueue.push({ file: fp, msg, nm });
			} catch {}
		}
		function meshScanInbox(nm) {
			try {
				const dir = path.join(MESH_DIR, "inbox", nm);
				const files = fs
					.readdirSync(dir)
					.filter((f) => f.endsWith(".json"))
					.map((f) => path.join(dir, f));
				files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
				for (const old of files.slice(0, -5)) {
					try {
						const m = JSON.parse(fs.readFileSync(old, "utf8"));
						meshDeliver(
							m.from,
							nm,
							"消息过于陈旧（积压超过 5 条），已被跳过：" + String(m.text ?? "").slice(0, 80),
							m.id,
						);
						fs.renameSync(old, old + ".done");
					} catch {}
				}
				const fresh = files.slice(-5);
				for (const f of fresh) meshEnqueueFile(f, nm);
				if (fresh.length) meshDrain();
			} catch {}
		}
		function startMeshBridge() {
			if (meshWatcher || !meshEnabled()) return;
			const inbox = path.join(MESH_DIR, "inbox");
			try {
				fs.mkdirSync(inbox, { recursive: true });
			} catch {}
			meshWatcher = fs.watch(inbox, { recursive: true }, (_evt, fname) => {
				if (!fname) return;
				const ag = activeAgent();
				if (!ag) return;
				const nm = meshAgentName(ag.name);
				const parts = String(fname).split("/");
				if (parts[0] !== nm || !parts[1]?.endsWith(".json") || parts[1].endsWith(".done")) return;
				meshEnqueueFile(path.join(inbox, String(fname)), parts[0]);
				meshDrain();
			});
			const ag = activeAgent();
			if (ag) {
				const nm = meshAgentName(ag.name);
				meshRegistry(nm, ag.name, true);
				meshScanInbox(nm);
			}
			console.log("[tunnel] mesh 桥已启动（pi_messenger 文件桥）");
		}
		function stopMeshBridge() {
			if (meshWatcher) {
				try {
					meshWatcher.close();
				} catch {}
				meshWatcher = null;
			}
			for (const [, p] of meshPending) clearTimeout(p.timer);
			meshPending.clear();
			for (const [, a] of state.agents) {
				if (a?.name) meshRegistry(meshAgentName(a.name), a.name, false);
			}
			console.log("[tunnel] mesh 桥已停止");
		}
		host.route("GET", "/mesh", (_req, res) => {
			res.setHeader("content-type", "application/json");
			const ag = activeAgent();
			res.end(
				JSON.stringify({
					enabled: meshEnabled(),
					agentName: ag ? meshAgentName(ag.name) : null,
					device: ag?.name || null,
					queue: meshQueue.length,
					pending: meshPending.size,
					running: !!meshWatcher,
				}),
			);
		});
		host.route("POST", "/mesh", async (req, res) => {
			const j = await readBodyJson(req);
			res.setHeader("content-type", "application/json");
			const on = !!j.enabled;
			host.storage.set("meshEnabled", on ? "1" : "0");
			if (on) startMeshBridge();
			else stopMeshBridge();
			auditRing.push({ ts: Date.now(), device: "-", op: "mesh.switch", detail: on ? "enabled" : "disabled" });
			res.end(JSON.stringify({ ok: true, enabled: on }));
		});
		host.route("GET", "/mesh/session", async (req, res) => {
			const u = new URL(req.url, "http://local");
			let aid = state.activeAgentId;
			const qn = u.searchParams.get("agent");
			if (qn)
				for (const [id, a] of state.agents)
					if (a?.name === qn) {
						aid = id;
						break;
					}
			res.setHeader("content-type", "application/json");
			if (!aid) return res.end(JSON.stringify({ ok: false, error: "设备不在线" }));
			const d = await deviceCtrl(aid, "/session", { method: "GET" }, 10_000);
			res.end(
				JSON.stringify(
					d.status === 200 ? { ok: true, ...(d.body || {}) } : { ok: false, error: `设备返回 ${d.status}` },
				),
			);
		});
		host.route("POST", "/mesh/reset", async (req, res) => {
			const j = await readBodyJson(req);
			res.setHeader("content-type", "application/json");
			let aid = state.activeAgentId;
			if (j.agentName)
				for (const [id, a] of state.agents)
					if (a?.name === j.agentName) {
						aid = id;
						break;
					}
			if (!aid) return res.end(JSON.stringify({ ok: false, error: "设备不在线" }));
			const d = await deviceCtrl(aid, "/session/reset", { method: "POST", body: "{}" }, 10_000);
			auditRing.push({
				ts: Date.now(),
				device: state.agents.get(aid)?.name || aid,
				op: "mesh.sessionReset",
				detail: JSON.stringify(d.body || {}).slice(0, 120),
			});
			res.end(
				JSON.stringify(
					d.status === 200 ? { ok: true, ...(d.body || {}) } : { ok: false, error: `设备返回 ${d.status}` },
				),
			);
		});

		let running = false;
		async function startTunnel() {
			if (running) return true;
			const upWs = await listenSafe(httpSrv, wsPort, "0.0.0.0", `WS:${wsPort}`);
			const upSocks = await listenSafe(socksSrv, socksPort, "127.0.0.1", `SOCKS:${socksPort}`);
			running = upWs || upSocks;
			if (running) notifyDebounced("info", "网络隧道服务已启动");
			if (running)
				setTimeout(() => {
					try {
						if (host.storage.get("meshEnabled") === "1") startMeshBridge();
					} catch (e) {
						console.log("[tunnel] mesh 桥启动失败:", e && e.message);
					}
				}, 0);

			return running;
		}
		function stopTunnel() {
			if (!running) return;
			stopMeshBridge();
			for (const [, e] of state.conns) {
				try {
					e.c.destroy();
				} catch {}
			}
			state.conns.clear();
			for (const [, a] of state.agents) {
				try {
					a.ws.close();
				} catch {}
			}
			state.agents.clear();
			state.activeAgentId = null;
			try {
				httpSrv.closeAllConnections?.();
			} catch {}
			try {
				socksSrv.closeAllConnections?.();
			} catch {}
			try {
				httpSrv.close();
			} catch {}
			try {
				socksSrv.close();
			} catch {}
			running = false;
			notifyDebounced("info", "网络隧道服务已停止");
		}

		const listenSafe = (srv, port, addr, name) =>
			new Promise((resolve) => {
				srv.once("error", (e) => {
					notifyDebounced("error", `pi-tunnel ${name} 启动失败：${e.code || e.message}`);
					resolve(false);
				});
				srv.listen(port, addr, () => resolve(true));
			});
		await startTunnel();
		const heartbeat = setInterval(() => {
			for (const [, a] of state.agents) {
				if (a.ws.readyState !== 1) continue;
				if (a.isAlive === false) {
					try {
						a.ws.terminate();
					} catch {}
					continue;
				}
				a.isAlive = false;
				a.ws.ping();
				a.ws.once("pong", () => {
					a.isAlive = true;
				});
			}
		}, 30_000);

		const offStatus = host.route("GET", "/status", (_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(statusSnapshot()));
		});
		const offCli = host.route("GET", "/cli", (req, res) => {
			res.setHeader("content-type", "text/javascript; charset=utf-8");
			res.end(cliCode(req));
		});
		host.route("GET", "/pi-pkg", (_req, res) => {
			try {
				const pkg = fs.readFileSync(path.join(__dirname, "assets", "pi-agent.tgz"));
				res.setHeader("content-type", "application/gzip");
				res.setHeader("content-length", pkg.length);
				res.end(pkg);
			} catch {
				res.statusCode = 404;
				res.end("pi-agent.tgz not found");
			}
		});
		const offRotate = host.route("POST", "/rotate", (_req, res) => {
			token = crypto.randomBytes(16).toString("hex");
			host.storage.set("token", token);
			for (const [, e] of state.conns) {
				try {
					e.c.destroy();
				} catch {}
			}
			state.conns.clear();
			for (const [, a] of state.agents) {
				try {
					a.ws.send(JSON.stringify({ t: "kicked", reason: "令牌已重置" }));
				} catch {}
				try {
					a.ws.close();
				} catch {}
			}
			state.agents.clear();
			state.activeAgentId = null;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({ ok: true, tokenPrefix: `${token.slice(0, 4)}…`, hint: "令牌已重置：所有设备需重新下载 CLI" }),
			);
			notifyDebounced("info", "网络隧道：令牌已重置，所有设备 CLI 需重新下载");
		});
		const offStart = host.route("POST", "/start", async (_req, res) => {
			const ok = await startTunnel();
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok, running }));
		});
		const offStop = host.route("POST", "/stop", (_req, res) => {
			stopTunnel();
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, running }));
		});
		const offSelect = host.route("POST", "/agent/select", (req, res) => {
			let body = "";
			req.on("data", (ch) => {
				body += ch;
			});
			req.on("end", () => {
				let id = "";
				try {
					id = String(JSON.parse(body || "{}").id ?? "");
				} catch {}
				if (!agentById(id)) {
					res.setHeader("content-type", "application/json");
					return res.end(JSON.stringify({ ok: false, error: "设备不在线" }));
				}
				state.activeAgentId = id;
				const nm = state.agents.get(id)?.name || id;
				notifyDebounced("info", `网络隧道：出口已切换到 ${nm}`);
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ ok: true, activeAgentId: id }));
			});
		});

		const offConfig = host.route("POST", "/agent/config", async (req, res) => {
			{
				const j = await readBodyJson(req);
				let id = "",
					patch = {},
					name = "";
				id = String(j.id ?? "");
				patch = j;
				name = String(j.name || "");
				const a = state.agents.get(id);
				const nm = a?.name || name;
				res.setHeader("content-type", "application/json");
				if (!nm) return res.end(JSON.stringify({ ok: false, error: "设备不在线且未提供 name" }));
				const cur = capsOf(nm);
				const next = {
					fsRead: typeof patch.fsRead === "boolean" ? patch.fsRead : (cur.fsRead ?? true),
					fsWrite: typeof patch.fsWrite === "boolean" ? patch.fsWrite : (cur.fsWrite ?? false),
					whitelist:
						Array.isArray(patch.whitelist) && patch.whitelist.length
							? patch.whitelist
							: (cur.whitelist ?? ["~/Downloads"]),
				};
				devCfg[nm] = next;
				saveDevCfg();
				if (a) toAgent(id, { t: "config", ...next });
				try {
					host.notify(
						"info",
						`网络隧道：设备 ${nm} 配置已更新（fsWrite=${next.fsWrite}${a ? "" : "，待设备上线生效"}）`,
					);
				} catch {}
				res.end(JSON.stringify({ ok: true, name: nm, config: next, pending: !a }));
			}
		});
		host.route("POST", "/device/fsread", async (req, res) => {
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? ""),
					p = String(j.path || "~");
				const d = id
					? await deviceCtrl(id, "/fs/read?path=" + encodeURIComponent(p))
					: { status: 400, body: { error: "缺少设备 id" } };
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(d.body));
			}
		});
		host.route("POST", "/device/fs", async (req, res) => {
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? ""),
					p = String(j.path || "~");
				const d = id
					? await deviceCtrl(id, "/fs/browse?path=" + encodeURIComponent(p))
					: { status: 400, body: { error: "缺少设备 id" } };
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(d.body));
			}
		});
		host.route("POST", "/device/uninstall", async (req, res) => {
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? "");
				const a = state.agents.get(id);
				res.setHeader("content-type", "application/json");
				if (!a) return res.end(JSON.stringify({ ok: false, error: "设备不在线" }));
				toAgent(id, { t: "uninstall" });
				try {
					host.notify("warning", `网络隧道：已下发卸载指令到 ${a.name || id}（停常驻+删文件）`);
				} catch {}
				res.end(JSON.stringify({ ok: true }));
			}
		});
		host.route("POST", "/device/hw", async (req, res) => {
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? "");
				const d = id ? await deviceCtrl(id, "/sys/hw") : { status: 400, body: { error: "缺少设备 id" } };
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(d.body));
			}
		});
		host.route("POST", "/device/task", async (req, res) => {
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? "");
				res.setHeader("content-type", "application/json");
				if (!id) return res.end(JSON.stringify({ error: "缺少设备 id" }));
				const ag = state.agents.get(id);
				if (!ag) return res.end(JSON.stringify({ error: "设备不在线" }));

				const caps = capsOf(ag.name || id);
				const toolsCheck = validateTaskTools(j.tools || "read,grep,glob", caps);
				if (!toolsCheck.ok) {
					return res.end(JSON.stringify({ error: toolsCheck.error }));
				}

				const me = resolveModelEnv(String(j.model ?? "").trim());
				if (!me || me.error) {
					return res.end(
						JSON.stringify({
							error:
								"模型通道无法解析" +
								(me?.error ? `：${me.error}` : "") +
								"——可在面板「网络隧道 → 模型通道」手动指定，或检查 models.json / provider-keys.json",
						}),
					);
				}
				const payload = JSON.stringify({
					prompt: String(j.prompt ?? ""),
					tools: toolsCheck.tools.join(","),
					env: me.env,
					model: me.model,
					timeoutS: +j.timeoutS || 300,
				});
				console.log(
					`[tunnel] task → ${id} model=${me.model} src=${me.source} baseUrl=${me.baseUrl || "-"} promptLen=${payload.length}`,
				);
				const d = await deviceCtrl(id, "/task", { method: "POST", body: payload }, (+j.timeoutS || 300) * 1000 + 30000);
				res.end(JSON.stringify(d.body));
			}
		});
		host.route("GET", "/modelenv", (_req, res) => {
			res.setHeader("content-type", "application/json");
			let manual = null;
			try {
				const j = JSON.parse(host.storage.get("modelEnv") || "null");
				if (j?.baseUrl && j?.apiKey && j?.model)
					manual = { baseUrl: j.baseUrl, model: j.model, keyTail: String(j.apiKey).slice(-4) };
			} catch {}
			const { providers, keys } = loadModelProviders();
			const candidates = Object.entries(providers).map(([prov, pdef]) => ({
				provider: prov,
				api: pdef?.api || "-",
				baseUrl: devReachableBase(pdef?.baseUrl) || pdef?.baseUrl || "",
				hasKey: !!providerKey(keys, prov),
				models: (pdef?.models ?? []).slice(0, 8).map((m) => m.id),
			}));
			const r = resolveModelEnv();
			res.end(
				JSON.stringify({
					manual,
					resolved:
						r && !r.error
							? {
									model: r.model,
									source: r.source,
									baseUrl: r.baseUrl,
									keyTail: String(r.env.OPENAI_API_KEY || "").slice(-4),
								}
							: null,
					resolveError: r?.error || null,
					candidates,
				}),
			);
		});
		host.route("POST", "/modelenv", async (req, res) => {
			const j = await readBodyJson(req);
			res.setHeader("content-type", "application/json");
			if (j.clear) {
				host.storage.set("modelEnv", "");
				try {
					host.notify("info", "网络隧道：模型通道已恢复自动挑选");
				} catch {}
				return res.end(JSON.stringify({ ok: true, cleared: true }));
			}
			const baseUrl = String(j.baseUrl ?? "").trim();
			const apiKey = String(j.apiKey ?? "").trim();
			const model = String(j.model ?? "").trim();
			if (!/^https?:\/\//i.test(baseUrl) || !apiKey || !model)
				return res.end(JSON.stringify({ ok: false, error: "需要 baseUrl（http/https）、apiKey、model 三项齐全" }));
			host.storage.set("modelEnv", JSON.stringify({ baseUrl, apiKey, model }));
			try {
				host.notify("info", `网络隧道：设备任务模型通道已手动指定 → ${model}`);
			} catch {}
			res.end(JSON.stringify({ ok: true }));
		});
		const offAudit = host.route("GET", "/audit", (_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ items: auditRing.slice(-100).reverse() }));
		});

		const offTool = host.registerAgentTool({
			name: "tunnel_fetch",
			label: "隧道探测",
			description:
				"经「主人设备反向隧道」发 HTTP 请求：数据面在出口设备所在网络执行，DNS 也在出口设备侧解析。" +
				"用于巡检主人网络（出口 IP、内网设备端口、经主人网络访问外网）。" +
				"无在线设备时快速失败。多设备时走面板选中的出口设备。" +
				'示例: tunnel_fetch {url:"http://myip.ipip.net"} 返回出口设备网络的出口 IP。',
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "目标 URL（http/https），域名由出口设备侧解析" },
					timeout: { type: "number", description: "超时秒数，默认 20，范围 3-60" },
				},
				required: ["url"],
			},
			execute: async (_toolCallId, params) => {
				const url = String(params.url ?? "");
				if (!/^https?:\/\//.test(url)) return { ok: false, error: "url 需以 http(s):// 开头" };
				const timeout = Math.min(Math.max(Number(params.timeout ?? 20), 3), 60);
				const args = [
					"--socks5-hostname",
					`127.0.0.1:${socksPort}`,
					"--max-time",
					String(timeout),
					"-s",
					"-w",
					"\n__META__ %{http_code} %{time_total}s",
					url,
				];
				return new Promise((resolve) => {
					execFile("curl", args, { timeout: (timeout + 5) * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
						const offline = !activeAgent();
						if (err && !stdout) {
							return resolve({
								ok: false,
								agentOnline: !offline,
								error: String(err.code || err.message),
								hint: offline ? "无在线出口设备，隧道不可用" : undefined,
							});
						}
						const [body, meta] = String(stdout).split("\n__META__ ");
						resolve({
							ok: !err,
							agentOnline: !offline,
							via: state.agents.get(state.activeAgentId)?.name || state.activeAgentId,
							http: (meta || "").trim(),
							body: body.slice(0, 8000),
						});
					});
				});
			},
		});

		if (running) {
			notifyDebounced("info", "网络隧道插件已就绪（多设备模式）");
		}

		return () => {
			clearInterval(heartbeat);
			offStatus();
			offCli();
			offRotate();
			offStart();
			offStop();
			offSelect();
			offConfig();
			offAudit();
			offTool();
			stopMeshBridge();
			stopTunnel();
			try {
				wss.close();
			} catch {}
		};
	},
};
