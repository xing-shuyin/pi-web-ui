import net from "node:net";
import { id, text, integer, profile, closeChannel, utf8Tail } from "./runtime.mjs";

export class Tasks {
	constructor(host, commands) {
		this.host = host;
		this.commands = commands;
		this.controllers = new Map();
		this.disposed = false;
		this.active = 0;
		const stored = host.storage.get("tasks", []);
		if (
			!Array.isArray(stored) ||
			stored.length > 24 ||
			stored.some(
				(t) =>
					!t ||
					typeof t.id !== "string" ||
					!["running", "completed", "cancelled"].includes(t.status) ||
					!Array.isArray(t.items) ||
					t.items.length > 64 ||
					t.items.some(
						(i) =>
							!i ||
							typeof i.hostName !== "string" ||
							!["queued", "running", "succeeded", "failed", "cancelled"].includes(i.status),
					),
			)
		)
			throw new Error("Invalid persisted tasks; storage was not overwritten");
		this.tasks = structuredClone(stored);
		let changed = false;
		for (const task of this.tasks)
			if (task.status === "running") {
				task.status = "cancelled";
				for (const item of task.items)
					if (["running", "queued"].includes(item.status)) {
						item.status = "cancelled";
						item.error = "Service restarted; previous remote processes may continue.";
					}
				changed = true;
			}
		if (changed) this.save(this.tasks);
	}
	save(tasks) {
		this.host.storage.set("tasks", tasks);
		this.tasks = structuredClone(tasks);
	}
	finish(taskId, hostName, result, error) {
		const copy = this.list(),
			task = copy.find((t) => t.id === taskId),
			item = task?.items.find((i) => i.hostName === hostName);
		if (!item) return;
		if (item.status !== "cancelled")
			item.status = error ? "failed" : result.ok ? "succeeded" : result.cancelled ? "cancelled" : "failed";
		if (result)
			item.result = {
				...result,
				output: utf8Tail(Buffer.from(result.output), 1024).toString("utf8"),
				truncated: result.truncated || Buffer.byteLength(result.output) > 1024,
			};
		if (error) item.error = String(error.message ?? error).slice(0, 512);
		if (!task.items.some((i) => ["running", "queued"].includes(i.status)) && task.status === "running")
			task.status = "completed";
		this.tasks = copy;
		try {
			this.host.storage.set("tasks", copy);
			this.storageError = undefined;
		} catch (e) {
			this.storageError = String(e.message ?? e);
		}
	}
	flush() {
		if (!this.storageError || this.disposed) return;
		try {
			this.host.storage.set("tasks", this.tasks);
			this.storageError = undefined;
		} catch (e) {
			this.storageError = String(e.message ?? e);
		}
	}
	list() {
		return structuredClone(this.tasks);
	}
	change(taskId, fn) {
		const copy = this.list();
		const task = copy.find((t) => t.id === taskId);
		if (!task) throw new Error("Unknown task");
		fn(task);
		this.save(copy);
		return structuredClone(task);
	}
	start(b) {
		if (this.disposed) throw new Error("Runtime disposed");
		if (!Array.isArray(b.hostNames) || !b.hostNames.length || b.hostNames.length > 64)
			throw new Error("Expected 1..64 host names");
		const names = [...new Set(b.hostNames.map((v) => text(v, "hostName", 256)))];
		const task = {
			id: id(),
			cmd: text(b.cmd, "cmd", 65536),
			cwd: b.cwd ? text(b.cwd, "cwd") : "",
			timeout: integer(b.timeout, 30, 1, 3600),
			concurrency: integer(b.concurrency, 4, 1, 8),
			createdAt: Date.now(),
			status: "running",
			items: names.map((hostName) => ({ hostName, status: "queued", attempt: 0 })),
		};
		if (this.tasks.filter((t) => t.status === "running").length >= 16) throw new Error("Task capacity reached");
		const retained = this.tasks.filter((t) => t.status === "running" || t.createdAt > Date.now() - 7 * 86400000);
		while (retained.length >= 24) {
			const at = retained.findIndex((t) => t.status !== "running");
			if (at < 0) throw new Error("Task capacity reached");
			retained.splice(at, 1);
		}
		if (Buffer.byteLength(JSON.stringify([...retained, task])) > 4 * 1024 * 1024)
			throw new Error("Task storage budget reached");
		this.save([...retained, task]);
		this.pump();
		return structuredClone(task);
	}
	cancel(taskId, hostName) {
		const task = this.change(taskId, (t) => {
			if (!hostName) t.status = "cancelled";
			for (const item of t.items)
				if ((!hostName || item.hostName === hostName) && ["queued", "running"].includes(item.status))
					item.status = "cancelled";
		});
		for (const item of task.items)
			if ((!hostName || item.hostName === hostName) && item.status === "cancelled")
				this.controllers.get(`${taskId}:${item.hostName}`)?.abort();
		this.pump();
		return task;
	}
	retry(taskId, hostNames) {
		if (hostNames !== undefined && (!Array.isArray(hostNames) || hostNames.length > 64))
			throw new Error("Invalid hostNames");
		const current = this.tasks.find((t) => t.id === taskId);
		if (!current) throw new Error("Unknown task");
		if (current.items.some((i) => this.controllers.has(`${taskId}:${i.hostName}`)))
			throw new Error("Wait for running attempts to settle before retry");
		const task = this.change(taskId, (t) => {
			let count = 0;
			for (const item of t.items)
				if (["failed", "cancelled"].includes(item.status) && (!hostNames || hostNames.includes(item.hostName))) {
					item.status = "queued";
					delete item.result;
					delete item.error;
					count++;
				}
			if (!count) throw new Error("No failed attempts selected");
			t.status = "running";
		});
		this.pump();
		return task;
	}
	pump() {
		if (this.disposed || this.storageError) return;
		for (const task of this.list()) {
			if (task.status !== "running") continue;
			let running = task.items.filter((i) => this.controllers.has(`${task.id}:${i.hostName}`)).length;
			for (const item of task.items) {
				if (item.status !== "queued" || running >= task.concurrency || this.active >= 8) continue;
				try {
					this.change(task.id, (t) => {
						const i = t.items.find((i) => i.hostName === item.hostName);
						i.status = "running";
						i.attempt++;
					});
				} catch (e) {
					this.storageError = String(e.message ?? e);
					return;
				}
				const controller = new AbortController(),
					key = `${task.id}:${item.hostName}`;
				this.controllers.set(key, controller);
				running++;
				this.active++;
				this.commands
					.run({ host: item.hostName, cmd: task.cmd, cwd: task.cwd, timeout: task.timeout }, controller.signal)
					.then((result) => {
						if (this.disposed) return;
						this.finish(task.id, item.hostName, result);
					})
					.catch((e) => {
						if (!this.disposed) this.finish(task.id, item.hostName, null, e);
					})
					.finally(() => {
						this.controllers.delete(key);
						this.active--;
						try {
							this.pump();
						} catch (e) {
							this.host.log?.("error", String(e));
						}
					});
			}
			const latest = this.tasks.find((t) => t.id === task.id);
			if (latest.status === "running" && !latest.items.some((i) => ["queued", "running"].includes(i.status)))
				try {
					this.change(task.id, (t) => {
						t.status = "completed";
					});
				} catch (e) {
					this.storageError = String(e.message ?? e);
					return;
				}
		}
	}
	dispose() {
		this.disposed = true;
		for (const c of this.controllers.values()) c.abort();
	}
}

export class Tunnels {
	constructor(host, svc, createServer = net.createServer) {
		this.host = host;
		this.svc = svc;
		this.createServer = createServer;
		this.active = new Map();
		this.disposed = false;
		const stored = host.storage.get("tunnels", []);
		if (
			!Array.isArray(stored) ||
			stored.length > 64 ||
			stored.some(
				(c) =>
					!c ||
					typeof c.id !== "string" ||
					typeof c.hostName !== "string" ||
					typeof c.targetHost !== "string" ||
					!Number.isInteger(c.localPort) ||
					c.localPort < 1 ||
					c.localPort > 65535 ||
					!Number.isInteger(c.targetPort) ||
					c.targetPort < 1 ||
					c.targetPort > 65535,
			)
		)
			throw new Error("Invalid persisted tunnels; storage was not overwritten");
		this.configs = structuredClone(stored);
	}
	list() {
		return this.configs.map((c) => ({
			...c,
			status: this.active.get(c.id)?.status ?? "stopped",
			error: this.active.get(c.id)?.error,
			startedAt: this.active.get(c.id)?.startedAt,
		}));
	}
	save(b) {
		if (this.disposed) throw new Error("Runtime disposed");
		const existing = b.id ? this.configs.find((c) => c.id === b.id) : null;
		if (b.id && !existing) throw new Error("Unknown tunnel");
		if (existing && this.active.has(existing.id)) throw new Error("Stop tunnel before editing");
		const c = {
			id: existing?.id ?? id(),
			hostName: text(b.hostName, "hostName", 256),
			localPort: integer(b.localPort, undefined, 1, 65535),
			targetHost: text(b.targetHost ?? "127.0.0.1", "targetHost", 256),
			targetPort: integer(b.targetPort, undefined, 1, 65535),
			autoReconnect: b.autoReconnect === true,
		};
		const configs = [...this.configs.filter((v) => v.id !== c.id), c];
		if (configs.length > 64) throw new Error("Tunnel capacity reached");
		this.host.storage.set("tunnels", configs);
		this.configs = configs;
		return { ...c, status: "stopped" };
	}
	async start(b) {
		const c = b.id ? this.configs.find((c) => c.id === b.id) : this.save(b);
		if (!c) throw new Error("Unknown tunnel");
		if (this.disposed) throw new Error("Runtime disposed");
		if (this.active.has(c.id)) throw new Error("Tunnel already active");
		const state = { status: "connecting", sockets: new Set(), channels: new Set(), generation: 0 };
		this.active.set(c.id, state);
		try {
			await this.connect(c, state);
		} catch (e) {
			if (this.active.get(c.id) === state && state.generation === 1) {
				this.cleanup(state);
				state.status = "error";
				state.error = String(e.message ?? e);
				if (c.autoReconnect) this.reconnect(c, state);
			}
			throw e;
		}
		return this.list().find((t) => t.id === c.id);
	}
	valid(c, s, g) {
		return !this.disposed && this.active.get(c.id) === s && s.generation === g;
	}
	cleanup(s) {
		s.generation++;
		clearTimeout(s.timer);
		if (s.conn && s.disconnect) {
			s.conn.client.removeListener("close", s.disconnect);
			s.conn.client.removeListener("error", s.disconnect);
		}
		s.conn = null;
		try {
			s.server?.close();
		} catch {}
		s.server = null;
		for (const socket of s.sockets) socket.destroy();
		for (const channel of s.channels) closeChannel(channel);
		s.sockets.clear();
		s.channels.clear();
	}
	reconnect(c, s) {
		s.status = "reconnecting";
		const g = s.generation;
		s.timer = setTimeout(async () => {
			if (!this.valid(c, s, g)) return;
			try {
				await this.connect(c, s);
			} catch (e) {
				if (this.active.get(c.id) !== s || this.disposed || s.generation !== g + 1) return;
				this.cleanup(s);
				s.error = String(e.message ?? e);
				this.reconnect(c, s);
			}
		}, 3000);
		s.timer.unref?.();
	}
	async connect(c, s) {
		const g = ++s.generation;
		const p = await profile(this.svc(), c.hostName);
		if (!this.valid(c, s, g)) throw new Error("Tunnel start cancelled");
		const conn = await this.svc().getOrConnectHost(p.host, p.port, p.username);
		if (!this.valid(c, s, g)) throw new Error("Tunnel start cancelled");
		s.conn = conn;
		s.disconnect = () => {
			if (!this.valid(c, s, g)) return;
			this.cleanup(s);
			s.status = "error";
			s.error = "SSH connection closed";
			if (c.autoReconnect) this.reconnect(c, s);
		};
		conn.client.on("close", s.disconnect);
		conn.client.on("error", s.disconnect);
		const server = this.createServer((socket) => {
			if (!this.valid(c, s, g) || s.sockets.size >= 64) {
				socket.destroy();
				return;
			}
			s.sockets.add(socket);
			socket.on("error", () => socket.destroy());
			socket.on("close", () => s.sockets.delete(socket));
			conn.client.forwardOut("127.0.0.1", socket.remotePort ?? 0, c.targetHost, c.targetPort, (err, channel) => {
				if (err || !this.valid(c, s, g) || socket.destroyed) {
					closeChannel(channel);
					socket.destroy();
					return;
				}
				s.channels.add(channel);
				channel.on("error", () => {
					socket.destroy();
					closeChannel(channel);
				});
				channel.on("close", () => {
					s.channels.delete(channel);
					socket.destroy();
				});
				socket.on("close", () => {
					s.channels.delete(channel);
					closeChannel(channel);
				});
				socket.pipe(channel).pipe(socket);
			});
		});
		s.server = server;
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Tunnel listen timeout")), 10000);
			timer.unref?.();
			server.once("listening", () => {
				clearTimeout(timer);
				resolve();
			});
			server.once("close", () => {
				clearTimeout(timer);
				reject(new Error("Tunnel closed before listening"));
			});
			server.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
				if (s.status === "listening") s.disconnect();
			});
			server.listen(c.localPort, "127.0.0.1");
		});
		if (!this.valid(c, s, g)) {
			try {
				server.close();
			} catch {}
			throw new Error("Tunnel start cancelled");
		}
		s.status = "listening";
		s.error = undefined;
		s.startedAt = Date.now();
	}
	stop(tunnelId) {
		const c = this.configs.find((c) => c.id === tunnelId);
		if (!c) throw new Error("Unknown tunnel");
		const s = this.active.get(tunnelId);
		this.active.delete(tunnelId);
		if (s) this.cleanup(s);
		return { ...c, status: "stopped" };
	}
	delete(tunnelId) {
		if (!this.configs.some((c) => c.id === tunnelId)) throw new Error("Unknown tunnel");
		const configs = this.configs.filter((c) => c.id !== tunnelId);
		this.host.storage.set("tunnels", configs);
		this.stop(tunnelId);
		this.configs = configs;
		return { deleted: true };
	}
	restore() {
		for (const c of this.configs)
			if (c.autoReconnect) this.start({ id: c.id }).catch((e) => this.host.log?.("warn", String(e)));
	}
	dispose() {
		this.disposed = true;
		for (const s of this.active.values()) this.cleanup(s);
		this.active.clear();
	}
}
