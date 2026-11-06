import { join } from "node:path";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const SFTP = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 };

const SSH2_PKGS = ["ssh2", "asn1", "bcrypt-pbkdf", "safer-buffer", "tweetnacl"];

export function ensurePluginSsh2Dep(plugDst, devPlugDir) {
	for (const pkg of SSH2_PKGS) {
		const src = join(devPlugDir, "node_modules", pkg);
		if (existsSync(src)) {
			cpSync(src, join(plugDst, "node_modules", pkg), { recursive: true });
		}
	}
	if (!existsSync(join(plugDst, "node_modules", "ssh2", "package.json"))) {
		console.log("[mock-ssh] 本地无 ssh2 依赖，回退 npm install…");
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

function tarDirEntry(name) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000755\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write("00000000000\0", 124);
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148);
	h[156] = 0x35;
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, Buffer.alloc(1024)]);
}

function tarFileEntry(name, content) {
	const h = Buffer.alloc(512);
	h.write(name.slice(0, 99), 0, "utf8");
	h.write("0000644\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
	h.write(Date.now().toString(8).padStart(11, "0") + "\0", 136);
	h.write("        ", 148);
	h[156] = 0x30;
	h.write("ustar\0", 257);
	h.write("00", 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

function tarStr(buf, offset, len) {
	const raw = buf.subarray(offset, offset + len);
	const end = raw.indexOf(0);
	return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

function untarBuffer(buf) {
	const out = [];
	let off = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (!h.some((b) => b !== 0)) break;
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

function parentOf(p) {
	const i = String(p).lastIndexOf("/");
	return i <= 0 ? "/" : String(p).slice(0, i);
}

function linkName(p) {
	const name = String(p).slice(String(p).lastIndexOf("/") + 1);
	const list = dirs[parentOf(p)];
	if (Array.isArray(list) && name && !list.includes(name)) list.push(name);
}

function unlinkName(p) {
	const name = String(p).slice(String(p).lastIndexOf("/") + 1);
	const list = dirs[parentOf(p)];
	if (!Array.isArray(list)) return;
	const i = list.indexOf(name);
	if (i >= 0) list.splice(i, 1);
}

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

function shellArgs(s) {
	return [...String(s).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function mockGlob(pat, name) {
	const re = `^${String(pat)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")}$`;
	return new RegExp(re).test(name);
}

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
			if (pruned(name)) continue;
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
	const failTar = { on: false };
	const { createRequire } = await import("node:module");
	const { generateKeyPairSync } = await import("node:crypto");
	const req = createRequire(join(pluginDir, "package.json"));
	const { Server, utils } = req("ssh2");
	const HOST_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
		type: "pkcs1",
		format: "pem",
	});

	let handleSeq = 0;
	const handles = new Map();

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
				return sftp.status(id, 1);
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
			const h = Buffer.from(`f${handleSeq++}`);
			handles.set(h.toString(), {
				kind: "file",
				write: true,
				path,
				buf: !files[path] || flags & SFTP.TRUNC ? Buffer.alloc(0) : Buffer.from(files[path]),
			});
			linkName(path);
			sftp.handle(id, h);
		});
		sftp.on("READ", (id, handleBuf, offset, len) => {
			const h = handles.get(handleBuf.toString());
			if (!h?.path) return sftp.status(id, 4);
			const buf = files[h.path];
			if (!buf) return sftp.status(id, 2);
			const slice = buf.subarray(offset, offset + len);
			if (!slice.length) return sftp.status(id, 1);
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
			sftp.status(id, 4);
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
				client.on("error", () => {});
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

							const runStep = (step) => {
								if (failTar.on && /(^|\s)tar(\s|$)/.test(step)) {
									stream.stderr.write("tar: not found");
									exitCode = 127;
									return false;
								}
								if (/^cd\s+'.*'$/.test(step)) return true;
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
					hostPublicKey: utils.parseKey(HOST_KEY).getPublicSSH(),
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
