/**
 * plugins/matrix/index.mjs
 * Matrix protocol integration for pi-web-ui (experimental).
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: outbound sync long-polling (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, and slash commands.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_ACCESS_TOKEN = "matrix.accessToken";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from Matrix User ID (@user:server). */
export function peerAccountId(userId, prefix = "mtx") {
	const raw = String(userId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags from Matrix message content. */
export function extractMatrixText(content = {}, botUserId = "") {
	let text = String(content?.body || "").trim();
	if (!text) return "";
	if (botUserId) {
		const regex = new RegExp(`@${botUserId.replace(/^@/, "")}\\b`, "gi");
		text = text.replace(regex, "").trim();
	}
	return text;
}

/**
 * Matrix Client-Server API request helper.
 */
export async function matrixApi(homeserverUrl, accessToken, method, path, payload = null, { timeoutMs = 35000 } = {}) {
	const base = homeserverUrl.replace(/\/+$/, "");
	const subpath = path.startsWith("/") ? path : `/${path}`;
	const url = `${base}${subpath}`;

	const headers = {
		"User-Agent": "pi-web-ui-matrix/0.1.0",
	};
	if (accessToken) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
	if (payload !== null) {
		headers["Content-Type"] = "application/json; charset=utf-8";
	}

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.error || `Matrix HTTP ${res.status}`);
	}

	return await res.json().catch(() => ({}));
}

/**
 * MatrixBotBridge manages outbound /sync long-polling duplex exchange with Matrix.
 */
export class MatrixBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[matrix-bot:${level}] ${msg}`));

		this.running = false;
		this.syncAbort = null;
		this.offRunEvent = null;

		this.botUserId = "";
		this.nextBatch = "";
		// sync 游标持久化：内存态 nextBatch 在重启/热重载后清零，首轮 sync 会把
		// 各房间最近时间线（此前已回复过的消息）当新消息重放、重复触发 agent
		this.nextBatchLoaded = false;

		this.seenEventIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			botUserId: "",
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	getStatus() {
		return { ...this.status };
	}

	resolveWorkspace(sender, cfg) {
		return String(this.userWorkspaces.get(sender) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.homeserverUrl || !cfg.accessToken) {
			this.status.state = "idle";
			this.status.lastError = "Missing Matrix Homeserver URL or Access Token";
			return;
		}

		// Verify bot identity
		try {
			const whoami = await matrixApi(
				cfg.homeserverUrl,
				cfg.accessToken,
				"GET",
				"/_matrix/client/v3/account/whoami",
				null,
				{ timeoutMs: 10000 },
			);
			this.botUserId = whoami.user_id || "";
			this.status.botUserId = this.botUserId;
			this.status.connected = true;
			this.status.state = "connected";
			this.status.lastError = null;
			this.log("info", `Matrix bot verified as ${this.botUserId}`);
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Matrix whoami failed: ${err.message}`);
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		this.startSyncLoop();
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.syncAbort) {
			try {
				this.syncAbort.abort();
			} catch {}
			this.syncAbort = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async startSyncLoop() {
		while (this.running) {
			const cfg = this.getConfig();
			if (!cfg.homeserverUrl || !cfg.accessToken) break;

			try {
				if (!this.nextBatchLoaded) {
					this.nextBatch = String((await this.host?.storage?.get?.("matrix.nextBatch")) || "");
					this.nextBatchLoaded = true;
				}
				const query = new URLSearchParams({
					timeout: "25000",
				});
				const initialSync = !this.nextBatch;
				if (this.nextBatch) {
					query.set("since", this.nextBatch);
				}

				const res = await matrixApi(
					cfg.homeserverUrl,
					cfg.accessToken,
					"GET",
					`/_matrix/client/v3/sync?${query.toString()}`,
					null,
					{ timeoutMs: 35000 },
				);

				if (res?.next_batch) {
					this.nextBatch = res.next_batch;
					await this.host?.storage?.set?.("matrix.nextBatch", this.nextBatch);
				}

				// Handle joined room timeline events（无持久化游标的首轮 sync 只落
				// 游标不消费时间线——Synapse 默认返回每房间最近约 10 条，其中多数
				// 是重启前已回复过的消息，重放会重复触发 agent）
				if (!initialSync) {
					const joinedRooms = res?.rooms?.join || {};
					for (const [roomId, roomData] of Object.entries(joinedRooms)) {
						const events = roomData?.timeline?.events || [];
						for (const ev of events) {
							if (ev.type === "m.room.message") {
								await this.onInboundMessage(roomId, ev).catch((err) => {
									this.log("warn", `Matrix event handling error: ${err.message}`);
								});
							}
						}
					}
				}

				this.status.connected = true;
				this.status.state = "connected";
			} catch (err) {
				if (!this.running) break;
				this.status.state = "connecting";
				this.log("info", `Matrix sync retry notice: ${err.message}`);
				await new Promise((r) => setTimeout(r, 4000));
			}
		}
	}

	async onInboundMessage(roomId, event) {
		if (!event || event.sender === this.botUserId) return;
		// m.notice 是 Matrix 生态的机器人消息约定——不滤掉会与其他 bot 互聊死循环
		if (event.content?.msgtype === "m.notice") return;
		const eventId = event.event_id;
		if (eventId) {
			if (this.seenEventIds.has(eventId)) return;
			this.seenEventIds.add(eventId);
			if (this.seenEventIds.size > 500) {
				const first = this.seenEventIds.values().next().value;
				this.seenEventIds.delete(first);
			}
		}

		const sender = event.sender;
		const cleanText = extractMatrixText(event.content, this.botUserId);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && sender && !allowedUsers.includes(sender)) {
			this.log("info", `Matrix user ${sender} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { roomId, sender, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(sender);
		let conversationId = this.userConversations.get(sender);
		if (!conversationId) {
			conversationId = `mtx_${sender.replace(/[^a-zA-Z0-9]/g, "_").slice(-12)}_${Date.now().toString(36)}`;
			this.userConversations.set(sender, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			roomId,
			sender,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		try {
			const workspace = this.resolveWorkspace(sender, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			await this.host.chat(chatReq);
		} catch (err) {
			this.log("warn", `Matrix host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await this.sendRoomMessage(roomId, `任务启动失败：${err.message}`).catch(() => {});
		}
	}

	async sendRoomMessage(roomId, text) {
		const cfg = this.getConfig();
		if (!cfg.homeserverUrl || !cfg.accessToken) return;
		const txnId = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		await matrixApi(
			cfg.homeserverUrl,
			cfg.accessToken,
			"PUT",
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
			{
				msgtype: "m.text",
				body: text,
			},
		);
	}

	async handleSlashCommand(cmdText, { roomId, sender, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🔮 **pi-web-ui Matrix 机器人帮助**",
					"",
					"- 发送消息即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd [路径]` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新会话",
					"- `/status`：查看机器人运行状态与指标",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await this.sendRoomMessage(roomId, helpText).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(sender, cfg) || "(默认跟随宿主当前项目)";
					await this.sendRoomMessage(
						roomId,
						`📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
					).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(sender, argPath);
				const newId = `mtx_${sender.replace(/[^a-zA-Z0-9]/g, "_").slice(-12)}_${Date.now().toString(36)}`;
				this.userConversations.set(sender, newId);
				await this.sendRoomMessage(
					roomId,
					`📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `mtx_${sender.replace(/[^a-zA-Z0-9]/g, "_").slice(-12)}_${Date.now().toString(36)}`;
				this.userConversations.set(sender, newId);
				await this.sendRoomMessage(roomId, "✨ 对话上下文已清空，已为您开启全新会话！").catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 **Matrix 机器人状态**`,
					`- 账号：${s.botUserId || "在线"}`,
					`- 运行状态：在线 (Sync 长轮询)`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n");
				await this.sendRoomMessage(roomId, statusText).catch(() => {});
				return true;
			}
			default:
				return false;
		}
	}

	async handleRunEvent(ev) {
		const convId = ev.conversationId;
		if (!convId) return;

		if (ev.type === "message" && ev.message) {
			const m = ev.message;
			let content = "";
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				content = m.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("\n")
					.trim();
			}

			if (content && (m.role === "assistant" || m.author === "assistant")) {
				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText += (r.accumulatedText ? "\n" : "") + content;
				} else {
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "" };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (!run) return;

			this.pendingRuns.delete(convId);
			this.earlyRuns.delete(convId);

			const rawText = run.accumulatedText || "";
			const cleanText = stripInternalMarkers(rawText);
			const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

			const chunks = chunkMarkdownText(finalText, 3800);

			try {
				for (const chunk of chunks) {
					await this.sendRoomMessage(run.roomId, chunk);
				}
				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `Matrix reply delivery failed: ${err.message}`);
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.accessToken;
	delete c.hasAccessToken;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingToken = savedSecrets[SECRET_ACCESS_TOKEN] || prev.accessToken || "";

	if (incoming.clearAccessToken || !out.accessToken?.trim()) {
		if (incoming.clearAccessToken) out.accessToken = "";
		else out.accessToken = existingToken;
	} else if (typeof incoming.accessToken === "string" && incoming.accessToken.trim()) {
		out.accessToken = incoming.accessToken.trim();
	} else {
		out.accessToken = existingToken;
	}

	delete out.clearAccessToken;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new MatrixBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.homeserverUrl && localConfig.accessToken) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Matrix bot start note: ${err.message}`);
		});
	}

	// Register AI tool "matrix" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "matrix",
		description: "Send messages or notifications to Matrix rooms via Matrix Client-Server API.",
		promptSnippet: "send messages to Matrix rooms",
		promptGuidelines: [
			"Confirm target room_id and message text with the user once before action=send",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				room_id: {
					type: "string",
					description: "send: target Matrix room ID (!xxx:server).",
				},
				text: {
					type: "string",
					description: "send: message content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const roomId = args.room_id?.trim() || localConfig.defaultRoomId?.trim();
					if (!roomId) throw new Error("room_id is required.");
					if (!localConfig.homeserverUrl || !localConfig.accessToken) {
						throw new Error("Matrix credentials are not configured.");
					}
					await botBridge.sendRoomMessage(roomId, args.text || "");
					return JSON.stringify({ success: true, roomId }, null, 2);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	host.onClientMessage?.(async (msg, reply) => {
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							homeserverUrl: localConfig.homeserverUrl || "https://matrix.org",
							defaultRoomId: localConfig.defaultRoomId || "",
							workspace: localConfig.workspace || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasAccessToken: Boolean(secrets[SECRET_ACCESS_TOKEN] || localConfig.accessToken),
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);

					if (host.secrets) {
						if (localConfig.accessToken) {
							await host.secrets.set(SECRET_ACCESS_TOKEN, localConfig.accessToken);
						} else if (incoming.clearAccessToken) {
							await host.secrets.delete?.(SECRET_ACCESS_TOKEN);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.homeserverUrl && localConfig.accessToken) {
						await botBridge.stop().catch(() => {});
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);

					if (!testCfg.homeserverUrl || !testCfg.accessToken) {
						reply({ type: "test_config_done", success: false, message: "未填入 Homeserver URL 或 Access Token" });
						break;
					}

					try {
						const whoami = await matrixApi(
							testCfg.homeserverUrl,
							testCfg.accessToken,
							"GET",
							"/_matrix/client/v3/account/whoami",
							null,
							{ timeoutMs: 10000 },
						);
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证 Matrix 用户：${whoami.user_id}`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const roomId = msg.roomId?.trim() || localConfig.defaultRoomId?.trim();
					if (!roomId) throw new Error("roomId is required.");
					if (!localConfig.homeserverUrl || !localConfig.accessToken) {
						throw new Error("Matrix credentials are not configured.");
					}
					await botBridge.sendRoomMessage(roomId, msg.text || "");
					reply({ type: "send_done", success: true });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", message: err.message });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
