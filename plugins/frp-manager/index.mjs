// frp-manager · 内网穿透一站式管理（frpc + 本地 frps 联调 + 远端 frps 一键部署）
// 纯函数区（平台映射 / 下载地址 / TOML 生成 / 校验 / 远端脚本）可被单测直接 import；
// 下半是 activate（状态文件、进程托管、AI 工具、HTTP 路由）。
// 刻意单文件：宿主 reload 只给 index.mjs 加缓存击穿，兄弟模块改了不生效。
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

export const FRP_DEFAULT_VERSION = "0.61.1";
export const STATE_FILE = "state.json";

/** 平台 → frp 官方 asset 后缀映射 */
export function detectAsset(platform = process.platform, arch = process.arch) {
	const a = arch === "arm64" ? "arm64" : arch === "arm" ? "arm" : "amd64";
	if (platform === "win32") return { os: "windows", arch: a === "arm" ? "arm64" : a, ext: "zip" };
	if (platform === "darwin") return { os: "darwin", arch: a, ext: "tar.gz" };
	return { os: "linux", arch: a === "arm" ? "arm" : a, ext: "tar.gz" };
}

export function sanitizeVersion(v) {
	const s = String(v || "")
		.trim()
		.replace(/^v/, "");
	return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(s) ? s : FRP_DEFAULT_VERSION;
}

/** 官方 release 包下载地址（GitHub） */
export function frpDownloadUrl(version, platform = process.platform, arch = process.arch) {
	const v = sanitizeVersion(version);
	const a = detectAsset(platform, arch);
	return `https://github.com/fatedier/frp/releases/download/v${v}/frp_${v}_${a.os}_${a.arch}.${a.ext}`;
}

export function tomlEscape(s) {
	return JSON.stringify(String(s ?? ""));
}

function nl(v) {
	const n = Number(v);
	return Number.isFinite(n) ? String(Math.trunc(n)) : "0";
}

/** 生成 frpc.toml（TOML 新版 v0.52+） */
export function buildFrpcToml(common = {}, proxies = []) {
	const L = [];
	L.push(`serverAddr = ${tomlEscape(common.serverAddr || "127.0.0.1")}`);
	L.push(`serverPort = ${nl(common.serverPort ?? 7000)}`);
	if (common.token) {
		L.push(`auth.method = "token"`);
		L.push(`auth.token = ${tomlEscape(common.token)}`);
	}
	if (common.tlsEnable) L.push(`transport.tls.enable = true`);
	L.push("");
	for (const p of proxies) {
		if (p.enabled === false) continue;
		L.push(`[[proxies]]`);
		L.push(`name = ${tomlEscape(p.name)}`);
		L.push(`type = ${tomlEscape(p.type || "tcp")}`);
		L.push(`localIP = ${tomlEscape(p.localIP || "127.0.0.1")}`);
		L.push(`localPort = ${nl(p.localPort ?? 0)}`);
		if (p.type === "http" || p.type === "https") {
			if (p.customDomains)
				L.push(
					`customDomains = [${String(p.customDomains)
						.split(/[,\s]+/)
						.filter(Boolean)
						.map(tomlEscape)
						.join(", ")}]`,
				);
			if (p.subdomain) L.push(`subdomain = ${tomlEscape(p.subdomain)}`);
		} else {
			if (p.remotePort) L.push(`remotePort = ${nl(p.remotePort)}`);
		}
		if (p.useEncryption) L.push(`transport.useEncryption = true`);
		if (p.useCompression) L.push(`transport.useCompression = true`);
		L.push("");
	}
	return L.join("\n");
}

/** 生成 frps.toml */
export function buildFrpsToml(cfg = {}) {
	const L = [];
	L.push(`bindPort = ${nl(cfg.bindPort ?? 7000)}`);
	if (cfg.token) {
		L.push(`auth.method = "token"`);
		L.push(`auth.token = ${tomlEscape(cfg.token)}`);
	}
	if (cfg.httpPort) L.push(`vhostHTTPPort = ${nl(cfg.httpPort)}`);
	if (cfg.httpsPort) L.push(`vhostHTTPSPort = ${nl(cfg.httpsPort)}`);
	if (cfg.dashboardPort) {
		L.push(`webServer.addr = "0.0.0.0"`);
		L.push(`webServer.port = ${nl(cfg.dashboardPort)}`);
		L.push(`webServer.user = ${tomlEscape(cfg.dashboardUser || "admin")}`);
		L.push(`webServer.password = ${tomlEscape(cfg.dashboardPwd || "admin")}`);
	}
	if (cfg.subdomainHost) L.push(`subdomainHost = ${tomlEscape(cfg.subdomainHost)}`);
	L.push("");
	return L.join("\n");
}

/** 校验一条穿透规则，返回 "" 表示通过 */
export function validateProxy(p = {}) {
	if (!p.name || !/^[A-Za-z0-9_.-]{1,64}$/.test(String(p.name))) return "名称需为 1-64 位字母/数字/._-";
	const t = String(p.type || "tcp");
	if (!["tcp", "udp", "http", "https", "stcp", "sudp", "xtcp"].includes(t)) return `未知类型 ${t}`;
	const lp = Number(p.localPort);
	if (!Number.isInteger(lp) || lp < 1 || lp > 65535) return "本地端口需为 1-65535";
	if (t === "http" || t === "https") {
		if (!p.customDomains && !p.subdomain) return "http/https 需填写 customDomains 或 subdomain";
	} else if (t === "tcp" || t === "udp") {
		const rp = Number(p.remotePort);
		if (!Number.isInteger(rp) || rp < 1 || rp > 65535) return "tcp/udp 需填写 1-65535 的远程端口";
	}
	return "";
}

/** 生成远端公网 frps 一键安装脚本（Debian/Ubuntu/CentOS 通用，root 运行） */
export function buildRemoteInstallScript(o = {}) {
	const v = sanitizeVersion(o.version);
	const bindPort = nl(o.bindPort ?? 7000);
	const token = String(o.token || "CHANGE_ME_TOKEN");
	const httpPort = o.httpPort ? nl(o.httpPort) : "";
	const httpsPort = o.httpsPort ? nl(o.httpsPort) : "";
	const dashPort = o.dashboardPort ? nl(o.dashboardPort) : "";
	const dashUser = String(o.dashboardUser || "admin");
	const dashPwd = String(o.dashboardPwd || "admin");
	const lines = [
		`#!/usr/bin/env bash`,
		`set -e`,
		`ARCH=$(uname -m)`,
		`case "$ARCH" in x86_64) FARCH=amd64;; aarch64|arm64) FARCH=arm64;; armv*) FARCH=arm;; *) FARCH=amd64;; esac`,
		'cd /tmp && DL="https://github.com/fatedier/frp/releases/download/v' +
			v +
			"/frp_" +
			v +
			'_linux_${FARCH}.tar.gz" && (curl -fSLO "$DL" || wget "$DL")',
		'tar -xzf "frp_' + v + '_linux_${FARCH}.tar.gz"',
		'install -m 755 "frp_' + v + '_linux_${FARCH}/frps" /usr/local/bin/frps',
		`mkdir -p /etc/frp`,
		`cat > /etc/frp/frps.toml <<'EOF'`,
		`bindPort = ${bindPort}`,
		`auth.method = "token"`,
		`auth.token = "${token.replace(/"/g, "")}"`,
		...(httpPort ? [`vhostHTTPPort = ${httpPort}`] : []),
		...(httpsPort ? [`vhostHTTPSPort = ${httpsPort}`] : []),
		...(dashPort
			? [
					`webServer.addr = "0.0.0.0"`,
					`webServer.port = ${dashPort}`,
					`webServer.user = "${dashUser}"`,
					`webServer.password = "${dashPwd}"`,
				]
			: []),
		`EOF`,
		`cat > /etc/systemd/system/frps.service <<'EOF'`,
		`[Unit]`,
		`Description=frps`,
		`After=network.target`,
		`[Service]`,
		`ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml`,
		`Restart=on-failure`,
		`[Install]`,
		`WantedBy=multi-user.target`,
		`EOF`,
		`systemctl daemon-reload && systemctl enable --now frps`,
		`echo "frps ${v} installed. bindPort=${bindPort}"`,
		`ss -lnt | grep -E '${bindPort}${dashPort ? `|${dashPort}` : ""}' || true`,
	];
	return lines.join("\n");
}

// ── 服务端 ──────────────────────────────────────────────

function atomicWrite(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}

function defaultState() {
	return {
		common: { serverAddr: "", serverPort: 7000, token: "", tlsEnable: false },
		proxies: [],
		frps: {
			bindPort: 7000,
			token: "",
			httpPort: 8080,
			httpsPort: 0,
			dashboardPort: 7500,
			dashboardUser: "admin",
			dashboardPwd: "admin",
			subdomainHost: "",
		},
		remote: { profile: "" },
	};
}

export default {
	async activate(host) {
		const dataDir = join(host.dataDir, "frp-manager");
		const binDir = join(dataDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const stateFile = join(dataDir, STATE_FILE);
		let state = defaultState();
		try {
			if (existsSync(stateFile)) state = { ...defaultState(), ...JSON.parse(readFileSync(stateFile, "utf8")) };
		} catch {}
		const save = () => {
			try {
				atomicWrite(stateFile, JSON.stringify(state, null, 2));
			} catch (e) {
				host.log(`frp-manager state 保存失败：${e.message}`);
			}
		};

		const settings = () => host.getSettings?.() ?? {};
		const exe = process.platform === "win32" ? ".exe" : "";
		const binName = (k) => (process.platform === "win32" ? `${k}.exe` : k);

		function settingsBin(kind) {
			const s = settings();
			const v = String(kind === "frpc" ? s.frpcPath || "" : s.frpsPath || "").trim();
			if (v && existsSync(v)) return v;
			return "";
		}
		function localBin(kind) {
			const p = join(binDir, binName(kind));
			return existsSync(p) ? p : "";
		}
		function pathBin(kind) {
			const dirs = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
			const exts = process.platform === "win32" ? ["", ".exe"] : [""];
			for (const d of dirs) {
				for (const e of exts) {
					try {
						const p = join(d, kind + e);
						if (p && existsSync(p)) return p;
					} catch {}
				}
			}
			return "";
		}
		const resolveBin = (kind) => settingsBin(kind) || localBin(kind) || pathBin(kind);
		const frpcTomlPath = join(dataDir, "frpc.toml");
		const frpsTomlPath = join(dataDir, "frps.toml");

		const procs = { frpc: null, frps: null };
		const logs = { frpc: [], frps: [] };
		const pushLog = (role, line) => {
			const arr = logs[role];
			arr.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${line}`);
			if (arr.length > 400) arr.splice(0, arr.length - 400);
		};

		function spawnDaemon(role, bin, args, cwd) {
			stopDaemon(role, true);
			const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.on("data", (d) =>
				String(d)
					.split(/\r?\n/)
					.filter(Boolean)
					.forEach((l) => pushLog(role, l)),
			);
			child.stderr?.on("data", (d) =>
				String(d)
					.split(/\r?\n/)
					.filter(Boolean)
					.forEach((l) => pushLog(role, l)),
			);
			child.on("exit", (code) => {
				pushLog(role, `进程退出 code=${code}`);
				if (procs[role]?.pid === child.pid) procs[role] = null;
			});
			procs[role] = child;
			pushLog(role, `启动：${bin} ${args.join(" ")} (pid=${child.pid})`);
			return child;
		}
		function stopDaemon(role, silent = false) {
			const c = procs[role];
			if (!c) return false;
			try {
				process.platform === "win32" ? c.kill() : c.kill("SIGTERM");
				setTimeout(() => {
					try {
						if (procs[role]?.pid === c.pid) c.kill("SIGKILL");
					} catch {}
				}, 3000).unref?.();
			} catch {}
			procs[role] = null;
			if (!silent) pushLog(role, "已停止");
			return true;
		}
		const isAlive = (role) => {
			const c = procs[role];
			return !!(c && c.exitCode === null && c.signalCode === null);
		};

		function writeTomls() {
			atomicWrite(frpcTomlPath, buildFrpcToml(state.common, state.proxies));
			atomicWrite(frpsTomlPath, buildFrpsToml(state.frps));
		}
		writeTomls();

		const execFileP = (f, a, o = {}) =>
			new Promise((res) =>
				execFile(f, a, { timeout: o.timeout ?? 60000, ...o }, (err, stdout, stderr) =>
					res({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }),
				),
			);

		let installing = null;
		async function installBinaries(version) {
			if (installing) return installing;
			const v = sanitizeVersion(version || settings().frpVersion || FRP_DEFAULT_VERSION);
			installing = (async () => {
				const url = frpDownloadUrl(v);
				const asset = detectAsset();
				const tmpFile = join(dataDir, `frp_${v}.${asset.ext}`);
				pushLog("frpc", `下载 frp v${v}：${url}`);
				const resp = await fetch(url);
				if (!resp.ok)
					throw new Error(`下载失败 HTTP ${resp.status}（本机直连 GitHub 失败可手动把 frpc/frps 放到 ${binDir}）`);
				const buf = Buffer.from(await resp.arrayBuffer());
				writeFileSync(tmpFile, buf);
				if (asset.ext === "zip") {
					if (process.platform === "win32") {
						const r = await execFileP(
							"powershell",
							["-NoProfile", "-Command", `Expand-Archive -Force '${tmpFile}' '${binDir}'`],
							{ timeout: 120000 },
						);
						if (r.err) throw new Error(`解压失败：${r.stderr || r.err.message}`);
					} else {
						const r = await execFileP("unzip", ["-o", tmpFile, "-d", binDir], { timeout: 120000 });
						if (r.err) throw new Error(`解压失败：${r.stderr || r.err.message}（需安装 unzip）`);
					}
				} else {
					const r = await execFileP("tar", ["-xzf", tmpFile, "-C", binDir], { timeout: 120000 });
					if (r.err) throw new Error(`解压失败：${r.stderr || r.err.message}`);
				}
				// tar 出来是 frp_x.y.z_os_arch/ 子目录，把里面的 frpc/frps 提到 bin/
				const { readdirSync, copyFileSync, rmSync } = await import("node:fs");
				for (const e of readdirSync(binDir)) {
					const sub = join(binDir, e);
					try {
						const inner1 = join(sub, binName("frpc"));
						const inner2 = join(sub, binName("frps"));
						if (existsSync(inner1)) {
							copyFileSync(inner1, join(binDir, binName("frpc")));
							if (existsSync(inner2)) copyFileSync(inner2, join(binDir, binName("frps")));
							rmSync(sub, { recursive: true, force: true });
						}
					} catch {}
				}
				try {
					if (process.platform !== "win32") {
						chmodSync(join(binDir, "frpc"), 0o755);
						chmodSync(join(binDir, "frps"), 0o755);
					}
				} catch {}
				try {
					const { unlinkSync } = await import("node:fs");
					unlinkSync(tmpFile);
				} catch {}
				pushLog("frpc", `frp v${v} 安装完成`);
				return { version: v };
			})();
			try {
				return await installing;
			} finally {
				installing = null;
			}
		}

		// 共享 SSH 主机库（global-hosts.json）：与远程工作台/SFTP 同一份，密码不出库
		const getRemoteSsh = () => (typeof host.services?.get === "function" ? host.services.get("remoteSsh") : null);
		async function listSharedProfiles() {
			try {
				const svc = getRemoteSsh();
				if (!svc) return [];
				const list = await svc.listProfiles();
				return (list || []).map((p) => ({
					name: p.name,
					host: p.host,
					port: p.port,
					username: p.username,
					authType: p.authType,
				}));
			} catch {
				return [];
			}
		}
		// 经共享 SSH 连接执行远端命令（ssh2 通道，base64 传脚本避开引号坑）
		function sshExec(client, cmd, timeoutMs = 180000) {
			return new Promise((resolve, reject) => {
				let out = "";
				let settled = false;
				let ch;
				const timer = setTimeout(() => {
					finish(new Error("远端命令超时"));
					try {
						ch?.close();
					} catch {}
				}, timeoutMs);
				const finish = (err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (err) reject(err);
					else resolve(out);
				};
				try {
					client.exec(cmd, (err, stream) => {
						if (err) return finish(err);
						ch = stream;
						stream.on("data", (d) => (out += d));
						stream.stderr.on("data", (d) => (out += d));
						stream.on("close", () => finish());
					});
				} catch (e) {
					finish(e);
				}
			});
		}
		async function status() {
			const profiles = await listSharedProfiles();
			const sel = profiles.find((p) => p.name === state.remote.profile || p.host === state.remote.profile) || null;
			return {
				ok: true,
				platform: `${process.platform}/${process.arch}`,
				frpcBin: resolveBin("frpc"),
				frpsBin: resolveBin("frps"),
				binDir,
				frpc: { running: isAlive("frpc"), pid: procs.frpc?.pid || 0 },
				frpsLocal: { running: isAlive("frps"), pid: procs.frps?.pid || 0 },
				common: state.common,
				proxies: state.proxies,
				frps: state.frps,
				remote: { profile: state.remote.profile || "", host: sel?.host || "", profiles },
				downloadUrl: frpDownloadUrl(settings().frpVersion || FRP_DEFAULT_VERSION),
			};
		}

		// 经共享 SSH 主机库部署远端 frps（probeOnly=true 时只测连通+看系统）
		async function deployRemote(probeOnly = false) {
			const svc = getRemoteSsh();
			if (!svc) throw new Error("宿主 remoteSsh 服务未就绪（升级 pi-web-ui 后重试）");
			const sel = String(state.remote.profile || "");
			if (!sel) throw new Error("还没选远端主机（面板远端部署页下拉选择，或 remote_use 指定）");
			const profiles = await svc.listProfiles();
			const prof = (profiles || []).find((p) => p.name === sel || p.host === sel);
			if (!prof) throw new Error(`共享主机库里找不到「${sel}」（先去远程工作台/SFTP 添加该主机）`);
			const conn = await svc.getOrConnectHost(prof.host, prof.port, prof.username);
			if (probeOnly) {
				const out = await sshExec(
					conn.client,
					"uname -a; echo ---; (cat /etc/os-release 2>/dev/null | head -2) || true",
					30000,
				);
				return `已连通 ${prof.name}（${prof.username}@${prof.host}:${prof.port}）：\n${out.trim()}`;
			}
			const script = buildRemoteInstallScript({
				version: settings().frpVersion,
				...state.frps,
				token: state.frps.token || state.common.token,
			});
			const b64 = Buffer.from(script, "utf8").toString("base64");
			const runner = prof.username === "root" ? "bash -s" : "sudo -n bash -s";
			// 分片传避免单条命令过长：base64 按 4k 切片多次 echo 追加
			const chunks = b64.match(/.{1,4000}/g) || [];
			const tmpf = "/tmp/frps-install-" + Date.now() + ".sh.b64";
			const asm = chunks.map((c, i) => `echo '${c}' ${i ? ">>" : ">"} ${tmpf}`).join(" && ");
			const cmd = `${asm} && base64 -d ${tmpf} | ${runner} && rm -f ${tmpf}`;
			if (!state.frps.token && !state.common.token)
				pushLog("frps", "提醒：token 为空，远端装完后记得在本地 frps 页设置并与 frpc 对齐");
			pushLog("frps", `经共享主机 ${prof.name} 部署远端 frps ...`);
			const out = await sshExec(conn.client, cmd, 240000);
			pushLog("frps", String(out).split("\n").slice(-25).join("\n"));
			state.common.serverAddr = state.common.serverAddr || prof.host;
			save();
			writeTomls();
			return `远端 frps 部署完成（${prof.name} ${prof.username}@${prof.host}）：\n${String(out).slice(-1200).trim()}\nfrpc 服务端地址已同步为 ${state.common.serverAddr}`;
		}

		// ── AI 工具（单 action 式，schema 只留字段名/类型） ──
		const offTool = host.registerAgentTool({
			name: "frp",
			description:
				"Manage frp tunnels: action=status|list|add|update|remove|toggle|set_server|frps_set|frpc_start|frpc_stop|frpc_restart|frps_start|frps_stop|logs|install|remote_list|remote_use|remote_probe|remote_deploy|remote_script. TOML config, frpc proxies, local frps debug, remote frps deploy via shared SSH hosts.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string" },
					name: { type: "string" },
					json: { type: "string" },
				},
			},
			execute: async (args) => {
				const a = String(args.action || "status");
				const J = (s) => {
					try {
						return JSON.parse(String(s || "{}"));
					} catch {
						return {};
					}
				};
				if (a === "status") {
					const s = await status();
					return JSON.stringify({
						frpcBin: !!s.frpcBin,
						frpsBin: !!s.frpsBin,
						frpc: s.frpc,
						frpsLocal: s.frpsLocal,
						proxies: s.proxies.length,
						server: `${s.common.serverAddr || "(未填)"}:${s.common.serverPort}`,
						remoteProfile: s.remote.profile || "(未选)",
					});
				}
				if (a === "remote_list") {
					const profiles = await listSharedProfiles();
					if (!profiles.length)
						return "共享 SSH 主机库为空（先去远程工作台/SFTP 添加主机），或宿主 remoteSsh 服务未就绪";
					return profiles.map((p) => `${p.name}（${p.username}@${p.host}:${p.port}）`).join("\n");
				}
				if (a === "remote_use") {
					const o = J(args.json);
					const sel = String(args.name || o.profile || "");
					const profiles = await listSharedProfiles();
					const hit = profiles.find((p) => p.name === sel || p.host === sel);
					if (!hit) return `共享主机库里找不到「${sel}」，用 remote_list 查看可选主机`;
					state.remote.profile = hit.name;
					state.common.serverAddr = hit.host;
					save();
					writeTomls();
					return `远端主机已选 ${hit.name}（${hit.username}@${hit.host}:${hit.port}），frpc 服务端地址已同步为 ${hit.host}`;
				}
				if (a === "remote_probe" || a === "remote_deploy") {
					try {
						return await deployRemote(a === "remote_probe");
					} catch (e) {
						return `远端操作失败：${e.message}`;
					}
				}
				if (a === "list") return JSON.stringify(state.proxies, null, 2);
				if (a === "add" || a === "update") {
					const p = { ...J(args.json), ...(args.name ? { name: args.name } : {}) };
					const err = validateProxy(p);
					if (err) return `参数错误：${err}`;
					const i = state.proxies.findIndex((x) => x.name === p.name);
					if (a === "add" && i >= 0) return `已存在同名穿透 ${p.name}，用 update 覆盖`;
					if (i >= 0) state.proxies[i] = { ...state.proxies[i], ...p };
					else state.proxies.push({ enabled: true, localIP: "127.0.0.1", type: "tcp", ...p });
					save();
					writeTomls();
					return `${a === "add" ? "已新增" : "已更新"}穿透 ${p.name}（改完需 frpc_restart 生效）`;
				}
				if (a === "remove") {
					const n = String(args.name || J(args.json).name || "");
					state.proxies = state.proxies.filter((x) => x.name !== n);
					save();
					writeTomls();
					return `已删除 ${n}`;
				}
				if (a === "toggle") {
					const o = J(args.json);
					const p = state.proxies.find((x) => x.name === (args.name || o.name));
					if (!p) return "找不到该穿透";
					p.enabled = o.enabled === undefined ? p.enabled === false : !!o.enabled;
					save();
					writeTomls();
					return `${p.name} 已${p.enabled === false ? "禁用" : "启用"}`;
				}
				if (a === "set_server") {
					const o = J(args.json);
					state.common = { ...state.common, ...o };
					save();
					writeTomls();
					return `服务端已指向 ${state.common.serverAddr || "(未填)"}:${state.common.serverPort}`;
				}
				if (a === "frps_set") {
					state.frps = { ...state.frps, ...J(args.json) };
					save();
					writeTomls();
					return "本地 frps 配置已保存";
				}
				if (a === "frpc_start" || a === "frpc_restart") {
					const bin = resolveBin("frpc");
					if (!bin) return "未找到 frpc，先 action=install 安装或在设置里填 frpcPath";
					writeTomls();
					spawnDaemon("frpc", bin, ["-c", frpcTomlPath], dataDir);
					return `frpc 已启动（pid=${procs.frpc?.pid}），配置 ${state.proxies.filter((p) => p.enabled !== false).length} 条启用中`;
				}
				if (a === "frpc_stop") {
					return stopDaemon("frpc") ? "frpc 已停止" : "frpc 本来就没跑";
				}
				if (a === "frps_start") {
					const bin = resolveBin("frps");
					if (!bin) return "未找到 frps，先 action=install 安装";
					writeTomls();
					spawnDaemon("frps", bin, ["-c", frpsTomlPath], dataDir);
					return `本地 frps 已启动（pid=${procs.frps?.pid}，bindPort=${state.frps.bindPort}）`;
				}
				if (a === "frps_stop") {
					return stopDaemon("frps") ? "本地 frps 已停止" : "本地 frps 本来就没跑";
				}
				if (a === "logs") {
					const o = J(args.json);
					const role = String(args.name || o.role || "frpc") === "frps" ? "frps" : "frpc";
					return logs[role].slice(-60).join("\n") || "(暂无日志)";
				}
				if (a === "install") {
					const o = J(args.json);
					const r = await installBinaries(o.version || settings().frpVersion);
					return `frp v${r.version} 安装完成`;
				}
				if (a === "remote_script") {
					return buildRemoteInstallScript({
						version: settings().frpVersion,
						...state.frps,
						token: state.frps.token || state.common.token,
					});
				}
				return `未知 action=${a}`;
			},
		});

		// ── HTTP 路由（面板用） ──
		const offStatus = host.route("GET", "/status", async (_req, res) => res.json(await status()));
		const offLogs = host.route("GET", "/logs", (req, res) => {
			const role = req.query?.role === "frps" ? "frps" : "frpc";
			(res.json ?? ((o) => res.end(JSON.stringify(o))))({ ok: true, role, lines: logs[role].slice(-200) });
		});
		const offInstall = host.route("POST", "/install", async (req, res) => {
			try {
				let body = "";
				if (req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
				else await new Promise((r) => req.on?.("data", (c) => (body += c)).on?.("end", r));
				const { version } = JSON.parse(body || "{}");
				const r = await installBinaries(version || settings().frpVersion);
				res.json({ ok: true, ...r, st: await status() });
			} catch (e) {
				res.json({ ok: false, error: String(e.message || e) });
			}
		});
		const offScript = host.route("GET", "/remote-script", (_req, res) => {
			const s = buildRemoteInstallScript({
				version: settings().frpVersion,
				...state.frps,
				token: state.frps.token || state.common.token,
			});
			res.json({ ok: true, script: s });
		});
		const offAction = host.route("POST", "/action", async (req, res) => {
			let body = req.body;
			if (body === undefined) {
				let raw = "";
				await new Promise((r) => (req.on ? req.on("data", (c) => (raw += c)).on("end", r) : r()));
				try {
					body = JSON.parse(raw || "{}");
				} catch {
					body = {};
				}
			} else if (typeof body === "string") {
				try {
					body = JSON.parse(body);
				} catch {
					body = {};
				}
			}
			const { action: a, ...p } = body || {};
			try {
				if (a === "proxy_save") {
					const proxy = p.proxy || {};
					const err = validateProxy(proxy);
					if (err) return res.json({ ok: false, error: err });
					const i = state.proxies.findIndex((x) => x.name === proxy.name);
					if (i >= 0 && p.editName && p.editName !== proxy.name) state.proxies.splice(i, 1);
					const j = state.proxies.findIndex((x) => x.name === proxy.name);
					if (j >= 0) state.proxies[j] = { ...state.proxies[j], ...proxy };
					else state.proxies.push({ enabled: true, localIP: "127.0.0.1", ...proxy });
				} else if (a === "proxy_delete") {
					state.proxies = state.proxies.filter((x) => x.name !== p.name);
				} else if (a === "proxy_toggle") {
					const t = state.proxies.find((x) => x.name === p.name);
					if (t) t.enabled = t.enabled === false;
				} else if (a === "server_save") {
					state.common = { ...state.common, ...(p.common || {}) };
				} else if (a === "frps_save") {
					state.frps = { ...state.frps, ...(p.frps || {}) };
				} else if (a === "remote_use") {
					const sel = String(p.profile || "");
					const svc = getRemoteSsh();
					const profiles = svc ? (await svc.listProfiles()) || [] : [];
					const hit = profiles.find((x) => x.name === sel || x.host === sel);
					if (!hit)
						return res.json({ ok: false, error: `共享主机库里找不到「${sel}」（先去远程工作台/SFTP 添加该主机）` });
					state.remote.profile = hit.name;
					state.common.serverAddr = state.common.serverAddr || hit.host;
				} else if (a === "frpc_start" || a === "frpc_restart") {
					const bin = resolveBin("frpc");
					if (!bin) return res.json({ ok: false, error: "未找到 frpc，先一键安装或在设置里填路径" });
					writeTomls();
					spawnDaemon("frpc", bin, ["-c", frpcTomlPath], dataDir);
				} else if (a === "frpc_stop") {
					stopDaemon("frpc");
				} else if (a === "frps_start") {
					const bin = resolveBin("frps");
					if (!bin) return res.json({ ok: false, error: "未找到 frps，先一键安装" });
					writeTomls();
					spawnDaemon("frps", bin, ["-c", frpsTomlPath], dataDir);
				} else if (a === "frps_stop") {
					stopDaemon("frps");
				} else if (a === "remote_probe") {
					try {
						const out = await deployRemote(true);
						return res.json({ ok: true, st: await status(), out });
					} catch (e) {
						return res.json({ ok: false, error: String(e.message || e) });
					}
				} else if (a === "remote_deploy") {
					try {
						const out = await deployRemote(false);
						return res.json({ ok: true, st: await status(), out });
					} catch (e) {
						const script = buildRemoteInstallScript({
							version: settings().frpVersion,
							...state.frps,
							token: state.frps.token || state.common.token,
						});
						return res.json({
							ok: false,
							error: `${String(e.message || e)}（也可「复制一键脚本」到远端手动执行）`,
							script,
						});
					}
				} else if (a === "uninstall_bin") {
					const { unlinkSync } = await import("node:fs");
					for (const k of ["frpc", "frps"]) {
						try {
							unlinkSync(join(binDir, binName(k)));
						} catch {}
					}
					stopDaemon("frpc", true);
					stopDaemon("frps", true);
				} else {
					return res.json({ ok: false, error: `未知 action=${a}` });
				}
				save();
				writeTomls();
				res.json({ ok: true, st: await status() });
			} catch (e) {
				res.json({ ok: false, error: String(e.message || e) });
			}
		});

		host.log(`frp-manager 已激活（数据目录 ${dataDir}，frpc ${resolveBin("frpc") ? "已就绪" : "未安装"}）`);
		return () => {
			for (const off of [offTool, offStatus, offLogs, offInstall, offScript, offAction]) {
				try {
					off?.();
				} catch {}
			}
			stopDaemon("frpc", true);
			stopDaemon("frps", true);
			host.log("frp-manager 已停用");
		};
	},
};
