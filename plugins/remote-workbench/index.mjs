import { Commands, text, integer, profile } from "./lib/runtime.mjs";
import { Shells } from "./lib/shells.mjs";
import { Tasks, Tunnels } from "./lib/services.mjs";
import path from "node:path";
import { compact } from "./client/lib/compact.mjs";
import { scanLocalSshConfig, expandHome } from "./client/lib/ssh-config.mjs";

export default {
	async activate(host) {
		const log = (msg, level = "info") => {
			try {
				host.log?.(level, `[remote-workbench] ${msg}`);
			} catch {}
		};

		const getRemoteSsh = () => {
			const svc = typeof host.services?.get === "function" ? host.services.get("remoteSsh") : null;
			if (!svc) {
				throw new Error("宿主远程 SSH 服务（remoteSsh）未就绪，请确保 pi-web-ui 为最新版本");
			}
			return svc;
		};

		const commands = new Commands(host, getRemoteSsh);
		const shells = new Shells(host, getRemoteSsh, commands);
		let tasks, tunnels;
		try {
			tasks = new Tasks(host, commands);
			tunnels = new Tunnels(host, getRemoteSsh);
		} catch (error) {
			shells.dispose();
			tasks?.dispose();
			commands.dispose();
			throw error;
		}
		const hostsWithMetadata = async () => {
			const metadata = host.storage.get("hostMetadata", {});
			return (await getRemoteSsh().listProfiles()).map((p) => ({
				...p,
				group: metadata[p.name]?.group ?? "",
				environment: metadata[p.name]?.environment ?? "",
			}));
		};

		const route = (method, p, fn) => {
			host.route(method, p, async (req, res) => {
				try {
					const data = await fn(req);
					res.json({ ok: true, data: data ?? null });
				} catch (err) {
					const msg = String(err?.message ?? err);
					log(`${method} ${p} 失败: ${msg}`, "warn");
					res.status(400).json({ ok: false, error: msg });
				}
			});
		};

		route("GET", "/hosts", async () => {
			return { hosts: await hostsWithMetadata() };
		});

		route("POST", "/hosts", async (req) => {
			const remoteSsh = getRemoteSsh();
			const b = req.body ?? {};
			const hostAddr = String(b.host ?? "").trim();
			const username = String(b.username ?? "").trim() || "root";
			const port = integer(b.port, 22, 1, 65535);
			const name = String(b.name ?? "").trim() || `${username}@${hostAddr}`;
			if (!hostAddr) throw new Error("主机地址（host）不能为空");

			const auth = b.auth ?? {};
			const authType = auth.type === "key" ? "key" : auth.type === "agent" ? "agent" : "password";

			await remoteSsh.saveProfile(
				name,
				{
					host: hostAddr,
					port,
					username,
					auth: {
						type: authType,
						password: authType === "password" ? String(auth.password ?? "") : undefined,
						privateKeyPath: authType === "key" ? String(auth.privateKeyPath ?? "") : undefined,
						passphrase: authType === "key" && auth.passphrase ? String(auth.passphrase) : undefined,
					},
				},
				{
					remotePath: b.remotePath ? String(b.remotePath).trim() : undefined,
					description: b.description ? String(b.description).trim() : undefined,
					reviewMode: Boolean(b.reviewMode),
				},
			);

			return { hosts: await hostsWithMetadata(), savedName: name };
		});

		route("POST", "/hosts/delete", async (req) => {
			const remoteSsh = getRemoteSsh();
			const name = String(req.body?.name ?? "").trim();
			if (!name) throw new Error("未指定要删除的主机名称");
			const metadata = structuredClone(host.storage.get("hostMetadata", {}));
			delete metadata[name];
			host.storage.set("hostMetadata", metadata);
			await remoteSsh.deleteProfile(name);
			const list = await remoteSsh.listProfiles();
			return { hosts: list };
		});

		route("POST", "/hosts/probe", async (req) => {
			const remoteSsh = getRemoteSsh();
			const b = req.body ?? {};
			const hostAddr = String(b.host ?? "").trim();
			const username = String(b.username ?? "").trim() || "root";
			const port = integer(b.port, 22, 1, 65535);
			const name = b.name ? String(b.name).trim() : undefined;
			const auth = b.auth ?? {};
			const authType = auth.type === "key" ? "key" : auth.type === "agent" ? "agent" : "password";

			const res = await remoteSsh.probe({
				host: hostAddr,
				port,
				username,
				profileName: name,
				auth: {
					type: authType,
					password: authType === "password" && auth.password ? String(auth.password) : undefined,
					privateKeyPath: authType === "key" && auth.privateKeyPath ? String(auth.privateKeyPath) : undefined,
					passphrase: authType === "key" && auth.passphrase ? String(auth.passphrase) : undefined,
				},
			});

			if (!res.ok) {
				return {
					...res,
					connected: false,
				};
			}

			return { ...res, connected: true, system: res.system ?? {} };
		});

		route("GET", "/sshconfig", async () => {
			const remoteSsh = getRemoteSsh();
			const scanned = await scanLocalSshConfig();
			const existing = await remoteSsh.listProfiles();
			const existingNames = new Set(existing.map((h) => h.name));
			const list = scanned.list.map((h) => ({
				...h,
				imported: existingNames.has(h.alias) || existingNames.has(`${h.username}@${h.host}`),
			}));
			return { exists: scanned.exists, path: scanned.path, warnings: scanned.warnings, list };
		});

		route("POST", "/sshconfig/import", async (req) => {
			const items = req.body?.items;
			if (!Array.isArray(items) || items.length > 256) throw new Error("Invalid import items");
			const scanned = await scanLocalSshConfig();
			const selected = [...new Set(items.map((item) => text(item?.alias, "alias", 256)))].map((alias) => {
				const h = scanned.list.find((h) => h.alias === alias);
				if (!h || h.importable === false) throw new Error("Unsupported or unknown SSH config alias: " + alias);
				return h;
			});
			const imported = [];
			for (const h of selected) {
				await getRemoteSsh().saveProfile(
					h.alias,
					{
						host: h.host,
						port: h.port || 22,
						username: h.username || "root",
						auth: h.privateKeyPath ? { type: "key", privateKeyPath: expandHome(h.privateKeyPath) } : { type: "agent" },
					},
					{ description: "Imported from ~/.ssh/config (" + h.alias + ")" },
				);
				imported.push(h.alias);
			}
			return { hosts: await hostsWithMetadata(), importedCount: imported.length, imported, warnings: scanned.warnings };
		});

		route("POST", "/files/list", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const reqPath = String(req.body?.path ?? "").trim();
			if (!hostName) throw new Error("未指定主机");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);

			const homeDir = conn.system?.homeDir || "/";
			let targetPath = reqPath || targetProf.remotePath || homeDir;
			if (targetPath === "~") targetPath = homeDir;
			else if (targetPath.startsWith("~/")) targetPath = path.posix.join(homeDir, targetPath.slice(2));
			if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

			return new Promise((resolve, reject) => {
				sftp.readdir(targetPath, (err, list) => {
					if (err) return reject(new Error(`无法读取目录「${targetPath}」: ${err.message}`));
					const items = (list || []).map((it) => ({
						name: it.filename,
						path: path.posix.join(targetPath, it.filename),
						isDirectory: (it.attrs.mode & 0o170000) === 0o040000,
						size: it.attrs.size,
						mtime: it.attrs.mtime * 1000,
					}));
					items.sort((a, b) => {
						if (a.isDirectory && !b.isDirectory) return -1;
						if (!a.isDirectory && b.isDirectory) return 1;
						return a.name.localeCompare(b.name);
					});
					const parentPath = targetPath === "/" ? null : path.posix.dirname(targetPath);
					resolve({ path: targetPath, parentPath, items });
				});
			});
		});

		route("POST", "/files/read", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const remotePath = String(req.body?.path ?? "").trim();
			const maxBytes = integer(req.body?.maxBytes, 256 * 1024, 1, 512 * 1024);
			if (!hostName || !remotePath) throw new Error("缺 hostName 或 path");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);

			return new Promise((resolve, reject) => {
				sftp.open(remotePath, "r", (err, handle) => {
					if (err) return reject(err);
					const buf = Buffer.alloc(maxBytes);
					const finish = (readErr, bytesRead = 0) => {
						sftp.close(handle, (closeErr) => {
							if (readErr || closeErr) return reject(readErr || closeErr);
							const slice = buf.subarray(0, bytesRead);
							let isBinary = false;
							for (let i = 0; i < Math.min(slice.length, 512); i++) {
								if (slice[i] === 0) {
									isBinary = true;
									break;
								}
							}
							resolve({
								path: remotePath,
								size: bytesRead,
								isBinary,
								content: isBinary ? "" : slice.toString("utf8"),
							});
						});
					};
					try {
						sftp.read(handle, buf, 0, maxBytes, 0, finish);
					} catch (error) {
						finish(error);
					}
				});
			});
		});

		route("POST", "/files/upload", async (req) => {
			const remoteSsh = getRemoteSsh();
			const hostName = String(req.body?.hostName ?? "").trim();
			const targetDir = String(req.body?.targetDir ?? "").trim() || "/";
			const fileName = String(req.body?.fileName ?? "").trim();
			const b64 = req.body?.b64;
			if (!hostName || !fileName) throw new Error("缺 hostName 或 fileName");
			if (
				fileName === "." ||
				fileName === ".." ||
				/[/\\\x00-\x1f]/.test(fileName) ||
				path.posix.basename(fileName) !== fileName ||
				fileName.length > 255
			)
				throw new Error("Invalid fileName");
			if (
				typeof b64 !== "string" ||
				b64.length > 5592408 ||
				b64.length % 4 ||
				!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)
			)
				throw new Error("Invalid base64 or upload exceeds 4 MiB");
			const payload = Buffer.from(b64, "base64");
			if (payload.length > 4 * 1024 * 1024 || payload.toString("base64") !== b64)
				throw new Error("Invalid upload payload");

			const profiles = await remoteSsh.listProfiles();
			const targetProf = profiles.find((p) => p.name === hostName || p.host === hostName);
			if (!targetProf) throw new Error(`主机「${hostName}」未找到`);

			const conn = await remoteSsh.getOrConnectHost(targetProf.host, targetProf.port, targetProf.username);
			const sftp = await remoteSsh.getSftp(conn);
			const fullPath = path.posix.join(targetDir, fileName);

			return new Promise((resolve, reject) => {
				const stream = sftp.createWriteStream(fullPath, { flags: "wx" });
				stream.on("error", (err) => reject(err));
				stream.on("close", () => resolve({ ok: true, path: fullPath }));
				stream.end(payload);
			});
		});

		route("POST", "/hosts/metadata", async (req) => {
			const name = text(req.body?.name, "name", 256);
			await profile(getRemoteSsh(), name);
			const field = (v) => (v === undefined || v === "" ? "" : text(v, "metadata", 128));
			const metadata = structuredClone(host.storage.get("hostMetadata", {}));
			Object.defineProperty(metadata, name, {
				value: { group: field(req.body.group), environment: field(req.body.environment) },
				enumerable: true,
				configurable: true,
				writable: true,
			});
			host.storage.set("hostMetadata", metadata);
			return { hosts: await hostsWithMetadata() };
		});
		route("GET", "/logs", (req) =>
			commands.read(text(req.query?.logId, "logId", 128), req.query?.offset, req.query?.limit),
		);
		route("GET", "/tasks", () => ({ tasks: tasks.list(), storageError: tasks.storageError }));
		route("POST", "/tasks/start", (req) => ({ task: tasks.start(req.body ?? {}) }));
		route("POST", "/tasks/cancel", (req) => ({
			task: tasks.cancel(text(req.body?.taskId, "taskId", 128), req.body?.hostName),
		}));
		route("POST", "/tasks/retry", (req) => ({
			task: tasks.retry(text(req.body?.taskId, "taskId", 128), req.body?.hostNames),
		}));
		route("GET", "/tunnels", () => ({ tunnels: tunnels.list() }));
		route("POST", "/tunnels/save", (req) => ({ tunnel: tunnels.save(req.body ?? {}) }));
		route("POST", "/tunnels/start", async (req) => ({ tunnel: await tunnels.start(req.body ?? {}) }));
		route("POST", "/tunnels/stop", (req) => ({ tunnel: tunnels.stop(text(req.body?.tunnelId, "tunnelId", 128)) }));
		route("POST", "/tunnels/delete", (req) => tunnels.delete(text(req.body?.tunnelId, "tunnelId", 128)));
		const healthPending = new Map(),
			healthCache = new Map();
		route("POST", "/health", async (req) => {
			const hostName = text(req.body?.hostName, "hostName", 256);
			if (healthCache.get(hostName)?.checkedAt > Date.now() - 5000) return healthCache.get(hostName);
			if (healthPending.has(hostName)) return healthPending.get(hostName);
			if (healthPending.size >= 4) throw new Error("Health probe capacity reached");
			const pending = (async () => {
				const result = await commands.run({
					host: hostName,
					timeout: 10,
					cmd: "if [ -r /proc/loadavg ] && [ -r /proc/meminfo ]; then printf 'load1='; cut -d ' ' -f1 /proc/loadavg; awk '/MemTotal:/{print \"memoryTotalKb=\"$2} /MemAvailable:/{print \"memoryAvailableKb=\"$2}' /proc/meminfo; else echo 'unsupported=load,memory'; fi; df -Pk / | awk 'NR==2{print \"diskTotalKb=\"$2; print \"diskAvailableKb=\"$4}'",
				});
				const metrics = {};
				for (const line of result.output.split(/\r?\n/)) {
					const m = /^(load1|memoryTotalKb|memoryAvailableKb|diskTotalKb|diskAvailableKb)=([0-9.]+)$/.exec(line);
					if (m) metrics[m[1]] = Number(m[2]);
				}
				const value = {
					hostName,
					checkedAt: Date.now(),
					output: result.output,
					metrics,
					ok: result.ok,
					error: result.error,
				};
				if (healthCache.size >= 128) healthCache.delete(healthCache.keys().next().value);
				healthCache.set(hostName, value);
				return value;
			})();
			healthPending.set(hostName, pending);
			try {
				return await pending;
			} finally {
				healthPending.delete(hostName);
			}
		});
		host.registerAgentTool({
			name: "remote_term",
			description:
				"Execute bounded SSH commands; full logs can be read by log ID. Cancellation closes the channel but cannot guarantee remote descendants stop.",
			promptSnippet: "Run commands on configured remote SSH profiles",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["run", "list", "probe", "log"] },
					host: { type: "string" },
					cmd: { type: "string" },
					cwd: { type: "string" },
					timeout: { type: "number" },
					logId: { type: "string" },
					offset: { type: "number" },
					limit: { type: "number" },
				},
				required: ["action"],
			},
			execute: async (_id, params, signal, onUpdate) => {
				if (params.action === "list")
					return { content: [{ type: "text", text: JSON.stringify({ hosts: await hostsWithMetadata() }) }] };
				if (params.action === "log")
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(await commands.readText(params.logId, params.offset, params.limit)),
							},
						],
					};
				if (!["run", "probe"].includes(params.action)) throw new Error("Unknown action");
				const result = await commands.run(
					{
						...params,
						cmd: params.action === "probe" ? "uname -a; uptime; df -Pk /; free -k 2>/dev/null" : params.cmd,
					},
					signal,
					onUpdate,
				);
				return { content: [{ type: "text", text: JSON.stringify({ ...result, output: compact(result.output) }) }] };
			},
		});
		const unmsg = host.onMessage((msg, from) => shells.message(msg, from));
		const tick = setInterval(() => shells.tick(), 16);
		tick.unref?.();
		const sweep = setInterval(() => {
			tasks.flush();
			tasks.pump();
			commands.sweep().catch((e) => log(String(e), "warn"));
		}, 60000);
		sweep.unref?.();
		tunnels.restore();
		return () => {
			unmsg?.();
			clearInterval(tick);
			clearInterval(sweep);
			shells.dispose();
			tasks.dispose();
			tunnels.dispose();
			commands.dispose();
		};
	},
};
