import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";

const IGNORED = new Set([
	"node_modules",
	".git",
	".pi-web",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"venv",
	".venv",
	"__pycache__",
	"coverage",
	".cache",
	".DS_Store",
	"Thumbs.db",
]);

const MAX_LIST_ENTRIES = 8000;
const MAX_DEPTH = 12;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SSH_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;
const MAX_EXEC_OUTPUT = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_STALE_MS = 30 * 60 * 1000;

// ---- 服务端报错双语（随每条消息的 lang 切换；AsyncLocalStorage 透传，热路径无签名改动） ----
const vscAls = new AsyncLocalStorage();
const LS = {
	zh: {
		pathOutside: "路径越界",
		invalidPath: "非法路径",
		notFile: "不是普通文件",
		fileOverMB: "文件超过 {n}MB 上限",
		packOverMB: "文件夹打包后超过 {n}MB 上限",
		packTooBig: "打包内容超过 {n}MB 上限",
		symlinkDeny: "路径含符号链接或越界，拒绝写入",
		symlinkDenyCreate: "路径含符号链接或越界，拒绝创建",
		existsSame: "已存在同名文件/文件夹",
		invalidNewName: "非法新名称",
		denyDelRoot: "拒绝删除根目录",
		tarNeeded: "本地打包需要系统 tar，打包失败：{e}",
		packEmpty: "打包结果为空",
		packFail: "本地打包失败（tar exit {code}{detail}），请确认系统已安装 tar",
		remotePackFail: "打包失败（远端无 tar 或目录不可读）",
		zipNoSys: "系统 zip 不可用",
		zipPackFail: "系统 zip 打包失败（exit {code}{detail}）",
		unzipNoSys: "系统 unzip 不可用",
		unzipFail: "解压失败（unzip exit {code}{detail}）",
		unzipListFail: "unzip 列表读取失败",
		unzipNolist: "unzip 列表不支持，转纯 Node 解压",
		symlinkPack: "符号链接拒绝打包",
		invalidZip: "不是有效的 ZIP 文件",
		noEocd: "不是有效的 ZIP 文件（找不到 EOCD）",
		badCentral: "ZIP 中央目录损坏",
		badLocal: "ZIP 本地文件头损坏",
		unsupMethod: "不支持的 ZIP 压缩方法：{m}",
		badCrc: "ZIP 校验失败：{name}",
		zipIllegal: "ZIP 条目非法已拒绝：{name}",
		zipSlip: "ZIP 条目越界已拒绝（ZipSlip）：{name}",
		pickPaths: "请选择 1~100 个文件/文件夹",
		remoteNoZipTar: "远端打包失败（远端无 zip 也无 tar）",
		remoteZipFail: "远端 zip 打包失败{detail}",
		remoteNoUnzip: "远端缺少 unzip，请先安装 unzip 后重试",
		remoteUnzipFail: "远端解压失败{detail}",
		needZip: "请选择 .zip 文件",
		badName: "非法文件名",
		badSize: "非法文件大小",
		uploadGone: "上传会话不存在或已超时，请重新上传",
		chunkOrder: "分片乱序",
		emptyChunk: "空分片",
		hostAddrNeed: "主机地址不能为空",
		hostMissing: "主机不存在",
		hostLimit: "最多保存 {n} 台主机",
		hostAuthNeed: "请填写密码、私钥（可填私钥路径）或 agent",
		needAlias: "缺少 alias",
		pickAliases: "请先勾选要导入的主机",
		cfgTooBig: "config 过大（512KB 上限），拒绝写入",
		pathMissing: "路径不存在",
		illegalTargetSelf: "目标不能是源本身或其子目录",
		targetExists: "目标已存在",
		srcMissing: "源不存在",
		denyCoverRoot: "拒绝覆盖根目录",
		emptyQuery: "搜索关键词不能为空",
		installingDeps: "📝 编辑器：开始安装依赖（ssh2）…",
		depsOk: "📝 编辑器依赖安装完成",
		depsFail: "📝 编辑器依赖安装失败——请在插件目录手动执行 npm install ssh2",
		colonSep: "：",
		invalidPathAt: "非法路径：{p}",
		hostLimitAdded: "最多保存 {n} 台主机（已导入 {added} 台）",
		packEmptyDir: "打包结果为空，可能目录不可读",
		connGone: "连接不存在或已断开",
		sshCfgReadFail: "读取 ~/.ssh/config 失败：{error}",
		sshCfgEmpty: "~/.ssh/config 里没有可导入的主机",
		sshCfgNoAlias: "~/.ssh/config 里没有主机「{alias}」（VSCode 侧改完 config 刷新即生效）",
		keyReadFail: "私钥文件读取失败：{path}",
		authNeedShort: "请填写密码、私钥或 agent（主机编辑里可填私钥路径 / agent）",
		ssh2NotReady: "ssh2 依赖未就绪，稍候再试",
		noAuthForAlias:
			"主机「{alias}」没有可用认证：config 未配 IdentityFile，本机也没有默认私钥/~/.ssh 下的 key 与 ssh-agent（VSCode 里能连通常是因为 agent 或 key，服务端没跑 agent 时请先配 IdentityFile）",
		proxyJumpFail: "ProxyJump 解析失败：{jump}",
	},
	en: {
		pathOutside: "Path outside workspace",
		invalidPath: "Invalid path",
		notFile: "Not a regular file",
		fileOverMB: "File exceeds the {n}MB limit",
		packOverMB: "Archive exceeds the {n}MB limit",
		packTooBig: "Pack content exceeds the {n}MB limit",
		symlinkDeny: "Symlink or out-of-workspace write denied",
		symlinkDenyCreate: "Symlink or out-of-workspace create denied",
		existsSame: "A file/folder with the same name exists",
		invalidNewName: "Invalid new name",
		denyDelRoot: "Refusing to delete the root directory",
		tarNeeded: "Local packing needs system tar, failed: {e}",
		packEmpty: "Pack result is empty",
		packFail: "Local pack failed (tar exit {code}{detail}); make sure tar is installed",
		remotePackFail: "Pack failed (no tar on remote host or directory unreadable)",
		zipNoSys: "System zip unavailable",
		zipPackFail: "System zip pack failed (exit {code}{detail})",
		unzipNoSys: "System unzip unavailable",
		unzipFail: "Extract failed (unzip exit {code}{detail})",
		unzipListFail: "unzip listing failed",
		unzipNolist: "unzip listing unsupported, using built-in extractor",
		symlinkPack: "Symlinks are not packed",
		invalidZip: "Not a valid ZIP file",
		noEocd: "Not a valid ZIP file (EOCD not found)",
		badCentral: "ZIP central directory is corrupt",
		badLocal: "ZIP local file header is corrupt",
		unsupMethod: "Unsupported ZIP compression method: {m}",
		badCrc: "ZIP checksum mismatch: {name}",
		zipIllegal: "ZIP entry rejected (illegal): {name}",
		zipSlip: "ZIP entry rejected (ZipSlip): {name}",
		pickPaths: "Please select 1–100 files/folders",
		remoteNoZipTar: "Remote pack failed (no zip and no tar on host)",
		remoteZipFail: "Remote zip pack failed{detail}",
		remoteNoUnzip: "No unzip on remote host; please install unzip first",
		remoteUnzipFail: "Remote extract failed{detail}",
		needZip: "Please choose a .zip file",
		badName: "Invalid file name",
		badSize: "Invalid file size",
		uploadGone: "Upload session expired or missing; please re-upload",
		chunkOrder: "Chunks out of order",
		emptyChunk: "Empty chunk",
		hostAddrNeed: "Host address is required",
		hostMissing: "Host does not exist",
		hostLimit: "At most {n} hosts",
		hostAuthNeed: "Fill in a password, private key (or key path) or agent",
		needAlias: "Missing alias",
		pickAliases: "Please tick the hosts to import first",
		cfgTooBig: "config too large (512KB cap), write denied",
		pathMissing: "Path does not exist",
		illegalTargetSelf: "Target cannot be the source itself or its subdirectory",
		targetExists: "Target already exists",
		srcMissing: "Source does not exist",
		denyCoverRoot: "Refusing to overwrite the root",
		emptyQuery: "Search keyword is required",
		installingDeps: "📝 Editor: installing dependency (ssh2)…",
		depsOk: "📝 Editor dependency installed",
		depsFail: "📝 Editor dependency install failed — run npm install ssh2 in the plugin directory manually",
		colonSep: ": ",
		invalidPathAt: "Invalid path: {p}",
		hostLimitAdded: "At most {n} hosts ({added} imported)",
		packEmptyDir: "Pack result is empty; directory may be unreadable",
		connGone: "Connection is gone or disconnected",
		sshCfgReadFail: "Failed to read ~/.ssh/config: {error}",
		sshCfgEmpty: "No importable hosts in ~/.ssh/config",
		sshCfgNoAlias: 'No host "{alias}" in ~/.ssh/config (refresh after editing on the VSCode side)',
		keyReadFail: "Failed to read key file: {path}",
		authNeedShort: "Fill in a password, private key or agent (key path / agent available in host editing)",
		ssh2NotReady: "ssh2 dependency is not ready, try again in a moment",
		noAuthForAlias:
			'Host "{alias}" has no usable auth: config has no IdentityFile, and there is no default key under ~/.ssh nor ssh-agent locally (when VSCode can connect it is usually via agent or a key; configure IdentityFile when no agent runs on the server)',
		proxyJumpFail: "ProxyJump parse failed: {jump}",
	},
};
function SLX(lang, key, vars) {
	let s = (lang === "en" ? LS.en[key] : null) ?? LS.zh[key] ?? key;
	if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
	return s;
}
function SL(key, vars) {
	return SLX(vscAls.getStore() ?? "zh", key, vars);
}

function toWire(p) {
	return p.split(path.sep).join("/");
}

export function sshPatternMatches(pattern, host) {
	let negated = false;
	let pat = pattern;
	if (pat.startsWith("!")) {
		negated = true;
		pat = pat.slice(1);
	}
	let re = "";
	for (const c of pat) {
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
		else re += c;
	}
	const hit = new RegExp(`^${re}$`).test(host);
	return negated ? !hit : hit;
}

export function sshBlockMatches(patterns, alias) {
	let matched = false;
	for (const p of patterns) {
		if (p.startsWith("!")) {
			if (sshPatternMatches(p.slice(1), alias)) return false;
		} else if (sshPatternMatches(p, alias)) matched = true;
	}
	return matched;
}

export function parseSshConfigBlocks(text) {
	const blocks = [];
	let cur = null;
	const stripQuote = (v) => {
		v = v.trim();
		if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
			return v.slice(1, -1);
		return v;
	};
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const sp = line.search(/[\s=]/);
		if (sp < 0) continue;
		const key = line.slice(0, sp).trim().toLowerCase();
		let val = line.slice(sp).trim().replace(/^=\s*/, "").trim();
		if (key === "host") {
			cur = {
				patterns: val.split(/\s+/).filter(Boolean),
				hostname: null,
				user: null,
				port: null,
				identityfiles: [],
				proxyjump: null,
				proxycommand: null,
				forwardagent: null,
				includes: [],
			};
			blocks.push(cur);
		} else if (key === "include" && val) {
			const parts = val.split(/\s+/).filter(Boolean).map(stripQuote);
			if (!cur) {
				cur = {
					patterns: [],
					hostname: null,
					user: null,
					port: null,
					identityfiles: [],
					proxyjump: null,
					proxycommand: null,
					forwardagent: null,
					includes: [],
				};
				blocks.push(cur);
			}
			cur.includes.push(...parts);
		} else if (cur) {
			if (key === "hostname" && cur.hostname === null && val) cur.hostname = stripQuote(val).split(/\s+/)[0];
			else if (key === "user" && cur.user === null && val) cur.user = stripQuote(val).split(/\s+/)[0];
			else if (key === "port" && cur.port === null && val) cur.port = stripQuote(val).split(/\s+/)[0];
			else if (key === "identityfile" && val) cur.identityfiles.push(stripQuote(val).split(/\s+/)[0]);
			else if (key === "proxyjump" && cur.proxyjump === null && val) cur.proxyjump = stripQuote(val);
			else if (key === "proxycommand" && cur.proxycommand === null && val) cur.proxycommand = stripQuote(val);
			else if (key === "forwardagent" && cur.forwardagent === null && val)
				cur.forwardagent = stripQuote(val).split(/\s+/)[0];
		}
	}
	return blocks;
}

export function resolveSshAlias(alias, blocks) {
	const eff = {
		hostname: null,
		user: null,
		port: null,
		identityfiles: [],
		proxyjump: null,
		proxycommand: null,
		forwardagent: null,
	};
	for (const b of blocks ?? []) {
		if (!b.patterns?.length) continue;
		if (!sshBlockMatches(b.patterns, alias)) continue;
		if (eff.hostname === null && b.hostname) eff.hostname = b.hostname;
		if (eff.user === null && b.user) eff.user = b.user;
		if (eff.port === null && b.port) eff.port = b.port;
		if (eff.proxyjump === null && b.proxyjump) eff.proxyjump = b.proxyjump;
		if (eff.proxycommand === null && b.proxycommand) eff.proxycommand = b.proxycommand;
		if (eff.forwardagent === null && b.forwardagent) eff.forwardagent = b.forwardagent;
		for (const f of b.identityfiles ?? []) if (!eff.identityfiles.includes(f)) eff.identityfiles.push(f);
	}
	return eff;
}

export function parseSshConfig(text) {
	const blocks = parseSshConfigBlocks(text);
	const out = [];
	const seen = new Set();
	for (const b of blocks) {
		for (const alias of b.patterns) {
			if (!alias || alias.startsWith("!") || /[*?]/.test(alias)) continue;
			if (seen.has(alias)) continue;
			seen.add(alias);
			const eff = resolveSshAlias(alias, blocks);
			out.push({
				alias,
				host: eff.hostname ?? alias,
				port: Number(eff.port) || 22,
				username: eff.user ?? "root",
				privateKeyPath: eff.identityfiles[0] ?? "",
				identityFiles: eff.identityfiles,
				proxyJump: eff.proxyjump ?? "",
				proxyCommand: eff.proxycommand ?? "",
				forwardAgent: eff.forwardagent ?? "",
			});
		}
	}
	return out;
}

export async function expandSshInclude(pattern, options = {}) {
	const configFile = options.configFile || path.join(options.homeDir || os.homedir(), ".ssh", "config");
	const fsImpl = options.fs || fs;
	const homeDir = options.homeDir || os.homedir();
	let p = String(pattern ?? "").trim();
	if (!p) return [];
	if (p === "~") p = homeDir;
	else if (p.startsWith("~/")) p = path.join(homeDir, p.slice(2));
	else if (!path.isAbsolute(p)) p = path.join(path.dirname(configFile), p);
	if (!/[*?\[]/.test(p)) {
		try {
			await fsImpl.access(p);
			return [p];
		} catch {
			return [];
		}
	}
	const dir = path.dirname(p);
	const base = path.basename(p);
	let entries;
	try {
		entries = await fsImpl.readdir(dir);
	} catch {
		return [];
	}
	const re = new RegExp(
		"^" +
			[...base]
				.map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : "\\^$.|+()[]{}".includes(ch) ? "\\" + ch : ch))
				.join("") +
			"$",
	);
	return entries
		.filter((n) => re.test(n))
		.sort()
		.map((n) => path.join(dir, n));
}

export async function loadSshConfigBlocks(options = {}) {
	const configFile = options.configFile || path.join(options.homeDir || os.homedir(), ".ssh", "config");
	const fsImpl = options.fs || fs;
	const out = [];
	const seenFiles = new Set();
	let fileCount = 0;
	async function loadFile(file, depth) {
		if (depth > 8 || fileCount > 64) return;
		let real;
		try {
			real = path.resolve(file);
		} catch {
			return;
		}
		if (seenFiles.has(real)) return;
		seenFiles.add(real);
		fileCount++;
		let text;
		try {
			text = await fsImpl.readFile(real, "utf8");
		} catch (err) {
			if (err?.code === "ENOENT") return;
			throw err;
		}
		const blocks = parseSshConfigBlocks(text);
		for (const b of blocks) {
			out.push(b);
			if (b.includes?.length) {
				for (const pat of b.includes) {
					for (const f of await expandSshInclude(pat, { configFile, fs: fsImpl, homeDir: options.homeDir })) {
						await loadFile(f, depth + 1);
					}
				}
				b.includes = [];
			}
		}
	}
	await loadFile(configFile, 0);
	return out;
}

export default {
	activate(host) {
		let root = path.resolve(host.cwd);
		let uiLang = "zh";

		function safeResolve(rel) {
			if (typeof rel !== "string") return null;
			const abs = path.resolve(root, rel);
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return abs;
		}

		function fail(reqId, error, code) {
			return { res: true, reqId, ok: false, error, code };
		}

		async function listDir(relDir) {
			const abs = safeResolve(relDir ?? "");
			if (!abs) throw new Error(SL("pathOutside"));
			const dirents = await fs.readdir(abs === root ? root : abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (IGNORED.has(d.name)) continue;
				if (d.isSymbolicLink()) continue;
				if (d.name.startsWith(".vsc-upload-")) continue;
				entries.push({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				});
			}
			entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
			return entries;
		}

		async function flatList() {
			const files = [];
			let truncated = false;
			const queue = [root];
			while (queue.length && files.length < MAX_LIST_ENTRIES) {
				const dir = queue.shift();
				const depth = dir.slice(root.length).split(path.sep).filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let dirents;
				try {
					dirents = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const d of dirents) {
					if (files.length >= MAX_LIST_ENTRIES) {
						truncated = true;
						break;
					}
					if (IGNORED.has(d.name) || d.name.startsWith(".vsc-upload-")) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(dir, d.name);
					if (d.isDirectory()) queue.push(full);
					else if (d.isFile()) files.push(toWire(path.relative(root, full)));
				}
			}
			return { files, truncated };
		}

		function looksLikeText(buf) {
			const n = Math.min(buf.length, 8000);
			let ctrl = 0;
			for (let i = 0; i < n; i++) {
				const b = buf[i];
				if (b === 0) return false;
				if (b < 9 || (b > 13 && b < 32)) ctrl++;
			}
			return n === 0 || ctrl / n < 0.02;
		}

		function decodeBuf(buf) {
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {}
			try {
				return new TextDecoder("gbk", { fatal: true }).decode(buf);
			} catch {}
			return new TextDecoder("latin1").decode(buf);
		}

		async function readFile(rel) {
			const abs = safeResolve(rel);
			if (!abs) throw new Error(SL("pathOutside"));
			const stat = await fs.stat(abs);
			if (!stat.isFile()) throw new Error(SL("notFile"));
			if (stat.size > MAX_READ_BYTES) throw new Error(SL("fileOverMB", { n: MAX_READ_BYTES / 1024 / 1024 }));
			const buf = await fs.readFile(abs);
			if (!looksLikeText(buf)) return { binary: true, size: stat.size, mtimeMs: stat.mtimeMs };
			return { text: decodeBuf(buf), encoding: "utf-8", size: stat.size, mtimeMs: stat.mtimeMs };
		}

		async function safeWriteTarget(abs) {
			let rootReal;
			try {
				rootReal = await fs.realpath(root);
			} catch {
				rootReal = root;
			}
			let anchor = abs;
			for (let guard = 0; guard < 64; guard++) {
				try {
					const real = await fs.realpath(anchor);
					if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
					if (anchor === abs) {
						const st = await fs.lstat(abs);
						if (st.isSymbolicLink()) return null;
					}
					return abs;
				} catch {
					const parent = path.dirname(anchor);
					if (parent === anchor) return null;
					anchor = parent;
				}
			}
			return null;
		}

		async function writeFile(rel, text) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error(SL("invalidPath"));
			if (!(await safeWriteTarget(abs))) throw new Error(SL("symlinkDeny"));
			await fs.mkdir(path.dirname(abs), { recursive: true });
			const tmp = abs + ".vsc-tmp-" + process.pid;
			await fs.writeFile(tmp, String(text ?? ""), "utf-8");
			await fs.rename(tmp, abs);
			const st = await fs.stat(abs);
			return { bytes: st.size, mtimeMs: st.mtimeMs };
		}

		async function createEntry(rel, kind) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error(SL("invalidPath"));
			if (!(await safeWriteTarget(abs))) throw new Error(SL("symlinkDenyCreate"));
			try {
				if (kind === "dir") await fs.mkdir(abs);
				else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await fs.writeFile(abs, "", { flag: "wx" });
				}
			} catch (err) {
				if (err.code === "EEXIST") throw Object.assign(new Error(SL("existsSame")), { code: "VSC_EXISTS" });
				throw err;
			}
		}

		async function renameEntry(rel, newName) {
			if (
				typeof newName !== "string" ||
				!newName.trim() ||
				newName.includes("/") ||
				newName.includes("\\") ||
				newName.includes("..")
			) {
				throw new Error(SL("invalidNewName"));
			}
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error(SL("invalidPath"));
			await fs.access(abs);
			await fs.rename(abs, path.join(path.dirname(abs), newName));
		}

		async function deleteEntry(rel) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error(SL("denyDelRoot"));
			await fs.rm(abs, { recursive: true, force: false });
		}

		function posixJoin(base, rel) {
			if (!rel) return base;
			return `${String(base).replace(/\/+$/, "")}/${String(rel).replace(/^\/+/g, "")}`;
		}

		function resolveKeyFile(p) {
			if (!p) return p;
			if (p === "~") return os.homedir();
			if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
			if (path.isAbsolute(p)) return p;
			return path.resolve(root, p);
		}

		function sshExecBuffer(c, cmd) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				c.client.exec(cmd, (err, stream) => {
					if (err) return void reject(err);
					const chunks = [];
					let size = 0;
					stream.on("data", (d) => {
						size += d.length;
						if (size > MAX_DOWNLOAD_BYTES) {
							try {
								stream.close();
							} catch {}
							return void reject(
								new Error(SLX(fxLang, "packOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) })),
							);
						}
						chunks.push(d);
					});
					stream.stderr.on("data", () => {});
					stream.on("close", () => resolve(Buffer.concat(chunks)));
				});
			});
		}

		const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

		// 本地文件夹打包下载：与远端 tar.gz 对称，优先用系统 tar，不引入新 npm 依赖。
		function tarGzLocal(abs) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				let child;
				try {
					child = spawn("tar", ["-czf", "-", "-C", path.dirname(abs), path.basename(abs)], {
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (err) {
					return void reject(new Error(SLX(fxLang, "tarNeeded", { e: err?.message ?? err })));
				}
				const chunks = [];
				let size = 0;
				let failed = false;
				const fail = (err) => {
					if (failed) return;
					failed = true;
					try {
						child.kill();
					} catch {}
					reject(err);
				};
				child.stdout.on("data", (d) => {
					size += d.length;
					if (size > MAX_DOWNLOAD_BYTES) {
						fail(new Error(SLX(fxLang, "packOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) })));
						return;
					}
					chunks.push(d);
				});
				let errText = "";
				child.stderr.on("data", (d) => {
					errText += String(d).slice(0, 500);
				});
				child.on("error", (err) => fail(new Error(SLX(fxLang, "tarNeeded", { e: err?.message ?? err }))));
				child.on("close", (code) => {
					if (failed) return;
					if (code !== 0) {
						fail(
							new Error(
								SLX(fxLang, "packFail", {
									code,
									detail: errText.trim() ? SLX(fxLang, "colonSep") + errText.trim() : "",
								}),
							),
						);
						return;
					}
					const buf = Buffer.concat(chunks);
					if (!buf.length) {
						fail(new Error(SLX(fxLang, "packEmptyDir")));
						return;
					}
					resolve(buf);
				});
			});
		}

		// ---- ZIP（零新依赖）：优先系统 zip/unzip，不可用则纯 Node 最小实现 ----
		// 写入仅 stored（不压缩，各解压工具均可读）；读取支持 stored/deflate，附 ZipSlip 防护。
		const ZIP_CRC_TABLE = (() => {
			const t = new Uint32Array(256);
			for (let n = 0; n < 256; n++) {
				let c = n;
				for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
				t[n] = c >>> 0;
			}
			return t;
		})();

		function zipCrc32(buf) {
			let c = 0xffffffff;
			for (let i = 0; i < buf.length; i++) c = ZIP_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
			return (c ^ 0xffffffff) >>> 0;
		}

		function zipStoreFiles(files) {
			const enc = new TextEncoder();
			const chunks = [];
			const central = [];
			let offset = 0;
			for (const f of files) {
				const nameBuf = Buffer.from(enc.encode(f.name));
				const data = f.dir ? Buffer.alloc(0) : Buffer.from(f.data);
				const crc = zipCrc32(data);
				const head = Buffer.alloc(30);
				head.writeUInt32LE(0x04034b50, 0);
				head.writeUInt16LE(20, 4);
				head.writeUInt16LE(0x0800, 6);
				head.writeUInt16LE(0, 8);
				head.writeUInt16LE(0, 10);
				head.writeUInt16LE(0, 12);
				head.writeUInt32LE(crc, 14);
				head.writeUInt32LE(data.length, 18);
				head.writeUInt32LE(data.length, 22);
				head.writeUInt16LE(nameBuf.length, 26);
				head.writeUInt16LE(0, 28);
				chunks.push(head, nameBuf, data);
				central.push({ nameBuf, crc, size: data.length, offset, dir: !!f.dir });
				offset += head.length + nameBuf.length + data.length;
			}
			const centralStart = offset;
			let centralSize = 0;
			for (const c of central) {
				const h = Buffer.alloc(46);
				h.writeUInt32LE(0x02014b50, 0);
				h.writeUInt16LE(20, 4);
				h.writeUInt16LE(20, 6);
				h.writeUInt16LE(0x0800, 8);
				h.writeUInt16LE(0, 10);
				h.writeUInt16LE(0, 12);
				h.writeUInt16LE(0, 14);
				h.writeUInt32LE(c.crc, 16);
				h.writeUInt32LE(c.size, 20);
				h.writeUInt32LE(c.size, 24);
				h.writeUInt16LE(c.nameBuf.length, 28);
				h.writeUInt16LE(0, 30);
				h.writeUInt16LE(0, 32);
				h.writeUInt16LE(0, 34);
				h.writeUInt16LE(0, 36);
				h.writeUInt32LE(c.dir ? 0x10 : 0, 38);
				h.writeUInt32LE(c.offset, 42);
				chunks.push(h, c.nameBuf);
				centralSize += h.length + c.nameBuf.length;
			}
			const end = Buffer.alloc(22);
			end.writeUInt32LE(0x06054b50, 0);
			end.writeUInt16LE(central.length, 8);
			end.writeUInt16LE(central.length, 10);
			end.writeUInt32LE(centralSize, 12);
			end.writeUInt32LE(centralStart, 16);
			end.writeUInt16LE(0, 20);
			chunks.push(end);
			return Buffer.concat(chunks);
		}

		function parseZipEntries(buf) {
			if (buf.length < 22) throw new Error(SL("invalidZip"));
			let eocd = -1;
			const maxComment = Math.min(buf.length - 22, 65535);
			for (let i = buf.length - 22; i >= buf.length - 22 - maxComment; i--) {
				if (buf.readUInt32LE(i) === 0x06054b50) {
					eocd = i;
					break;
				}
			}
			if (eocd < 0) throw new Error(SL("noEocd"));
			const count = buf.readUInt16LE(eocd + 10);
			let ptr = buf.readUInt32LE(eocd + 16);
			const out = [];
			for (let i = 0; i < count; i++) {
				if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(SL("badCentral"));
				const method = buf.readUInt16LE(ptr + 10);
				const crc = buf.readUInt32LE(ptr + 16);
				const compSize = buf.readUInt32LE(ptr + 20);
				const nameLen = buf.readUInt16LE(ptr + 28);
				const extraLen = buf.readUInt16LE(ptr + 30);
				const commentLen = buf.readUInt16LE(ptr + 32);
				const localOff = buf.readUInt32LE(ptr + 42);
				const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
				ptr += 46 + nameLen + extraLen + commentLen;
				if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(SL("badLocal"));
				const lhNameLen = buf.readUInt16LE(localOff + 26);
				const lhExtraLen = buf.readUInt16LE(localOff + 28);
				const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
				const comp = buf.subarray(dataStart, dataStart + compSize);
				let data;
				if (method === 0) data = Buffer.from(comp);
				else if (method === 8) data = inflateRawSync(comp);
				else throw new Error(SL("unsupMethod", { m: method }));
				if (zipCrc32(data) !== crc) throw new Error(SL("badCrc", { name }));
				out.push({ name, data, isDir: name.endsWith("/") });
			}
			return out;
		}

		function assertZipEntrySafe(name) {
			const norm = String(name ?? "").replace(/\\/g, "/");
			if (!norm || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm))
				throw Object.assign(new Error(SL("zipIllegal", { name })), { code: "VSC_ZIP_PATH" });
			for (const s of norm.split("/")) {
				if (s === "..") throw Object.assign(new Error(SL("zipSlip", { name })), { code: "VSC_ZIP_PATH" });
			}
			return norm;
		}

		async function collectLocalZipEntries(absPaths) {
			const files = [];
			let rawTotal = 0;
			const pushFile = async (entryName, abs) => {
				const data = await fs.readFile(abs);
				rawTotal += data.length;
				if (rawTotal > MAX_DOWNLOAD_BYTES * 4)
					throw new Error(SL("packTooBig", { n: Math.round((MAX_DOWNLOAD_BYTES * 4) / 1024 / 1024) }));
				files.push({ name: entryName, data });
			};
			const walkDir = async (absDir, entryBase) => {
				files.push({ name: `${entryBase}/`, dir: true, data: Buffer.alloc(0) });
				const dirents = await fs.readdir(absDir, { withFileTypes: true });
				for (const d of dirents) {
					if (IGNORED.has(d.name)) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(absDir, d.name);
					const entryName = `${entryBase}/${d.name}`;
					if (d.isDirectory()) await walkDir(full, entryName);
					else if (d.isFile()) await pushFile(entryName, full);
				}
			};
			for (const abs of absPaths) {
				const st = await fs.lstat(abs);
				if (st.isSymbolicLink()) throw new Error(SL("symlinkPack"));
				const base = path.basename(abs);
				if (st.isFile()) await pushFile(base, abs);
				else if (st.isDirectory()) await walkDir(abs, base);
				else throw new Error(SL("notFile"));
			}
			return files;
		}

		async function unzipBufferToDir(buf, destAbs) {
			const entries = parseZipEntries(buf);
			const destReal = path.resolve(destAbs);
			let count = 0;
			for (const e of entries) {
				const norm = assertZipEntrySafe(e.name);
				const target = path.resolve(path.join(destReal, norm));
				if (target !== destReal && !target.startsWith(destReal + path.sep))
					throw Object.assign(new Error(SL("zipSlip", { name: e.name })), { code: "VSC_ZIP_PATH" });
				if (e.isDir || !norm.split("/").pop()) {
					await fs.mkdir(target, { recursive: true });
					continue;
				}
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, e.data);
				count++;
			}
			return count;
		}

		function zipLocalViaSystem(relPaths, cwd) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				let child;
				try {
					child = spawn("zip", ["-r", "-", "--", ...relPaths], {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (err) {
					return void reject(Object.assign(new Error(SLX(fxLang, "zipNoSys")), { code: "ENOENT" }));
				}
				const chunks = [];
				let size = 0;
				let failed = false;
				const fail = (err) => {
					if (failed) return;
					failed = true;
					try {
						child.kill();
					} catch {}
					reject(err);
				};
				child.stdout.on("data", (d) => {
					size += d.length;
					if (size > MAX_DOWNLOAD_BYTES) {
						fail(new Error(SLX(fxLang, "packOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) })));
						return;
					}
					chunks.push(d);
				});
				let errText = "";
				child.stderr.on("data", (d) => {
					errText += String(d).slice(0, 500);
				});
				child.on("error", (err) =>
					fail(err?.code === "ENOENT" ? Object.assign(new Error(SLX(fxLang, "zipNoSys")), { code: "ENOENT" }) : err),
				);
				child.on("close", (code) => {
					if (failed) return;
					if (code !== 0) {
						fail(
							new Error(
								SLX(fxLang, "zipPackFail", {
									code,
									detail: errText.trim() ? SLX(fxLang, "colonSep") + errText.trim() : "",
								}),
							),
						);
						return;
					}
					const out = Buffer.concat(chunks);
					if (!out.length) {
						fail(new Error(SL("packEmpty")));
						return;
					}
					resolve(out);
				});
			});
		}

		function unzipListNames(zipAbs) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				let child;
				try {
					child = spawn("unzip", ["-Z1", zipAbs], { stdio: ["ignore", "pipe", "pipe"] });
				} catch (err) {
					return void reject(Object.assign(new Error(SLX(fxLang, "unzipNoSys")), { code: "ENOENT" }));
				}
				const chunks = [];
				child.stdout.on("data", (d) => chunks.push(d));
				child.stderr?.on("data", () => {});
				child.on("error", (err) =>
					reject(
						err?.code === "ENOENT" ? Object.assign(new Error(SLX(fxLang, "unzipNoSys")), { code: "ENOENT" }) : err,
					),
				);
				child.on("close", (code) => {
					if (code !== 0)
						return void reject(Object.assign(new Error(SLX(fxLang, "unzipListFail")), { code: "NOLIST" }));
					resolve(
						Buffer.concat(chunks)
							.toString("utf8")
							.split("\n")
							.map((s) => s.replace(/\r$/, ""))
							.filter((s) => s.length),
					);
				});
			});
		}

		function unzipLocalViaSystem(zipAbs, destAbs) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				let child;
				try {
					child = spawn("unzip", ["-o", "-q", zipAbs, "-d", destAbs], {
						stdio: ["ignore", "ignore", "pipe"],
					});
				} catch (err) {
					return void reject(Object.assign(new Error(SLX(fxLang, "unzipNoSys")), { code: "ENOENT" }));
				}
				let errText = "";
				child.stderr?.on("data", (d) => {
					errText += String(d).slice(0, 500);
				});
				child.on("error", (err) =>
					reject(
						err?.code === "ENOENT" ? Object.assign(new Error(SLX(fxLang, "unzipNoSys")), { code: "ENOENT" }) : err,
					),
				);
				child.on("close", (code) => {
					if (code !== 0)
						reject(
							new Error(
								SLX(fxLang, "unzipFail", {
									code,
									detail: errText.trim() ? SLX(fxLang, "colonSep") + errText.trim() : "",
								}),
							),
						);
					else resolve(-1);
				});
			});
		}

		function sshExecCapture(c, cmd) {
			const fxLang = vscAls.getStore() ?? "zh";
			return new Promise((resolve, reject) => {
				c.client.exec(cmd, (err, stream) => {
					if (err) return void reject(err);
					const out = [];
					const er = [];
					let size = 0;
					let failed = false;
					stream.on("data", (d) => {
						size += d.length;
						if (size > MAX_DOWNLOAD_BYTES) {
							failed = true;
							try {
								stream.close();
							} catch {}
							reject(new Error(SLX(fxLang, "packOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) })));
							return;
						}
						out.push(d);
					});
					stream.stderr.on("data", (d) => {
						er.push(d);
					});
					stream.on("close", (code) => {
						if (failed) return;
						resolve({
							code: Number(code),
							stdout: Buffer.concat(out),
							stderr: Buffer.concat(er).toString("utf8").slice(0, 500),
						});
					});
				});
			});
		}

		function remoteCommonParent(paths) {
			const segs = paths.map((p) => String(p).split("/").filter(Boolean));
			let common = segs[0] ?? [];
			for (const s of segs.slice(1)) {
				let i = 0;
				while (i < common.length && i < s.length && common[i] === s[i]) i++;
				common = common.slice(0, i);
			}
			return `/${common.join("/")}`;
		}

		async function remoteDownloadZip(c, paths) {
			for (const p of paths) safeRemotePath(p);
			const common = remoteCommonParent(paths);
			const rels = paths.map((p) => (p === common ? "." : p.slice(common === "/" ? 1 : common.length + 1)));
			const base =
				paths.length === 1
					? paths[0].split("/").filter(Boolean).pop()
					: common.split("/").filter(Boolean).pop() || "files";
			const zipCmd = `cd ${shQuote(common)} && zip -r - ${rels.map((r) => shQuote(r)).join(" ")}`;
			const r = await sshExecCapture(c, zipCmd);
			if (r.code === 0 && r.stdout.length) return { buf: r.stdout, name: `${base}.zip`, fallback: null };
			const errLower = `${r.stderr}`.toLowerCase();
			if (r.code === 127 || errLower.includes("not found")) {
				const t = await sshExecCapture(`cd ${shQuote(common)} && tar -czf - ${rels.map((x) => shQuote(x)).join(" ")}`);
				if (t.code !== 0 || !t.stdout.length) throw new Error(SL("remoteNoZipTar"));
				return { buf: t.stdout, name: `${base}.tar.gz`, fallback: "tar.gz" };
			}
			throw new Error(SL("remoteZipFail", { detail: r.stderr ? SL("colonSep") + r.stderr : "" }));
		}

		async function remoteUnzip(c, zipPath, destDir) {
			const zp = safeRemotePath(zipPath);
			const dp = safeRemotePath(destDir);
			try {
				const l = await sshExecCapture(c, `unzip -Z1 ${shQuote(zp)}`);
				if (l.code === 0) {
					for (const nm of l.stdout
						.toString("utf8")
						.split("\n")
						.map((s) => s.replace(/\r$/, ""))
						.filter((s) => s.length)) {
						assertZipEntrySafe(nm);
					}
				}
			} catch (err) {
				if (err?.code === "VSC_ZIP_PATH") throw err;
			}
			const r = await sshExecCapture(c, `unzip -o -q ${shQuote(zp)} -d ${shQuote(dp)}`);
			if (r.code !== 0) {
				const errLower = `${r.stderr}`.toLowerCase();
				if (r.code === 127 || errLower.includes("not found")) throw new Error(SL("remoteNoUnzip"));
				throw new Error(SL("remoteUnzipFail", { detail: r.stderr ? SL("colonSep") + r.stderr : "" }));
			}
		}

		function safeRemotePath(p) {
			p = String(p ?? "");
			if (!p.startsWith("/") || p.split("/").includes("..")) throw new Error(SL("invalidPath"));
			return p;
		}

		function sftpCall(sftp, method, ...args) {
			return new Promise((resolve, reject) => sftp[method](...args, (err, r) => (err ? reject(err) : resolve(r))));
		}

		const sshDeps = { mod: null, ok: false, installing: false, waiters: [] };

		function ensureSshMod() {
			if (sshDeps.ok) return Promise.resolve(sshDeps.mod);
			if (sshDeps.installing) return new Promise((res) => sshDeps.waiters.push(res));
			return new Promise(async (res) => {
				sshDeps.installing = true;
				try {
					const m = await import("ssh2");
					sshDeps.mod = m.default ?? m;
					sshDeps.ok = true;
				} catch {
					host.notify("info", SLX(uiLang, "installingDeps"));
					let cli = null;
					try {
						cli = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
					} catch {}
					const args = ["--prefix", host.dir, "install", "ssh2@latest", "--no-audit", "--no-fund"];
					const child = cli
						? spawn(process.execPath, [cli, ...args], { stdio: "ignore" })
						: spawn("npm", args, { stdio: "ignore", shell: process.platform === "win32" });
					child.on("error", () => finish(false));
					child.on("exit", (code) => finish(code === 0));
					return;
					async function finish(ok) {
						sshDeps.installing = false;
						if (ok) {
							try {
								const m = await import("ssh2");
								sshDeps.mod = m.default ?? m;
								sshDeps.ok = true;
							} catch {}
						}
						host.notify(sshDeps.ok ? "success" : "error", sshDeps.ok ? SLX(uiLang, "depsOk") : SLX(uiLang, "depsFail"));
						for (const w of sshDeps.waiters.splice(0)) w(sshDeps.ok ? sshDeps.mod : null);
						broadcastSshState();
						res(sshDeps.ok ? sshDeps.mod : null);
					}
				}
				sshDeps.installing = false;
				res(sshDeps.ok ? sshDeps.mod : null);
			});
		}

		const SSH_STORE = path.join(host.dir, "ssh-hosts.json");
		const LEGACY_SSH_STORE = path.join(host.dir, "..", "ssh", "ssh-hosts.json");
		const sec = host.secrets;
		const SECRET_FIELDS = [
			["password", "pass"],
			["privateKey", "key"],
			["passphrase", "pp"],
		];

		function hostSecretName(hostId, fileField) {
			for (const [f, short] of SECRET_FIELDS) if (f === fileField) return `ssh:${hostId}:${short}`;
			return null;
		}

		let sshCfgs = null;
		const sshConns = new Map();
		let nextSshConn = 1;

		async function ensureSshCfgs() {
			if (sshCfgs) return sshCfgs;
			try {
				sshCfgs = JSON.parse(await fs.readFile(SSH_STORE, "utf8"));
			} catch {
				sshCfgs = {};
			}
			if (!Array.isArray(sshCfgs.hosts)) {
				try {
					const legacy = JSON.parse(await fs.readFile(LEGACY_SSH_STORE, "utf8"));
					if (Array.isArray(legacy.hosts) && legacy.hosts.length) sshCfgs.hosts = legacy.hosts;
				} catch {}
			}
			if (!Array.isArray(sshCfgs.hosts)) sshCfgs.hosts = [];
			if (sec?.set) {
				let migrated = false;
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						const name = hostSecretName(h.id, field);
						if (h[field] && name) {
							try {
								sec.set(name, String(h[field]));
							} catch {
								continue;
							}
							delete h[field];
							migrated = true;
						}
					}
				}
				if (migrated) {
					try {
						await saveSshCfgs();
					} catch {}
					host.log("已将 SSH 主机凭据迁移到加密存储");
				}
			}
			if (sec?.get) {
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						if (!h[field]) {
							const name = hostSecretName(h.id, field);
							const v = name ? sec.get(name) : undefined;
							if (v !== undefined) h[field] = v;
						}
					}
				}
			}
			return sshCfgs;
		}

		async function saveSshCfgs() {
			const hosts = sec
				? (sshCfgs?.hosts ?? []).map((h) => {
						const clean = { ...h };
						for (const [field] of SECRET_FIELDS) delete clean[field];
						return clean;
					})
				: (sshCfgs?.hosts ?? []);
			await fs.writeFile(SSH_STORE, JSON.stringify({ ...sshCfgs, hosts }, null, "\t"), "utf8");
		}

		function storeHostSecret(hostId, field, value) {
			const name = hostSecretName(hostId, field);
			if (!sec || !name || !hostId) return;
			try {
				if (value === null) sec.delete(name);
				else if (value) sec.set(name, String(value));
			} catch {}
		}

		function publicSshHost(h) {
			return {
				id: h.id,
				name: h.name,
				host: h.host,
				port: h.port ?? 22,
				username: h.username ?? "root",
				hasPass: Boolean(h.password),
				hasKey: Boolean(h.privateKey || h.privateKeyPath),
				hasPassphrase: Boolean(h.passphrase),
				privateKeyPath: h.privateKeyPath ?? "",
				agent: h.agent ?? "",
			};
		}

		const SSH_CONFIG_FILE = path.join(os.homedir(), ".ssh", "config");
		let sshConfigCache = { at: 0, blocks: [], list: [] };

		async function refreshSshConfigCache() {
			try {
				const blocks = await loadSshConfigBlocks({ configFile: SSH_CONFIG_FILE });
				const out = [];
				const seen = new Set();
				for (const b of blocks) {
					for (const alias of b.patterns) {
						if (!alias || alias.startsWith("!") || /[*?]/.test(alias) || seen.has(alias)) continue;
						seen.add(alias);
						const eff = resolveSshAlias(alias, blocks);
						out.push({
							alias,
							host: eff.hostname ?? alias,
							port: Number(eff.port) || 22,
							username: eff.user ?? "root",
							privateKeyPath: eff.identityfiles[0] ?? "",
							identityFiles: eff.identityfiles,
							proxyJump: eff.proxyjump ?? "",
							proxyCommand: eff.proxycommand ?? "",
							forwardAgent: eff.forwardagent ?? "",
						});
					}
				}
				sshConfigCache = { at: Date.now(), blocks, list: out, error: null };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				host.log("warn", `刷新 ~/.ssh/config 缓存失败: ${msg}`);
				sshConfigCache = { at: Date.now(), blocks: [], list: [], error: msg };
			}
			return sshConfigCache;
		}

		function publicSshState() {
			return {
				depsReady: sshDeps.ok,
				depsInstalling: sshDeps.installing,
				hosts: (sshCfgs?.hosts ?? []).map(publicSshHost),
				configHosts: sshConfigCache.list,
				configPath: "~/.ssh/config",
				conns: [...sshConns.values()].map((c) => ({
					connId: c.connId,
					hostId: c.hostId,
					label: c.label,
					status: c.status,
				})),
			};
		}

		function broadcastSshState() {
			host.broadcast({ kind: "state", state: publicSshState() });
		}

		function getSshConn(connId) {
			const c = sshConns.get(connId);
			if (!c) throw new Error(SL("connGone"));
			return c;
		}

		function dropSshConn(c, reason) {
			if (!sshConns.has(c.connId)) return;
			sshConns.delete(c.connId);
			for (const [, stream] of c.streams) {
				try {
					stream.end();
				} catch {}
			}
			c.streams.clear();
			try {
				c.client.end();
			} catch {}
			for (const j of c.jumps ?? []) {
				try {
					j.end();
				} catch {}
			}
			for (const p of c.procs ?? []) {
				try {
					p.kill();
				} catch {}
			}
			host.sendTo(c.ownerId, { event: "conn_closed", connId: c.connId, reason: reason ?? "" });
			broadcastSshState();
		}

		async function readSshConfigCandidates() {
			const { list, error } = await refreshSshConfigCache();
			if (error) throw new Error(SL("sshCfgReadFail", { error }));
			if (!list.length) throw new Error(SL("sshCfgEmpty"));
			await ensureSshCfgs();
			const exists = new Set();
			for (const h of sshCfgs.hosts) {
				if (h.host) exists.add(`${h.host}:${h.port ?? 22}:${h.username ?? "root"}`);
				if (h.name) exists.add(`name:${h.name}`);
			}
			return list.map((c) => ({
				...c,
				imported: exists.has(`${c.host}:${c.port}:${c.username}`) || exists.has(`name:${c.alias}`),
			}));
		}

		async function resolveConfigAlias(alias) {
			const { list, error } = await refreshSshConfigCache();
			if (error) throw new Error(SL("sshCfgReadFail", { error }));
			const c = list.find((x) => x.alias === String(alias ?? ""));
			if (!c) throw new Error(SL("sshCfgNoAlias", { alias }));
			return c;
		}

		async function readSshConfigRaw() {
			try {
				return await fs.readFile(SSH_CONFIG_FILE, "utf8");
			} catch {
				return "";
			}
		}

		async function writeSshConfigRaw(text) {
			const t = String(text ?? "");
			if (t.length > 512 * 1024) throw new Error(SL("cfgTooBig"));
			await fs.mkdir(path.dirname(SSH_CONFIG_FILE), { recursive: true, mode: 0o700 });
			try {
				const prev = await fs.readFile(SSH_CONFIG_FILE, "utf8");
				await fs.writeFile(`${SSH_CONFIG_FILE}.bak`, prev, "utf8");
			} catch {}
			await fs.writeFile(SSH_CONFIG_FILE, t, { encoding: "utf8", mode: 0o600 });
			await refreshSshConfigCache();
			broadcastSshState();
		}

		async function buildSshOpts(cfg) {
			const opts = {
				host: cfg.host,
				port: Number(cfg.port) || 22,
				username: cfg.username || "root",
				readyTimeout: CONN_TIMEOUT_MS,
				keepaliveInterval: 10000,
				keepaliveCountMax: 3,
			};
			if (cfg.agent) {
				opts.agent = String(cfg.agent).replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
				return opts;
			}
			if (cfg.password) opts.password = cfg.password;
			const keyPath = cfg.privateKeyPath ? resolveKeyFile(String(cfg.privateKeyPath).trim()) : null;
			let key = null;
			if (keyPath) {
				try {
					key = await fs.readFile(keyPath, "utf8");
				} catch {
					throw new Error(SL("keyReadFail", { path: cfg.privateKeyPath }));
				}
			} else if (cfg.privateKey) key = cfg.privateKey;
			if (key) opts.privateKey = key;
			if (cfg.passphrase) opts.passphrase = cfg.passphrase;
			if (!opts.password && !opts.privateKey && !opts.agent) {
				throw new Error(SL("authNeedShort"));
			}
			return opts;
		}

		async function buildConfigAuth(candidate) {
			const files = [
				...(candidate.identityFiles ?? []),
				...(candidate.privateKeyPath ? [candidate.privateKeyPath] : []),
			];
			const keys = [];
			for (const f of files) {
				if (!f || keys.includes(f)) continue;
				try {
					keys.push({ path: f, pem: await fs.readFile(resolveKeyFile(String(f).trim()), "utf8") });
				} catch {}
			}
			if (!keys.length) {
				for (const d of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
					const p = path.join(os.homedir(), ".ssh", d);
					try {
						keys.push({ path: p, pem: await fs.readFile(p, "utf8") });
						break;
					} catch {}
				}
			}
			const agentSock = process.env.SSH_AUTH_SOCK || "";
			return { keys, agentSock };
		}

		function parseProxyJump(spec, blocks) {
			const hops = [];
			for (const part of String(spec ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)) {
				if (/^none$/i.test(part)) continue;
				const m = part.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
				if (!m) continue;
				const alias = m[2];
				const eff = resolveSshAlias(alias, blocks);
				const hasBlock = blocks.some((b) => b.patterns?.length && sshBlockMatches(b.patterns, alias));
				hops.push({
					host: eff.hostname ?? alias,
					port: Number(eff.port) || Number(m[3]) || 22,
					username: m[1] ?? eff.user ?? "root",
					identityFiles: eff.identityfiles,
				});
				void hasBlock;
			}
			return hops;
		}

		async function dialViaJumps(mod, hops, targetHost, targetPort, auth) {
			const jumps = [];
			try {
				let prevStream = null;
				for (const hop of hops) {
					const hopAuth = await buildConfigAuth({ identityFiles: hop.identityFiles });
					void auth;
					const jc = new mod.Client();
					const jopts = {
						host: hop.host,
						port: hop.port,
						username: hop.username,
						readyTimeout: CONN_TIMEOUT_MS,
						keepaliveInterval: 10000,
						keepaliveCountMax: 3,
					};
					if (prevStream) jopts.sock = prevStream;
					if (hopAuth.keys[0]) jopts.privateKey = hopAuth.keys[0].pem;
					if (hopAuth.agentSock) jopts.agent = hopAuth.agentSock;
					await new Promise((resolve, reject) => {
						jc.on("ready", resolve).on("error", reject).connect(jopts);
					});
					jumps.push(jc);
					const isLast = hop === hops[hops.length - 1];
					const dstHost = isLast ? targetHost : hops[hops.indexOf(hop) + 1].host;
					const dstPort = isLast ? targetPort : hops[hops.indexOf(hop) + 1].port;
					prevStream = await new Promise((resolve, reject) => {
						jc.forwardOut("127.0.0.1", 0, dstHost, dstPort, (err, stream) => (err ? reject(err) : resolve(stream)));
					});
				}
				return { sock: prevStream, jumps };
			} catch (err) {
				for (const j of jumps) {
					try {
						j.end();
					} catch {}
				}
				throw err;
			}
		}

		function dialViaProxyCommand(spec, targetHost, targetPort) {
			const cmd = String(spec).replace(/%h/g, targetHost).replace(/%p/g, String(targetPort));
			// eslint-disable-next-line node/no-unsupported-features -- spawn shell 复用系统 ssh 做传输
			const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
			const sock = new Duplex({
				read() {},
				write(chunk, _enc, cb) {
					child.stdin.write(chunk, cb);
				},
			});
			child.stdout.on("data", (d) => sock.push(d));
			child.on("exit", () => sock.destroy());
			sock.on("close", () => {
				try {
					child.kill();
				} catch {}
			});
			return { sock, procs: [child] };
		}

		async function connectSshHost(cfg, clientId, reqId) {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error(SL("ssh2NotReady"));
				const connId = `c${nextSshConn++}`;
				const c = {
					connId,
					client: new mod.Client(),
					ownerId: clientId,
					hostId: cfg.id,
					label: cfg.name || `${cfg.username}@${cfg.host}`,
					status: "connecting",
					streams: new Map(),
					nextShell: 1,
					sftp: null,
					jumps: [],
					procs: [],
				};
				sshConns.set(connId, c);
				broadcastSshState();
				const opts = await buildSshOpts(cfg);
				c.client
					.on("ready", () => {
						c.status = "connected";
						host.sendTo(clientId, { res: true, reqId, ok: true, action: "connect", connId, label: c.label });
						broadcastSshState();
					})
					.on("error", (err) => {
						const m = err?.level ? `[${err.level}] ${err.message}` : (err?.message ?? String(err));
						if (c.status === "connecting") {
							sshConns.delete(connId);
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "连接已关闭"));
				c.client.connect(opts);
			} catch (err) {
				sshConns.delete(connId);
				try {
					c.client?.end();
				} catch {}
				broadcastSshState();
				host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: err?.message ?? String(err) });
			}
		}

		async function connectConfigAlias(alias, clientId, reqId, action = "config_connect") {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error(SL("ssh2NotReady"));
				const candidate = await resolveConfigAlias(alias);
				const { keys, agentSock } = await buildConfigAuth(candidate);
				if (!keys.length && !agentSock) {
					throw new Error(SL("noAuthForAlias", { alias }));
				}
				const connId = `c${nextSshConn++}`;
				const c = {
					connId,
					client: new mod.Client(),
					ownerId: clientId,
					hostId: null,
					label: `${candidate.alias}（${candidate.username}@${candidate.host}）`,
					status: "connecting",
					streams: new Map(),
					nextShell: 1,
					sftp: null,
					jumps: [],
					procs: [],
				};
				sshConns.set(connId, c);
				broadcastSshState();
				const opts = {
					host: candidate.host,
					port: candidate.port,
					username: candidate.username,
					readyTimeout: CONN_TIMEOUT_MS,
					keepaliveInterval: 10000,
					keepaliveCountMax: 3,
				};
				if (keys[0]) opts.privateKey = keys[0].pem;
				if (agentSock) opts.agent = agentSock;
				if (candidate.proxyCommand) {
					const via = dialViaProxyCommand(candidate.proxyCommand, candidate.host, candidate.port);
					opts.sock = via.sock;
					c.procs.push(...via.procs);
				} else if (candidate.proxyJump) {
					const hops = parseProxyJump(candidate.proxyJump, sshConfigCache.blocks);
					if (!hops.length) throw new Error(SL("proxyJumpFail", { jump: candidate.proxyJump }));
					const via = await dialViaJumps(mod, hops, candidate.host, candidate.port);
					opts.sock = via.sock;
					c.jumps.push(...via.jumps);
				}
				c.client
					.on("ready", () => {
						c.status = "connected";
						host.sendTo(clientId, { res: true, reqId, ok: true, action, connId, label: c.label });
						broadcastSshState();
					})
					.on("error", (err) => {
						const m = err?.level ? `[${err.level}] ${err.message}` : (err?.message ?? String(err));
						if (c.status === "connecting") {
							sshConns.delete(connId);
							for (const j of c.jumps) {
								try {
									j.end();
								} catch {}
							}
							for (const p of c.procs) {
								try {
									p.kill();
								} catch {}
							}
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action, error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "连接已关闭"));
				c.client.connect(opts);
			} catch (err) {
				sshConns.delete(connId);
				for (const j of c.jumps) {
					try {
						j.end();
					} catch {}
				}
				for (const p of c.procs) {
					try {
						p.kill();
					} catch {}
				}
				try {
					c.client?.end();
				} catch {}
				broadcastSshState();
				host.sendTo(clientId, { res: true, reqId, ok: false, action, error: err?.message ?? String(err) });
			}
		}

		function getSftp(c) {
			if (c.sftp) return Promise.resolve(c.sftp);
			return new Promise((resolve, reject) => {
				c.client.sftp((err, sftp) => {
					if (err) return reject(err);
					c.sftp = sftp;
					sftp.on("close", () => {
						if (c.sftp === sftp) c.sftp = null;
					});
					resolve(sftp);
				});
			});
		}

		async function remoteList(c, dirPath) {
			const list = await sftpCall(await getSftp(c), "readdir", dirPath || "/");
			const entries = list.map((f) => ({
				name: f.filename,
				type: f.attrs.isDirectory() ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file",
				size: Number(f.attrs.size ?? 0),
			}));
			entries.sort((a, b) => (a.type === "file" ? 1 : 0) - (b.type === "file" ? 1 : 0) || a.name.localeCompare(b.name));
			return entries;
		}

		async function mkdirpRemote(sftp, rpath) {
			const segs = String(rpath ?? "")
				.split("/")
				.filter(Boolean);
			let cur = rpath.startsWith("/") ? "" : ".";
			for (const s of segs) {
				cur = cur === "." ? s : `${cur}/${s}`;
				await sftpCall(sftp, "mkdir", cur).catch(() => {});
			}
		}

		async function remoteRead(c, p) {
			const sftp = await getSftp(c);
			const stat = await sftpCall(sftp, "stat", p);
			if (stat.size > MAX_READ_BYTES) throw new Error(SL("fileOverMB", { n: MAX_READ_BYTES / 1024 / 1024 }));
			const buf = await sftpCall(sftp, "readFile", p);
			const mtimeMs = Number(stat.mtime ?? 0) * 1000;
			if (buf.includes(0)) return { binary: true, size: buf.length, mtimeMs };
			return { text: decodeBuf(buf), encoding: "utf-8", size: buf.length, mtimeMs };
		}

		async function remoteWrite(c, p, text) {
			const sftp = await getSftp(c);
			const parent = String(p).split("/").slice(0, -1).join("/");
			if (parent) await mkdirpRemote(sftp, parent);
			await sftpCall(sftp, "writeFile", p, Buffer.from(String(text ?? ""), "utf8"));
			const st = await sftpCall(sftp, "stat", p);
			return { bytes: Number(st.size ?? 0) };
		}

		async function remoteCreate(c, p, kind) {
			const sftp = await getSftp(c);
			if (kind === "dir") await mkdirpRemote(sftp, p);
			else {
				const parent = String(p).split("/").slice(0, -1).join("/");
				if (parent) await mkdirpRemote(sftp, parent);
				try {
					await sftpCall(sftp, "stat", p);
					throw Object.assign(new Error(SL("existsSame")), { code: "VSC_EXISTS" });
				} catch (err) {
					if (err?.code === "VSC_EXISTS") throw err;
				}
				await sftpCall(sftp, "writeFile", p, Buffer.alloc(0));
			}
		}

		async function remoteRename(c, p, newName) {
			if (
				typeof newName !== "string" ||
				!newName.trim() ||
				newName.includes("/") ||
				newName.includes("\\") ||
				newName.includes("..")
			) {
				throw new Error(SL("invalidNewName"));
			}
			const idx = p.lastIndexOf("/");
			const parent = idx >= 0 ? p.slice(0, idx) : "";
			await sftpCall(await getSftp(c), "rename", p, parent ? `${parent}/${newName}` : newName);
		}

		async function remoteDelete(c, p, isDir) {
			const sftp = await getSftp(c);
			if (!isDir) {
				await sftpCall(sftp, "unlink", p);
				return;
			}
			async function rmTree(dir) {
				let list;
				try {
					list = await sftpCall(sftp, "readdir", dir);
				} catch {
					return;
				}
				for (const f of list) {
					const child = `${dir}/${f.filename}`;
					if (f.attrs.isDirectory()) await rmTree(child);
					else await sftpCall(sftp, "unlink", child).catch(() => {});
				}
				await sftpCall(sftp, "rmdir", dir).catch(() => {});
			}
			await rmTree(p);
		}

		async function remoteCopy(c, src, dest, move) {
			src = safeRemotePath(src);
			dest = safeRemotePath(dest);
			if (dest === src || dest.startsWith(src.endsWith("/") ? src : `${src}/`)) {
				throw new Error(SL("illegalTargetSelf"));
			}
			const sftp = await getSftp(c);
			try {
				await sftpCall(sftp, "stat", dest);
				throw Object.assign(new Error(SL("targetExists")), { code: "VSC_TARGET_EXISTS" });
			} catch (err) {
				if (err?.code === "VSC_TARGET_EXISTS") throw err;
			}
			const destParent = dest.split("/").slice(0, -1).join("/");
			if (move) {
				if (destParent) await mkdirpRemote(sftp, destParent);
				await sftpCall(sftp, "rename", src, dest);
				return;
			}
			let st;
			try {
				st = await sftpCall(sftp, "stat", src);
			} catch {
				throw new Error(SL("srcMissing"));
			}
			if (st.isDirectory()) {
				await mkdirpRemote(sftp, dest);
				async function cpTree(sdir, ddir) {
					const list = await sftpCall(sftp, "readdir", sdir);
					for (const f of list) {
						const s = `${sdir}/${f.filename}`;
						const d = `${ddir}/${f.filename}`;
						if (f.attrs.isDirectory()) {
							await sftpCall(sftp, "mkdir", d).catch(() => {});
							await cpTree(s, d);
						} else {
							await sftpCall(sftp, "writeFile", d, await sftpCall(sftp, "readFile", s));
						}
					}
				}
				await cpTree(src, dest);
			} else {
				if (destParent) await mkdirpRemote(sftp, destParent);
				await sftpCall(sftp, "writeFile", dest, await sftpCall(sftp, "readFile", src));
			}
		}

		async function localCopy(srcRel, destRel, move) {
			const srcAbs = safeResolve(srcRel);
			const destAbs = safeResolve(destRel);
			if (!srcAbs || !destAbs || srcAbs === root) throw new Error(SL("invalidPath"));
			if (destAbs === root) throw new Error(SL("denyCoverRoot"));
			if (destAbs === srcAbs || destAbs.startsWith(srcAbs + path.sep)) {
				throw new Error(SL("illegalTargetSelf"));
			}
			await fs.access(srcAbs);
			try {
				await fs.access(destAbs);
				throw Object.assign(new Error(SL("targetExists")), { code: "VSC_TARGET_EXISTS" });
			} catch (err) {
				if (err?.code === "VSC_TARGET_EXISTS") throw err;
			}
			await fs.mkdir(path.dirname(destAbs), { recursive: true });
			if (move) await fs.rename(srcAbs, destAbs);
			else await fs.cp(srcAbs, destAbs, { recursive: true, errorOnExist: true, force: false });
		}

		const MAX_SEARCH_RESULTS = 50;

		async function searchLocal(query, baseRel) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) throw new Error(SL("emptyQuery"));
			const baseAbs = safeResolve(baseRel ?? "");
			if (!baseAbs) throw new Error(SL("pathOutside"));
			const out = [];
			const queue = [baseAbs];
			let visited = 0;
			while (queue.length && out.length < MAX_SEARCH_RESULTS && visited < 20000) {
				const dir = queue.shift();
				const depth = dir.slice(root.length).split(path.sep).filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let dirents;
				try {
					dirents = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const d of dirents) {
					if (out.length >= MAX_SEARCH_RESULTS || visited++ >= 20000) break;
					if (IGNORED.has(d.name) || d.name.startsWith(".vsc-upload-")) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(dir, d.name);
					const isDir = d.isDirectory();
					if (d.name.toLowerCase().includes(q)) {
						out.push({ path: toWire(path.relative(root, full)), type: isDir ? "dir" : "file" });
					}
					if (isDir) queue.push(full);
				}
			}
			return { results: out, truncated: out.length >= MAX_SEARCH_RESULTS };
		}

		async function searchRemote(c, query, baseDir) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) throw new Error(SL("emptyQuery"));
			const base = safeRemotePath(baseDir || "/");
			const sftp = await getSftp(c);
			const out = [];
			const queue = [base];
			let visited = 0;
			while (queue.length && out.length < MAX_SEARCH_RESULTS && visited < 20000) {
				const dir = queue.shift();
				const depth = dir.split("/").filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let list;
				try {
					list = await sftpCall(sftp, "readdir", dir);
				} catch {
					continue;
				}
				for (const f of list) {
					if (out.length >= MAX_SEARCH_RESULTS || visited++ >= 20000) break;
					if (f.filename === "." || f.filename === "..") continue;
					const full = `${dir === "/" ? "" : dir}/${f.filename}`;
					const isDir = f.attrs.isDirectory();
					if (f.filename.toLowerCase().includes(q)) {
						out.push({ path: full, type: isDir ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file" });
					}
					if (isDir) queue.push(full);
				}
			}
			return { results: out, truncated: out.length >= MAX_SEARCH_RESULTS };
		}

		function sshOpenShell(c, msg, reqId, clientId) {
			c.ownerId = clientId;
			c.client.shell({ cols: msg.cols ?? 80, rows: msg.rows ?? 24, term: "xterm-256color" }, (err, stream) => {
				if (err)
					return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "shell_open", error: err.message });
				const shellId = `s${c.nextShell++}`;
				c.streams.set(shellId, stream);
				const onData = (d) =>
					host.sendTo(c.ownerId, {
						event: "shell_data",
						connId: c.connId,
						shellId,
						b64: d.toString("base64"),
					});
				stream.on("data", onData);
				stream.stderr.on("data", onData);
				stream.on("close", () => {
					c.streams.delete(shellId);
					host.sendTo(c.ownerId, { event: "shell_exit", connId: c.connId, shellId });
				});
				host.sendTo(clientId, { res: true, reqId, ok: true, action: "shell_open", shellId });
			});
		}

		function sshExec(c, cmd, reqId, clientId) {
			c.client.exec(cmd, (err, stream) => {
				if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "exec", error: err.message });
				const chunks = [];
				stream.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.on("close", (code) => {
					let out = chunks.join("");
					if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + "\n…[截断]";
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "exec", exitCode: code ?? 0, output: out });
				});
			});
		}

		const uploads = new Map();

		function sweepUploads() {
			const now = Date.now();
			for (const [, u] of uploads) {
				if (now - u.last > UPLOAD_STALE_MS) void abortUploadEntry(u);
			}
		}

		async function abortUploadEntry(u) {
			if (!u) return;
			uploads.delete(u.key);
			const fh = u.fh;
			u.fh = null;
			u.bufs = [];
			if (fh) {
				try {
					await fh.close();
				} catch {}
			}
			if (u.tmp) {
				try {
					await fs.unlink(u.tmp);
				} catch {}
			}
		}

		async function beginUpload(clientId, msg) {
			const name = String(msg.name ?? "");
			if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
				throw new Error(SL("badName"));
			}
			const size = Number(msg.size);
			if (!Number.isFinite(size) || size < 0) throw new Error(SL("badSize"));
			if (size > MAX_UPLOAD_BYTES) throw new Error(SL("fileOverMB", { n: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) }));
			sweepUploads();
			const uploadId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
			const key = `${clientId}:${uploadId}`;
			const last = Date.now();
			if (msg.connId) {
				const c = getSshConn(msg.connId);
				const rpath = safeRemotePath(posixJoin(String(msg.dir ?? "/"), name));
				let exists = false;
				try {
					exists = (await sftpCall(await getSftp(c), "stat", rpath)).isFile();
				} catch {}
				uploads.set(key, {
					key,
					uploadId,
					scope: "remote",
					connId: msg.connId,
					rpath,
					bufs: [],
					bytes: 0,
					total: size,
					last,
					next: 0,
				});
				return { uploadId, exists };
			}
			const absDir = safeResolve(String(msg.dir ?? ""));
			if (!absDir) throw new Error(SL("pathOutside"));
			const finalAbs = path.join(absDir, name);
			let exists = false;
			try {
				exists = (await fs.stat(finalAbs)).isFile();
			} catch {}
			await fs.mkdir(absDir, { recursive: true });
			const tmp = path.join(absDir, `.vsc-upload-${uploadId}.part`);
			const fh = await fs.open(tmp, "w");
			uploads.set(key, {
				key,
				uploadId,
				scope: "local",
				tmp,
				finalAbs,
				fh,
				bufs: null,
				bytes: 0,
				total: size,
				last,
				next: 0,
			});
			return { uploadId, exists };
		}

		async function chunkUpload(clientId, msg) {
			const u = uploads.get(`${clientId}:${msg.uploadId}`);
			if (!u) throw new Error(SL("uploadGone"));
			if (Number(msg.i) !== u.next) throw new Error(SL("chunkOrder"));
			u.last = Date.now();
			sweepUploads();
			// 空文件（文件夹上传里的 .gitkeep 等）：首包即终包，直接落盘，无需分片。
			if (u.total === 0) {
				if (Number(msg.i) !== 0) throw new Error(SL("chunkOrder"));
				if (u.scope === "local") {
					await u.fh.close().catch(() => {});
					u.fh = null;
					await fs.rename(u.tmp, u.finalAbs);
				} else {
					const sftp0 = await getSftp(getSshConn(u.connId));
					await mkdirpRemote(sftp0, u.rpath.split("/").slice(0, -1).join("/"));
					await sftpCall(sftp0, "writeFile", u.rpath, Buffer.alloc(0));
				}
				uploads.delete(u.key);
				return { done: true, size: 0 };
			}
			const buf = Buffer.from(String(msg.b64 ?? ""), "base64");
			if (!buf.length) throw new Error(SL("emptyChunk"));
			u.bytes += buf.length;
			if (u.bytes > MAX_UPLOAD_BYTES)
				throw new Error(SL("fileOverMB", { n: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) }));
			if (u.scope === "local") await u.fh.write(buf, 0, buf.length, null);
			else u.bufs.push(buf);
			if (Number(msg.i) !== Number(msg.total) - 1) {
				u.next++;
				return { received: u.next };
			}
			if (u.scope === "local") {
				await u.fh.close().catch(() => {});
				u.fh = null;
				await fs.rename(u.tmp, u.finalAbs);
			} else {
				const sftp = await getSftp(getSshConn(u.connId));
				await mkdirpRemote(sftp, u.rpath.split("/").slice(0, -1).join("/"));
				await sftpCall(sftp, "writeFile", u.rpath, Buffer.concat(u.bufs, u.bytes));
			}
			uploads.delete(u.key);
			return { done: true, size: u.bytes };
		}

		async function upsertSshHost(h) {
			await ensureSshCfgs();
			h = h && typeof h === "object" ? h : {};
			if (!h.host || !String(h.host).trim()) throw new Error(SL("hostAddrNeed"));
			let id;
			if (h.id) {
				const i = sshCfgs.hosts.findIndex((x) => x.id === h.id);
				if (i < 0) throw new Error(SL("hostMissing"));
				const old = sshCfgs.hosts[i];
				storeHostSecret(h.id, "password", h.password === null ? null : h.password || undefined);
				storeHostSecret(h.id, "privateKey", h.privateKey === null ? null : h.privateKey || undefined);
				storeHostSecret(h.id, "passphrase", h.passphrase === null ? null : h.passphrase || undefined);
				sshCfgs.hosts[i] = {
					...old,
					name: h.name ?? old.name,
					host: String(h.host).trim() || old.host,
					port: Number(h.port) || old.port,
					username: h.username ?? old.username,
					password: h.password === null ? undefined : h.password || old.password,
					privateKey: h.privateKey === null ? undefined : h.privateKey || old.privateKey,
					passphrase: h.passphrase === null ? undefined : h.passphrase || old.passphrase,
					privateKeyPath:
						h.privateKeyPath !== undefined
							? String(h.privateKeyPath || "").trim() || undefined
							: (old.privateKeyPath ?? undefined),
					agent: h.agent !== undefined ? String(h.agent || "") || undefined : (old.agent ?? undefined),
				};
				id = h.id;
			} else {
				if (!h.password && !h.privateKey && !h.privateKeyPath && !h.agent) throw new Error(SL("hostAuthNeed"));
				if (sshCfgs.hosts.length >= MAX_SSH_HOSTS) throw new Error(SL("hostLimit", { n: MAX_SSH_HOSTS }));
				id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
				storeHostSecret(id, "password", h.password || undefined);
				storeHostSecret(id, "privateKey", h.privateKey || undefined);
				storeHostSecret(id, "passphrase", h.passphrase || undefined);
				sshCfgs.hosts.push({
					id,
					name: String(h.name || h.host),
					host: String(h.host).trim(),
					port: Number(h.port) || 22,
					username: String(h.username || "root"),
					password: h.password ? String(h.password) : undefined,
					privateKey: h.privateKey ? String(h.privateKey) : undefined,
					passphrase: h.passphrase ? String(h.passphrase) : undefined,
					privateKeyPath: h.privateKeyPath ? String(h.privateKeyPath).trim() : undefined,
					agent: h.agent ? String(h.agent) : undefined,
				});
			}
			await saveSshCfgs();
			broadcastSshState();
			return id;
		}

		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;
			uiLang = msg.lang === "en" ? "en" : "zh";
			vscAls.enterWith(uiLang);
			try {
				switch (action) {
					case "list":
						if (msg.connId) {
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								dir: String(msg.dir ?? "/"),
								entries: await remoteList(getSshConn(msg.connId), msg.dir),
							});
							break;
						}
						host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							dir: toWire(msg.dir ?? ""),
							entries: await listDir(msg.dir),
						});
						break;
					case "flatlist":
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...(await flatList()) });
						break;
					case "download": {
						if (!msg.connId) {
							const abs = safeResolve(String(msg.path ?? ""));
							if (!abs || abs === root) throw new Error(SL("invalidPath"));
							const st = await fs.stat(abs);
							if (st.isDirectory()) {
								const buf = await tarGzLocal(abs);
								host.sendTo(clientId, {
									res: true,
									reqId,
									ok: true,
									action,
									b64: buf.toString("base64"),
									size: buf.length,
									name: `${path.basename(abs)}.tar.gz`,
								});
								break;
							}
							if (!st.isFile()) throw new Error(SL("notFile"));
							if (st.size > MAX_DOWNLOAD_BYTES)
								throw new Error(SL("fileOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) }));
							const buf = await fs.readFile(abs);
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: buf.toString("base64"),
								size: st.size,
								name: path.basename(abs),
							});
							break;
						}
						const c = getSshConn(msg.connId);
						const p = safeRemotePath(msg.path);
						const sftp = await getSftp(c);
						let st;
						try {
							st = await sftpCall(sftp, "stat", p);
						} catch {
							throw new Error(SL("pathMissing"));
						}
						if (st.isDirectory()) {
							const clean = p.replace(/\/+$/, "");
							const name = clean.split("/").pop();
							const parent = clean.split("/").slice(0, -1).join("/") || "/";
							const buf = await sshExecBuffer(c, `cd ${shQuote(parent)} && tar -czf - ${shQuote(name)}`);
							if (!buf.length) throw new Error(SL("remotePackFail"));
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: buf.toString("base64"),
								size: buf.length,
								name: `${name}.tar.gz`,
							});
						} else {
							if (Number(st.size) > MAX_DOWNLOAD_BYTES)
								throw new Error(SL("fileOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) }));
							const buf = await sftpCall(sftp, "readFile", p);
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: buf.toString("base64"),
								size: buf.length,
								name: p.split("/").pop(),
							});
						}
						break;
					}
					case "download_zip": {
						const paths = Array.isArray(msg.paths) ? msg.paths.map(String) : [String(msg.path ?? "")];
						if (!paths.length || paths.length > 100) throw new Error(SL("pickPaths"));
						if (!msg.connId) {
							const absList = paths.map((pp) => {
								const a = safeResolve(pp);
								if (!a || a === root) throw new Error(SL("invalidPathAt", { p: pp }));
								return a;
							});
							const relList = absList.map((a) => toWire(path.relative(root, a)));
							let zbuf = null;
							let zfallback = null;
							try {
								zbuf = await zipLocalViaSystem(relList, root);
							} catch (err) {
								if (err?.code !== "ENOENT") throw err;
							}
							if (!zbuf) {
								const entries = await collectLocalZipEntries(absList);
								zbuf = zipStoreFiles(entries);
								zfallback = "node";
							}
							if (zbuf.length > MAX_DOWNLOAD_BYTES)
								throw new Error(SL("packOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) }));
							const zdirs = relList.map((rr) => (rr.includes("/") ? rr.split("/").slice(0, -1).join("/") : ""));
							const zsameDir = zdirs.every((dd) => dd === zdirs[0]);
							const zbase =
								absList.length === 1
									? path.basename(absList[0])
									: zsameDir && zdirs[0]
										? path.basename(zdirs[0])
										: "files";
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: zbuf.toString("base64"),
								size: zbuf.length,
								name: `${zbase}.zip`,
								fallback: zfallback,
							});
							break;
						}
						const zc = getSshConn(msg.connId);
						const rpaths = paths.map((pp) => safeRemotePath(pp));
						const zr = await remoteDownloadZip(zc, rpaths);
						host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							b64: zr.buf.toString("base64"),
							size: zr.buf.length,
							name: zr.name,
							fallback: zr.fallback,
						});
						break;
					}
					case "unzip": {
						const zipWire = String(msg.zip ?? msg.path ?? "");
						const destWire = String(msg.dest ?? msg.dir ?? "");
						if (!zipWire.toLowerCase().endsWith(".zip")) throw new Error(SL("needZip"));
						if (!msg.connId) {
							const zipAbs = safeResolve(zipWire);
							const destAbs = safeResolve(destWire);
							if (!zipAbs || !destAbs) throw new Error(SL("invalidPath"));
							const zst = await fs.stat(zipAbs);
							if (!zst.isFile()) throw new Error(SL("notFile"));
							if (zst.size > MAX_DOWNLOAD_BYTES)
								throw new Error(SL("fileOverMB", { n: Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024) }));
							await fs.mkdir(destAbs, { recursive: true });
							let ucount = -1;
							let ufallback = null;
							try {
								let unames = null;
								try {
									unames = await unzipListNames(zipAbs);
								} catch (le) {
									if (le?.code !== "ENOENT") throw Object.assign(new Error(SL("unzipNolist")), { code: "NOLIST" });
									throw le;
								}
								for (const nm of unames) assertZipEntrySafe(nm);
								await unzipLocalViaSystem(zipAbs, destAbs);
							} catch (err) {
								if (err?.code !== "ENOENT" && err?.code !== "NOLIST") throw err;
								ufallback = "node";
								ucount = await unzipBufferToDir(await fs.readFile(zipAbs), destAbs);
							}
							host.sendTo(clientId, { res: true, reqId, ok: true, action, count: ucount, fallback: ufallback });
							break;
						}
						const uc = getSshConn(msg.connId);
						await remoteUnzip(uc, zipWire, destWire || "/");
						host.sendTo(clientId, { res: true, reqId, ok: true, action, count: -1, fallback: null });
						break;
					}
					case "read": {
						const r = msg.connId
							? await remoteRead(getSshConn(msg.connId), String(msg.path ?? ""))
							: await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write": {
						const info = msg.connId
							? await remoteWrite(getSshConn(msg.connId), String(msg.path ?? ""), msg.text)
							: await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...info });
						break;
					}
					case "stat": {
						if (msg.connId) {
							const sc = getSshConn(msg.connId);
							const sp = safeRemotePath(String(msg.path ?? "/"));
							const sst = await sftpCall(await getSftp(sc), "stat", sp);
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								path: msg.path,
								size: Number(sst.size ?? 0),
								isDir: sst.isDirectory(),
								mtimeMs: Number(sst.mtime ?? 0) * 1000,
							});
						} else {
							const sabs = safeResolve(String(msg.path ?? ""));
							if (!sabs) throw new Error(SL("pathOutside"));
							const sst = await fs.stat(sabs);
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								path: msg.path,
								size: sst.size,
								isDir: sst.isDirectory(),
								mtimeMs: sst.mtimeMs,
							});
						}
						break;
					}
					case "create":
						if (msg.connId) await remoteCreate(getSshConn(msg.connId), String(msg.path ?? ""), msg.kind);
						else await createEntry(msg.path, msg.kind);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "rename":
						if (msg.connId) await remoteRename(getSshConn(msg.connId), String(msg.path ?? ""), msg.newName);
						else await renameEntry(msg.path, msg.newName);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "delete":
						if (msg.connId) await remoteDelete(getSshConn(msg.connId), String(msg.path ?? ""), Boolean(msg.isDir));
						else await deleteEntry(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "copy": {
						if (msg.connId) {
							await remoteCopy(
								getSshConn(msg.connId),
								String(msg.src ?? ""),
								String(msg.dest ?? ""),
								msg.move === true,
							);
						} else {
							await localCopy(String(msg.src ?? ""), String(msg.dest ?? ""), msg.move === true);
						}
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "search": {
						const r = msg.connId
							? await searchRemote(getSshConn(msg.connId), msg.query, msg.baseDir ?? msg.base ?? "/")
							: await searchLocal(msg.query, msg.base ?? msg.baseDir ?? "");
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...r });
						break;
					}
					case "upload_begin": {
						const st = await beginUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload": {
						const st = await chunkUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload_abort": {
						const u = uploads.get(`${clientId}:${msg.uploadId}`);
						if (u) await abortUploadEntry(u);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "state":
						await ensureSshCfgs();
						await refreshSshConfigCache();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, state: publicSshState() });
						break;
					case "deps_install":
						ensureSshMod();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "hosts_save": {
						const id = await upsertSshHost(msg.host);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, id });
						break;
					}
					case "sshconfig_list": {
						const list = await readSshConfigCandidates();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, hosts: list });
						break;
					}
					case "config_connect": {
						if (!msg.alias) throw new Error(SL("needAlias"));
						void connectConfigAlias(String(msg.alias), clientId, reqId);
						return;
					}
					case "sshconfig_get": {
						host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							text: await readSshConfigRaw(),
							path: SSH_CONFIG_FILE,
						});
						break;
					}
					case "sshconfig_save": {
						await writeSshConfigRaw(msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "sshconfig_import": {
						await ensureSshCfgs();
						const aliases = Array.isArray(msg.aliases) ? msg.aliases.map(String) : [];
						if (!aliases.length) throw new Error(SL("pickAliases"));
						const wanted = new Map((await readSshConfigCandidates()).map((c) => [c.alias, c]));
						let added = 0,
							skipped = 0;
						for (const alias of aliases) {
							const c = wanted.get(alias);
							if (!c || c.imported) {
								skipped++;
								continue;
							}
							if (sshCfgs.hosts.length >= MAX_SSH_HOSTS)
								throw new Error(SL("hostLimitAdded", { n: MAX_SSH_HOSTS, added }));
							const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}${added}`;
							sshCfgs.hosts.push({
								id,
								name: c.alias,
								host: c.host,
								port: c.port,
								username: c.username,
								privateKeyPath: c.privateKeyPath || undefined,
							});
							added++;
						}
						await saveSshCfgs();
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, added, skipped });
						break;
					}
					case "hosts_delete": {
						await ensureSshCfgs();
						const before = sshCfgs.hosts.length;
						for (const x of sshCfgs.hosts) {
							if (x.id === msg.id) for (const [field] of SECRET_FIELDS) storeHostSecret(x.id, field, null);
						}
						sshCfgs.hosts = sshCfgs.hosts.filter((x) => x.id !== msg.id);
						if (sshCfgs.hosts.length === before) throw new Error(SL("hostMissing"));
						await saveSshCfgs();
						for (const c of [...sshConns.values()]) if (c.hostId === msg.id) dropSshConn(c, "主机已删除");
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "connect": {
						await ensureSshCfgs();
						const cfg = sshCfgs.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error(SL("hostMissing"));
						void connectSshHost(cfg, clientId, reqId);
						return;
					}
					case "disconnect":
						dropSshConn(getSshConn(msg.connId), "手动断开");
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "shell_open":
						return void sshOpenShell(getSshConn(msg.connId), msg, reqId, clientId);
					case "shell_close": {
						const c = getSshConn(msg.connId);
						c.streams.get(msg.shellId)?.end();
						c.streams.delete(msg.shellId);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "shell_input":
						try {
							getSshConn(msg.connId)
								.streams.get(msg.shellId)
								?.write(Buffer.from(String(msg.b64 ?? ""), "base64"));
						} catch {}
						return;
					case "shell_resize":
						try {
							getSshConn(msg.connId)
								.streams.get(msg.shellId)
								?.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0);
						} catch {}
						return;
					case "exec":
						return void sshExec(getSshConn(msg.connId), String(msg.cmd ?? ""), reqId, clientId);
					default:
						host.log("unknown action:", action);
						host.sendTo(clientId, fail(reqId, `未知操作 ${action}`));
				}
			} catch (err) {
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err), err?.code));
			}
		});

		host.log(`activated; workspace root: ${toWire(root)}`);
		const offAttach = host.onAttach?.((clientId) => {
			void ensureSshCfgs()
				.then(() => refreshSshConfigCache())
				.then(() => {
					host.sendTo(clientId, { kind: "state", state: publicSshState() });
				});
		});
		const offCwd = host.onCwdChange?.((next) => {
			root = path.resolve(next);
			host.broadcast({ kind: "workspace", root: toWire(root) });
			host.log(`workspace root switched: ${toWire(root)}`);
		});
		void ensureSshCfgs()
			.then(() => refreshSshConfigCache())
			.then(() => ensureSshMod());
		return () => {
			off();
			try {
				offAttach?.();
			} catch {}
			try {
				offCwd?.();
			} catch {}
			for (const c of sshConns.values()) {
				try {
					c.client.end();
				} catch {}
			}
			for (const [, u] of uploads) void abortUploadEntry(u);
			uploads.clear();
			sshConns.clear();
			host.log("deactivated");
		};
	},
};
