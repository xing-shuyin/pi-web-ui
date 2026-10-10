/**
 * SSH / SFTP 连接管理 —— 连接池 + 配置指纹重连 + 空闲回收 + 远端 exec。
 *
 * 依赖 `ssh2` 不随插件分发：首次用到时经 `host.ensureDeps(["ssh2"])` 自动装到插件
 * 目录（宿主做单飞合并，并发调用只装一次）。装完再 `import("ssh2")` —— 裸 ESM
 * 说明符会从本文件所在目录向上找 node_modules，正好命中插件目录里刚装的那份。
 *
 * 连接键 = `cwd \u0000 连接名`：切换工作区/换 profile 各用各的，互不串台。
 * 指纹 = 影响连接的字段（host/port/username/凭据）；用户改完配置保存，下一次
 * 取连接自动断开重连，不需要重载插件。
 */

import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRef } from "./refs.mjs";

const IDLE_CLOSE_MS = 5 * 60 * 1000; // 空闲多久断开（远端 sshd 一般 10 分钟掐 idle，留点余量）
const READY_TIMEOUT_MS = 20_000;
const MAX_EXEC_BYTES = 256 * 1024;

/** `~` 展开（配置文件里写 `~/.ssh/id_ed25519` 是通行习惯）。 */
export function expandHome(p) {
	const s = String(p ?? "").trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
	return s;
}

/** 遵循 OpenSSH 标准行为，未指定密钥路径时自动探测 ~/.ssh/ 下的常用私钥。 */
export const DEFAULT_KEY_PATHS = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa", "~/.ssh/id_dsa"];

/**
 * 探测用户目录常用私钥，返回第一个存在且有内容的密钥信息。
 */
export async function findDefaultPrivateKey(fsModule = fs) {
	for (const candidate of DEFAULT_KEY_PATHS) {
		const file = expandHome(candidate);
		try {
			const content = await fsModule.readFile(file, "utf8");
			if (content && content.trim()) {
				return { path: candidate, expandedPath: file, content };
			}
		} catch {
			/* 不存在或不可读，尝试下一个 */
		}
	}
	return null;
}

/**
 * 寻找本地对应的公钥文件（.pub）。
 * 优先找指定 privateKeyPath 对应的 .pub，未指定时按 DEFAULT_KEY_PATHS 查找。
 */
export async function resolvePublicKey(privateKeyPath, fsModule = fs) {
	if (privateKeyPath) {
		const expanded = expandHome(privateKeyPath);
		const pubCandidate = `${expanded}.pub`;
		try {
			const content = await fsModule.readFile(pubCandidate, "utf8");
			if (content && content.trim()) {
				return { path: pubCandidate, content: content.trim() };
			}
		} catch {
			/* 不存在，继续向后查找 */
		}
	}
	for (const candidate of DEFAULT_KEY_PATHS) {
		const pubCandidate = `${expandHome(candidate)}.pub`;
		try {
			const content = await fsModule.readFile(pubCandidate, "utf8");
			if (content && content.trim()) {
				return { path: pubCandidate, content: content.trim() };
			}
		} catch {
			/* 不存在，尝试下一个 */
		}
	}
	return null;
}

/** `$SSH_AUTH_SOCK` 占位符展开（vscode-sftp 的习惯写法）。 */
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
	/** 依赖状态：idle | installing | ready | failed（前端读它画 ⚠ 提示）。 */
	const dep = { status: "idle", error: "" };
	/** key → { client, sftp, fp, lastUsed, timer, alive } */
	const pool = new Map();

	/** 惰性加载 ssh2；缺了就装上。并发调用共享同一个 Promise。 */
	function library() {
		if (mod) return Promise.resolve(mod);
		if (loading) return loading;
		loading = (async () => {
			try {
				const m = await import("ssh2");
				mod = m.default ?? m;
				dep.status = "ready";
				return mod;
			} catch {
				/* 没装，下面补装 */
			}
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

	/** 把连接上的凭据引用解析成真实值（明文原样返回，但记录来源用于告警）。 */
	async function resolveAuth(conn) {
		const a = conn.auth ?? {};
		const method = String(a.method ?? "").trim();

		// 按认证方式按需解析引用，避免选了密钥登录却因残留的密码机密引用报错
		let password = { value: "", source: "plain" };
		let passphrase = { value: "", source: "plain" };
		let privateKey = { value: "", source: "plain" };
		let agent = { value: "", source: "plain" };

		if (method === "password") {
			password = await resolveRef(a.password, { secrets, label: `${conn.name}.auth.password` });
		} else if (method === "agent") {
			agent = await resolveRef(a.agent, { secrets, label: `${conn.name}.auth.agent` });
		} else if (method === "key") {
			[passphrase, privateKey] = await Promise.all([
				resolveRef(a.passphrase, { secrets, label: `${conn.name}.auth.passphrase` }),
				resolveRef(a.privateKey, { secrets, label: `${conn.name}.auth.privateKey` }),
			]);
		} else {
			// 未显式指定 method，按字段存在性依次解析
			[password, passphrase, privateKey, agent] = await Promise.all([
				resolveRef(a.password, { secrets, label: `${conn.name}.auth.password` }),
				resolveRef(a.passphrase, { secrets, label: `${conn.name}.auth.passphrase` }),
				resolveRef(a.privateKey, { secrets, label: `${conn.name}.auth.privateKey` }),
				resolveRef(a.agent, { secrets, label: `${conn.name}.auth.agent` }),
			]);
		}

		let key = privateKey.value;
		let keySource = privateKey.source;
		if (!key && a.privateKeyPath) {
			const file = expandHome(a.privateKeyPath);
			try {
				key = await fs.readFile(file, "utf8");
				keySource = "path";
			} catch (err) {
				throw new Error(`私钥文件读不到（${file}）：${err?.code ?? err?.message ?? err}`);
			}
		} else if (!key && (method === "key" || (!password.value && !agent.value))) {
			// 选了密钥方式或没有任何可用凭据时，默认尝试 ~/.ssh 用户目录的标准密钥
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

	/** 影响连接的字段指纹 —— 变了就重连。 */
	function fingerprint(conn, auth) {
		return JSON.stringify([
			conn.host,
			conn.port,
			conn.username,
			auth.password,
			auth.passphrase,
			auth.privateKey ? auth.privateKey.length : 0,
			auth.agent,
		]);
	}

	function drop(key) {
		const entry = pool.get(key);
		if (!entry) return;
		pool.delete(key);
		clearTimeout(entry.timer);
		entry.alive = false;
		try {
			entry.client.end();
		} catch {
			/* 关不掉的连接交给 OS */
		}
	}

	function dropAll() {
		// Map 迭代中删除当前项是安全的（不会跳过未访问的项）
		for (const key of pool.keys()) drop(key);
	}

	function shorten(entry) {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			if (entry.alive) log(`空闲回收连接 ${entry.key}`);
			drop(entry.key);
		}, IDLE_CLOSE_MS);
		if (typeof entry.timer.unref === "function") entry.timer.unref();
	}

	/**
	 * 取一条可用的 SFTP 通道（必要时新建连接）。
	 * @returns {Promise<{ client: any, sftp: any, key: string }>}
	 */
	async function getSftp(conn) {
		const { Client } = await library();
		if (!conn?.host) throw new Error("尚未配置连接（缺 host）——先在 .pi/sftp.json 或界面里配好");
		const auth = await resolveAuth(conn);
		const fp = fingerprint(conn, auth);
		const key = `${conn.__cwd ?? ""}\u0000${conn.name}`;
		const existing = pool.get(key);
		if (existing && existing.fp === fp && existing.alive) {
			existing.lastUsed = Date.now();
			shorten(existing);
			return { client: existing.client, sftp: existing.sftp, key };
		}
		if (existing) drop(key);

		const opened = await new Promise((resolve, reject) => {
			const client = new Client();
			const opts = {
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
				try {
					client.end();
				} catch {
					/* ignore */
				}
				reject(err);
			};
			if (auth.password) {
				client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
					finish(Array.isArray(prompts) ? prompts.map(() => auth.password) : [auth.password]);
				});
			}
			client.on("error", fail);
			client.on("close", () => {
				const cur = pool.get(key);
				if (cur?.client === client) drop(key);
			});
			client.on("ready", () => {
				client.sftp((err, sftp) => {
					if (err) return fail(err);
					settled = true;
					resolve({ client, sftp });
				});
			});
			try {
				client.connect(opts);
			} catch (err) {
				fail(err);
			}
		});

		const entry = { ...opened, fp, key, lastUsed: Date.now(), alive: true, conn };
		entry.timer = null;
		pool.set(key, entry);
		shorten(entry);
		return { client: opened.client, sftp: opened.sftp, key };
	}

	/**
	 * 在远端跑一条命令，收集输出（截断保护）与退出码。
	 *
	 * - `inputStream`：把流（AsyncIterable / Readable）喂进 stdin 再关掉，**带背压**。
	 *   打包上传靠它 —— 不必先在内存里攒出整包再一次 `end()`。
	 * - `binary`：stdout 按字节收（`tar -czf -` 的 gzip 流一旦过 UTF-8 解码就整包全坏）。
	 * - `signal`：中止就断开这条执行通道（命令真被掐掉，不会留在远端跑完）。
	 */
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
				} catch {
					/* 关不掉的交给 OS */
				}
				reject(err);
			};
			const onAbort = () => fail(abortErr());
			const timer = setTimeout(
				() => fail(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)}s）：${String(cmd).slice(0, 120)}`)),
				timeoutMs,
			);
			const push = (buf, which) => {
				if (which === "err") {
					const e = buf.toString("utf8");
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
					outChunks.push(Buffer.from(buf)); // 拷贝一份：ssh2 的接收缓冲不保证可长期持有
					outBytes += buf.length;
					return;
				}
				const s = buf.toString("utf8");
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
						stdout: binary ? Buffer.concat(outChunks) : out,
						stderr: errOut,
						truncated,
					});
				});
				stream.on("error", fail);
				if (inputStream) {
					// 背压喂 stdin：`for await` + write() 的返回值决定要不要等 drain
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
				} catch {
					/* 关不掉的交给 OS */
				}
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

	/** 连通性探测：连接 + 远端根可达 + 可写（写一个探针文件再删掉）。 */
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

	/**
	 * 把本地公钥添加到远端 authorized_keys 中（类似 ssh-copy-id）。
	 * 支持临时提供密码（未配置密钥授权时的首次登入）。
	 */
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

		// 公钥行清理：提取第一行非空，必须像合法 SSH 公钥（ssh-ed25519 / ssh-rsa / ecdsa-sha2-...）
		const rawLine =
			pubInfo.content
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find(Boolean) || "";
		if (!rawLine.startsWith("ssh-") && !rawLine.startsWith("ecdsa-")) {
			throw new Error(`公钥格式不正确（${pubInfo.path}）：${rawLine.slice(0, 30)}...`);
		}
		const pubLine = rawLine;

		// 决定连接认证凭据：优先使用本次传入的临时密码 → 配置中的密码 → 机密库中同名 password → 现有凭据
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
			} catch {
				/* ignore missing ref */
			}
		}
		if (!effectivePassword && conn.name) {
			try {
				effectivePassword = secrets?.get?.(`${conn.name}-password`) || "";
			} catch {
				/* ignore */
			}
		}

		if (effectivePassword) {
			connectOpts.password = effectivePassword;
			connectOpts.tryKeyboard = true;
		} else {
			throw new Error("NEED_PASSWORD: 请先在上方「密码」输入框填写一次远程服务器密码，再点击「添加公钥到远端」");
		}

		// 建立临时 SSH + SFTP 连接
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
			// 获取远端用户 home 目录
			let homeDir = "";
			try {
				homeDir = await sftpCallInternal(sftp, "realpath", ".");
			} catch {
				/* fallback */
			}
			if (!homeDir || typeof homeDir !== "string" || !homeDir.startsWith("/")) {
				homeDir = conn.username === "root" ? "/root" : `/home/${conn.username}`;
			}
			homeDir = homeDir.replace(/\/+$/, "") || "/";

			const sshDir = `${homeDir}/.ssh`;
			const authKeysFile = `${sshDir}/authorized_keys`;

			// 确保 ~/.ssh 目录存在并具有 700 权限
			let sshDirStat = null;
			try {
				sshDirStat = await sftpCallInternal(sftp, "stat", sshDir);
			} catch {
				/* 目录不存在 */
			}
			if (!sshDirStat) {
				try {
					await sftpCallInternal(sftp, "mkdir", sshDir);
				} catch {
					/* 忽略已存在报错 */
				}
			}
			try {
				await sftpCallInternal(sftp, "setstat", sshDir, { mode: 0o700 });
			} catch {}

			// 读取已有 authorized_keys
			let existingContent = "";
			try {
				const buf = await sftpCallInternal(sftp, "readFile", authKeysFile);
				existingContent = buf ? buf.toString("utf8") : "";
			} catch {
				/* 文件不存在视为空 */
			}

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

		// 清理已有连接池缓存，测试密钥登录验证
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
