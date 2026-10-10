/**
 * 内嵌 SSH mock 远端 —— 用 ssh2 自带的 Server 在进程内起一个假 SSH 服务。
 *
 * 供编辑器插件（vscode-editor，含 Remote-SSH）的协议/UI 测试使用（零外部依赖、离线可跑）：
 * - 认证：用户名 tester / 密码 secret123，其余拒绝
 * - shell：欢迎横幅 welcome-to-mock + 按行回显（输入 foo\r → echo:foo）
 * - exec：
 *     echo xxx   → 输出 xxx、退出码 0
 *     fail*      → stderr "boom"、退出码 7
 *     pwd        → /home/test
 * - sftp：内存文件系统（见 dirs/files 导出），支持 REALPATH/STAT/OPENDIR/
 *   READDIR/OPEN/READ/WRITE/CLOSE/MKDIR/REMOVE/RMDIR/RENAME
 */
import { join } from "node:path";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const SFTP = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 };

/** ssh2 运行时依赖子集（离线拷贝用；cpu-features/nan 可选，缺省走纯 JS） */
const SSH2_PKGS = ["ssh2", "asn1", "bcrypt-pbkdf", "safer-buffer", "tweetnacl"];

/**
 * 给临时插件目录准备 ssh2 依赖：
 * 1. 离线优先——从本地构建目录（plugins/vscode-editor/node_modules）拷贝；
 * 2. 本地没有（如 CI）→ 回退 npm install（需要网络）。
 */
export function ensurePluginSsh2Dep(plugDst, devPlugDir) {
	for (const pkg of SSH2_PKGS) {
		const src = join(devPlugDir, "node_modules", pkg);
		if (existsSync(src)) {
			cpSync(src, join(plugDst, "node_modules", pkg), { recursive: true });
		}
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		console.log("[mock-ssh] 本地无 ssh2 依赖，回退 npm install…");
		// 临时目录算 project-scoped 安装（--prefix），而 `npm run test:smoke` 会把
		// npm_config_* 注入子进程 env：其中的 allow-scripts 在 project-scoped 安装里是
		// 硬报错 EALLOWSCRIPTS，于是本测试在冒烟聚合（经 npm run 启动）下假失败、单跑
		// 又正常。两手都做：① 项目级 .npmrc 按 npm 官方指引声明 allowScripts；
		// ② 抹掉继承来的 npm_config_* / NPM_CONFIG_*，让这次安装与调用者的 npm 上下文无关。
		writeFileSync(join(plugDst, ".npmrc"), "allow-scripts=ssh2,cpu-features\naudit=false\nfund=false\n");
		const env = { ...process.env };
		for (const k of Object.keys(env)) {
			if (/^npm_?config_/i.test(k)) delete env[k];
		}
		execFileSync("npm", ["install", "--prefix", plugDst, "ssh2@latest", "--no-audit", "--no-fund"], {
			stdio: "inherit",
			timeout: 180_000,
			shell: process.platform === "win32",
			env,
		});
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		throw new Error("ssh2 依赖准备失败（拷贝与 npm install 均未成功）");
	}
}

export const dirs = {
	"/": ["home"],
	"/home": ["test"],
	"/home/test": ["a.txt", "sub", "big.bin"],
	"/home/test/sub": [],
};
export const files = {
	"/home/test/a.txt": Buffer.from("hello ssh\n第二行\n", "utf8"),
	"/home/test/big.bin": Buffer.from([0x00, 0x01, 0x02, 0x00]),
};

/** 构造 ustar 目录条目（512B 头 + 结束块），供模拟 tar -czf - */
function tarDirEntry(name) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000755\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write("00000000000\0", 124); // 目录 size = 0
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148); // checksum 先置空格
	h[156] = 0x35; // '5' 目录
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, Buffer.alloc(1024)]); // 数据区 + 两块结束
}

/** 构造 ustar 文件条目（头 + 内容补齐到 512 + 尾部结束块） */
function tarFileEntry(name, content) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148);
	h[156] = 0x30; // '0' 普通文件
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

/** 读 ustar 头里的 NUL 结尾字符串。 */
function tarStr(buf, offset, len) {
	const raw = buf.subarray(offset, offset + len);
	const end = raw.indexOf(0);
	return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

/** 解一个 ustar 流（够我们用：普通文件 + 目录）。 */
function untarBuffer(buf) {
	const out = [];
	let off = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (!h.some((b) => b !== 0)) break; // 全零块 = 结束
		const name = tarStr(h, 0, 100);
		const prefix = tarStr(h, 345, 155);
		const size = parseInt(tarStr(h, 124, 12).trim() || "0", 8) || 0;
		const type = String.fromCharCode(h[156] || 0x30);
		off += 512;
		const data = buf.subarray(off, off + size);
		off += Math.ceil(size / 512) * 512;
		if (!name) continue;
		const full = prefix ? `${prefix}/${name}` : name;
		if (type === "0" || type === "\0") out.push({ name: full, data: Buffer.from(data) });
		else if (type === "5") out.push({ name: full, dir: true });
	}
	return out;
}

/** 父目录路径（`/a.txt` → `/`）。 */
function parentOf(p) {
	const i = String(p).lastIndexOf("/");
	return i <= 0 ? "/" : String(p).slice(0, i);
}

/** 把 name 登记进父目录的条目表（父目录不在表里就跳过，与真实服务器一致：目录必须先存在）。 */
function linkName(p) {
	const name = String(p).slice(String(p).lastIndexOf("/") + 1);
	const list = dirs[parentOf(p)];
	if (Array.isArray(list) && name && !list.includes(name)) list.push(name);
}

/** 从父目录的条目表里摘掉 name。
 *  ⚠ 必须判 indexOf >= 0：旧版直接 `splice(indexOf(...), 1)`，名字本就不在表里时
 *  indexOf 回 -1，`splice(-1, 1)` 会删掉**列表最后一项**（静默弄丢一个完全无关的文件）。 */
function unlinkName(p) {
	const name = String(p).slice(String(p).lastIndexOf("/") + 1);
	const list = dirs[parentOf(p)];
	if (!Array.isArray(list)) return;
	const i = list.indexOf(name);
	if (i >= 0) list.splice(i, 1);
}

/** mock 文件系统的写操作（批量上传的 mkdir/mv/rm 靠这几个）。 */
function mockFsOps() {
	function ensureDir(p) {
		const parts = String(p).split("/").filter(Boolean);
		let cur = "";
		for (const seg of parts) {
			cur = `${cur}/${seg}`;
			if (!dirs[cur]) {
				dirs[cur] = [];
				linkName(cur);
			}
		}
	}
	function removePath(p) {
		for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
		for (const k of Object.keys(dirs)) if (k === p || k.startsWith(`${p}/`)) delete dirs[k];
		unlinkName(p);
	}
	return { ensureDir, removePath };
}

/**
 * 把一条 `a && b && c` 拆成命令列表。只在引号外切 —— 文件名里带 " && " 也不能拆错。
 */
function splitShellChain(cmd) {
	const out = [];
	let cur = "";
	let quote = "";
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote) {
			if (c === quote) quote = "";
			cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			cur += c;
			continue;
		}
		if (c === "&" && cmd[i + 1] === "&") {
			out.push(cur.trim());
			cur = "";
			i++;
			continue;
		}
		cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** 带引号的参数（我们的命令都是单引号包路径）。 */
function shellArgs(s) {
	return [...String(s).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** 极简 glob（`*` / `?`）—— 只给 mock 内部用。 */
function mockGlob(pat, name) {
	const re = `^${String(pat)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")}$`;
	return new RegExp(re).test(name);
}

/**
 * 模拟远端 `tar -czf - <名字…>`：内存文件系统 → ustar → gzip。
 * 名字给目录就打包整棵子树（编辑器插件整目录下载），给文件就只打那一个（批量下载）。
 */
function exportTar(cdDir, names) {
	const root = cdDir === "/" ? "" : String(cdDir).replace(/\/+$/, "");
	const parts = [];
	for (const name of names) {
		const abs = `${root}/${name}`;
		if (dirs[abs]) {
			parts.push(tarDirEntry(name));
			for (const d of Object.keys(dirs)) {
				if (d.startsWith(abs + "/")) parts.push(tarFileEntry(d.slice(root.length + 1), Buffer.alloc(0)));
			}
			for (const [p, content] of Object.entries(files)) {
				if (p.startsWith(abs + "/")) parts.push(tarFileEntry(p.slice(root.length + 1), content));
			}
			continue;
		}
		if (files[abs]) parts.push(tarFileEntry(name, files[abs]));
	}
	return Buffer.concat(parts);
}

/**
 * 极简 find：`'<root>' [( -name 'x' -o ... ) -prune -o] [-type f] -printf '<fmt>'`。
 *
 * 只实现插件会发的那一形状（包括 `%P` 相对路径、`-prune` 剪枝、`-printf` 里的 `\t`/`\0`）。
 * `%T@` 输出 `?`：mock 文件系统不存 mtime，而引擎把非数字 mtime 当作「远端没给 mtime」
 * —— 与 readdir 路径（mock 的 attrs 也不带 mtime）完全一致，所以两条扫描路径能互相比对。
 */
function runFind(stream, root, mid, fmt) {
	const pruneNames = [...String(mid).matchAll(/-name\s+'([^']*)'/g)].map((m) => m[1]);
	const typeFilter = /-type\s+([a-z])/.exec(mid)?.[1] ?? "";
	const base = String(root).replace(/\/+$/, "");
	const pruned = (name) =>
		pruneNames.some((p) => (p.includes("*") || p.includes("?") ? mockGlob(p, name) : p === name));
	const render = (type, path, size) => {
		const rel = path.slice(base.length).replace(/^\/+/, "");
		return fmt
			.replace(/%y/g, type)
			.replace(/%s/g, String(size))
			.replace(/%T@/g, "?")
			.replace(/%P/g, rel)
			.replace(/\\t/g, "\t")
			.replace(/\\0/g, "\0")
			.replace(/\\n/g, "\n");
	};
	let out = "";
	const walk = (dir) => {
		for (const name of dirs[dir] ?? []) {
			const p = `${dir === "/" ? "" : dir}/${name}`;
			if (pruned(name)) continue; // -prune：不打印也不下去
			if (dirs[p]) {
				if (!typeFilter || typeFilter === "d") out += render("d", p, 4096);
				walk(p);
			} else if (!typeFilter || typeFilter === "f") {
				out += render("f", p, files[p]?.length ?? 0);
			}
		}
	};
	walk(base || "/");
	stream.write(out);
	return true;
}

/** mock 的 `mv -f`（源不存在 ⇒ 返回 false，正好能测「打包失败回落逐文件」）。 */
function runMv(src, dst) {
	if (dirs[src]) {
		for (const k of Object.keys(dirs))
			if (k === src || k.startsWith(`${src}/`)) dirs[dst + k.slice(src.length)] = dirs[k];
		for (const k of Object.keys(dirs)) if (k === src || k.startsWith(`${src}/`)) delete dirs[k];
		for (const k of Object.keys(files)) if (k.startsWith(`${src}/`)) files[dst + k.slice(src.length)] = files[k];
		for (const k of Object.keys(files)) if (k.startsWith(`${src}/`)) delete files[k];
	} else if (files[src]) {
		files[dst] = files[src];
		delete files[src];
		unlinkName(src);
	} else {
		return false;
	}
	linkName(dst);
	return true;
}

/**
 * 启动 mock SSH 服务。
 * @param {string} pluginDir 含 node_modules/ssh2 的插件目录（复用同一份依赖）
 * @param {number} port 监听端口
 * @param {{ latencyMs?: number }} [opts] `latencyMs` 给每个 READDIR 加固定延迟（模拟高延迟链路；
 *   返回的 `latency` 是个活开关，测试中途可改 —— 取消类测试需要一段真实存在的时间窗）
 * @returns {Promise<{close(): void, latency: {latencyMs: number}}>}
 */
export async function startMockSsh(pluginDir, port, opts = {}) {
	const latency = { latencyMs: Math.max(0, Number(opts.latencyMs) || 0) };
	/** 活开关：置 true 后所有 tar 命令都失败（测「远端没有 tar 时回落逐文件」这条兵不血刃的路）。 */
	const failTar = { on: false };
	const { createRequire } = await import("node:module");
	const { generateKeyPairSync } = await import("node:crypto");
	const req = createRequire(join(pluginDir, "package.json"));
	const { Server } = req("ssh2");
	// RSA PKCS#1 PEM（ed25519 只能导出 PKCS#8，ssh2 的 parseKey 不认）
	const HOST_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
		type: "pkcs1",
		format: "pem",
	});

	let handleSeq = 0;
	const handles = new Map(); // handleStr → 句柄记录

	function bindSftp(sftp) {
		sftp.on("REALPATH", (id, path) => {
			sftp.name(id, [{ filename: path || "/" }]);
		});
		sftp.on("STAT", (id, path) => {
			if (dirs[path]) return sftp.attrs(id, { mode: 0o040755, size: 4096 });
			if (files[path]) return sftp.attrs(id, { mode: 0o100644, size: files[path].length });
			sftp.status(id, 2);
		});
		sftp.on("OPENDIR", (id, path) => {
			if (!dirs[path]) return sftp.status(id, 2);
			const h = Buffer.from(`d${handleSeq++}`);
			handles.set(h.toString(), { kind: "dir", path, readAll: false });
			sftp.handle(id, h);
		});
		sftp.on("READDIR", (id, handleBuf) => {
			// 高延迟链路模拟：延迟加在每个 READDIR 响应上（一个目录一次往返），别处不受影响
			if (latency.latencyMs > 0) {
				setTimeout(() => readdirOnce(id, handleBuf), latency.latencyMs);
				return;
			}
			readdirOnce(id, handleBuf);
		});
		const readdirOnce = (id, handleBuf) => {
			const key = handleBuf.toString();
			const h = handles.get(key);
			if (!h) return sftp.status(id, 4);
			if (h.readAll) {
				handles.delete(key);
				return sftp.status(id, 1); // EOF
			}
			h.readAll = true;
			sftp.name(
				id,
				dirs[h.path].map((n) => ({
					filename: n,
					longname: `-rw-r--r-- 1 u u 0 ${n}`,
					attrs: {
						mode: dirs[`${h.path}/${n}`] ? 0o040755 : 0o100644,
						size: files[`${h.path}/${n}`]?.length ?? 0,
					},
				})),
			);
		};
		sftp.on("OPEN", (id, path, flags) => {
			if (flags & SFTP.READ && !(flags & (SFTP.WRITE | SFTP.CREAT | SFTP.TRUNC))) {
				if (!files[path]) return sftp.status(id, 2);
				const h = Buffer.from(`f${handleSeq++}`);
				handles.set(h.toString(), { kind: "file", path });
				return sftp.handle(id, h);
			}
			// 写路径：TRUNC 或新文件从空开始，否则续写已有内容
			const h = Buffer.from(`f${handleSeq++}`);
			handles.set(h.toString(), {
				kind: "file",
				write: true,
				path,
				buf: !files[path] || flags & SFTP.TRUNC ? Buffer.alloc(0) : Buffer.from(files[path]),
			});
			// 新建的文件要出现在父目录列表里（真实服务器就是这样：上传完 ls 能看见）
			linkName(path);
			sftp.handle(id, h);
		});
		sftp.on("READ", (id, handleBuf, offset, len) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.path) return sftp.status(id, 4);
			const buf = files[h.path];
			if (!buf) return sftp.status(id, 2);
			const slice = buf.subarray(offset, offset + len);
			if (!slice.length) return sftp.status(id, 1); // EOF
			sftp.data(id, slice);
		});
		sftp.on("WRITE", (id, handleBuf, offset, data) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.write) return sftp.status(id, 4);
			if (offset + data.length > h.buf.length) {
				const nb = Buffer.alloc(offset + data.length);
				h.buf.copy(nb, 0);
				h.buf = nb;
			}
			data.copy(h.buf, offset);
			sftp.status(id, 0);
		});
		sftp.on("CLOSE", (id, handleBuf) => {
			const h = handles.get(handleBuf.toString());
			if (h?.write) files[h.path] = Buffer.from(h.buf);
			handles.delete(handleBuf.toString());
			sftp.status(id, 0);
		});
		sftp.on("MKDIR", (id, path) => {
			if (dirs[path]) return sftp.status(id, 4);
			dirs[path] = [];
			linkName(path);
			sftp.status(id, 0);
		});
		sftp.on("REMOVE", (id, path) => {
			if (!files[path]) return sftp.status(id, 2);
			delete files[path];
			unlinkName(path);
			sftp.status(id, 0);
		});
		sftp.on("RMDIR", (id, path) => {
			if (!dirs[path]?.length) {
				delete dirs[path];
				unlinkName(path);
				return sftp.status(id, 0);
			}
			sftp.status(id, 4); // 目录非空或不存在
		});
		sftp.on("RENAME", (id, src, dst) => {
			if (files[src]) {
				files[dst] = files[src];
				delete files[src];
			} else if (dirs[src]) {
				dirs[dst] = dirs[src];
				delete dirs[src];
			} else return sftp.status(id, 2);
			unlinkName(src);
			linkName(dst);
			sftp.status(id, 0);
		});
	}

	return new Promise((resolve, reject) => {
		let srv;
		try {
			srv = new Server({ hostKeys: [HOST_KEY] }, (client) => {
				client.on("error", () => {}); // 客户端断开等 socket 错误不炸测试进程
				client.on("authentication", (ctx) => {
					if (ctx.username === "tester" && ctx.password === "secret123") return ctx.accept();
					ctx.reject();
				});
				client.on("ready", () => {
					client.on("session", (accept) => {
						const session = accept();
						session.once("pty", (accept2) => accept2?.());
						session.once("shell", (accept2) => {
							const stream = accept2();
							stream.write("welcome-to-mock\r\n");
							let buf = "";
							stream.on("data", (d) => {
								buf += d.toString();
								while (buf.includes("\r")) {
									const line = buf.slice(0, buf.indexOf("\r")).trim();
									buf = buf.slice(buf.indexOf("\r") + 1);
									if (line) stream.write(`echo:${line}\r\n`);
								}
							});
						});
						session.once("exec", (accept2, reject2, info) => {
							const stream = accept2();
							const cmd = info.command ?? "";
							const ops = mockFsOps();
							let stdin = Buffer.alloc(0);
							let exitCode = 0;

							/** 单条命令（返回 false = 失败，退出码写在 exitCode 里）。 */
							const runStep = (step) => {
								if (failTar.on && /(^|\s)tar(\s|$)/.test(step)) {
									stream.stderr.write("tar: not found");
									exitCode = 127;
									return false;
								}
								if (/^cd\s+'.*'$/.test(step)) return true; // 目录切换：mock 只有一棵树，空操作
								// 批量上传：tar -x [-m] -f - -C '<暂存目录>'（数据从 stdin 来）
								const tarX = step.match(/^tar\s+-x\s+(?:-m\s+)?-f\s+-\s+-C\s+'([^']*)'$/);
								if (tarX) {
									const base = tarX[1].replace(/\/+$/, "");
									ops.ensureDir(base);
									for (const e of untarBuffer(stdin)) {
										const p = `${base}/${e.name}`;
										if (e.dir) {
											ops.ensureDir(p);
											continue;
										}
										ops.ensureDir(parentOf(p));
										files[p] = e.data;
										linkName(p);
									}
									return true;
								}
								// 远端快扫：find '<root>' [\( -name 'x' -o ... \) -prune -o] [-type f] -printf '<fmt>'
								const findM = step.match(/^find\s+'([^']*)'(.*?)-printf\s+'([^']*)'$/);
								if (findM) return runFind(stream, findM[1], findM[2], findM[3]);
								if (step.startsWith("mkdir -p ")) {
									for (const p of shellArgs(step.slice(9))) ops.ensureDir(p);
									return true;
								}
								const mvM = step.match(/^mv\s+-f\s+'([^']*)'\s+'([^']*)'$/);
								if (mvM) return runMv(mvM[1], mvM[2]);
								if (step.startsWith("rm -rf ")) {
									for (const p of shellArgs(step.slice(7))) ops.removePath(p);
									return true;
								}
								if (step.startsWith("echo ")) {
									stream.write(step.slice(5).replace(/^["']|["']$/g, "") + "\n");
									return true;
								}
								if (step === "pwd") {
									stream.write("/home/test\n");
									return true;
								}
								if (step.startsWith("fail")) {
									stream.stderr.write("boom\n");
									exitCode = 7;
									return false;
								}
								exitCode = 127;
								return false;
							};

							const finish = () => {
								// 自带 `cd X &&` 前缀的命令（编辑器插件整目录下载）要**整条**先试：
								// 按 ` && ` 拆开会把它拆成两条互不相干的命令，正则就再也匹配不上了
								const wholeTar = failTar.on ? null : cmd.match(/^cd '(.*)' && tar -czf - (.*)$/);
								if (wholeTar) {
									stream.write(gzipSync(exportTar(wholeTar[1], shellArgs(wholeTar[2]))));
									stream.exit(0);
									stream.end();
									return;
								}
								let ok = true;
								for (const step of splitShellChain(cmd)) {
									if (!runStep(step)) {
										ok = false;
										break;
									}
								}
								stream.exit(ok ? 0 : exitCode || 1);
								stream.end();
							};
							// 要 stdin 的命令（tar -x）必须等数据到齐；其余命令直接跑
							if (/tar\s+-x/.test(cmd)) {
								stream.on("data", (d) => {
									stdin = Buffer.concat([stdin, d]);
								});
								stream.on("end", finish);
								stream.on("close", finish);
							} else {
								finish();
							}
						});
						session.once("sftp", (accept2) => bindSftp(accept2()));
					});
				});
			});
			srv.on("error", reject);
			srv.listen(port, "127.0.0.1", () =>
				resolve({
					latency,
					failTar,
					close() {
						try {
							srv.close();
						} catch {}
					},
				}),
			);
		} catch (err) {
			reject(err);
		}
	});
}
