import { once } from "node:events";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRef } from "./refs.mjs";
import { createHostVerifier } from "../../../plugin-sdk/ssh-host-trust.mjs";

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 20_000;
const MAX_EXEC_BYTES = 256 * 1024;

export function expandHome(p) {
	const s = String(p ?? "").trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
	return s;
}

export const DEFAULT_KEY_PATHS = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa", "~/.ssh/id_dsa"];

export async function findDefaultPrivateKey(fsModule = fs) {
	for (const candidate of DEFAULT_KEY_PATHS) {
		const file = expandHome(candidate);
		try {
			const content = await fsModule.readFile(file, "utf8");
			if (content && content.trim()) {
				return { path: candidate, expandedPath: file, content };
			}
		} catch {}
	}
	return null;
}

export async function resolvePublicKey(privateKeyPath, fsModule = fs) {
	if (privateKeyPath) {
		const expanded = expandHome(privateKeyPath);
		const pubCandidate = `${expanded}.pub`;
		try {
			const content = await fsModule.readFile(pubCandidate, "utf8");
			if (content && content.trim()) {
				return { path: pubCandidate, content: content.trim() };
			}
		} catch {}
	}
	for (const candidate of DEFAULT_KEY_PATHS) {
		const pubCandidate = `${expandHome(candidate)}.pub`;
		try {
			const content = await fsModule.readFile(pubCandidate, "utf8");
			if (content && content.trim()) {
				return { path: pubCandidate, content: content.trim() };
			}
		} catch {}
	}
	return null;
}

function expandAgent(a) {
	return String(a ?? "").replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
}

/**
 * @param {{ host: any, log?: (msg: string, level?: string) => void, secrets: { get(n: string): string | undefined } }} deps
 */
export function createSshManager({ host, log = () => {}, secrets }) {
	/** @type {any} */
	let mod = null;
	let loading = null;
	const dep = { status: "idle", error: "" };
	const pool = new Map();
	const inflight = new Map();
	const generations = new Map();

	function library() {
		if (mod) return Promise.resolve(mod);
		if (loading) return loading;
		loading = (async () => {
			try {
				const m = await import("ssh2");
				mod = m.default ?? m;
				dep.status = "ready";
				return mod;
			} catch {}
			dep.status = "installing";
			log("ssh2 未就绪，开始安装到插件目录…");
			try {
				if (typeof host.ensureDeps === "function") {
					const ok = await host.ensureDeps(["ssh2"], { onProgress: (m) => log(`install: ${m}`) });
					if (!ok) throw new Error("ensureDeps 返回失败");
				}
				const m = await import("ssh2");
				mod = m.default ?? m;
				dep.status = "ready";
				dep.error = "";
				log("ssh2 就绪");
				return mod;
			} catch (err) {
				dep.status = "failed";
				dep.error = String(err?.message ?? err);
				log(`ssh2 安装失败：${dep.error}`, "error");
				throw new Error(`ssh2 依赖未就绪（${dep.error}）。请在插件目录手动执行 npm install ssh2 后重试。`);
			}
		})();
		loading
			.catch(() => {})
			.finally(() => {
				loading = null;
			});
		return loading;
	}

	async function resolveAuth(conn) {
		const a = conn.auth ?? {};
		const method = String(a.method ?? "").trim();

		const remoteSsh = typeof host?.get === "function" ? host.get("remoteSsh") : null;
		const globalDecrypted =
			conn.useGlobal && remoteSsh ? await remoteSsh.getDecryptedProfile(conn.useGlobal).catch(() => null) : null;
		if (conn.useGlobal && remoteSsh) {
			if (globalDecrypted) {
				if (!conn.host && globalDecrypted.profile.host) conn.host = globalDecrypted.profile.host;
				if (!conn.port && globalDecrypted.profile.port) conn.port = globalDecrypted.profile.port;
				if (!conn.username && globalDecrypted.profile.username) conn.username = globalDecrypted.profile.username;
				if (globalDecrypted.profile.remotePath && (!conn.remotePath || conn.remotePath === "/")) {
					conn.remotePath = globalDecrypted.profile.remotePath;
				}
			}
		}

		let password = { value: "", source: "plain" };
		let passphrase = { value: "", source: "plain" };
		let privateKey = { value: "", source: "plain" };
		let agent = { value: "", source: "plain" };

		if (method === "password" || method === "secret") {
			password = await resolveRef(a.password, { secrets, label: `${conn.name}.auth.password` });
		} else if (method === "agent") {
			agent = await resolveRef(a.agent, { secrets, label: `${conn.name}.auth.agent` });
		} else if (method === "key") {
			[passphrase, privateKey] = await Promise.all([
				resolveRef(a.passphrase, { secrets, label: `${conn.name}.auth.passphrase` }),
				resolveRef(a.privateKey, { secrets, label: `${conn.name}.auth.privateKey` }),
			]);
		} else {
			[password, passphrase, privateKey, agent] = await Promise.all([
				resolveRef(a.password, { secrets, label: `${conn.name}.auth.password` }),
				resolveRef(a.passphrase, { secrets, label: `${conn.name}.auth.passphrase` }),
				resolveRef(a.privateKey, { secrets, label: `${conn.name}.auth.privateKey` }),
				resolveRef(a.agent, { secrets, label: `${conn.name}.auth.agent` }),
			]);
		}

		let key = privateKey.value;
		let keySource = privateKey.source;

		const allowKey = !method || method === "key";
		const allowPassword = !method || method === "password" || method === "secret";
		if (globalDecrypted) {
			if (allowPassword && globalDecrypted.password && !password.value) {
				password = { value: globalDecrypted.password, source: "global" };
			}
			if (allowKey && globalDecrypted.passphrase && !passphrase.value) {
				passphrase = { value: globalDecrypted.passphrase, source: "global" };
			}
			if (allowKey && !a.privateKeyPath && globalDecrypted.profile.privateKeyPath && !key) {
				const file = expandHome(globalDecrypted.profile.privateKeyPath);
				try {
					key = await fs.readFile(file, "utf8");
					keySource = "global-path";
				} catch {}
			}
		}
		if (allowKey && !key && a.privateKeyPath) {
			const file = expandHome(a.privateKeyPath);
			try {
				key = await fs.readFile(file, "utf8");
				keySource = "path";
			} catch (err) {
				throw new Error(`私钥文件读不到（${file}）：${err?.code ?? err?.message ?? err}`);
			}
		} else if (allowKey && !key && (method === "key" || (!password.value && !agent.value))) {
			const found = await findDefaultPrivateKey();
			if (found) {
				key = found.content;
				keySource = "default";
				log(`连接「${conn.name}」未指定私钥路径，自动使用用户目录密钥：${found.path}`);
			}
		}

		return {
			password: password.value,
			passphrase: passphrase.value,
			privateKey: key,
			agent: expandAgent(agent.value),
			sources: {
				password: password.source,
				passphrase: passphrase.source,
				privateKey: keySource,
				agent: agent.source,
			},
		};
	}

	function fingerprint(conn, auth) {
		return createHash("sha256")
			.update(
				JSON.stringify([
					conn.host,
					conn.port,
					conn.username,
					auth.password,
					auth.passphrase,
					auth.privateKey,
					auth.agent,
				]),
			)
			.digest("hex");
	}

	function drop(key) {
		const generation = generations.get(key);
		generations.delete(key);
		inflight.delete(key);
		generation?.abort(new Error("SSH connection cancelled"));
		const entry = pool.get(key);
		if (!entry) return;
		pool.delete(key);
		clearTimeout(entry.timer);
		entry.alive = false;
		try {
			entry.client.end();
		} catch {}
	}

	function dropAll(exceptCwd) {
		for (const key of new Set([...pool.keys(), ...generations.keys()])) {
			if (exceptCwd && key.startsWith(`${exceptCwd}\u0000`)) continue;
			drop(key);
		}
	}

	function shorten(entry) {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			if (entry.alive) log(`空闲回收连接 ${entry.key}`);
			if (pool.get(entry.key) === entry) drop(entry.key);
		}, IDLE_CLOSE_MS);
		if (typeof entry.timer.unref === "function") entry.timer.unref();
	}

	/**
	 * 取一条可用的 SFTP 通道（必要时新建连接）。
	 * @returns {Promise<{ client: any, sftp: any, key: string }>}
	 */
	async function getSftp(conn) {
		const key = `${conn.__cwd ?? ""}\u0000${conn.name}`;
		let generation = generations.get(key);
		if (!generation) generations.set(key, (generation = new AbortController()));
		const check = () => generation.signal.throwIfAborted();
		const { Client } = await library();
		check();
		const auth = await resolveAuth(conn);
		check();
		if (!conn?.host) throw new Error("尚未配置连接（缺 host）——先在 .pi/sftp.json 或界面里配好");
		const fp = fingerprint(conn, auth);
		while (true) {
			check();
			const pending = inflight.get(key);
			if (pending) {
				try {
					await pending;
				} catch (err) {
					check();
					if (pending.fp === fp) throw err;
				}
				continue;
			}
			const existing = pool.get(key);
			if (existing && existing.fp === fp && existing.alive) {
				existing.lastUsed = Date.now();
				shorten(existing);
				return { client: existing.client, sftp: existing.sftp, key };
			}
			if (existing) {
				pool.delete(key);
				clearTimeout(existing.timer);
				existing.alive = false;
				existing.client.end();
			}

			const opening = (async () => {
				const trust = await createHostVerifier(conn.host, conn.port || 22);
				check();
				const opened = await new Promise((resolve, reject) => {
					const client = new Client();
					const opts = {
						hostVerifier: trust.hostVerifier,
						host: conn.host,
						port: conn.port || 22,
						username: conn.username || "root",
						readyTimeout: READY_TIMEOUT_MS,
						keepaliveInterval: 10_000,
						keepaliveCountMax: 3,
					};
					if (auth.password) {
						opts.password = auth.password;
						opts.tryKeyboard = true;
					} else if (auth.agent) opts.agent = auth.agent;
					else if (auth.privateKey) {
						opts.privateKey = auth.privateKey;
						if (auth.passphrase) opts.passphrase = auth.passphrase;
					} else {
						return reject(
							new Error(
								`${conn.name}: 没有任何可用凭据 —— 配 auth.password / auth.privateKeyPath / auth.agent 之一（或在 ~/.ssh/ 放置 id_ed25519/id_rsa 私钥）`,
							),
						);
					}
					let settled = false;
					const fail = (err) => {
						if (settled) return;
						settled = true;
						generation.signal.removeEventListener("abort", onAbort);
						try {
							client.end();
						} catch {}
						reject(trust.getError() ?? err);
					};
					const onAbort = () => fail(generation.signal.reason);
					generation.signal.addEventListener("abort", onAbort, { once: true });
					if (auth.password) {
						client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
							finish(Array.isArray(prompts) ? prompts.map(() => auth.password) : [auth.password]);
						});
					}
					client.on("error", fail);
					client.on("close", () => {
						if (!settled) fail(new Error("SSH connection closed before SFTP ready"));
						const cur = pool.get(key);
						if (cur?.client === client) drop(key);
					});
					client.on("ready", () => {
						if (settled) return;
						client.sftp((err, sftp) => {
							if (settled) return;
							if (err) return fail(err);
							settled = true;
							generation.signal.removeEventListener("abort", onAbort);
							resolve({ client, sftp });
						});
					});
					try {
						client.connect(opts);
					} catch (err) {
						fail(err);
					}
				});

				if (generation.signal.aborted) {
					opened.client.end();
					check();
				}
				const entry = { ...opened, fp, key, lastUsed: Date.now(), alive: true, conn };
				entry.timer = null;
				pool.set(key, entry);
				shorten(entry);
				return entry;
			})().finally(() => {
				if (inflight.get(key) === opening) inflight.delete(key);
			});
			opening.fp = fp;
			inflight.set(key, opening);
			const entry = await opening;
			return { client: entry.client, sftp: entry.sftp, key };
		}
	}

	async function exec(
		conn,
		cmd,
		{ timeoutMs = 120_000, maxBytes = MAX_EXEC_BYTES, binary = false, inputStream, signal } = {},
	) {
		const { client } = await getSftp(conn);
		return new Promise((resolve, reject) => {
			let out = "";
			/** @type {Buffer[]} */
			const outChunks = [];
			let outBytes = 0;
			let errOut = "";
			let truncated = false;
			/** @type {any} */
			let chan = null;
			let settled = false;
			const abortErr = () => (signal?.reason instanceof Error ? signal.reason : new Error("已取消"));
			const stop = () => {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
			};
			const fail = (err) => {
				if (settled) return;
				settled = true;
				stop();
				try {
					chan?.destroy();
				} catch {}
				reject(err);
			};
			const onAbort = () => fail(abortErr());
			const timer = setTimeout(
				() => fail(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）：${String(cmd).slice(0, 120)}`)),
				timeoutMs,
			);
			const outDecoder = new StringDecoder("utf8");
			const errDecoder = new StringDecoder("utf8");
			const push = (buf, which) => {
				if (which === "err") {
					const e = errDecoder.write(buf);
					if (outBytes + out.length + errOut.length + e.length > maxBytes) {
						truncated = true;
						return;
					}
					errOut += e;
					return;
				}
				if (binary) {
					if (outBytes + buf.length > maxBytes) {
						truncated = true;
						return;
					}
					outChunks.push(Buffer.from(buf));
					outBytes += buf.length;
					return;
				}
				const s = outDecoder.write(buf);
				if (out.length + errOut.length + s.length > maxBytes) {
					truncated = true;
					return;
				}
				out += s;
			};
			if (signal) {
				if (signal.aborted) return fail(abortErr());
				signal.addEventListener("abort", onAbort, { once: true });
			}
			client.exec(String(cmd), (err, stream) => {
				if (err) return fail(err);
				chan = stream;
				stream.on("data", (b) => push(b, "out"));
				stream.stderr.on("data", (b) => push(b, "err"));
				stream.on("close", (c) => {
					if (settled) return;
					settled = true;
					stop();
					resolve({
						code: typeof c === "number" ? c : null,
						stdout: binary ? Buffer.concat(outChunks) : out + outDecoder.end(),
						stderr: errOut + errDecoder.end(),
						truncated,
					});
				});
				stream.on("error", fail);
				if (inputStream) {
					(async () => {
						for await (const chunk of inputStream) {
							if (settled) return;
							if (!stream.write(chunk)) await once(stream, "drain");
						}
						stream.end();
					})().catch(fail);
				}
			});
		});
	}

	/**
	 * 跑一条命令，把 stdout 当**流**交给调用方（下载方向的 `tar -czf -` 靠它）：
	 * 调用方边消费边落盘，内存只留一个 chunk，不攒整包。stderr 照旧收集，退出码在流结束后给出。
	 *
	 * 注意：`consume` **不能用 `.on("data")`**（那会切到 flowing 模式把数据抢走），要用
	 * `for await` 迭代传进来的可读流。
	 *
	 * @param {{ consume: (out: any) => Promise<void>, signal?: AbortSignal, timeoutMs?: number, maxStderrBytes?: number }} o
	 * @returns {Promise<{ code: number|null, stderr: string, stderrTruncated: boolean }>}
	 */
	async function execStream(conn, cmd, { consume, signal, timeoutMs = 120_000, maxStderrBytes = 64 * 1024 } = {}) {
		const { client } = await getSftp(conn);
		return new Promise((resolve, reject) => {
			let errOut = "";
			let stderrTruncated = false;
			let code = null;
			let consumed = false;
			let closed = false;
			let settled = false;
			/** @type {any} */
			let chan = null;
			const abortErr = () => (signal?.reason instanceof Error ? signal.reason : new Error("已取消"));
			const stop = () => {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
			};
			const fail = (err) => {
				if (settled) return;
				settled = true;
				stop();
				try {
					chan?.destroy();
				} catch {}
				reject(err);
			};
			const onAbort = () => fail(abortErr());
			const done = () => {
				if (settled || !consumed || !closed) return;
				settled = true;
				stop();
				resolve({ code, stderr: errOut, stderrTruncated });
			};
			const timer = setTimeout(
				() => fail(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）：${String(cmd).slice(0, 120)}`)),
				timeoutMs,
			);
			if (signal) {
				if (signal.aborted) return fail(abortErr());
				signal.addEventListener("abort", onAbort, { once: true });
			}
			client.exec(String(cmd), (err, stream) => {
				if (err) return fail(err);
				chan = stream;
				stream.stderr.on("data", (b) => {
					if (errOut.length >= maxStderrBytes) {
						stderrTruncated = true;
						return;
					}
					errOut += b.toString("utf8");
				});
				stream.on("close", (c) => {
					code = typeof c === "number" ? c : null;
					closed = true;
					done();
				});
				stream.on("error", fail);
				Promise.resolve()
					.then(() => consume(stream))
					.then(
						() => {
							consumed = true;
							done();
						},
						(e) => fail(e),
					);
			});
		});
	}

	async function probe(conn, { sftpCalls }) {
		const { sftp } = await getSftp(conn);
		const dir = conn.remotePath || "/";
		const existsProbe = await sftpCalls.stat(sftp, dir);
		const probeFile = `${dir.replace(/\/+$/, "")}/.sftp-tmp-probe-${process.pid}`;
		let writable = true;
		let writeError = "";
		try {
			await sftpCalls.writeFile(sftp, probeFile, Buffer.from("ok"));
			await sftpCalls.unlink(sftp, probeFile);
		} catch (err) {
			writable = false;
			writeError = String(err?.message ?? err);
		}
		return {
			remoteExists: Boolean(existsProbe),
			writable,
			writeError,
			authSources: (await resolveAuth(conn)).sources,
		};
	}

	function sftpCallInternal(sftp, method, ...args) {
		return new Promise((resolve, reject) => {
			try {
				sftp[method](...args, (err, ...res) => {
					if (err) return reject(err);
					resolve(res.length <= 1 ? res[0] : res);
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async function authorizePublicKey(conn, opts = {}) {
		const { Client } = await library();
		const password = opts.password;
		const customKey = opts.publicKey;
		const customKeyPath = opts.privateKeyPath || conn.auth?.privateKeyPath;

		let pubInfo = null;
		if (customKey && typeof customKey === "string" && customKey.trim()) {
			pubInfo = { path: "(custom)", content: customKey.trim() };
		} else {
			pubInfo = await resolvePublicKey(customKeyPath);
		}

		if (!pubInfo || !pubInfo.content) {
			throw new Error("未找到本地公钥文件（~/.ssh/id_ed25519.pub / id_rsa.pub 等不存在，请先用 ssh-keygen 生成）");
		}

		const rawLine =
			pubInfo.content
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find(Boolean) || "";
		if (!rawLine.startsWith("ssh-") && !rawLine.startsWith("ecdsa-")) {
			throw new Error(`公钥格式不正确（${pubInfo.path}）：${rawLine.slice(0, 30)}...`);
		}
		const pubLine = rawLine;

		const connectOpts = {
			host: conn.host,
			port: conn.port || 22,
			username: conn.username || "root",
			readyTimeout: READY_TIMEOUT_MS,
			keepaliveInterval: 10_000,
			keepaliveCountMax: 3,
		};

		let effectivePassword = password ? String(password) : "";
		if (!effectivePassword && conn.auth?.password) {
			try {
				const r = await resolveRef(conn.auth.password, { secrets, label: `${conn.name}.auth.password` });
				effectivePassword = r.value || "";
			} catch {}
		}
		if (!effectivePassword && conn.name) {
			try {
				effectivePassword = secrets?.get?.(`${conn.name}-password`) || "";
			} catch {}
		}

		if (effectivePassword) {
			connectOpts.password = effectivePassword;
			connectOpts.tryKeyboard = true;
		} else {
			throw new Error("NEED_PASSWORD: 请先在上方「密码」输入框填写一次远程服务器密码，再点击「添加公钥到远端」");
		}

		const client = new Client();
		const sftp = await new Promise((resolve, reject) => {
			let settled = false;
			const fail = (err) => {
				if (settled) return;
				settled = true;
				try {
					client.end();
				} catch {}
				reject(err);
			};
			client.on("error", fail);
			if (effectivePassword) {
				client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
					finish(Array.isArray(prompts) ? prompts.map(() => effectivePassword) : [effectivePassword]);
				});
			}
			client.on("ready", () => {
				client.sftp((err, s) => {
					if (err) return fail(err);
					settled = true;
					resolve(s);
				});
			});
			try {
				client.connect(connectOpts);
			} catch (err) {
				fail(err);
			}
		});

		let alreadyPresent = false;
		try {
			let homeDir = "";
			try {
				homeDir = await sftpCallInternal(sftp, "realpath", ".");
			} catch {}
			if (!homeDir || typeof homeDir !== "string" || !homeDir.startsWith("/")) {
				homeDir = conn.username === "root" ? "/root" : `/home/${conn.username}`;
			}
			homeDir = homeDir.replace(/\/+$/, "") || "/";

			const sshDir = `${homeDir}/.ssh`;
			const authKeysFile = `${sshDir}/authorized_keys`;

			let sshDirStat = null;
			try {
				sshDirStat = await sftpCallInternal(sftp, "stat", sshDir);
			} catch {}
			if (!sshDirStat) {
				try {
					await sftpCallInternal(sftp, "mkdir", sshDir);
				} catch {}
			}
			try {
				await sftpCallInternal(sftp, "setstat", sshDir, { mode: 0o700 });
			} catch {}

			let existingContent = "";
			try {
				const buf = await sftpCallInternal(sftp, "readFile", authKeysFile);
				existingContent = buf ? buf.toString("utf8") : "";
			} catch {}

			const lines = existingContent.split(/\r?\n/).map((l) => l.trim());
			if (lines.includes(pubLine)) {
				alreadyPresent = true;
			} else {
				const newContent = existingContent.trim() ? `${existingContent.trimEnd()}\n${pubLine}\n` : `${pubLine}\n`;
				await sftpCallInternal(sftp, "writeFile", authKeysFile, Buffer.from(newContent, "utf8"));
				try {
					await sftpCallInternal(sftp, "setstat", authKeysFile, { mode: 0o600 });
				} catch {}
			}
		} finally {
			try {
				client.end();
			} catch {}
		}

		drop(`${conn.__cwd ?? ""}\u0000${conn.name}`);
		let verified = false;
		let verifyError = "";
		try {
			if (opts.sftpCalls) {
				const probeRes = await probe(conn, { sftpCalls: opts.sftpCalls });
				verified = probeRes.remoteExists !== false;
			}
		} catch (err) {
			verifyError = String(err?.message ?? err);
		}

		return {
			ok: true,
			publicKeyPath: pubInfo.path,
			publicKey: pubLine,
			alreadyPresent,
			verified,
			verifyError,
		};
	}

	return {
		library,
		getSftp,
		exec,
		execStream,
		probe,
		authorizePublicKey,
		resolveAuth,
		drop,
		dropAll,
		_pool: pool,
		depState: () => ({ ...dep }),
		poolState: () =>
			[...pool.values()].map((e) => ({
				key: e.key,
				name: e.conn?.name ?? "",
				host: e.conn?.host ?? "",
				idleMs: Date.now() - e.lastUsed,
			})),
	};
}
