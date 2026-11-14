import { randomUUID, createHash } from "node:crypto";
import { resolve, basename, isAbsolute } from "node:path";

const MAX_BYTES = 20 * 1024 * 1024;
const OUTPUT_BYTES = 256 * 1024;

function parseCommand(text) {
	const trimmed = text.trim();
	const [token = ""] = trimmed.split(/\s+/);
	return { command: token.normalize("NFKC").toLowerCase(), arg: trimmed.slice(token.length).trim() };
}

function appendAssistant(run, message, budget = OUTPUT_BYTES) {
	const content = message.content;
	if (Array.isArray(content) && content.some((part) => part.type === "toolCall" || part.type === "tool_call")) {
		run.text = "";
		run.truncated = false;
		return;
	}
	const text =
		(typeof content === "string"
			? content
			: (Array.isArray(content) ? content : [])
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("\n")) + "\n";
	const bytes = Buffer.from(text);
	const remaining = Math.max(0, Math.min(OUTPUT_BYTES, budget));
	run.text = bytes.subarray(0, remaining).toString("utf8");
	run.truncated = bytes.length > remaining;
}
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function installChannelBehavior(Bridge, platform, api, extract, chunk, strip) {
	const discord = platform === "discord";
	Object.assign(Bridge.prototype, {
		async reply(route, text, canSend = () => true) {
			const cfg = this.getConfig();
			try {
				for (const part of chunk(text, discord ? 1900 : 3800)) {
					if (!canSend()) return;
					if (discord)
						await api(cfg.botToken, "POST", `/channels/${route.channelId}/messages`, {
							content: part,
							allowed_mentions: { parse: [] },
						});
					else
						await api(cfg.botToken, "chat.postMessage", {
							channel: route.channelId,
							thread_ts: route.threadTs,
							text: part,
						});
				}
			} catch (error) {
				if (!canSend()) return;
				this.status.lastError = `Delivery failed: ${error.message}`;
				this.host.notify?.("error", this.status.lastError);
				throw error;
			}
		},
		revokeRuns() {
			this.sendGeneration = (this.sendGeneration || 0) + 1;
			for (const run of [
				...(this.ownedRuns?.values() || []),
				...(this.webRuns?.values() || []),
				...(this.dispatches || []),
			]) {
				run.cancelled = true;
				run.state.busy = false;
				run.state.downloadController?.abort();
			}
			this.ownedRuns?.clear();
			this.webRuns?.clear();
			this.dispatches?.clear();
		},
		revokeRoutes() {
			this.revokeRuns();
			for (const state of this.channelStates?.values() || []) state.cancelled = true;
			this.channelStates?.clear();
			this.sessionRoutes?.clear();
		},
		accountFingerprint() {
			return createHash("sha256")
				.update(String(this.getConfig()?.botToken || ""))
				.digest("hex");
		},
		async restoreRoutes() {
			const saved = await this.host.storage?.get("sessionRoutes");
			if (saved?.account !== this.accountFingerprint()) {
				this.revokeRoutes();
				await this.saveRoutes();
				return;
			}
			this.channelStates = new Map((saved.states || []).map(([key, state]) => [key, { ...state, busy: false }]));
			this.sessionRoutes = new Map(saved.routes || []);
		},
		async saveRoutes() {
			const saved = JSON.parse(
				JSON.stringify({
					account: this.accountFingerprint(),
					states: [...(this.channelStates || [])].map(([key, s]) => [
						key,
						{
							key,
							account: s.account,
							epoch: s.epoch,
							conversationId: s.conversationId,
							cwd: s.cwd,
							model: s.model,
							thinkingLevel: s.thinkingLevel,
						},
					]),
					routes: [...(this.sessionRoutes || [])].filter(([key]) => key.startsWith("session:")),
				}),
			);
			this.routeSave = (this.routeSave || Promise.resolve())
				.catch(() => {})
				.then(() => this.host.storage?.set("sessionRoutes", saved));
			try {
				await this.routeSave;
			} catch (error) {
				this.status.lastError = `Route save failed: ${error.message}`;
				this.host.notify?.("error", this.status.lastError);
				throw error;
			}
		},
		sessionKey(identity) {
			return identity.sessionId
				? `session:${identity.sessionId}`
				: identity.clientId && identity.conversationId
					? `owner:${JSON.stringify([identity.clientId, identity.conversationId])}`
					: "";
		},
		validRoute(binding) {
			const state = this.channelStates?.get(binding?.key);
			return state && !state.cancelled && state.epoch === binding.epoch && state.account === this.accountFingerprint();
		},
		async bindRoute(identity, run) {
			if (run.cancelled || run.state.cancelled || run.state.account !== this.accountFingerprint()) return;
			const key = this.sessionKey(identity);
			if (!key) return;
			this.sessionRoutes ??= new Map();
			const previous = this.sessionRoutes.get(key);
			if (previous?.ambiguous || (this.validRoute(previous) && previous.key !== run.state.key)) {
				this.sessionRoutes.set(key, { ambiguous: true });
			} else this.sessionRoutes.set(key, { key: run.state.key, epoch: run.state.epoch, route: run.route });
			await this.saveRoutes();
		},
		stateFor(route) {
			this.channelStates ??= new Map();
			const key = JSON.stringify([route.userId, route.channelId, route.sessionThread ?? route.threadTs ?? ""]);
			const previous = this.channelStates.get(key);
			if (previous && previous.account !== this.accountFingerprint()) this.resetState(route);
			if (!this.channelStates.has(key))
				this.channelStates.set(key, {
					key,
					account: this.accountFingerprint(),
					conversationId: `${platform}_${randomUUID()}`,
					epoch: randomUUID(),
				});
			return this.channelStates.get(key);
		},
		resetState(route) {
			const key = JSON.stringify([route.userId, route.channelId, route.sessionThread ?? route.threadTs ?? ""]);
			const old = this.channelStates?.get(key) || this.stateFor(route);
			old.cancelled = true;
			old.downloadController?.abort();
			if (old.runId) {
				this.ownedRuns?.delete(old.runId);
				void Promise.resolve()
					.then(() => this.host.abortRun(old.runId))
					.catch(() => {});
			}
			for (const run of this.dispatches || []) {
				if (run.state === old) this.dispatches.delete(run);
			}
			const state = {
				key: old.key,
				account: this.accountFingerprint(),
				conversationId: `${platform}_${randomUUID()}`,
				epoch: randomUUID(),
				cwd: old.cwd,
				model: old.model,
				thinkingLevel: old.thinkingLevel,
			};
			this.channelStates.set(old.key, state);
			for (const [key, binding] of this.sessionRoutes || [])
				if (binding.key === old.key) this.sessionRoutes.delete(key);
			return state;
		},
		async handleSlashCommand(text, route) {
			const state = this.stateFor(route);
			const cfg = this.getConfig();
			const { command, arg } = parseCommand(text);
			let answer;
			switch (command.toLowerCase()) {
				case "/help":
					answer =
						"/help /new /clear /reset [prompt] /status /stop (/abort) /model [provider/id|default] /thinking [off|minimal|low|medium|high|xhigh|default] /cwd (/workspace) [absolute path]. Reset commands start a fresh conversation and optionally run a prompt. Commands are plain messages; mention the bot in channels. Settings apply to the next message.";
					break;
				case "/stop":
				case "/abort": {
					if (state.downloadController) {
						state.downloadController.abort();
						answer = "Download cancelled; no model dispatch.";
						break;
					}
					const result = state.runId ? await this.host.abortRun(state.runId) : null;
					answer = result?.ok
						? "Stop requested."
						: `Stop failed: ${result?.error || "no stable runId; stop this run in the web conversation"}`;
					break;
				}
				case "/new":
				case "/clear":
				case "/reset":
					{
						const fresh = this.resetState(route);
						await this.saveRoutes();
						if (arg) return { prompt: arg, state: fresh };
					}
					answer = "Started a fresh conversation (history retained).";
					break;
				case "/model":
					if (arg) {
						if (state.busy) {
							answer = "Run active. Stop and wait before changing model.";
							break;
						}
						this.resetState(route).model = arg.toLowerCase() === "default" ? undefined : arg;
					}
					answer = `Model: ${state.model || cfg.model || "host default"}${arg ? "; applied on next message, host validates availability." : ""}`;
					break;
				case "/thinking": {
					const level = arg.toLowerCase();
					if (level && level !== "default" && !THINKING.includes(level)) {
						answer = `Invalid thinking level. Use ${THINKING.join(", ")} or default.`;
						break;
					}
					if (level) {
						if (state.busy) {
							answer = "Run active. Stop and wait before changing thinking level.";
							break;
						}
						this.resetState(route).thinkingLevel = level === "default" ? undefined : level;
					}
					answer = `Thinking: ${state.thinkingLevel || cfg.thinkingLevel || "host default"}; applied on next message.`;
					break;
				}
				case "/cwd":
				case "/workspace":
					if (arg) {
						if (!isAbsolute(arg)) throw new Error("Workspace must be an absolute path");
						const dir = await this.host.fs.statPath(arg);
						if (dir.type !== "dir") throw new Error("Workspace must be an accessible directory");
						if (state.cancelled) return true;
						this.resetState(route).cwd = arg;
					}
					answer = `Workspace: ${this.stateFor(route).cwd || cfg.workspace || this.host.cwd}`;
					break;
				case "/status":
					answer = `Connection: ${this.status.state}; conversation: ${state.conversationId}; running: ${Boolean(state.busy)}; model: ${state.model || cfg.model || "host default"}; thinking: ${state.thinkingLevel || cfg.thinkingLevel || "host default"}; cwd: ${state.cwd || cfg.workspace || this.host.cwd}; last error: ${this.status.lastError || "none"}`;
					break;
				default:
					answer = `Unknown command: ${command}. Use /help.`;
			}
			await this.saveRoutes();
			await this.reply(route, answer);
			return true;
		},
		async inbound(event) {
			if (
				!event ||
				(discord
					? event.author?.bot
					: event.bot_id || event.subtype === "bot_message" || (event.subtype && event.subtype !== "file_share"))
			)
				return;
			const userId = discord ? event.author?.id : event.user;
			const channelId = discord ? event.channel_id : event.channel;
			const botId = discord ? this.botUser?.id : this.botUser?.user_id;
			if (!userId || !channelId || userId === botId) return;
			const direct = discord ? !event.guild_id : event.channel_type === "im";
			if (
				!direct &&
				(!botId || !(discord ? event.mentions?.some((u) => u.id === botId) : event.text?.includes(`<@${botId}>`)))
			)
				return;
			const route = {
				userId,
				channelId,
				threadTs: discord ? undefined : event.thread_ts || event.ts,
				sessionThread: discord ? "" : event.thread_ts || (direct ? "" : event.ts),
			};
			const cfg = this.getConfig();
			const allowed = (cfg.allowedUsers || [])
				.map(String)
				.map((s) => s.trim())
				.filter(Boolean);
			// 安全默认：白名单为空=拒绝所有发送者（需显式 allowAllSenders:true 才放行）。
			if (allowed.length > 0 ? !allowed.includes(String(userId)) : cfg.allowAllSenders !== true) {
				await this.reply(
					route,
					"Access restricted: no whitelist configured, denying by default. Ask the admin to add your ID or enable allowAllSenders.",
				);
				return;
			}
			let text = extract(discord ? event : event.text, botId);
			const files = discord ? event.attachments || [] : event.files || [];
			if (!text && !files.length) return;
			let state = this.stateFor(route);
			let acquired = false;
			try {
				if (parseCommand(text).command.startsWith("/")) {
					const result = await this.handleSlashCommand(text, route);
					if (!result?.state || result.state.cancelled) return;
					text = result.prompt;
					state = result.state;
				}
				if (state.busy) {
					await this.reply(route, "Run active. Wait or use /stop.");
					return;
				}
				state.busy = true;
				acquired = true;
				if (files.length > 16) throw new Error("At most 16 files per message");
				const imageFiles = files.filter((file) =>
					["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.content_type || file.mimetype),
				);
				if (
					imageFiles.length > 8 ||
					imageFiles.some((file) => file.size > 10 * 1024 * 1024) ||
					imageFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0) > MAX_BYTES
				)
					throw new Error("Image limit: 8 images, 10 MiB each, 20 MiB total");
				const cwd = state.cwd || cfg.workspace || this.host.cwd;
				state.downloadController = new AbortController();
				const controller = state.downloadController;
				const attachments = [];
				let imageCount = 0,
					imageBytes = 0;
				for (const file of files) {
					const path = await downloadMedia(this.host, platform, cfg.botToken, cwd, file, controller.signal);
					if (state.cancelled) return;
					const name = file.filename || file.name || basename(path);
					const mimeType = file.content_type || file.mimetype || "application/octet-stream";
					if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
						const bytes = await this.host.fs.readPath(path);
						imageCount++;
						imageBytes += bytes.length;
						if (imageCount > 8 || bytes.length > 10 * 1024 * 1024 || imageBytes > MAX_BYTES)
							throw new Error("Image limit: 8 images, 10 MiB each, 20 MiB total");
						attachments.push({ path, imageData: bytes.toString("base64"), mimeType, name });
					} else {
						attachments.push({ path, mode: "reference", name });
						text += `\nAttachment saved at ${JSON.stringify(path)}. Use read with this path. Audio/video require decoding/transcription tools; report unavailable decoding explicitly.`;
						await this.reply(
							route,
							`Downloaded ${name} as a file reference. ${mimeType.startsWith("image/") ? "Unsupported image type for direct vision." : mimeType.startsWith("audio/") || mimeType.startsWith("video/") ? "Audio/video are not automatically decoded or transcribed." : "File content requires a suitable reader; unknown formats may not be decodable."}`,
						);
					}
				}
				if (state.cancelled) return;
				controller.signal.throwIfAborted();
				state.downloadController = null;
				this.status.messagesReceived++;
				this.status.lastMessageAt = Date.now();
				this.dispatches ??= new Set();
				this.ownedRuns ??= new Map();
				const run = { route, state, text: "", events: new Map(), truncated: false };
				this.dispatches.add(run);
				try {
					await this.saveRoutes();
					const result = await this.host.chat({
						text: text || "Inspect the attached images.",
						...(attachments.length ? { attachments } : {}),
						accountId: `${platform}_${createHash("sha256")
							.update(JSON.stringify([userId, channelId, route.sessionThread, state.epoch]))
							.digest("hex")
							.slice(0, 24)}`,
						conversationId: state.conversationId,
						cwd,
						model: state.model || cfg.model || undefined,
						thinkingLevel: state.thinkingLevel || cfg.thinkingLevel || undefined,
					});
					if (state.cancelled || run.cancelled || state.account !== this.accountFingerprint()) {
						if (result?.runId) await this.host.abortRun(result.runId);
						return;
					}
					if (result?.ok === false || !result?.conversationId || !result?.runId)
						throw new Error(result?.error || "Host did not return conversationId and stable runId");
					state.conversationId = result.conversationId;
					run.runId = result.runId;
					state.runId = result.runId;
					this.ownedRuns.set(result.runId, run);
					await this.bindRoute(result, run);
					this.dispatches.delete(run);
					const early = run.events.get(result.runId);
					if (early) {
						run.text = early.text;
						run.truncated = early.truncated;
						if (early.end) await this.handleRunEvent(early.end);
					}
					run.events.clear();
				} finally {
					this.dispatches.delete(run);
				}
			} catch (error) {
				if (state.cancelled) return;
				if (acquired) {
					state.busy = false;
					state.downloadController = null;
				}
				this.status.lastError = error.message;
				await this.reply(route, `Failed: ${error.message}`);
			}
		},
		async handleRunEvent(ev) {
			this.completedRuns ??= new Set();
			if (ev.runId && this.completedRuns.has(ev.runId)) return;
			this.webRuns ??= new Map();
			const key = this.sessionKey(ev);
			let run = ev.runId ? this.ownedRuns?.get(ev.runId) : this.webRuns.get(key);
			if (!ev.runId && !run && ev.type === "run_start" && key) {
				const binding = this.sessionRoutes?.get(key);
				if (!this.validRoute(binding)) return;
				const state = this.channelStates.get(binding.key);
				if (state.busy) return;
				state.busy = true;
				run = { state, route: binding.route, text: "", truncated: false, web: true };
				this.webRuns.set(key, run);
			}
			if (!run && ev.runId) {
				for (const pending of this.dispatches || []) {
					if (ev.type !== "run_end" && !(ev.type === "message" && ev.message?.role === "assistant")) continue;
					let early = pending.events.get(ev.runId);
					if (!early) {
						early = { text: "", truncated: false };
						pending.events.set(ev.runId, early);
					}
					if (ev.type === "run_end") early.end = ev;
					else {
						if (pending.events.size > 64) pending.events.delete(pending.events.keys().next().value);
						const used =
							[...pending.events.values()].reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) -
							Buffer.byteLength(early.text);
						appendAssistant(early, ev.message, Math.max(0, OUTPUT_BYTES - used));
					}
				}
				return;
			}
			if (
				!run ||
				run.state.cancelled ||
				run.state.account !== this.accountFingerprint() ||
				(!run.web && run.state.runId !== ev.runId)
			)
				return;
			if (ev.type === "message" && ev.message?.role === "assistant") {
				appendAssistant(run, ev.message);
			}
			if (ev.type === "run_end") {
				if (run.web) this.webRuns.delete(key);
				else {
					this.ownedRuns.delete(ev.runId);
					this.completedRuns.add(ev.runId);
					while (this.completedRuns.size > 500) this.completedRuns.delete(this.completedRuns.values().next().value);
				}
				run.state.busy = false;
				if (run.state.runId === ev.runId) run.state.runId = undefined;
				const epoch = run.state.epoch;
				const generation = this.sendGeneration || 0;
				const canSend = () =>
					generation === (this.sendGeneration || 0) &&
					!run.cancelled &&
					!run.state.cancelled &&
					run.state.account === this.accountFingerprint() &&
					run.state.epoch === epoch &&
					this.stateFor(run.route) === run.state;
				await this.reply(
					run.route,
					[
						strip(run.text),
						run.truncated ? "Output truncated; inspect host conversation for full result." : "",
						ev.stopReason === "aborted"
							? "Run stopped."
							: ev.isError || ev.stopReason === "error"
								? "Run failed. Check host logs."
								: "",
					]
						.filter(Boolean)
						.join("\n\n") || "Task completed (no text output).",
					canSend,
				);
				if (!canSend()) return;
				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			}
		},
	});
	Bridge.prototype[discord ? "onInboundMessage" : "onInboundEvent"] = Bridge.prototype.inbound;
}

export async function downloadMedia(host, platform, token, cwd, file, signal) {
	signal?.throwIfAborted();
	const raw = file.url_private_download || file.url_private || file.url;
	const url = new URL(raw);
	const allowed = platform === "discord" ? ["cdn.discordapp.com", "media.discordapp.net"] : ["files.slack.com"];
	if (url.protocol !== "https:" || !allowed.includes(url.hostname)) throw new Error("Untrusted attachment URL");
	if (file.size > MAX_BYTES) throw new Error("Attachment exceeds 20 MiB");
	const response = await fetch(url, {
		headers: platform === "slack" ? { Authorization: `Bearer ${token}` } : {},
		redirect: "error",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`Attachment download HTTP ${response.status}`);
	const pieces = [];
	let size = 0;
	for await (const part of response.body) {
		size += part.length;
		if (size > MAX_BYTES) throw new Error("Attachment exceeds 20 MiB");
		pieces.push(part);
	}
	signal?.throwIfAborted();
	const dir = resolve(cwd, ".channel-attachments", platform);
	await host.fs.mkdirPath(dir);
	const name = basename(file.filename || file.name || "attachment")
		.replace(/[^\w.\-]/g, "_")
		.slice(-100);
	const path = resolve(dir, `${randomUUID()}-${name}`);
	await host.fs.writePath(path, Buffer.concat(pieces));
	return path;
}

export async function sendMedia(host, platform, api, cfg, route, args) {
	const path = String(args.file || args.image || args.audio || args.video || "");
	if (!path) throw new Error("Local media path is required");
	const meta = await host.fs.statPath(path);
	if (meta.type !== "file" || meta.size > MAX_BYTES) throw new Error("Media must be a file up to 20 MiB");
	const data = await host.fs.readPath(path);
	if (data.length > MAX_BYTES) throw new Error("Media exceeds 20 MiB");
	const name = basename(path);
	if (platform === "discord") {
		const form = new FormData();
		form.set("payload_json", JSON.stringify({ content: args.text || "", allowed_mentions: { parse: [] } }));
		form.set("files[0]", new Blob([data]), name);
		const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(route.channelId)}/messages`, {
			method: "POST",
			headers: { Authorization: `Bot ${cfg.botToken}` },
			body: form,
			signal: AbortSignal.timeout(60000),
		});
		if (!res.ok) throw new Error(`Discord upload HTTP ${res.status}`);
		return res.json();
	}
	const upload = await api(cfg.botToken, "files.getUploadURLExternal", { filename: name, length: data.length });
	const url = new URL(upload.upload_url);
	if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) throw new Error("Untrusted Slack upload URL");
	const res = await fetch(url, { method: "POST", body: data, redirect: "error", signal: AbortSignal.timeout(60000) });
	if (!res.ok) throw new Error(`Slack upload HTTP ${res.status}`);
	return api(cfg.botToken, "files.completeUploadExternal", {
		files: [{ id: upload.file_id, title: name }],
		channel_id: route.channelId,
		thread_ts: route.threadTs,
		initial_comment: args.text || undefined,
	});
}
