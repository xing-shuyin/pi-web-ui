/**
 * pi-tunnel 插件服务端 —— 反向隧道（多设备共存）+ 本机 SOCKS5 出口。
 *
 * 数据面：AI --> SOCKS5(127.0.0.1:<socksPort>) --> WS(:<wsPort>) --> 出口设备 CLI --> 目标
 * DNS 解析发生在出口设备侧（SOCKS5 域名模式），测得即该设备所在网络真实结果。
 *
 * 多设备（B档，2026-10-19 主人拍板）：所有 CLI 共存在线（不互顶），server 维护设备表；
 *   SOCKS 流量走「当前出口设备」；出口掉线自动切换到剩余在线设备；面板可手动切换。
 *   CLI 零平台代码（Node net/WebSocket），hello 上报 name/os；旧 CLI 无 os 显示「—」兼容。
 *
 * 迁自 A 档 ~/projects/pi-tunnel/server/server.mjs（回环 + HTTPS 实测通过）。
 * ⚠ 全部逻辑内联本文件：宿主 plugins_reload 只对 index.mjs 做缓存击穿（?e=<epoch>），
 *   被 index 静态 import 的本地兄弟模块会命中 Node 模块缓存导致改动不生效。
 * 源仓：~/projects/pi-tunnel/plugin/（部署位 ~/.pi-web/plugins/tunnel/，cp 同步）。
 */
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

// ── ws 库定位：插件与宿主同进程，从宿主入口(process.argv[1])向上解析即可命中
// 宿主 node_modules 里的 ws —— 对任何用户的 npm -g / 本地安装环境都成立，不硬编码路径。
function loadWs() {
	const tries = [];
	if (process.env.PI_TUNNEL_WS) tries.push(process.env.PI_TUNNEL_WS);
	try {
		const hostRequire = createRequire(process.argv[1] || import.meta.url);
		tries.push(hostRequire.resolve("ws"));
	} catch {}
	tries.push("ws"); // 插件目录自身/全局 node_modules 兑底
	for (const spec of tries) {
		try {
			return require(spec);
		} catch {}
	}
	throw new Error("pi-tunnel: 找不到 ws 库（设 PI_TUNNEL_WS=<ws包路径>）");
}

// ── 纯函数区（可离线单测）─────────────────────────────────────────────────────
/** 常时口令安全比对（SHA-256 哈希后 timingSafeEqual，消除逐字节短路时序侧信道）。 */
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

/** 校验任务通道工具是否符合设备端能力模型约束（fsRead / fsWrite）。 */
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

/** 过滤并校验 mesh 发送目标名称（必须合法标识符，防止路径穿越）。 */
export function sanitizeMeshTo(to) {
	if (typeof to !== "string") return "";
	const s = to.trim();
	return /^[a-zA-Z0-9_-]+$/.test(s) ? s : "";
}

/** 目录浏览安全白名单检查（限制在用户目录与外置卷，禁止系统保留根路径）。 */
export function isRestrictedBrowsePath(targetPath, homeDir = os.homedir()) {
	if (!targetPath || typeof targetPath !== "string") return true;
	const norm = targetPath.trim().replace(/\\/g, "/");

	// 严格禁止 Unix 系统敏感目录及根目录
	const blockedPrefixes = ["/etc", "/proc", "/sys", "/dev", "/var", "/root", "/boot", "/bin", "/sbin", "/usr"];
	if (norm === "/" || blockedPrefixes.some((p) => norm === p || norm.startsWith(p + "/"))) {
		return true;
	}

	const resolved = path.resolve(targetPath);
	const home = path.resolve(homeDir);

	// 允许在用户主目录或其子目录中浏览
	if (resolved === home || resolved.startsWith(home + path.sep)) {
		return false;
	}

	// 跨盘/外接存储卷（macOS /Volumes/*, Linux /media/*, /mnt/*, Windows X:\）
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

/** 解析 SOCKS5 CONNECT 请求（RFC1928，仅 CMD=CONNECT；ATYP 1=IPv4 3=域名；4=IPv6 不支持）。 */
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
/** 自动探测本机内网 IPv4（面板生成常驻命令用，用户零配置；跨平台）。 */
export function detectLanIp() {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address))
				return a.address;
		}
	}
	return "";
}
/** HTML 转义（面板渲染设备名/OS 用，防注入习惯）。 */
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
		// token 首次运行自动生成（代码里不硬编码；重置走面板或 POST /rotate）
		let token = host.storage.get("token");
		if (!token) {
			token = crypto.randomBytes(16).toString("hex");
			host.storage.set("token", token);
		}

		const state = {
			agents: new Map(), // aid -> { ws, name, os, since, ctrlPort }
			activeAgentId: null, // 当前出口设备
			conns: new Map(), // cid -> { c, replied, aid }
			nextId: 1,
			nextAid: 1,
			totalServed: 0,
			lastNotifyAt: 0,
			ctrlPending: new Map(), // P4: rid -> { resolve }（面板→设备控制请求-响应）
		};
		let ctrlSeq = 0;
		// POST body 读取：宿主 express.json 已消费流时用 req.body（手动读会永远等不到 end → ECONNRESET，20261019 实战根因）；
		// content-type 非 JSON（express.json 跳过）时兜底手动读。
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
		// 面板经 server 中转到设备控制 API（复用 CLI 本机鉴权/审计，不走 SOCKS 开销）
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
		// ── 模型通道（v1.2 重写）──────────────────────────────────────────────
		// 旧版两缺陷（20261024 修复）：
		//   ① 正则扫 client-state.json 全文取「第一个 provider/model」——命中 projectModels 里任意项目条目，并非当前会话模型
		//   ② 标准 provider 返回 {env:{}} 只传模型 ID——设备端 pi 无凭据直接报 No API key
		// 新版语义（模型通道 = 为设备任务挑一条可用通道，不再假装「跟随会话」），三级解析：
		//   ① 请求级 override：POST /device/task 带 model="provider/model[/…]" → 精确解析该 provider
		//   ② 面板手动 modelEnv（storage 三元组）——明确指定优先于自动挑选
		//   ③ 自动枚举：models.json providers ∩ provider-keys.json，仅 openai-completions 型
		//     （设备端 cli.mjs /task 仅对 OPENAI_* 回写设备 models.json）；baseUrl 为
		//     127.0.0.1/localhost 时换算 lanIp——设备与本机同网段直连，流量不出公网
		// 返回 { env, model, source, baseUrl }；可解析但语义不匹配时返回 { error }；完全失败返回 null
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
				model: fullModel.split("/").slice(1).join("/") || fullModel, // 剥 provider 前缀 = provider 侧模型 ID
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
				); // 内网网关型优先：设备流量不出公网
				for (const [prov, pdef] of order) {
					if (!pdef?.models?.[0]?.id) continue;
					const r = buildModelChannel(providers, keys, prov, pdef, `${prov}/${pdef.models[0].id}`, "auto");
					if (!r.error) return r;
				}
			} catch {}
			return null;
		};
		// C 档 P1：审计环 + 设备能力配置（按 name 持久化，重连不丢授权）
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
		/** 出口掉线时自动切换到剩余在线设备；无设备则提示。 */
		const ensureActive = () => {
			if (agentById(state.activeAgentId)) return;
			state.activeAgentId = pickAnyOnline();
			if (state.activeAgentId) {
				const nm = state.agents.get(state.activeAgentId)?.name || state.activeAgentId;
				notifyDebounced("info", `网络隧道：出口设备已切换到 ${nm}`);
			}
		};
		const CLI_VER_PUBLISH = "p16"; // 能力版本：server 握手下发最新版，本地旧则自更新（与 assets/cli.mjs CLI_VER 同步）
		const lanIp = detectLanIp(); // 面板生成常驻命令用（网络变化随插件重载自动更新）

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
				rev: "c1-p3", // 代码版本标记：reload 后可观测新代码是否激活
				lanIp,
				agentOnline: !!activeAgent(), // 兼容旧面板语义：当前出口在线
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
				token: includeToken ? token : "", // 宿主未设 PI_WEB_TOKEN 时脱敏保护，防止公网反代无鉴权暴露下泄露
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

		// ── WS 汇聚 + CLI 下载（:wsPort，全网卡——主人设备经 WG 连入）──────────────
		// ── 鉴权（上游 60daa53d 移植）：wsPort 全网卡暴露，/cli 与 /status 必须校验 token，
		// 否则任意同网可达主机都能拿到内嵌完整 token 的 CLI 代码冒充设备、踢掉真设备、劫持 SOCKS 出口。
		// 宿主 route 通道（/plugins-api/tunnel/*）由面板自身鉴权体系保护，不加此处。
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
				if (!agentById(state.activeAgentId)) state.activeAgentId = aid; // 无出口时首连即出口
				ws.on("message", (raw) => {
					let m;
					try {
						m = JSON.parse(raw.toString());
					} catch {
						return;
					}
					const e = state.conns.get(m.id);
					// SOCKS 连接消息设备归属校验：防止任一已配对设备伪造/跨设备串扰其他连接
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
							// 应用层心跳应答（CLI 25s 一发，服务端回 pong 供其判僵尸——TCP 半开时 onclose 不触发，靠这个自愈）
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
							// 同名设备：能力优先（ctrlPort>0 的 P1 版保留）——旧版重连被拒长退避，根治互踢循环
							const twin = [...state.agents.entries()].find(
								([oid, oa]) => oid !== aid && oa.name && oa.name === a?.name && oa.ws.readyState === 1,
							);
							if (twin) {
								const [oid, oa] = twin;
								const newFull = a.ctrlPort > 0 && !(oa.ctrlPort > 0); // 新连接有控制 API 而在线的没有 → 新版接管
								if (!newFull) {
									// 新连接是旧版（或在线的也是新版）：拒绝本次连接，令其长退避
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
							// 重连自动同步持久化配置（一次性标志，防 hello↔config 死循环：CLI 收 config 回 hello，server 又推 → 无限闪烁）
							if (devCfg[a.name] && !a.cfgSent) {
								a.cfgSent = true;
								toAgent(aid, { t: "config", ...devCfg[a.name] });
							}
							// P3a: mesh 桥——设备上线刷新 registry + 积压补发
							if (meshEnabled() && meshWatcher && a?.name) {
								const nm = meshAgentName(a.name);
								meshRegistry(nm, a.name, true);
								meshScanInbox(nm);
							}
							try {
								ws.send(JSON.stringify({ t: "ver", v: CLI_VER_PUBLISH }));
							} catch {} // 握手下发最新 CLI 能力版本（旧版自更新；与 assets/cli.mjs 的 CLI_VER 保持一致）
							break;
						}
						case "audit": {
							// C 档 P1：CLI 批量上报的操作审计（清洗字段并钳制时间戳）
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
							// P4: 设备控制响应回给等待中的面板请求（校验 aid 归属防止抢答）
							const p = state.ctrlPending.get(m.rid);
							if (p && p.aid === aid) {
								state.ctrlPending.delete(m.rid);
								p.resolve({ status: m.status ?? 500, body: m.body ?? {} });
							}
							break;
						}
						case "msg-res": {
							// P3a: 设备 mesh 任务结果上行 → 写发起方 inbox
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
							const to = pm.to; // 严格以服务端记录的发起方为准，绝不信任客户端自报的 m.to
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
					// 该设备承载的 SOCKS 连接全部拆除
					for (const [cid, e] of state.conns) {
						if (e.aid !== aid) continue;
						try {
							e.c.destroy();
						} catch {}
						state.conns.delete(cid);
					}
					ensureActive();
					notifyDebounced("warning", `网络隧道：设备 ${nm} 已断开`);
					// P3a: mesh 桥——设备下线标记 registry
					if (meshEnabled() && meshWatcher) meshRegistry(meshAgentName(nm), nm, false);
				});
				ws.on("error", () => {});
			});
		});

		// ── SOCKS5（仅本机）───────────────────────────────────────────────────────
		const socksSrv = net.createServer((c) => {
			c.on("error", () => {});
			let stage = 0;
			c.on("data", (buf) => {
				if (stage === 0) {
					// 阶段1: 方法协商（curl 分步收发不粘包，A 档实测成立）
					if (buf[0] !== 5) return c.destroy();
					c.write(Buffer.from([5, 0]));
					stage = 1;
					return;
				}
				c.removeAllListeners("data"); // 阶段2: CONNECT 请求
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
				} // 无在线设备：拒绝，AI 侧表现为快速失败
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

		// ── P3a: pi_messenger mesh 桥（设计 docs/PHASE3-MESH-DESIGN.md）────────────
		// 纯文件 mesh：桥替设备 agent 读写 registry/inbox；发起方 wake 由其 pi-messenger watcher 自带，零改造。
		const MESH_DIR = path.join(os.homedir(), ".pi", "agent", "messenger");
		const meshPending = new Map(); // msgId -> { to, from, timer }
		const meshQueue = []; // 待投递消息（设备离线时滞留，上线扫描补发）
		let meshBusy = false;
		let meshWatcher = null;
		function meshEnabled() {
			return host.storage.get("meshEnabled") === "1";
		} // function 声明带提升：hello/离线钩子可在 startTunnel await 让出期触发（const 箭头 TDZ 竞态已两次致 activate failed）
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
						j.offline = true; // pi-messenger 忽略未知字段，安全
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
			// 写发起方（mini 侧 pi 会话）inbox → 其 pi-messenger watcher 自动 wake（零改造）
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
			// 串行消费（防多设备/多消息并发冲突）；设备离线则滞留队列等上线扫描
			// P3b: 按目标路由——消息所在 inbox 目录即目标设备 agent（<nm>/xxx.json），经 registry 反查设备 aid 投递；
			// p3a 版本错误地投给 activeAgent()（单设备侥幸正确，多设备必投错）
			if (meshBusy) return;
			meshBusy = true;
			try {
				while (meshQueue.length) {
					const item = meshQueue.shift();
					const { file, msg, nm } = item;
					// registry <nm>.json 里存的 devName（物理设备名）→ state.agents 里找 aid
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
						break; // 目标设备不在线：滞留等上线补发（meshScanInbox 会重新入队）
					}
					const me = resolveModelEnv(); // mesh 任务走三级解析默认路径
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
						} catch {} // 投递成功即标记（server 重启不重投；结果由 msg-res 异步回）
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
				if (msg?.to && msg?.from && typeof msg.text === "string") meshQueue.push({ file: fp, msg, nm }); // nm = 目标设备 agent 名（P3b 路由用）
			} catch {}
		}
		function meshScanInbox(nm) {
			// 上线补发：inbox/<nm>/ 未处理消息按时间序，限最近 5 条，更旧标记跳过并回写发起方
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
				if (parts[0] !== nm || !parts[1]?.endsWith(".json") || parts[1].endsWith(".done")) return; // 只消费设备 agent 自己的 inbox，防环
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
		// P3b: 设备端 mesh 会话快照（只读）——默认活跃设备，可 ?agent=<设备agent名> 指定
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
		// P3b: 重置设备端 mesh 会话（删 session.json，下次消息开新会话）
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

		// ── 服务启停（面板按钮 / POST /start /stop 控制；插件激活时默认启动）────────
		let running = false;
		async function startTunnel() {
			if (running) return true;
			const upWs = await listenSafe(httpSrv, wsPort, "0.0.0.0", `WS:${wsPort}`);
			const upSocks = await listenSafe(socksSrv, socksPort, "127.0.0.1", `SOCKS:${socksPort}`);
			running = upWs || upSocks;
			if (running) notifyDebounced("info", "网络隧道服务已启动");
			// P3a: mesh 桥的启动移到 hello 钩子（设备上线后注册+补发），此处不依赖块级 meshEnabled
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
			stopMeshBridge(); // 停隧道一并关闭 mesh 桥并标记 registry 下线，防 watcher/timer 句柄泄露
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

		// 端口被占时不拖垮宿主：error 后 notify 并继续
		const listenSafe = (srv, port, addr, name) =>
			new Promise((resolve) => {
				srv.once("error", (e) => {
					notifyDebounced("error", `pi-tunnel ${name} 启动失败：${e.code || e.message}`);
					resolve(false);
				});
				srv.listen(port, addr, () => resolve(true));
			});
		await startTunnel(); // 激活即运行，面板可随时停/启
		// 心跳 + 半开检测：ping 后未回 pong 的连接判定为僵尸（进程退出未挥手/网络半开），
		// terminate 触发 close → 从设备表移除（否则假在线残留，SOCKS 全部空响应，20261019 实战根因）
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

		// ── 宿主集成：route（面板数据 + CLI 下载 + 令牌轮换 + 出口切换 + 启停）───────
		const offStatus = host.route("GET", "/status", (_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(statusSnapshot()));
		});
		const offCli = host.route("GET", "/cli", (req, res) => {
			res.setHeader("content-type", "text/javascript; charset=utf-8");
			res.end(cliCode(req));
		});
		host.route("GET", "/pi-pkg", (_req, res) => {
			// pi agent 离线安装包（mac 自包含 tgz，设备免公网 npm）
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
			// 踢掉所有已连接设备与现有 SOCKS 连接：旧 token 失效后必须重新配对
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

		// C 档 P1：设备能力/白名单下发（CLI 持久化并回 hello 确认）+ 审计查询
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
				const nm = a?.name || name; // 离线预配置：设备 crash/不在线时可直接传 name 持久化，重连自动下发（防 fsWrite 死锁）
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
			// P3a 收尾：面板读设备文件（白名单内，只读）——KeepAlive 排障用
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
			// P4: 面板浏览设备目录（选白名单路径用）
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
			// P4: 面板下发 CLI 自卸载
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
			// P4+: 查看设备硬件概览（只读）
			{
				const j = await readBodyJson(req);
				const id = String(j.id ?? "");
				const d = id ? await deviceCtrl(id, "/sys/hw") : { status: 400, body: { error: "缺少设备 id" } };
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(d.body));
			}
		});
		host.route("POST", "/device/task", async (req, res) => {
			// P4-B: 通用任务通道（指挥设备 pi agent）
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

				const me = resolveModelEnv(String(j.model ?? "").trim()); // 请求级 model override 优先于面板手动/自动
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
			// v1.2: 模型通道状态（key 只回尾部 4 位，不回全文）
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
			// v1.2: 手动指定模型通道三元组；{clear:true} 恢复自动挑选
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

		// ── 宿主集成：AI 工具（数据面 = 当前出口设备所在网络）──────────────────────
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

		// deactivate 清理（宿主 reload/停用时调用）
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
