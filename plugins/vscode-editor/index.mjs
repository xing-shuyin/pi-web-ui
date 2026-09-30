/**
 * vscode-editor 服务端入口 —— 类 VSCode 编辑器插件的文件系统后端。
 *
 * 约定：ESM 默认导出 { activate(host) → deactivate? }。
 * 客户端上行 plugin_message：{ action, reqId, ... }，本插件用 host.sendTo
 * 定向回给发起请求的 socket（带 reqId 供并发匹配），不广播。
 *
 * AI 工具：activate 末尾经 host.registerAgentTool 注册 vsc_sftp 开头（同步配置/
 * 测试/上传下载）、vsc_ssh 开头（主机管理/连接/exec）、vsc_remote 开头（远端文件
 * 列表/读写/复制/删除/搜索）共 15 个，供模型自主配置 SFTP、上传代码、操作
 * SSH 远端——与 UI 表单共用同一套 upsert/dial/remote 后端。
 *
 * 安全：
 * - 所有路径必须是相对 host.cwd（服务启动工作区）的相对路径，
 *   resolve 后必须仍落在 root 内，越界直接拒绝；
 * - 目录遍历跳过 node_modules/.git 等噪音目录与符号链接（防循环）；
 * - 读有 2MB 上限；写走 tmp + rename 原子落盘。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";

/** 列目录时跳过的噪音条目名 */
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

const MAX_LIST_ENTRIES = 8000; // flatlist 总条目上限
const MAX_DEPTH = 12; // flatlist 最大深度
const MAX_READ_BYTES = 2 * 1024 * 1024; // 单文件读取上限（本地与远程 SFTP 共用）
const MAX_SSH_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;
const MAX_EXEC_OUTPUT = 256 * 1024; // 远程 exec 输出截断上限
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 本地文件下载到电脑的大小上限（base64 经 WS）
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 上传文件的大小上限（base64 分片经 WS）
const UPLOAD_STALE_MS = 30 * 60 * 1000; // 上传会话残留超时（客户端中途断开后自动清扫）

function toWire(p) {
	return p.split(path.sep).join("/");
}

/** OpenSSH config 通配匹配（ssh_config(5)：`*`/`?` 通配，`!` 前缀取反）。
 * 纯函数，单独导出供单测。 */
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

/** 某 Host 块是否匹配给定的别名：patterns 全部按 OpenSSH 语义依次判定
 * （含 `!` 否定：后面的肯定也救不回，见 ssh_config(5)）。 */
export function sshBlockMatches(patterns, alias) {
	let matched = false;
	for (const p of patterns) {
		if (p.startsWith("!")) {
			if (sshPatternMatches(p.slice(1), alias)) return false;
		} else if (sshPatternMatches(p, alias)) matched = true;
	}
	return matched;
}

/** 解析单份 ssh config 文本为块数组（含 Include 原始值，调用方展开）。
 * 语义对齐 OpenSSH：关键字大小写不敏感、`=` 与空白等价、同块同键首值优先。
 * 纯函数，单独导出供单测。 */
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
			// Include 可出现在文件顶层（VSCode Remote-SSH 常见写法），归入当前块以便顺序展开；
			// 顶层（cur 为空）时挂到一个零 patterns 的伪块，展开时无条件生效。
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

/** 按 OpenSSH `ssh -G alias` 语义求别名的生效配置：文件顺序遍历所有匹配块，
 * 首个出现的值获胜（first-obtained-wins）；IdentityFile 可多值累积。
 * 纯函数，单独导出供单测。 */
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
		if (!b.patterns?.length) continue; // 纯 Include 伪块不参与匹配
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

/** 解析 ~/.ssh/config 文本，产出可导入/直连候选 [{ alias, host, port, username, privateKeyPath, ... }]。
 * 语义对齐 OpenSSH `ssh -G`：通配块（含 `Host *`）只充当默认值继承不产出候选；
 * 别名含通配符的不产出；`~` 保持原样（连接时 resolveKeyFile 展开）。
 * privateKeyPath = 首个 IdentityFile（兼容旧字段），identityFiles = 全量，
 * proxyJump/proxyCommand/forwardAgent 透出供直连使用。纯函数，issue #149。 */
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

/** 展开一条 Include 模式：相对 ~/.ssh/ 解析，支持 glob（`*?[]`）。
 * 纯函数/辅助函数，单独导出供单测。 */
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

/** 递归加载主 config + 所有 Include（深度/数量封顶防循环），返回合并后的块数组。
 * 纯函数/辅助函数，单独导出供单测。 */
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
			// Include 按出现顺序就地展开（OpenSSH 语义：被包含内容如同写在这个位置）
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
		// 可变：跟随主应用 set_cwd 实时切换（host.onCwdChange 回调，见 activate 尾部）
		let root = path.resolve(host.cwd);

		/** 相对路径 → 校验后的绝对路径；非法返回 null */
		function safeResolve(rel) {
			if (typeof rel !== "string") return null;
			const abs = path.resolve(root, rel); // "" = 工作区根本身，合法
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return abs;
		}

		function fail(reqId, error) {
			return { res: true, reqId, ok: false, error };
		}

		/** 单层目录列表（tree 动作用，惰性展开） */
		async function listDir(relDir) {
			const abs = safeResolve(relDir ?? "");
			if (!abs) throw new Error("路径越界");
			const dirents = await fs.readdir(abs === root ? root : abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (IGNORED.has(d.name)) continue;
				// 符号链接/junction 不跟随展开（防循环、防越界），只按名字显示类型
				if (d.isSymbolicLink()) continue;
				// 上传中的临时文件（.vsc-upload-*.part）不显示在树里
				if (d.name.startsWith(".vsc-upload-")) continue;
				entries.push({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				});
			}
			entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
			return entries;
		}

		/** 全仓扁平文件列表（Ctrl+P 快速打开用），BFS 带深度/数量上限 */
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
					continue; // 权限等错误跳过该目录
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

		/** 文件内容嗅探：无 NUL 且控制字符占比 <2% 视为文本 */
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

		/** 解码：严格 UTF-8 → GBK → latin1（与主应用 decodeText 同语义） */
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
			if (!abs) throw new Error("路径越界");
			const stat = await fs.stat(abs);
			if (!stat.isFile()) throw new Error("不是普通文件");
			if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB 上限`);
			const buf = await fs.readFile(abs);
			if (!looksLikeText(buf)) return { binary: true, size: stat.size };
			return { text: decodeBuf(buf), encoding: "utf-8", size: stat.size };
		}

		/**
		 * 写前 symlink 防穿出：safeResolve 是纯词法校验，路径里任何一级是符号链接
		 * （指向工作区外）都能绕过它。这里从最近的已存在祖先开始取 realpath，确认
		 * 已存在部分的真实落点仍在工作区根内；目标本身存在时还要求不是符号链接。
		 * 不存在的那段是本次新建的名字，词法上已被 safeResolve 保证在 root 内。
		 * 返回 null = 校验不通过（存在检查与写入之间的 TOCTOU 窗口不在能力范围内）。
		 */
		async function safeWriteTarget(abs) {
			// 边界用 realpath 后的工作区根（root 自身可能在符号链接路径下/大小写不同）
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
					if (parent === anchor) return null; // 一路到根都没 realpath 成功（异常）
					anchor = parent;
				}
			}
			return null;
		}

		async function writeFile(rel, text) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			// 写前先做 symlink 防穿出校验（mkdir/写文件都会跟随符号链接）
			if (!(await safeWriteTarget(abs))) throw new Error("路径含符号链接或越界，拒绝写入");
			await fs.mkdir(path.dirname(abs), { recursive: true });
			// 原子写：tmp + rename，防半截内容
			const tmp = abs + ".vsc-tmp-" + process.pid;
			await fs.writeFile(tmp, String(text ?? ""), "utf-8");
			await fs.rename(tmp, abs);
		}

		async function createEntry(rel, kind) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			if (!(await safeWriteTarget(abs))) throw new Error("路径含符号链接或越界，拒绝创建");
			try {
				if (kind === "dir") await fs.mkdir(abs);
				else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await fs.writeFile(abs, "", { flag: "wx" }); // 已存在则报错
				}
			} catch (err) {
				if (err.code === "EEXIST") throw new Error("已存在同名文件/文件夹");
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
				throw new Error("非法新名称");
			}
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			await fs.access(abs); // 不存在直接抛
			await fs.rename(abs, path.join(path.dirname(abs), newName));
		}

		async function deleteEntry(rel) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("拒绝删除根目录");
			await fs.rm(abs, { recursive: true, force: false });
		}

		// ------------------------------------------------------------------
		// SFTP 同步：把本地工作区与远端目录互传
		//
		// 配置存工作区 <root>/.vscode/sftp.json（vscode-sftp 兼容字段名，
		// 可直接编辑该文件、Ctrl+S 保存即生效；首次使用从旧版插件目录的
		// sync-configs.json 一次性迁移）。依赖 ssh2 不随包分发，首次使用自动
		// npm 补装到插件目录。方向：up 本地→远端；down 远端→本地。范围：file
		// 单文件 / tree 子树 / all 全仓。排除规则：vscode-sftp 风格 glob。
		// ------------------------------------------------------------------
		const sftpCfgDir = () => path.join(root, ".vscode");
		const sftpCfgFile = () => path.join(sftpCfgDir(), "sftp.json"); // vscode-sftp 约定路径（随工作区切换）
		const LEGACY_SYNC_STORE = path.join(host.dir, "sync-configs.json"); // 旧版存储（迁移源）
		const syncConns = new Map(); // workspaceRoot → {client,sftp}
		let syncConnFp = ""; // 当前连接对应的配置指纹（配置文件改动后自动重连）
		const syncDeps = { mod: null, ok: false, installing: false, waiters: [] };

		function posixJoin(base, rel) {
			if (!rel) return base;
			return `${String(base).replace(/\/+$/, "")}/${String(rel).replace(/^\/+/g, "")}`;
		}

		/** 内部统一形状；兼容 vscode-sftp 字段名（name/host/remotePath/privateKeyPath/
		 *  passphrase/ignore/agent 以及旧版 watcher.autoUpload）。vscode-sftp 的
		 *  privateKeyPath 习惯写 ~/.ssh/id_rsa，故解析时做 ~ 展开（见 resolveKeyFile）。 */
		function normalizeCfg(c) {
			c = c && typeof c === "object" ? c : {};
			const watcher = c.watcher && typeof c.watcher === "object" ? c.watcher : {};
			return {
				name: String(c.name ?? ""),
				host: String(c.host ?? "").trim(),
				port: Number(c.port) || 22,
				username: String(c.username ?? "root"),
				password: String(c.password ?? ""),
				passphrase: String(c.passphrase ?? ""),
				privateKey: String(c.privateKey ?? ""),
				privateKeyPath: String(c.privateKeyPath ?? ""),
				// vscode-sftp 同时支持顶层 uploadOnSave 与旧版 watcher.autoUpload，二者都认
				uploadOnSave: Boolean(c.uploadOnSave ?? watcher.autoUpload),
				// ssh-agent socket（vscode-sftp 用 "$SSH_AUTH_SOCK"）；配置里保持原样，
				// 连接时再展开环境变量（见 getSyncSftp）
				agent: String(c.agent ?? ""),
				protocol: String(c.protocol ?? "sftp").toLowerCase(),
				remoteRoot: String(c.remotePath ?? c.remoteRoot ?? "").trim() || "/",
				exclude: Array.isArray(c.ignore ?? c.exclude)
					? [...new Set((c.ignore ?? c.exclude).map(String))].filter(Boolean)
					: [],
			};
		}

		/** 解析私钥路径：支持 ~ 展开（vscode-sftp 习惯 ~/.ssh/id_rsa），绝对路径原样使用，
		 *  其余相对路径回退按工作区解析（兼容旧行为）。 */
		function resolveKeyFile(p) {
			if (!p) return p;
			if (p === "~") return os.homedir();
			if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
			if (path.isAbsolute(p)) return p;
			return path.resolve(root, p);
		}

		/** 每次直读小文件——用户改完 .vscode/sftp.json 保存即生效，无需重载；
		 *  不存在时尝试从旧版插件目录存储一次性迁移过来 */
		async function readSyncCfg() {
			try {
				return normalizeCfg(JSON.parse(await fs.readFile(sftpCfgFile(), "utf8")));
			} catch {}
			try {
				const legacy = JSON.parse(await fs.readFile(LEGACY_SYNC_STORE, "utf8"));
				const old = normalizeCfg(legacy?.[root]);
				if (old.host) {
					await saveSyncCfg(old);
					return old; // 迁移成功
				}
			} catch {}
			return {};
		}

		/** 写 vscode-sftp 风格 JSON（原子写 tmp+rename），用户可直接打开编辑 */
		async function saveSyncCfg(cfg) {
			await fs.mkdir(sftpCfgDir(), { recursive: true });
			const file = {
				host: cfg.host,
				port: cfg.port || 22,
				username: cfg.username || "root",
				protocol: "sftp",
				password: cfg.password || "",
				passphrase: cfg.passphrase || "",
				remotePath: cfg.remoteRoot || "/",
				uploadOnSave: !!cfg.uploadOnSave,
				ignore: cfg.exclude ?? [],
			};
			if (cfg.name) file.name = cfg.name;
			if (cfg.privateKeyPath) file.privateKeyPath = cfg.privateKeyPath;
			if (cfg.privateKey) file.privateKey = cfg.privateKey;
			// 保持原始写法（含 $SSH_AUTH_SOCK 占位符），便于跨环境复用
			if (cfg.agent) file.agent = cfg.agent;
			const tmp = `${sftpCfgFile()}.tmp-${process.pid}`;
			await fs.writeFile(tmp, JSON.stringify(file, null, 4) + "\n", "utf8");
			await fs.rename(tmp, sftpCfgFile());
		}

		/** 新建/更新同步配置（UI 的 sync_save 与 AI 的 vsc_sftp_save 共用，规则唯一）。
		 *  入参用 UI 表单字段名（remoteRoot/exclude）；AI 工具层负责把
		 *  vscode-sftp 字段名（remotePath/ignore）转过来。语义：缺席字段沿用旧值
		 *  （AI 只传要改的即可），凭据传显式 null = 清除。返回生效后的完整配置。 */
		async function upsertSyncCfg(c) {
			c = c && typeof c === "object" ? c : {};
			if (!c.host || !String(c.host).trim()) throw new Error("主机地址不能为空");
			const old = await readSyncCfg();
			const remoteRoot = c.remoteRoot !== undefined ? String(c.remoteRoot).trim() : (old.remoteRoot ?? "/");
			if (!remoteRoot.startsWith("/")) throw new Error("远端根路径必须是绝对路径（以 / 开头）");
			const next = normalizeCfg({
				...old,
				host: String(c.host).trim(),
				port: c.port !== undefined ? Number(c.port) || 22 : old.port || 22,
				username: c.username ?? old.username ?? "root",
				name: c.name !== undefined ? String(c.name || "") : (old.name ?? ""),
				// 凭据留空 = 沿用旧值；显式 null = 清除
				password: c.password === null ? "" : c.password || old.password,
				passphrase: c.passphrase === null ? "" : c.passphrase || old.passphrase,
				privateKey: c.privateKey === null ? "" : c.privateKey || old.privateKey,
				privateKeyPath:
					c.privateKeyPath !== undefined ? String(c.privateKeyPath || "").trim() : (old.privateKeyPath ?? ""),
				agent: c.agent !== undefined ? String(c.agent || "") : (old.agent ?? ""),
				remoteRoot,
				exclude: Array.isArray(c.exclude) ? c.exclude.map(String) : (old.exclude ?? []),
				uploadOnSave: c.uploadOnSave !== undefined ? Boolean(c.uploadOnSave) : Boolean(old.uploadOnSave),
			});
			await saveSyncCfg(next);
			dropSyncConn(root); // 配置变了，旧连接作废
			return next;
		}

		/** 在远端执行命令并收集原始 stdout Buffer（供打包下载；与 sshExec 不同不经 UTF8 解码） */
		function sshExecBuffer(c, cmd) {
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
							return void reject(new Error(`压缩包超过 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB 上限`));
						}
						chunks.push(d);
					});
					stream.stderr.on("data", () => {});
					stream.on("close", () => resolve(Buffer.concat(chunks)));
				});
			});
		}

		/** POSIX shell 单引号转义 */
		const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

		/** 远程路径校验：必须绝对路径且无 .. 段 */
		function safeRemotePath(p) {
			p = String(p ?? "");
			if (!p.startsWith("/") || p.split("/").includes("..")) throw new Error("非法路径");
			return p;
		}

		function publicSync(cfg) {
			if (!cfg?.host) return { configured: false };
			return {
				configured: true,
				name: cfg.name ?? "",
				host: cfg.host,
				port: cfg.port ?? 22,
				username: cfg.username ?? "root",
				remoteRoot: cfg.remoteRoot ?? "/",
				exclude: cfg.exclude ?? [],
				uploadOnSave: Boolean(cfg.uploadOnSave),
				hasPass: Boolean(cfg.password),
				hasKey: Boolean(cfg.privateKey || cfg.privateKeyPath),
				hasAgent: Boolean(cfg.agent),
				privateKeyPath: cfg.privateKeyPath ?? "",
				agent: cfg.agent ?? "",
			};
		}

		/** 惰性加载 ssh2；未安装时自动 npm 补装（同 ssh 插件模式）。 */
		function ensureSshMod() {
			if (syncDeps.ok) return Promise.resolve(syncDeps.mod);
			if (syncDeps.installing) return new Promise((res) => syncDeps.waiters.push(res));
			return new Promise(async (res) => {
				syncDeps.installing = true;
				try {
					const m = await import("ssh2");
					syncDeps.mod = m.default ?? m;
					syncDeps.ok = true;
				} catch {
					host.notify("info", "📝 编辑器同步：开始安装依赖（ssh2）…");
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
						syncDeps.installing = false;
						if (ok) {
							try {
								const m = await import("ssh2");
								syncDeps.mod = m.default ?? m;
								syncDeps.ok = true;
							} catch {}
						}
						host.notify(
							syncDeps.ok ? "success" : "error",
							syncDeps.ok
								? "📝 编辑器同步依赖安装完成"
								: "📝 编辑器同步依赖安装失败——请在插件目录手动执行 npm install ssh2",
						);
						for (const w of syncDeps.waiters.splice(0)) w(syncDeps.ok ? syncDeps.mod : null);
						broadcastSshState(); // 依赖状态变化 → 刷新前端主机栏的 ⚠ssh2 按钮（函数声明提升，安全）
						res(syncDeps.ok ? syncDeps.mod : null);
					}
				}
				syncDeps.installing = false;
				res(syncDeps.ok ? syncDeps.mod : null);
			});
		}

		function dropSyncConn(key) {
			const c = syncConns.get(key);
			if (!c) return;
			syncConns.delete(key);
			try {
				c.client.end();
			} catch {}
		}

		async function getSyncSftp(cfg) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 依赖未就绪");
			if (!cfg?.host) throw new Error("尚未配置同步——请先点 ☁ → 同步配置或编辑 .vscode/sftp.json");
			// 配置指纹变化（用户改了 .vscode/sftp.json）→ 自动断开旧连接重连
			const fp = JSON.stringify([
				cfg.host,
				cfg.port,
				cfg.username,
				cfg.password,
				cfg.passphrase,
				cfg.privateKey,
				cfg.privateKeyPath,
				cfg.agent,
			]);
			const entry = syncConns.get(root);
			if (entry && syncConnFp === fp) return entry.sftp;
			dropSyncConn(root);
			const opened = await new Promise((resolve, reject) => {
				const client = new mod.Client();
				const opts = {
					host: cfg.host,
					port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: 15000,
					keepaliveInterval: 10000,
				};
				if (cfg.password) opts.password = cfg.password;
				else if (cfg.agent) {
					// ssh-agent socket（vscode-sftp 用 "$SSH_AUTH_SOCK" 占位符）
					opts.agent = cfg.agent.replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
					connect();
					return;
				} else {
					// 私钥：privateKeyPath 优先于内联 PEM；路径支持 ~ 展开（vscode-sftp 习惯 ~/.ssh/id_rsa）
					const keyPath = cfg.privateKeyPath ? resolveKeyFile(cfg.privateKeyPath) : null;
					Promise.resolve(keyPath ? fs.readFile(keyPath, "utf8") : cfg.privateKey)
						.then((key) => {
							if (!key) return reject(new Error("请填写密码、私钥或 agent（编辑 .vscode/sftp.json 或用 ☁ 同步配置）"));
							opts.privateKey = key;
							if (cfg.passphrase) opts.passphrase = cfg.passphrase;
						})
						.catch(() => reject(new Error(`私钥文件读取失败：${cfg.privateKeyPath}`)))
						.then(connect);
					return;
				}
				connect();
				function connect() {
					client.on("ready", () => {
						client.sftp((err, sftp) => {
							if (err) {
								try {
									client.end();
								} catch {}
								return reject(err);
							}
							syncConns.set(root, { client, sftp });
							resolve({ client, sftp });
						});
					});
					client.on("error", (e) => {
						try {
							client.end();
						} catch {}
						reject(e);
					});
					client.connect(opts);
				}
			});
			syncConnFp = fp;
			return opened.sftp;
		}

		/** glob → RegExp（支持 ** 与 * 与 ? 通配；vscode-sftp 风格）。
		 *  例：规则「**＋斜杠＋*.map」同时匹配 a.map 与 a/b/c.map */
		function globToRegExp(pattern) {
			let re = "";
			for (let i = 0; i < pattern.length; i++) {
				const c = pattern[i];
				if (c === "*") {
					if (pattern[i + 1] === "*") {
						i++;
						if (i >= pattern.length - 1)
							re += ".*"; // 尾部 **：跨层匹配剩余全部（a/** 匹配子文件）
						else if (pattern[i + 1] === "/") {
							i++;
							re += "(?:[^/]*/)*";
						} // "**/" 匹配零层或多层目录
						else re += ".*";
					} else re += "[^/]*";
				} else if (c === "?") re += "[^/]";
				else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
				else re += c;
			}
			return new RegExp(`^${re}$`);
		}

		/** 编译 ignore 规则集：整路径匹配 + 无斜杠模式任意层级生效 + 目录规则覆盖其下所有内容 */
		function makeIgnoreMatcher(patterns) {
			const rules = (patterns ?? [])
				.map(String)
				.filter(Boolean)
				.map((raw) => {
					const pat = raw.replace(/^\/+|\/+$/g, "");
					if (pat === "**") return [/.*/]; // 全忽略
					const list = [globToRegExp(pat)];
					if (!pat.includes("/")) {
						list.push(globToRegExp(`**/${pat}`)); // "dist"、"*.log" 匹配任意层级的段
						list.push(globToRegExp(`${pat}/**`)); // 目录名规则覆盖顶层其下所有内容
						list.push(globToRegExp(`**/${pat}/**`)); // 任意层级下的同名目录内容
					}
					if (pat.endsWith("/**")) list.push(globToRegExp(pat.slice(0, -3))); // a/** 也忽略 a 本身
					return list;
				});
			return (rel) => rules.some((list) => list.some((re) => re.test(rel)));
		}

		function isSyncExcluded(rel, cfg) {
			return makeIgnoreMatcher(cfg.exclude)(rel);
		}

		/** 收集要传输的相对文件列表（双方通用：只产出 rel 路径数组） */
		async function collectLocal(relBase, cfg) {
			const out = [];
			async function walk(absDir, relDir) {
				const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
				for (const d of dirents) {
					const rel = relDir ? `${relDir}/${d.name}` : d.name;
					if (isSyncExcluded(rel, cfg)) continue;
					if (d.isSymbolicLink()) continue;
					if (d.isDirectory()) await walk(path.join(absDir, d.name), rel);
					else if (d.isFile()) out.push(rel);
				}
			}
			await walk(path.resolve(root, relBase || ""), relBase || "");
			return out;
		}

		function sftpCall(sftp, method, ...args) {
			return new Promise((resolve, reject) => sftp[method](...args, (err, r) => (err ? reject(err) : resolve(r))));
		}

		/** SFTP readdir 的 filename 正常只是名字；异常/恶意服务器可能回带路径分隔符
		 *  或 ".." 的条目——拼进 rel 后落盘会穿出工作区根。这类名字一律拒收。 */
		function isSuspiciousRemoteName(name) {
			return !name || name.includes("/") || name.includes("\\") || name.includes("..") || name === ".";
		}

		async function collectRemote(sftp, remoteBase, relBase, cfg) {
			const files = [];
			const skipped = []; // 可疑远端名（不拼 rel、不落盘，回传给调用方注明）
			async function walk(rdir, relDir) {
				let list;
				try {
					list = await sftpCall(sftp, "readdir", rdir);
				} catch {
					return;
				} // 目录不存在视为空
				for (const f of list) {
					if (isSuspiciousRemoteName(f.filename)) {
						skipped.push(relDir ? `${relDir}/${f.filename}` : f.filename);
						continue;
					}
					const rel = relDir ? `${relDir}/${f.filename}` : f.filename;
					if (isSyncExcluded(rel, cfg)) continue;
					if (f.attrs.isDirectory()) await walk(`${rdir}/${f.filename}`, rel);
					else if (f.attrs.isFile()) files.push(rel);
				}
			}
			await walk(remoteBase, relBase || "");
			return { files, skipped };
		}

		async function mkdirpRemote(sftp, rpath) {
			const segs = rpath.split("/").filter(Boolean);
			let cur = rpath.startsWith("/") ? "" : ".";
			for (const s of segs) {
				cur = cur === "." ? s : `${cur}/${s}`;
				await sftpCall(sftp, "mkdir", cur).catch(() => {}); // 已存在会报错，忽略
			}
		}

		/** 执行一次同步任务；返回摘要。progress(onDone, name) 上报进度。 */
		async function runSyncTransfer(cfg, direction, scope, targetRel, onProgress) {
			const sftp = await getSyncSftp(cfg);
			let rels;
			let skippedRemote = [];
			if (scope === "file") {
				rels = [targetRel];
				if (isSyncExcluded(targetRel, cfg)) throw new Error(`「${targetRel}」在排除规则内`);
			} else {
				const baseRel = scope === "tree" ? String(targetRel || "") : "";
				if (direction === "up") {
					rels = await collectLocal(baseRel, cfg);
				} else {
					// 远端清单里的可疑文件名已在 collectRemote 里剔除，这里拿到的是干净 rel
					const remote = await collectRemote(sftp, posixJoin(cfg.remoteRoot || "/", baseRel), baseRel, cfg);
					rels = remote.files;
					skippedRemote = remote.skipped;
				}
			}
			const failed = [];
			let done = 0;
			for (const rel of rels) {
				try {
					if (direction === "up") {
						const rp = posixJoin(cfg.remoteRoot || "/", rel);
						await mkdirpRemote(sftp, rp.split("/").slice(0, -1).join("/"));
						const srcAbs = safeResolve(rel);
						if (!srcAbs || srcAbs === root) throw new Error("非法路径（本地源越界）");
						await sftpCall(sftp, "writeFile", rp, await fs.readFile(srcAbs));
					} else {
						// 落盘前 rel 再过一次本地 safeResolve 式检查：远端来的路径绝不能穿出工作区根
						const lp = safeResolve(rel);
						if (!lp || lp === root) throw new Error("非法路径（落盘目标越界）");
						await fs.mkdir(path.dirname(lp), { recursive: true });
						await fs.writeFile(lp, await sftpCall(sftp, "readFile", posixJoin(cfg.remoteRoot || "/", rel)));
					}
				} catch (err) {
					failed.push({ rel, error: err?.message ?? String(err) });
				}
				done++;
				onProgress(done, rels.length, rel);
			}
			// skipped 注进结果：用户能看到哪些远端条目因名字可疑被跳过
			return skippedRemote.length
				? { total: rels.length, failed, skipped: skippedRemote }
				: { total: rels.length, failed };
		}

		// ------------------------------------------------------------------
		// SSH 远程主机（Remote-SSH 模式）
		//
		// 主机 CRUD（<pluginDir>/ssh-hosts.json，明文本机、回显脱敏；首次运行
		// 自动从旧版独立 ssh 插件的同名配置迁移）+ 连接池（keepalive 保活）+
		// PTY shell（base64 流式转发）+ exec。
		// 远程文件操作不设独立 action——客户端在 list/read/write/create/rename/
		// delete 上带 connId 即路由到该连接的 SFTP，与本地文件共用一套前端路径。
		// ssh2 依赖复用上方 ensureSshMod（未安装自动补装）。
		// 事件：shell_data / shell_exit / conn_closed 定向推送创建者 socket；
		// kind:"state" 广播主机/连接列表变化（凭据脱敏）。
		// ------------------------------------------------------------------
		const SSH_STORE = path.join(host.dir, "ssh-hosts.json");
		const LEGACY_SSH_STORE = path.join(host.dir, "..", "ssh", "ssh-hosts.json");
		// 机密存储：主机密码/私钥/passphrase 按主机 id 走宿主 host.secrets
		//（AES-256-GCM）；ssh-hosts.json 不再落明文凭据。旧版宿主无此设施时回退旧行为。
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
		const sshConns = new Map(); // connId → 连接记录
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
					// 迁移旧版独立 ssh 插件的主机列表（同格式直接搬）
					const legacy = JSON.parse(await fs.readFile(LEGACY_SSH_STORE, "utf8"));
					if (Array.isArray(legacy.hosts) && legacy.hosts.length) sshCfgs.hosts = legacy.hosts;
				} catch {}
			}
			if (!Array.isArray(sshCfgs.hosts)) sshCfgs.hosts = [];
			if (sec?.set) {
				// 一次性迁移：历史明文凭据 → 加密机密 + 文件剥离
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
				// 回填内存副本（连接需要真实凭据；脱敏回显在 publicSshHost 层做）
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
						for (const [field] of SECRET_FIELDS) delete clean[field]; // 凭据只进机密库
						return clean;
					})
				: (sshCfgs?.hosts ?? []);
			await fs.writeFile(SSH_STORE, JSON.stringify({ ...sshCfgs, hosts }, null, "\t"), "utf8");
		}

		/** 保存/清除某台主机的某个凭据字段（值真 → 写；显式 null → 删）。 */
		function storeHostSecret(hostId, field, value) {
			const name = hostSecretName(hostId, field);
			if (!sec || !name || !hostId) return;
			try {
				if (value === null) sec.delete(name);
				else if (value) sec.set(name, String(value));
			} catch {}
		}

		/** 脱敏回显：密码/私钥/口令不回传，只报是否存在；路径与 agent 非密文可直显 */
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

		// ---- ~/.ssh/config 自动加载（与 VSCode Remote-SSH 同源） ------------------
		// state 下发的 configHosts 每次都走缓存：`state` action 与 onAttach 先刷新，
		// 广播用缓存（文件几 KB，直读也便宜；缓存只为保住同步的 publicSshState 签名）。
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
				depsReady: syncDeps.ok,
				depsInstalling: syncDeps.installing,
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
			if (!c) throw new Error("连接不存在或已断开");
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
			if (error) throw new Error(`读取 ~/.ssh/config 失败：${error}`);
			if (!list.length) throw new Error("~/.ssh/config 里没有可导入的主机");
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

		/** config 别名 → 可直连候选（自动加载用；找不到抛错）。 */
		async function resolveConfigAlias(alias) {
			const { list, error } = await refreshSshConfigCache();
			if (error) throw new Error(`读取 ~/.ssh/config 失败：${error}`);
			const c = list.find((x) => x.alias === String(alias ?? ""));
			if (!c) throw new Error(`~/.ssh/config 里没有主机「${alias}」（VSCode 侧改完 config 刷新即生效）`);
			return c;
		}

		/** 打开 ~/.ssh/config 原文（前端「编辑 ssh config」弹层用）。 */
		async function readSshConfigRaw() {
			try {
				return await fs.readFile(SSH_CONFIG_FILE, "utf8");
			} catch {
				return "";
			}
		}

		/** 保存 ~/.ssh/config 原文（先备份 config.bak，权限 600）。 */
		async function writeSshConfigRaw(text) {
			const t = String(text ?? "");
			if (t.length > 512 * 1024) throw new Error("config 过大（512KB 上限），拒绝写入");
			await fs.mkdir(path.dirname(SSH_CONFIG_FILE), { recursive: true, mode: 0o700 });
			try {
				const prev = await fs.readFile(SSH_CONFIG_FILE, "utf8");
				await fs.writeFile(`${SSH_CONFIG_FILE}.bak`, prev, "utf8");
			} catch {}
			await fs.writeFile(SSH_CONFIG_FILE, t, { encoding: "utf8", mode: 0o600 });
			await refreshSshConfigCache();
			broadcastSshState();
		}

		/** 组装 ssh2 连接参数（密码 / 私钥路径(~ 展开) / 内联私钥 / agent 四选一；不足抛错）。
		 *  UI 的 connectSshHost 与 AI 的 dialSshHost 共用，规则唯一。 */
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
				// ssh-agent socket（与 SFTP 同步侧同一规则："$SSH_AUTH_SOCK" 占位符展开）
				opts.agent = String(cfg.agent).replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
				return opts;
			}
			if (cfg.password) opts.password = cfg.password;
			// 私钥：privateKeyPath 优先于内联 PEM（与 SFTP 同步侧同一规则），路径支持 ~ 展开
			const keyPath = cfg.privateKeyPath ? resolveKeyFile(String(cfg.privateKeyPath).trim()) : null;
			let key = null;
			if (keyPath) {
				try {
					key = await fs.readFile(keyPath, "utf8");
				} catch {
					throw new Error(`私钥文件读取失败：${cfg.privateKeyPath}`);
				}
			} else if (cfg.privateKey) key = cfg.privateKey;
			if (key) opts.privateKey = key;
			// 带口令的私钥：passphrase 无处输入/不传是 bug（issue #149 附带发现），这里补上
			if (cfg.passphrase) opts.passphrase = cfg.passphrase;
			if (!opts.password && !opts.privateKey && !opts.agent) {
				throw new Error("请填写密码、私钥或 agent（主机编辑里可填私钥路径 / agent）");
			}
			return opts;
		}

		/** config 直连的认证组装（OpenSSH 默认行为）：IdentityFile 全部试读（~ 展开），
		 * 读不到时回退默认私钥 + SSH_AUTH_SOCK（与 `ssh alias` 一致，免手动填）。 */
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
				} catch {
					/* 跳过不可读的 key，下一个 */
				}
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

		/** 解析 ProxyJump 值（`[user@]host[:port][,...]`，逗号分隔多跳）。 */
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

		/** 经跳板机逐跳建连，返回 { sock, jumps }（jumps 随连接存活，断开时一起关）。 */
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

		/** ProxyCommand 建连：本地起命令，stdio 作传输 sock（OpenSSH 同语义，`%h/%p` 展开）。 */
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
				if (!mod?.Client) throw new Error("ssh2 依赖未就绪，稍候再试");
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
				// 连接参数不足直接抛（不留半连接、不广播 connecting 闪烁）
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
							// 首连失败不留半连接
							sshConns.delete(connId);
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "连接已关闭"));
				c.client.connect(opts);
			} catch (err) {
				host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: err?.message ?? String(err) });
			}
		}

		/** config 别名直连（免导入，与 VSCode Remote-SSH 同源）：认证走 OpenSSH 默认
		 * （IdentityFile 全试 + 默认私钥 + ssh-agent），ProxyJump/ProxyCommand 透传建连。 */
		async function connectConfigAlias(alias, clientId, reqId, action = "config_connect") {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error("ssh2 依赖未就绪，稍候再试");
				const candidate = await resolveConfigAlias(alias);
				const { keys, agentSock } = await buildConfigAuth(candidate);
				if (!keys.length && !agentSock) {
					throw new Error(
						`主机「${alias}」没有可用认证：config 未配 IdentityFile，本机也没有默认私钥/~/.ssh 下的 key 与 ssh-agent（VSCode 里能连通常是因为 agent 或 key，服务端没跑 agent 时请先配 IdentityFile）`,
					);
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
				// 跳板 / 代理命令（OpenSSH 同语义；跳板认证同样走本机 key/agent）
				if (candidate.proxyCommand) {
					const via = dialViaProxyCommand(candidate.proxyCommand, candidate.host, candidate.port);
					opts.sock = via.sock;
					c.procs.push(...via.procs);
				} else if (candidate.proxyJump) {
					const hops = parseProxyJump(candidate.proxyJump, sshConfigCache.blocks);
					if (!hops.length) throw new Error(`ProxyJump 解析失败：${candidate.proxyJump}`);
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

		// ---- 远程文件操作（经连接的 SFTP；错误统一抛给路由 catch） -----------------
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

		async function remoteRead(c, p) {
			const sftp = await getSftp(c);
			const stat = await sftpCall(sftp, "stat", p);
			if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB 上限`);
			const buf = await sftpCall(sftp, "readFile", p);
			if (buf.includes(0)) return { binary: true, size: buf.length };
			return { text: decodeBuf(buf), encoding: "utf-8", size: buf.length };
		}

		async function remoteWrite(c, p, text) {
			const sftp = await getSftp(c);
			const parent = String(p).split("/").slice(0, -1).join("/");
			if (parent) await mkdirpRemote(sftp, parent); // 父目录自动补（与本地 writeFile 同语义，AI 直写新路径可用）
			await sftpCall(sftp, "writeFile", p, Buffer.from(String(text ?? ""), "utf8"));
		}

		async function remoteCreate(c, p, kind) {
			const sftp = await getSftp(c);
			if (kind === "dir")
				await mkdirpRemote(sftp, p); // 递归建目录（与本地 mkdir -p 同语义）
			else {
				const parent = String(p).split("/").slice(0, -1).join("/");
				if (parent) await mkdirpRemote(sftp, parent);
				// 已存在则拒绝（与本地 create 的 wx 同语义，避免静默覆盖）
				try {
					await sftpCall(sftp, "stat", p);
					throw new Error("已存在同名文件/文件夹");
				} catch (err) {
					if (err?.message === "已存在同名文件/文件夹") throw err;
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
				throw new Error("非法新名称");
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
			// 递归删目录（含非空，SFTP 自底向上；不存在视作已删）
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

		/** 远端复制/移动（SFTP 逐级；move 走 rename 原子改名）。dest 已存在一律拒绝。 */
		async function remoteCopy(c, src, dest, move) {
			src = safeRemotePath(src);
			dest = safeRemotePath(dest);
			if (dest === src || dest.startsWith(src.endsWith("/") ? src : `${src}/`)) {
				throw new Error("目标不能是源本身或其子目录");
			}
			const sftp = await getSftp(c);
			try {
				await sftpCall(sftp, "stat", dest);
				throw new Error("目标已存在");
			} catch (err) {
				if (err?.message === "目标已存在") throw err;
			} // 不存在 → 继续（复制/移动统一拒绝覆盖）
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
				throw new Error("源不存在");
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

		/** 本地复制/移动（含目录递归；move 走 rename）。dest 已存在一律拒绝，由调用方先算好副本名。 */
		async function localCopy(srcRel, destRel, move) {
			const srcAbs = safeResolve(srcRel);
			const destAbs = safeResolve(destRel);
			if (!srcAbs || !destAbs || srcAbs === root) throw new Error("非法路径");
			if (destAbs === root) throw new Error("拒绝覆盖根目录");
			if (destAbs === srcAbs || destAbs.startsWith(srcAbs + path.sep)) {
				throw new Error("目标不能是源本身或其子目录");
			}
			await fs.access(srcAbs); // 不存在直接抛
			try {
				await fs.access(destAbs);
				throw new Error("目标已存在");
			} catch (err) {
				if (err?.message === "目标已存在") throw err;
			} // 不存在 → 继续
			await fs.mkdir(path.dirname(destAbs), { recursive: true });
			if (move) await fs.rename(srcAbs, destAbs);
			else await fs.cp(srcAbs, destAbs, { recursive: true, errorOnExist: true, force: false });
		}

		const MAX_SEARCH_RESULTS = 50;

		/** 本地文件名搜索（大小写不敏感子串；忽略目录/深度口径与 flatList 一致）。
		 *  返回 [{ path, type }]，path 为工作区相对路径（/ 分隔）。 */
		async function searchLocal(query, baseRel) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) throw new Error("搜索关键词不能为空");
			const baseAbs = safeResolve(baseRel ?? "");
			if (!baseAbs) throw new Error("路径越界");
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

		/** 远端文件名搜索（SFTP 递归；50 条封顶）。baseDir 必须绝对路径。 */
		async function searchRemote(c, query, baseDir) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) throw new Error("搜索关键词不能为空");
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

		// ---- PTY shell 与 exec ---------------------------------------------------
		function sshOpenShell(c, msg, reqId, clientId) {
			c.ownerId = clientId; // 重连/多标签后：最新请求者接管该连接的终端输出流
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

		// ------------------------------------------------------------------
		// 上传：本地工作区 / 远端 SFTP 共用同一分片协议
		//
		// 协议：upload_begin（校验目标 + 报 exists 供覆盖确认）→ 逐片 upload
		//（base64 分片，顺序校验）→ 末片收尾落盘。本地分片写入目标目录下的
		// 临时文件、末片 rename 原子落位（与 writeFile 同语义，防半截内容）；
		// 远端分片暂存内存、末片一次性 sftp.writeFile（大小上限同下载）。
		// 会话按 clientId:uploadId 隔离；客户端报错/超时残留由 upload_abort
		// 与定时清扫兜底。文件逐个上传、由客户端保证顺序。
		// ------------------------------------------------------------------
		const uploads = new Map(); // `${clientId}:${uploadId}` → 上传会话

		function sweepUploads() {
			const now = Date.now();
			for (const [, u] of uploads) {
				if (now - u.last > UPLOAD_STALE_MS) void abortUploadEntry(u);
			}
		}

		/** 中止并清理一个上传会话（关句柄 / 删临时文件 / 丢弃内存分片）。
		 *  返回 Promise：Windows 上句柄还没关就 unlink 会 EBUSY/EPERM，
		 *  旧写法 void close() 后立即 unlink 并把错误吞掉，`.part` 就残留在目标目录里
		 *  （upload_abort 之后客户端会立刻核验目录，必须在返回响应前删干净）。 */
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

		/** 开局：校验目标目录/文件名/大小，探测目标是否存在（供客户端覆盖确认）；
		 *  本地提前打开临时文件句柄（分片顺序追加），远端校验路径合法。 */
		async function beginUpload(clientId, msg) {
			const name = String(msg.name ?? "");
			if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
				throw new Error("非法文件名");
			}
			const size = Number(msg.size);
			if (!Number.isFinite(size) || size <= 0) throw new Error("非法文件大小");
			if (size > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
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
			if (!absDir) throw new Error("路径越界");
			const finalAbs = path.join(absDir, name);
			let exists = false;
			try {
				exists = (await fs.stat(finalAbs)).isFile();
			} catch {}
			await fs.mkdir(absDir, { recursive: true });
			const tmp = path.join(absDir, `.vsc-upload-${uploadId}.part`);
			const fh = await fs.open(tmp, "w"); // 句柄保持打开，分片顺序追加
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

		/** 接收一片；非末片返回 {received}，末片落盘/传输并结束会话返回 {done, size} */
		async function chunkUpload(clientId, msg) {
			const u = uploads.get(`${clientId}:${msg.uploadId}`);
			if (!u) throw new Error("上传会话不存在或已超时，请重新上传");
			if (Number(msg.i) !== u.next) throw new Error("分片乱序");
			u.last = Date.now();
			sweepUploads();
			const buf = Buffer.from(String(msg.b64 ?? ""), "base64");
			if (!buf.length) throw new Error("空分片");
			u.bytes += buf.length;
			if (u.bytes > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
			if (u.scope === "local") await u.fh.write(buf, 0, buf.length, null);
			else u.bufs.push(buf);
			if (Number(msg.i) !== Number(msg.total) - 1) {
				u.next++;
				return { received: u.next };
			}
			// 末片：收尾落盘，会话结束
			if (u.scope === "local") {
				await u.fh.close().catch(() => {});
				u.fh = null;
				await fs.rename(u.tmp, u.finalAbs); // 原子取代（含覆盖既有文件）
			} else {
				const sftp = await getSftp(getSshConn(u.connId));
				await mkdirpRemote(sftp, u.rpath.split("/").slice(0, -1).join("/")); // 目标目录不存在则自动创建（与本地同语义）
				await sftpCall(sftp, "writeFile", u.rpath, Buffer.concat(u.bufs, u.bytes));
			}
			uploads.delete(u.key);
			return { done: true, size: u.bytes };
		}

		/** 新建/更新 SSH 主机（UI 的 hosts_save 与 AI 的 vsc_ssh_save 共用，规则唯一）。
		 *  更新：缺席字段沿用旧值，凭据传显式 null = 清除；新建：host 必填，
		 *  密码/私钥/私钥路径/agent 四选一。返回主机 id。 */
		async function upsertSshHost(h) {
			await ensureSshCfgs();
			h = h && typeof h === "object" ? h : {};
			if (!h.host || !String(h.host).trim()) throw new Error("主机地址不能为空");
			let id;
			if (h.id) {
				const i = sshCfgs.hosts.findIndex((x) => x.id === h.id);
				if (i < 0) throw new Error("主机不存在");
				const old = sshCfgs.hosts[i];
				// 凭据进机密库：留空 = 沿用旧值；显式 null = 清除（同步删机密）；
				// 内存对象仍保留真实凭据供连接使用，脱敏在 publicSshHost 层
				storeHostSecret(h.id, "password", h.password === null ? null : h.password || undefined);
				storeHostSecret(h.id, "privateKey", h.privateKey === null ? null : h.privateKey || undefined);
				storeHostSecret(h.id, "passphrase", h.passphrase === null ? null : h.passphrase || undefined);
				sshCfgs.hosts[i] = {
					...old,
					name: h.name ?? old.name,
					host: String(h.host).trim() || old.host,
					port: Number(h.port) || old.port,
					username: h.username ?? old.username,
					// 凭据留空 = 沿用旧值；显式 null = 清除
					password: h.password === null ? undefined : h.password || old.password,
					privateKey: h.privateKey === null ? undefined : h.privateKey || old.privateKey,
					passphrase: h.passphrase === null ? undefined : h.passphrase || old.passphrase,
					// 路径/agent 非密文：字段缺席 = 沿用旧值；空串 = 清除
					privateKeyPath:
						h.privateKeyPath !== undefined
							? String(h.privateKeyPath || "").trim() || undefined
							: (old.privateKeyPath ?? undefined),
					agent: h.agent !== undefined ? String(h.agent || "") || undefined : (old.agent ?? undefined),
				};
				id = h.id;
			} else {
				if (!h.password && !h.privateKey && !h.privateKeyPath && !h.agent)
					throw new Error("请填写密码、私钥（可填私钥路径）或 agent");
				if (sshCfgs.hosts.length >= MAX_SSH_HOSTS) throw new Error(`最多保存 ${MAX_SSH_HOSTS} 台主机`);
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
			try {
				switch (action) {
					case "list": // 单层目录（文件树惰性展开）；带 connId = 远程目录
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
						// 下载到用户电脑：本地直读；带 connId 走远端 SFTP，文件夹用 tar.gz 打包
						if (!msg.connId) {
							const abs = safeResolve(String(msg.path ?? ""));
							if (!abs || abs === root) throw new Error("非法路径");
							const st = await fs.stat(abs);
							if (!st.isFile()) throw new Error("不是普通文件");
							if (st.size > MAX_DOWNLOAD_BYTES)
								throw new Error(`文件超过 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB 上限`);
							const buf = await fs.readFile(abs);
							host.sendTo(clientId, { res: true, reqId, ok: true, action, b64: buf.toString("base64"), size: st.size });
							break;
						}
						// 远端范围
						const c = getSshConn(msg.connId);
						const p = safeRemotePath(msg.path);
						const sftp = await getSftp(c);
						let st;
						try {
							st = await sftpCall(sftp, "stat", p);
						} catch {
							throw new Error("路径不存在");
						}
						if (st.isDirectory()) {
							// 文件夹：在远端就地打包（tar.gz），避免逐文件传输
							const clean = p.replace(/\/+$/, "");
							const name = clean.split("/").pop();
							const parent = clean.split("/").slice(0, -1).join("/") || "/";
							const buf = await sshExecBuffer(c, `cd ${shQuote(parent)} && tar -czf - ${shQuote(name)}`);
							if (!buf.length) throw new Error("打包失败（远端无 tar 或目录不可读）");
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
								throw new Error(`文件超过 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB 上限`);
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
					case "read": {
						const r = msg.connId
							? await remoteRead(getSshConn(msg.connId), String(msg.path ?? ""))
							: await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write":
						if (msg.connId) await remoteWrite(getSshConn(msg.connId), String(msg.path ?? ""), msg.text);
						else await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path });
						break;
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
						// 复制/移动/创建副本：本地与远端 SFTP 共用（dest 已存在则拒绝）
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
						// 文件名搜索（大小写不敏感子串；本地 base 相对路径，远端 baseDir 绝对路径）
						const r = msg.connId
							? await searchRemote(getSshConn(msg.connId), msg.query, msg.baseDir ?? msg.base ?? "/")
							: await searchLocal(msg.query, msg.base ?? msg.baseDir ?? "");
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...r });
						break;
					}
					case "upload_begin": {
						// 开局：报 exists（覆盖确认用）+ 创建会话
						const st = await beginUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload": {
						// 分片；末片（i === total-1）落盘/传输并结束会话
						const st = await chunkUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload_abort": {
						// 中止会话（客户端遇到错误/用户取消覆盖时清理临时文件）
						const u = uploads.get(`${clientId}:${msg.uploadId}`);
						if (u) await abortUploadEntry(u);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "sync_get": {
						// 注意：不要与远程 SFTP 操作混用（远程走 list/read + connId）
						const cfg = await readSyncCfg();
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							config: publicSync(cfg),
							configPath: ".vscode/sftp.json", // 前端「编辑配置文件」入口
						});
					}
					case "sync_save": {
						const next = await upsertSyncCfg(msg.config);
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							config: publicSync(next),
							configPath: ".vscode/sftp.json",
						});
					}
					case "sync_ensure": {
						// 「编辑配置文件」：确保存在（必要时写模板/迁移），返回相对路径
						let cfg = await readSyncCfg();
						if (!cfg.host) {
							cfg = normalizeCfg({ host: "", remoteRoot: "/", ignore: [".git", "node_modules"] });
							await saveSyncCfg(cfg);
						}
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							path: ".vscode/sftp.json",
							configPath: ".vscode/sftp.json",
						});
					}
					case "sync_test": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("尚未配置同步——请先点 ☁ → 同步配置或编辑 .vscode/sftp.json");
						const sftp = await getSyncSftp(cfg);
						// 探测远端根目录可达
						await sftpCall(sftp, "readdir", cfg.remoteRoot || "/");
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action });
					}
					case "sync_run": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("尚未配置同步——请先点 ☁ → 同步配置或编辑 .vscode/sftp.json");
						const direction = msg.dir === "down" ? "down" : "up";
						const scope = ["file", "tree", "all"].includes(msg.scope) ? msg.scope : "file";
						if (scope === "file") {
							const abs = safeResolve(msg.path);
							if (!abs || abs === root) throw new Error("非法路径");
						}
						const summary = await runSyncTransfer(cfg, direction, scope, msg.path ?? "", (done, total, name) =>
							host.sendTo(clientId, { event: "sync_progress", done, total, name }),
						);
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							...summary,
							dir: direction,
							scope,
						});
					}
					// ----------------------------------------------------------------
					// SSH 远程主机管理
					// ----------------------------------------------------------------
					case "state": // 插件状态：主机列表 / config 自动加载 / 连接列表 / ssh2 依赖状态（脱敏）
						await ensureSshCfgs();
						await refreshSshConfigCache(); // 与 VSCode 同源：每次拉 state 都重读 ~/.ssh/config（含 Include）
						host.sendTo(clientId, { res: true, reqId, ok: true, action, state: publicSshState() });
						break;
					case "deps_install":
						ensureSshMod(); // 内部幂等，已在装则等待，装完广播 state
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "hosts_save": {
						const id = await upsertSshHost(msg.host);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, id });
						break;
					}
					case "sshconfig_list": {
						// 解析 ~/.ssh/config，候选主机（已导入的标 imported）
						const list = await readSshConfigCandidates();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, hosts: list });
						break;
					}
					case "config_connect": {
						// config 别名直连（免导入，与 VSCode Remote-SSH 同源）
						if (!msg.alias) throw new Error("缺少 alias");
						void connectConfigAlias(String(msg.alias), clientId, reqId); // ready/error 异步回复
						return;
					}
					case "sshconfig_get": {
						// 读 ~/.ssh/config 原文（前端弹层编辑用）
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
						// 存 ~/.ssh/config 原文（自动备份 .bak + 刷新自动加载）
						await writeSshConfigRaw(msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "sshconfig_import": {
						// 批量导入：凭据存 privateKeyPath 引用，不读私钥内容
						await ensureSshCfgs();
						const aliases = Array.isArray(msg.aliases) ? msg.aliases.map(String) : [];
						if (!aliases.length) throw new Error("请先勾选要导入的主机");
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
								throw new Error(`最多保存 ${MAX_SSH_HOSTS} 台主机（已导入 ${added} 台）`);
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
						if (sshCfgs.hosts.length === before) throw new Error("主机不存在");
						await saveSshCfgs();
						for (const c of [...sshConns.values()]) if (c.hostId === msg.id) dropSshConn(c, "主机已删除");
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "connect": {
						await ensureSshCfgs();
						const cfg = sshCfgs.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("主机不存在");
						void connectSshHost(cfg, clientId, reqId); // ready/error 异步回复，内部已兑底报错
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
					case "shell_input": // 无 reqId 的流式通道：失败静默，不占响应协议
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
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err)));
			}
		});

		host.log(`activated; workspace root: ${toWire(root)}`);
		// 新客户端接入时主动推送完整状态（服务端唯一事实源，对齐主应用快照架构）。
		// host.onAttach 在旧版宿主（<0.35）上不存在——可选链兼容，客户端仍有
		// 带 reqId 的拉取兑底。
		const offAttach = host.onAttach?.((clientId) => {
			void ensureSshCfgs()
				.then(() => refreshSshConfigCache())
				.then(() => {
					host.sendTo(clientId, { kind: "state", state: publicSshState() });
				});
		});
		// 工作区实时跟随主应用 set_cwd：根变了 → 旧项目的同步连接作废
		//（.vscode/sftp.json 每项目独立）、广播通知前端清缓存重建树。
		const offCwd = host.onCwdChange?.((next) => {
			root = path.resolve(next);
			for (const [, c] of syncConns) {
				try {
					c.client.end();
				} catch {}
			}
			syncConns.clear();
			host.broadcast({ kind: "workspace", root: toWire(root) });
			host.log(`workspace root switched: ${toWire(root)}`);
		});
		// ------------------------------------------------------------------
		// AI 工具（host.registerAgentTool）：模型自主配置 SFTP/SSH、上传代码、
		// 操作远端文件的无头入口。UI 的表单/按钮与这些工具共用同一套
		// upsert*/dial*/remote* 后端，规则唯一。返回给 LLM 的都是短文本。
		// ------------------------------------------------------------------

		/** AI 用的拨号：与 UI 的 connectSshHost 同参数规则，成功 resolve 连接记录。
		 *  ownerId 留空——无头调用没有浏览器，conn_closed 等推送经 sendTo 空转丢弃。 */
		/** AI 用的 config 别名直连（Promise 化，与 dialSshHost 同返回）。 */
		async function dialConfigAlias(alias) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 依赖未就绪，稍候再试");
			const candidate = await resolveConfigAlias(alias);
			const { keys, agentSock } = await buildConfigAuth(candidate);
			if (!keys.length && !agentSock)
				throw new Error(`主机「${alias}」没有可用认证（config 未配 IdentityFile，本机也无默认私钥/ssh-agent）`);
			const connId = `c${nextSshConn++}`;
			const c = {
				connId,
				client: new mod.Client(),
				ownerId: "",
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
				const via = await dialViaJumps(mod, hops, candidate.host, candidate.port);
				opts.sock = via.sock;
				c.jumps.push(...via.jumps);
			}
			try {
				await new Promise((resolve, reject) => {
					c.client.on("ready", () => {
						c.status = "connected";
						resolve();
					});
					c.client.on("error", (err) => {
						if (c.status === "connecting") reject(err);
					});
					c.client.on("close", () => {
						if (c.status === "connecting") reject(new Error("连接已关闭"));
						else dropSshConn(c, "连接已关闭");
					});
					c.client.connect(opts);
				});
			} catch (err) {
				sshConns.delete(connId);
				try {
					c.client.end();
				} catch {}
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
				const m = err?.level ? `[${err.level}] ${err.message}` : (err?.message ?? String(err));
				throw new Error(m);
			}
			broadcastSshState();
			return c;
		}

		async function dialSshHost(cfg) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 依赖未就绪，稍候再试");
			const opts = await buildSshOpts(cfg);
			const connId = `c${nextSshConn++}`;
			const c = {
				connId,
				client: new mod.Client(),
				ownerId: "",
				hostId: cfg.id ?? null,
				label: cfg.name || `${cfg.username}@${cfg.host}`,
				status: "connecting",
				streams: new Map(),
				nextShell: 1,
				sftp: null,
			};
			sshConns.set(connId, c);
			broadcastSshState();
			try {
				await new Promise((resolve, reject) => {
					c.client.on("ready", () => {
						c.status = "connected";
						resolve();
					});
					c.client.on("error", (err) => {
						if (c.status === "connecting") reject(err); // 连接后错误走 close 统一清理
					});
					c.client.on("close", () => {
						if (c.status === "connecting") reject(new Error("连接已关闭"));
						else dropSshConn(c, "连接已关闭");
					});
					c.client.connect(opts);
				});
			} catch (err) {
				// 首连失败不留半连接
				sshConns.delete(connId);
				try {
					c.client.end();
				} catch {}
				broadcastSshState();
				const m = err?.level ? `[${err.level}] ${err.message}` : (err?.message ?? String(err));
				throw new Error(m);
			}
			broadcastSshState();
			return c;
		}

		/** AI 用的 exec：复用 sshExec 的输出截断口径，Promise 化。 */
		function execSshAsync(c, cmd) {
			return new Promise((resolve, reject) => {
				c.client.exec(String(cmd ?? ""), (err, stream) => {
					if (err) return reject(err);
					const chunks = [];
					stream.on("data", (d) => chunks.push(d.toString("utf8")));
					stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
					stream.on("close", (code) => {
						let out = chunks.join("");
						if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + "\n…[截断]";
						resolve({ exitCode: code ?? 0, output: out });
					});
				});
			});
		}

		function fmtSize(n) {
			n = Number(n) || 0;
			if (n < 1024) return `${n}B`;
			if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
			return `${(n / 1048576).toFixed(1)}MB`;
		}

		const CONN_ID_PROP = {
			connId: {
				type: "string",
				description: "SSH connection id (returned by vsc_ssh_connect; see vsc_ssh_hosts for existing ones)",
			},
		};
		const REMOTE_PATH_PROP = {
			path: { type: "string", description: "Remote absolute path (starts with /, e.g. /var/www/app)" },
		};

		const AI_TOOLS = [
			{
				name: "vsc_sftp_get",
				label: "读取 SFTP 同步配置",
				description:
					"Read the current workspace's SFTP sync config (.vscode/sftp.json; credentials redacted: only whether a password/private key exists is returned, never plaintext). Call it before uploading code to confirm the config exists.",
				promptGuidelines: [
					"To transfer code to a server or operate on SSH remote files, prefer the vscode-editor plugin's vsc_sftp_* / vsc_ssh_* / vsc_remote_* tools instead of hand-crafting scp/sftp commands",
				],
				parameters: { type: "object", properties: {} },
				execute: async () => {
					const cfg = await readSyncCfg();
					const pub = publicSync(cfg);
					if (!pub.configured)
						return "尚未配置 SFTP 同步（.vscode/sftp.json 为空）。用 vsc_sftp_save 新建配置，或把现成的 sftp.json 拷进工作区 .vscode/ 目录。";
					return `SFTP 已配置（.vscode/sftp.json）：${pub.username}@${pub.host}:${pub.port}，远端根 ${pub.remoteRoot}，保存自动上传 ${pub.uploadOnSave ? "开" : "关"}，排除 ${pub.exclude.length ? pub.exclude.join(", ") : "无"}，凭据：${[pub.hasPass && "密码", pub.hasKey && "私钥", pub.hasAgent && "agent"].filter(Boolean).join("/") || "无"}`;
				},
			},
			{
				name: "vsc_sftp_save",
				label: "保存 SFTP 同步配置",
				description:
					"Create or update the current workspace's SFTP sync config (writes .vscode/sftp.json, compatible with the VS Code vscode-sftp plugin format). Omitted fields keep old values; pass null to password/privateKey/passphrase to clear them. At least one of password/privateKeyPath/agent must be valid. After saving, test with vsc_sftp_test and upload code with vsc_sftp_sync.",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string", description: "Config alias (optional)" },
						host: { type: "string", description: "Remote host address (required)" },
						port: { type: "number", description: "SSH port (default 22)" },
						username: { type: "string", description: "Username (default root)" },
						password: { type: ["string", "null"], description: "Password; null clears it" },
						privateKey: { type: ["string", "null"], description: "Private key PEM content; null clears it" },
						privateKeyPath: {
							type: "string",
							description:
								"Private key path (~ expansion supported, e.g. ~/.ssh/id_rsa); takes precedence over privateKey",
						},
						passphrase: { type: ["string", "null"], description: "Private key passphrase; null clears it" },
						agent: { type: "string", description: "ssh-agent socket (e.g. $SSH_AUTH_SOCK)" },
						remotePath: { type: "string", description: "Remote root directory (absolute path, e.g. /var/www/app)" },
						ignore: {
							type: "array",
							items: { type: "string" },
							description: "Exclude globs (e.g. .git, node_modules, *.map)",
						},
						uploadOnSave: { type: "boolean", description: "Auto-upload on file save" },
					},
					required: ["host"],
				},
				execute: async (_id, p) => {
					const next = await upsertSyncCfg({
						name: p.name,
						host: p.host,
						port: p.port,
						username: p.username,
						password: p.password,
						privateKey: p.privateKey,
						privateKeyPath: p.privateKeyPath,
						passphrase: p.passphrase,
						agent: p.agent,
						remoteRoot: p.remotePath ?? p.remoteRoot,
						exclude: p.ignore ?? p.exclude,
						uploadOnSave: p.uploadOnSave,
					});
					return `SFTP 配置已保存：${next.username}@${next.host}:${next.port}，远端根 ${next.remoteRoot}。下一步用 vsc_sftp_test 测试连接。`;
				},
			},
			{
				name: "vsc_sftp_test",
				label: "测试 SFTP 连接",
				description:
					"Connect to the remote using the current SFTP sync config and probe whether the remote root is reachable. Call it right after saving the config or when an upload fails.",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					const cfg = await readSyncCfg();
					if (!cfg?.host) throw new Error("尚未配置 SFTP 同步（先用 vsc_sftp_save 配置）");
					const sftp = await getSyncSftp(cfg);
					await sftpCall(sftp, "readdir", cfg.remoteRoot || "/");
					return `连接成功：${cfg.username}@${cfg.host}:${cfg.port}，远端根 ${cfg.remoteRoot} 可达。`;
				},
			},
			{
				name: "vsc_sftp_sync",
				label: "SFTP 上传/下载代码",
				description:
					"Sync files between the local workspace and the SFTP remote root. direction=up is local→remote (upload/publish code), down is remote→local; scope=file is a single file (path required), tree a subtree, all the whole repo. Exclusion rules come from the config's ignore.",
				parameters: {
					type: "object",
					properties: {
						direction: { type: "string", enum: ["up", "down"], description: "up uploads (default), down downloads" },
						scope: { type: "string", enum: ["file", "tree", "all"], description: "file single file (default all)" },
						path: {
							type: "string",
							description: "Local relative path when scope=file; subtree relative path when tree",
						},
					},
				},
				execute: async (_id, p) => {
					const cfg = await readSyncCfg();
					if (!cfg?.host)
						throw new Error("尚未配置 SFTP 同步（先用 vsc_sftp_save 配置，或把 sftp.json 拷到 .vscode/）");
					const direction = p.direction === "down" ? "down" : "up";
					const scope = ["file", "tree", "all"].includes(p.scope) ? p.scope : "all";
					const target = String(p.path ?? "");
					if (scope === "file") {
						const abs = safeResolve(target);
						if (!abs || abs === root) throw new Error("非法路径");
					}
					const summary = await runSyncTransfer(cfg, direction, scope, target, () => {});
					const fails = summary.failed.map((f) => `${f.rel}：${f.error}`).join("\n");
					return `同步完成（${direction === "up" ? "本地→远端" : "远端→本地"}，范围 ${scope}）：共 ${summary.total} 个文件${summary.failed.length ? `，失败 ${summary.failed.length} 个：\n${fails}` : "，全部成功"}`;
				},
			},
			{
				name: "vsc_ssh_hosts",
				label: "列出 SSH 主机",
				description:
					"List saved SSH hosts (credentials redacted), hosts auto-loaded from ~/.ssh/config (same source as VS Code Remote-SSH, connect directly without import), and current live connections (with connId).",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					await ensureSshCfgs();
					await refreshSshConfigCache();
					const st = publicSshState();
					const lines = [];
					if (!st.hosts.length) lines.push("尚未保存任何 SSH 主机（用 vsc_ssh_save 新建）。");
					for (const h of st.hosts) {
						const conn = st.conns.find((c) => c.hostId === h.id);
						lines.push(
							`- ${h.name}（id=${h.id}）：${h.username}@${h.host}:${h.port}，凭据：${[h.hasPass && "密码", h.hasKey && "私钥", h.agent && `agent(${h.agent})`].filter(Boolean).join("/") || "无"}${conn ? `，【已连接 connId=${conn.connId}】` : ""}`,
						);
					}
					if (st.configHosts?.length) {
						lines.push(
							`~/.ssh/config 自动加载（${st.configHosts.length} 台，与 VSCode 同源，vsc_ssh_connect 传 alias 直连）：`,
						);
						for (const c of st.configHosts) {
							lines.push(
								`- ${c.alias}：${c.username}@${c.host}:${c.port}${c.proxyJump ? `（经跳板 ${c.proxyJump}）` : ""}${c.proxyCommand ? "（ProxyCommand）" : ""}`,
							);
						}
					}
					for (const c of st.conns) {
						if (!st.hosts.some((h) => h.id === c.hostId)) lines.push(`- 临时连接 connId=${c.connId}（${c.label}）`);
					}
					return lines.join("\n");
				},
			},
			{
				name: "vsc_ssh_save",
				label: "保存 SSH 主机",
				description:
					"Create or update an SSH host (written to ssh-hosts.json in the plugin directory; passwords/private keys go into encrypted storage). On update, omitted fields keep old values and passing null clears a credential; on create, host is required plus exactly one of password/privateKey/privateKeyPath/agent. Returns the host id, then connect with vsc_ssh_connect.",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "Host id (fill in to update; omit to create)" },
						name: { type: "string", description: "Alias (defaults to host)" },
						host: { type: "string", description: "Host address (required on create)" },
						port: { type: "number", description: "Port (default 22)" },
						username: { type: "string", description: "Username (default root)" },
						password: { type: ["string", "null"], description: "Password; null clears it" },
						privateKey: { type: ["string", "null"], description: "Private key PEM content; null clears it" },
						privateKeyPath: {
							type: "string",
							description: "Private key path (~ expansion supported); takes precedence over privateKey",
						},
						passphrase: { type: ["string", "null"], description: "Private key passphrase; null clears it" },
						agent: { type: "string", description: "ssh-agent socket (e.g. $SSH_AUTH_SOCK)" },
					},
				},
				execute: async (_id, p) => {
					const isNew = !p.id;
					const id = await upsertSshHost({ ...p });
					return `${isNew ? "已新建" : "已更新"} SSH 主机（id=${id}）。用 vsc_ssh_connect 连接它。`;
				},
			},
			{
				name: "vsc_ssh_connect",
				label: "连接 SSH 主机",
				description:
					"Open an SSH connection and return connId (used by all later vsc_ssh_exec / vsc_remote_* calls). id = a manually saved host; alias = a host alias from ~/.ssh/config (same name as VS Code Remote-SSH, connects directly without import). For an already-connected host, reuse its connId from vsc_ssh_hosts.",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "Host id (returned by vsc_ssh_hosts / vsc_ssh_save)" },
						alias: { type: "string", description: "Host alias from ~/.ssh/config (same name as on the VS Code side)" },
					},
				},
				execute: async (_id, p) => {
					if (p.alias) {
						const c = await dialConfigAlias(String(p.alias));
						return `已连接 ${c.label}（connId=${c.connId}）。远端文件操作与命令都用这个 connId。`;
					}
					await ensureSshCfgs();
					const cfg = sshCfgs.hosts.find((x) => x.id === String(p.id ?? ""));
					if (!cfg) throw new Error("主机不存在（用 vsc_ssh_hosts 查看；config 别名改传 alias 参数）");
					const c = await dialSshHost(cfg);
					return `已连接 ${c.label}（connId=${c.connId}）。远端文件操作与命令都用这个 connId。`;
				},
			},
			{
				name: "vsc_ssh_disconnect",
				label: "断开 SSH 连接",
				description: "Close an SSH connection (close it as soon as you are done to avoid idle occupation).",
				parameters: { type: "object", properties: { ...CONN_ID_PROP }, required: ["connId"] },
				execute: async (_id, p) => {
					dropSshConn(getSshConn(String(p.connId ?? "")), "AI 主动断开");
					return `已断开 ${p.connId}。`;
				},
			},
			{
				name: "vsc_ssh_exec",
				label: "远端执行命令",
				description:
					"Run one shell command on an SSH connection (view logs, restart services, extract archives, etc.); returns exitCode and output (truncated when too long). Commands needing interactivity (vim/top) are not supported.",
				parameters: {
					type: "object",
					properties: { ...CONN_ID_PROP, cmd: { type: "string", description: "Shell command" } },
					required: ["connId", "cmd"],
				},
				execute: async (_id, p) => {
					const cmd = String(p.cmd ?? "").trim();
					if (!cmd) throw new Error("cmd 不能为空");
					const r = await execSshAsync(getSshConn(String(p.connId ?? "")), cmd);
					return `exitCode: ${r.exitCode}\n${r.output || "（无输出）"}`;
				},
			},
			{
				name: "vsc_remote_list",
				label: "列远端目录",
				description:
					"List the entries (subdirectories/files/sizes) of a directory on the SSH remote. Use it to browse the remote or locate upload targets.",
				parameters: {
					type: "object",
					properties: { ...CONN_ID_PROP, dir: { type: "string", description: "Remote absolute path (default /)" } },
					required: ["connId"],
				},
				execute: async (_id, p) => {
					const dir = safeRemotePath(String(p.dir ?? "/"));
					const entries = await remoteList(getSshConn(String(p.connId ?? "")), dir);
					if (!entries.length) return `${dir} 为空。`;
					return [
						`${dir}（${entries.length} 项）：`,
						...entries.map(
							(e) =>
								`${e.type === "dir" ? "📁" : e.type === "link" ? "🔗" : "📄"} ${e.name}${e.type === "file" ? `（${fmtSize(e.size)}）` : ""}`,
						),
					].join("\n");
				},
			},
			{
				name: "vsc_remote_read",
				label: "读远端文件",
				description:
					"Read a text file on the SSH remote (2MB cap, truncated when too long; binary files report size only).",
				parameters: {
					type: "object",
					properties: { ...CONN_ID_PROP, ...REMOTE_PATH_PROP },
					required: ["connId", "path"],
				},
				execute: async (_id, p) => {
					const r = await remoteRead(getSshConn(String(p.connId ?? "")), safeRemotePath(String(p.path ?? "")));
					if (r.binary) return `二进制文件（${fmtSize(r.size)}），无法显示文本。`;
					const cap = 20000;
					return r.text.length > cap ? r.text.slice(0, cap) + `\n…[截断，共 ${r.text.length} 字符]` : r.text;
				},
			},
			{
				name: "vsc_remote_write",
				label: "写远端文件",
				description:
					"Write a text file to the SSH remote (parent directories auto-created, overwrites directly). Write small files directly; for large code releases prefer uploading with vsc_sftp_sync first.",
				parameters: {
					type: "object",
					properties: {
						...CONN_ID_PROP,
						...REMOTE_PATH_PROP,
						text: { type: "string", description: "Full file content" },
					},
					required: ["connId", "path", "text"],
				},
				execute: async (_id, p) => {
					await remoteWrite(
						getSshConn(String(p.connId ?? "")),
						safeRemotePath(String(p.path ?? "")),
						String(p.text ?? ""),
					);
					return `已写入 ${p.path}。`;
				},
			},
			{
				name: "vsc_remote_copy",
				label: "远端复制/移动",
				description:
					"Copy or move files/directories within the same SSH remote (move=true moves/renames, use it for cross-directory rename; rejected if dest already exists).",
				parameters: {
					type: "object",
					properties: {
						...CONN_ID_PROP,
						src: { type: "string", description: "Source absolute path" },
						dest: { type: "string", description: "Destination absolute path (including the new file name)" },
						move: { type: "boolean", description: "true = move (default copy)" },
					},
					required: ["connId", "src", "dest"],
				},
				execute: async (_id, p) => {
					await remoteCopy(
						getSshConn(String(p.connId ?? "")),
						String(p.src ?? ""),
						String(p.dest ?? ""),
						p.move === true,
					);
					return `${p.move === true ? "已移动" : "已复制"}：${p.src} → ${p.dest}。`;
				},
			},
			{
				name: "vsc_remote_delete",
				label: "删除远端文件",
				description:
					"Delete a file or directory on the SSH remote (directories are deleted recursively, including non-empty ones; irreversible).",
				parameters: {
					type: "object",
					properties: { ...CONN_ID_PROP, ...REMOTE_PATH_PROP },
					required: ["connId", "path"],
				},
				execute: async (_id, p) => {
					const c = getSshConn(String(p.connId ?? ""));
					const rp = safeRemotePath(String(p.path ?? ""));
					if (rp === "/") throw new Error("拒绝删除远端根目录");
					let isDir = false;
					try {
						isDir = (await sftpCall(await getSftp(c), "stat", rp)).isDirectory();
					} catch {
						throw new Error("路径不存在");
					}
					await remoteDelete(c, rp, isDir);
					return `已删除 ${rp}。`;
				},
			},
			{
				name: "vsc_remote_search",
				label: "搜索远端文件",
				description:
					"Recursively search the SSH remote by file name (case-insensitive substring, capped at 50 results). baseDir defaults to /; narrow it down for large directories.",
				parameters: {
					type: "object",
					properties: {
						...CONN_ID_PROP,
						query: { type: "string", description: "Keyword" },
						baseDir: { type: "string", description: "Starting directory (default /)" },
					},
					required: ["connId", "query"],
				},
				execute: async (_id, p) => {
					const r = await searchRemote(
						getSshConn(String(p.connId ?? "")),
						String(p.query ?? ""),
						String(p.baseDir ?? "/"),
					);
					if (!r.results.length) return `无匹配：${p.query}。`;
					return [
						`匹配 ${r.results.length} 项${r.truncated ? "（已截断，只显示前 50）" : ""}：`,
						...r.results.map((x) => `${x.type === "dir" ? "📁" : "📄"} ${x.path}`),
					].join("\n");
				},
			},
		];
		const aiToolOffs = AI_TOOLS.map((t) => host.registerAgentTool(t));
		host.log(`AI 工具已注册 ${aiToolOffs.length} 个（vsc_sftp_*/vsc_ssh_*/vsc_remote_*）`);

		void ensureSshCfgs()
			.then(() => refreshSshConfigCache())
			.then(() => ensureSshMod()); // 预热：迁移旧配置 + 重读 ~/.ssh/config + 预载 ssh2
		return () => {
			off();
			for (const u of aiToolOffs) {
				try {
					u();
				} catch {}
			}
			try {
				offAttach?.();
			} catch {}
			try {
				offCwd?.();
			} catch {}
			for (const [, c] of syncConns) {
				try {
					c.client.end();
				} catch {}
			}
			syncConns.clear();
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

// 说明：host.cwd 是活的（跟随主应用 set_cwd，旧版宿主仍是启动时快照），
// 编辑器以它为工作区根 —— onCwdChange 触发时切根、作废旧同步连接并广播前端。
