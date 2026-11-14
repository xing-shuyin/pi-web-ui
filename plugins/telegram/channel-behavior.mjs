import { createHash, randomUUID } from "node:crypto";
import { SessionRoutes } from "./session-routes.mjs";
import { mkdir, writeFile, stat, realpath, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const HELP =
	"Telegram 机器人帮助: /help /new [prompt] (/clear /reset) /status /stop (/abort) /model [provider/id] /thinking [off|minimal|low|medium|high|xhigh] /cwd [absolute path] (/workspace)";

export function parseCommand(text) {
	const match = text.match(/^([/／][^\s　]+)(?:[\s　]+([\s\S]*))?$/u);
	if (!match) return null;
	const head = match[1].normalize("NFKC").toLowerCase();
	const command = head.match(/^\/([a-z][a-z0-9_]*)(?:@(\w+))?$/);
	if (!command) return null;
	const aliases = { clear: "new", reset: "new", abort: "stop", workspace: "cwd" };
	return { cmd: `/${aliases[command[1]] || command[1]}`, bot: command[2], value: (match[2] || "").trim() };
}
const LIMIT = 20 * 1024 * 1024;
export async function validateWorkspace(value) {
	if (!path.isAbsolute(value)) throw new Error("Workspace must be an absolute path.");
	const resolved = await realpath(value);
	if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace must be a directory.");
	const forbidden = [
		path.parse(resolved).root,
		homedir(),
		process.env.SystemRoot,
		"/etc",
		"/usr",
		"/bin",
		"/sbin",
		"/proc",
		"/sys",
		"/dev",
	].filter(Boolean);
	if (forbidden.some((p) => path.resolve(p).toLowerCase() === resolved.toLowerCase()))
		throw new Error("Home roots and system directories cannot be workspaces.");
	return resolved;
}
async function bytes(response) {
	if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
	if (Number(response.headers?.get("content-length")) > LIMIT) throw new Error("Media exceeds 20 MiB.");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > LIMIT) {
			await response.body.cancel?.().catch(() => {});
			throw new Error("Media exceeds 20 MiB.");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
export async function uploadMedia(api, token, args, options) {
	const kind =
		args.media_type ||
		(args.photo ? "photo" : args.video ? "video" : args.audio ? "audio" : args.voice ? "voice" : "document");
	const types = {
		photo: "sendPhoto",
		video: "sendVideo",
		audio: "sendAudio",
		voice: "sendVoice",
		document: "sendDocument",
		animation: "sendAnimation",
	};
	if (!types[kind]) throw new Error("Unsupported media_type.");
	const source = args.media || args[kind] || args.file;
	if (!source) throw new Error("Media path or URL is required.");
	let data, name;
	if (/^https?:\/\//i.test(source)) {
		const url = new URL(source);
		name = path.basename(url.pathname) || "media";
		data = await bytes(await fetch(url, { signal: AbortSignal.timeout(35000) }));
	} else {
		if (!(await stat(source)).isFile()) throw new Error("Media must be a file.");
		if ((await stat(source)).size > LIMIT) throw new Error("Media exceeds 20 MiB.");
		data = await readFile(source);
		name = path.basename(source);
	}
	const form = new FormData();
	form.set("chat_id", args.chat_id);
	if (args.message_thread_id) form.set("message_thread_id", String(args.message_thread_id));
	if (args.text) form.set("caption", args.text);
	form.set(kind, new Blob([data]), name);
	return api(token, types[kind], form, options);
}
export class ChannelBehavior {
	async routesReady() {
		this.peerEpochs ||= new Map();
		this.sessionRouting ||= new SessionRoutes(this);
		await this.sessionRouting.ready();
	}
	peer(msg) {
		return `${msg.chat.id}:${msg.message_thread_id || 0}:${msg.from.id}`;
	}
	async send(msg, text) {
		const cfg = this.getConfig();
		return this.api(
			cfg.botToken,
			"sendMessage",
			{
				chat_id: msg.chat.id,
				...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
				reply_to_message_id: msg.message_id,
				text,
			},
			{ apiBase: cfg.apiBase },
		);
	}
	peerController(peer) {
		this.peerCancels ||= new Map();
		if (!this.peerCancels.has(peer)) this.peerCancels.set(peer, new AbortController());
		return this.peerCancels.get(peer);
	}
	invalidatePeer(peer, reset = true) {
		this.peerController(peer).abort();
		this.peerCancels.delete(peer);
		this.peerQueues?.delete(peer);
		if (reset) {
			this.userConversations.delete(peer);
			this.peerEpochs.set(peer, randomUUID());
			this.sessionRouting?.revoke(peer);
		}
		const runs = [...this.pendingRuns.entries()].filter(([, run]) => run.peer === peer);
		for (const [id] of runs) this.pendingRuns.delete(id);
		return runs;
	}
	async abortRuns(runs) {
		const results = await Promise.allSettled(runs.filter(([, run]) => !run?.web).map(([id]) => this.host.abortRun(id)));
		if (runs.some(([, run]) => run?.web))
			throw new Error("Web run reply detached; host cannot precisely abort a run without runId.");
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
			if (result.value?.ok === false) throw new Error(result.value.error || "Abort failed");
		}
	}
	async onInboundMessage(msg, promptOverride) {
		const generation = this.stopGeneration || 0;
		await this.routesReady();
		if (generation !== (this.stopGeneration || 0)) return;
		const cfg = this.getConfig();
		if (!msg?.chat?.id || !msg.from?.id || msg.from.is_bot) return;
		const user = String(msg.from.id);
		const tgAllowed = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.map(String) : [];
		// 安全默认：白名单为空=拒绝所有发送者（需显式 allowAllSenders:true 才放行，公开场景用）。
		if (tgAllowed.length > 0 ? !tgAllowed.includes(user) : cfg.allowAllSenders !== true) {
			await this.send(
				msg,
				"访问受限：该机器人未配置白名单，默认拒绝所有人。请管理员配置白名单或显式开启 allowAllSenders 后再试。",
			);
			return;
		}
		let text = String(promptOverride ?? (msg.text || msg.caption || "")).trim();
		const bot = this.status.botUsername;
		const command = promptOverride === undefined ? parseCommand(text) : null;
		if (command?.bot && command.bot !== bot.toLowerCase()) return;
		if (promptOverride === undefined && msg.chat.type !== "private") {
			const mentioned = command?.bot || (bot && text.toLowerCase().includes(`@${bot.toLowerCase()}`));
			const replying = Boolean(this.botInfo?.id && msg.reply_to_message?.from?.id === this.botInfo.id);
			if (!mentioned && !replying) return;
		}
		if (bot && !command) text = text.replace(new RegExp(`@${bot}\\b`, "gi"), "").trim();
		const peer = this.peer(msg);
		this.preferences ||= new Map();
		this.peerQueues ||= new Map();
		this.peerEpochs ||= new Map();
		this.peerCancels ||= new Map();
		const controller = this.peerController(peer);
		if (command) {
			try {
				await this.handleCommand(msg, peer, command, controller);
			} catch (err) {
				await this.send(msg, `❌ ${err.message}`);
			}
			return;
		}
		const epoch = this.peerEpochs.get(peer) || 0;
		const previous = this.peerQueues.get(peer) || Promise.resolve();
		const work = previous
			.catch(() => {})
			.then(async () => {
				try {
					if (controller.signal.aborted) return;
					const media =
						msg.photo?.at(-1) || msg.voice || msg.audio || msg.document || msg.video || msg.video_note || msg.animation;
					if (!text && !media) {
						await this.send(msg, "Unsupported message. Send text, a photo, voice, audio, document or video.");
						return;
					}
					let attachments;
					if (media) {
						const downloaded = await this.downloadMedia(media, msg, controller.signal);
						text += downloaded.prompt;
						attachments = [downloaded.attachment];
					}
					const pref = this.preferences.get(peer) || {};
					const cwd = await validateWorkspace(pref.cwd || cfg.workspace || this.host.cwd || process.cwd());
					const current = this.userConversations.get(peer);
					const req = {
						text,
						attachments,
						accountId: `tg_${createHash("sha256").update(`${this.sessionRouting.accountId}:${peer}:${epoch}`).digest("hex").slice(0, 16)}`,
						cwd,
						model: pref.model || cfg.model || undefined,
						thinkingLevel: pref.thinking || cfg.thinkingLevel || undefined,
					};
					if (current) req.conversationId = current;
					if (controller.signal.aborted) return;
					this.inflight = (this.inflight || 0) + 1;
					try {
						const receipt = await this.host.chat(req);
						if (!receipt?.conversationId || !receipt?.runId || receipt.ok === false)
							throw new Error(receipt?.error || "Host did not return conversationId and runId.");
						if (controller.signal.aborted) {
							this.earlyRuns.delete(receipt.runId);
							await this.abortRuns([[receipt.runId]]);
							return;
						}
						this.userConversations.set(peer, receipt.conversationId);
						const route = this.sessionRouting.bind(receipt, peer, msg);
						const run = {
							peer,
							msg,
							controller,
							route,
							sessionId: receipt.sessionId,
							conversationId: receipt.conversationId,
							accumulatedText: "",
						};
						this.pendingRuns.set(receipt.runId, run);
						const events = this.earlyRuns.get(receipt.runId) || [];
						this.earlyRuns.delete(receipt.runId);
						for (const ev of events) if (ev) await this.handleRunEvent(ev);
					} finally {
						this.inflight--;
						if (!this.inflight) this.earlyRuns.clear();
					}
					this.status.messagesReceived++;
					this.status.lastMessageAt = Date.now();
				} catch (err) {
					if (controller.signal.aborted) return;
					this.status.lastError = err.message;
					this.log("warn", `Telegram request failed: ${err.message}`);
					await this.send(msg, `❌ ${err.message}`).catch((e) =>
						this.log("warn", `Telegram failure delivery failed: ${e.message}`),
					);
				}
			});
		this.peerQueues.set(peer, work);
		try {
			await work;
		} finally {
			if (this.peerQueues.get(peer) === work) this.peerQueues.delete(peer);
		}
	}
	async downloadMedia(media, msg, signal) {
		if (media.file_size > LIMIT) throw new Error("Media exceeds 20 MiB.");
		const cfg = this.getConfig();
		const meta = await this.api(cfg.botToken, "getFile", { file_id: media.file_id }, { apiBase: cfg.apiBase, signal });
		if (signal?.aborted) throw new Error("Cancelled");
		if (!meta?.file_path) throw new Error("Telegram did not return a file path.");
		const base = (cfg.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
		const data = await bytes(
			await fetch(`${base}/file/bot${cfg.botToken}/${meta.file_path}`, {
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
			}),
		);
		const dir = path.join(tmpdir(), "pi-telegram-media");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const name = path.basename(media.file_name || meta.file_path).replace(/[^a-zA-Z0-9._-]/g, "_");
		const file = path.join(dir, `${randomUUID()}-${name}`);
		await writeFile(file, data, { flag: "wx", mode: 0o600 });
		const audiovisual = msg.voice || msg.audio || msg.video || msg.video_note;
		const mimeType = media.mime_type || (msg.photo ? "image/jpeg" : "application/octet-stream");
		const image = Boolean(msg.photo) || ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
		if (image && data.length > 10 * 1024 * 1024) throw new Error("Image exceeds 10 MiB.");
		const attachment = image
			? { path: "", imageData: data.toString("base64"), mimeType, name }
			: { path: file, mode: "reference", name };
		return {
			attachment,
			prompt: `\nTelegram media saved locally: ${JSON.stringify(file)}. Use read with this local file path when needed.${audiovisual ? " Audio/video is not decoded or transcribed by this plugin. If your tools cannot decode it, explicitly tell the user and request a transcript or supported still image." : " If the file cannot be decoded, explicitly tell the user."}`,
		};
	}
	async handleCommand(msg, peer, { cmd, value }, controller) {
		const pref = { ...(this.preferences.get(peer) || {}) };
		const runs = [...this.pendingRuns.entries()].filter(([, r]) => r.peer === peer);
		if (cmd === "/new" || cmd === "/stop") {
			const oldRuns = this.invalidatePeer(peer, cmd === "/new");
			const follow = cmd === "/new" && value ? this.onInboundMessage(msg, value) : Promise.resolve();
			await Promise.all([this.abortRuns(oldRuns), follow]);
			await this.send(
				msg,
				cmd === "/new"
					? "✅ New conversation. Peer preferences retained; stored history was not deleted."
					: "✅ Stopped.",
			);
			return;
		}
		if (cmd === "/help" || cmd === "/start") {
			await this.send(msg, HELP);
			return;
		}
		if (cmd === "/status") {
			await this.send(
				msg,
				`Conversation: ${this.userConversations.get(peer) || "new"}\nRunning: ${runs.length}\nModel: ${pref.model || this.getConfig().model || "default"}\nThinking: ${pref.thinking || this.getConfig().thinkingLevel || "default"}\nCwd: ${pref.cwd || this.getConfig().workspace || this.host.cwd || process.cwd()}`,
			);
			return;
		}
		if (cmd === "/model") {
			if (value) {
				const models = await this.host.models?.list();
				if (!models?.some((m) => `${m.provider}/${m.id}` === value))
					throw new Error("Unknown model. Use provider/id from the model list.");
				pref.model = value;
			} else {
				const models = await this.host.models?.list();
				await this.send(
					msg,
					`Model: ${pref.model || this.getConfig().model || "default"}\n${(models || []).map((m) => `${m.provider}/${m.id}`).join("\n")}`,
				);
				return;
			}
		} else if (cmd === "/thinking") {
			if (value && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value))
				throw new Error("Invalid thinking level.");
			if (value) pref.thinking = value;
			else {
				await this.send(msg, `Thinking: ${pref.thinking || this.getConfig().thinkingLevel || "default"}`);
				return;
			}
		} else if (cmd === "/cwd") {
			if (value) pref.cwd = await validateWorkspace(value);
			else {
				await this.send(msg, `Cwd: ${pref.cwd || this.getConfig().workspace || this.host.cwd || process.cwd()}`);
				return;
			}
		} else {
			await this.send(msg, `Unknown command. ${HELP}`);
			return;
		}
		if (controller.signal.aborted) return;
		const oldRuns = this.invalidatePeer(peer);
		this.preferences.set(peer, pref);
		await this.abortRuns(oldRuns);
		await this.send(msg, `✅ ${cmd.slice(1)} updated for this peer. Next message starts a new conversation.`);
	}
	async handleRunEvent(ev) {
		const generation = this.stopGeneration || 0;
		await this.routesReady();
		if (generation !== (this.stopGeneration || 0)) return;
		if (ev.runId && this.sessionRouting.completed.has(ev.runId)) return;
		const key = ev.runId || this.sessionRouting.key(ev);
		if (!key) return;
		let run = this.pendingRuns.get(key);
		if (!run && !ev.runId && ev.type === "run_start") {
			const route = this.sessionRouting.routes.get(key);
			if (
				!this.sessionRouting.valid(route) ||
				[...this.pendingRuns.values()].some((r) => r.sessionId && r.sessionId === ev.sessionId)
			)
				return;
			run = {
				...route,
				route,
				sessionId: ev.sessionId,
				conversationId: ev.conversationId,
				controller: this.peerController(route.peer),
				accumulatedText: "",
				web: true,
			};
			this.pendingRuns.set(key, run);
		}
		if (!run) {
			if (
				ev.runId &&
				this.inflight &&
				(ev.type === "run_end" || (ev.type === "message" && ev.message?.role === "assistant"))
			) {
				const queue = this.earlyRuns.get(ev.runId) || [];
				if (ev.type === "run_end") queue[1] = ev;
				else {
					const content =
						typeof ev.message.content === "string"
							? ev.message.content
							: (ev.message.content || []).map((p) => p.text || "").join("\n");
					if (
						Array.isArray(ev.message.content) &&
						ev.message.content.some((p) => p.type === "toolCall" || p.type === "tool_use")
					)
						return;
					queue[0] = {
						...ev,
						message: { ...ev.message, content: content.slice(-256000) },
					};
				}
				this.earlyRuns.set(ev.runId, queue);
			}
			return;
		}
		if (run.controller?.signal.aborted || (run.sessionId && ev.sessionId && run.sessionId !== ev.sessionId)) return;
		if (run.route && !this.sessionRouting.valid(run.route)) return;
		if (ev.conversationId) {
			run.conversationId = ev.conversationId;
			this.userConversations.set(run.peer, ev.conversationId);
			this.sessionRouting.save();
		}
		if (ev.type === "message" && ev.message?.role === "assistant") {
			const c = ev.message.content;
			if (Array.isArray(c) && c.some((p) => p.type === "toolCall" || p.type === "tool_use")) return;
			const text = typeof c === "string" ? c : (c || []).map((p) => p.text || "").join("\n");
			run.accumulatedText = text;
		}
		if (ev.type === "message" && ev.message?.role === "assistant") {
			if (ev.message.stopReason === "error") run.failure = ev.message.errorMessage || "Agent run failed.";
			if (ev.message.stopReason === "aborted") run.failure = "Agent run stopped before completion.";
		}
		if (ev.type !== "run_end") return;
		this.pendingRuns.delete(key);
		this.sessionRouting.done(ev.runId);
		const text = this.cleanText(run.accumulatedText);
		const error =
			ev.error ||
			run.failure ||
			(ev.aborted || ev.cancelled || ev.reason === "aborted" || ev.stopReason === "aborted"
				? "Agent run stopped before completion."
				: ev.isError || ev.stopReason === "error"
					? "Agent run failed."
					: "");
		const final = error
			? `❌ ${typeof error === "string" ? error : JSON.stringify(error)}${text ? `\n${text}` : ""}`
			: text || "✅ Task completed (no text output).";
		try {
			for (const chunk of this.chunkText(final, 3800)) {
				if (run.controller?.signal.aborted || (run.route && !this.sessionRouting.valid(run.route))) return;
				await this.send(run.msg, chunk);
			}
			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();
		} catch (e) {
			this.status.lastError = e.message;
			this.log("warn", `Telegram reply delivery failed: ${e.message}`);
		}
	}
}
