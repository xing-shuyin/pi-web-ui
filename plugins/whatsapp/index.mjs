/**
 * plugins/whatsapp/index.mjs
 * WhatsApp integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 * Inspired by dsh-im: duplex bot chat, structure-aware Markdown chunks,
 * isolated multi-turn sessions, access control whitelist, and Meta Cloud API.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_ACCESS_TOKEN = "whatsapp.accessToken";
const GRAPH_API_BASE = "https://graph.facebook.com/v20.0";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from WhatsApp sender phone number or JID. */
export function peerAccountId(senderId, prefix = "wa") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content from WhatsApp inbound message webhook object. */
export function extractWhatsappText(message) {
	if (!message) return "";
	if (message.type === "text" && message.text?.body) {
		return String(message.text.body).trim();
	}
	if (message.type === "interactive" && message.interactive) {
		const inter = message.interactive;
		return String(inter.button_reply?.title || inter.list_reply?.title || "").trim();
	}
	return String(message.body || "").trim();
}

/**
 * Builds standard WhatsApp Cloud API JSON payload.
 */
export function buildWhatsappPayload(to, text) {
	return {
		messaging_product: "whatsapp",
		recipient_type: "individual",
		to: String(to).replace(/[^0-9]/g, ""),
		type: "text",
		text: {
			preview_url: false,
			body: String(text || "").trim(),
		},
	};
}

/**
 * WhatsApp Cloud API request helper.
 */
export async function whatsappApi(
	accessToken,
	phoneNumberId,
	path,
	payload = null,
	{ method = "POST", timeoutMs = 15000 } = {},
) {
	if (!accessToken) throw new Error("WhatsApp Access Token is required.");
	const subpath = path.startsWith("/") ? path : `/${path}`;
	const url = `${GRAPH_API_BASE}/${phoneNumberId}${subpath}`;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": "pi-web-ui-whatsapp/0.1.0",
	};

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		const errorMsg = errJson.error?.message || `WhatsApp HTTP ${res.status}`;
		throw new Error(errorMsg);
	}

	return await res.json();
}

/**
 * WhatsappBotBridge manages duplex message exchange between WhatsApp and pi-web-ui agent host.
 */
export class WhatsappBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[whatsapp-bot:${level}] ${msg}`));

		this.running = false;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connected' | 'error'
			displayPhone: "",
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

	resolveWorkspace(senderPhone, cfg) {
		return String(this.userWorkspaces.get(senderPhone) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		const cfg = this.getConfig();
		if (!cfg.accessToken || !cfg.phoneNumberId) {
			this.status.state = "idle";
			this.status.lastError = "Missing WhatsApp Access Token or Phone Number ID";
			return;
		}

		// Verify credentials via Meta Graph API
		try {
			const info = await whatsappApi(cfg.accessToken, cfg.phoneNumberId, "", null, { method: "GET", timeoutMs: 10000 });
			this.status.displayPhone = info.display_phone_number || info.verified_name || cfg.phoneNumberId;
			this.status.connected = true;
			this.status.state = "connected";
			this.status.lastError = null;
			this.log("info", `WhatsApp verified for ${this.status.displayPhone}`);
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `WhatsApp verification failed: ${err.message}`);
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async onInboundMessage(event) {
		if (!event) return;
		const msgId = event.id || event.messageId;
		if (msgId) {
			if (this.seenMessageIds.has(msgId)) return;
			this.seenMessageIds.add(msgId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		const senderPhone = event.from || event.sender || "";
		const rawText = extractWhatsappText(event);
		const cleanText = rawText.replace(/@\S+/g, "").trim();
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Access control whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && senderPhone && !allowedUsers.includes(String(senderPhone))) {
			if (cfg.accessToken && cfg.phoneNumberId) {
				const replyPayload = buildWhatsappPayload(
					senderPhone,
					"【Access Restricted】You are not in the authorized whitelist for this WhatsApp AI Assistant. Please contact the administrator.",
				);
				await whatsappApi(cfg.accessToken, cfg.phoneNumberId, "/messages", replyPayload).catch(() => {});
			}
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { senderPhone, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(senderPhone);
		let conversationId = this.userConversations.get(senderPhone);
		if (!conversationId) {
			conversationId = `wa_${String(senderPhone).slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(senderPhone, conversationId);
		}

		this.pendingRuns.set(conversationId, {
			senderPhone,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		try {
			const workspace = this.resolveWorkspace(senderPhone, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			await this.host.chat(chatReq);
		} catch (err) {
			this.log("warn", `WhatsApp host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			if (cfg.accessToken && cfg.phoneNumberId) {
				const replyPayload = buildWhatsappPayload(senderPhone, `Failed to start session: ${err.message}`);
				await whatsappApi(cfg.accessToken, cfg.phoneNumberId, "/messages", replyPayload).catch(() => {});
			}
		}
	}

	async handleSlashCommand(cmdText, { senderPhone, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();
		if (!cfg.accessToken || !cfg.phoneNumberId) return false;

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 *pi-web-ui WhatsApp Bot Help*",
					"",
					"- Send any text message to chat with your AI assistant",
					"- `/cwd [path]` or `/workspace [path]`: view or switch current workspace root",
					"- `/clear` or `/new`: reset context and start a fresh session",
					"- `/status`: inspect bot connection and metrics",
					"- `/help`: display this help guide",
				].join("\n");
				await whatsappApi(
					cfg.accessToken,
					cfg.phoneNumberId,
					"/messages",
					buildWhatsappPayload(senderPhone, helpText),
				).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(senderPhone, cfg) || "(following host current project)";
					await whatsappApi(
						cfg.accessToken,
						cfg.phoneNumberId,
						"/messages",
						buildWhatsappPayload(
							senderPhone,
							`📂 Current workspace root: ${currentWs}\nTip: send /cwd <path> to switch workspace.`,
						),
					).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(senderPhone, argPath);
				const newId = `wa_${String(senderPhone).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(senderPhone, newId);
				await whatsappApi(
					cfg.accessToken,
					cfg.phoneNumberId,
					"/messages",
					buildWhatsappPayload(senderPhone, `📂 Switched workspace root to: ${argPath}\n✨ Started a fresh session!`),
				).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `wa_${String(senderPhone).slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(senderPhone, newId);
				await whatsappApi(
					cfg.accessToken,
					cfg.phoneNumberId,
					"/messages",
					buildWhatsappPayload(senderPhone, "✨ Context cleared! Started a fresh conversation session."),
				).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`🟢 *WhatsApp Bot Status*`,
					`- Phone: ${s.displayPhone || "Connected"}`,
					`- Status: Online (Cloud API)`,
					`- Received: ${s.messagesReceived} messages`,
					`- Replied: ${s.messagesReplied} messages`,
				].join("\n");
				await whatsappApi(
					cfg.accessToken,
					cfg.phoneNumberId,
					"/messages",
					buildWhatsappPayload(senderPhone, statusText),
				).catch(() => {});
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
			const finalText = cleanText || "✅ Task completed (no text output).";

			const cfg = this.getConfig();
			// WhatsApp single message limit is ~4096 chars, using 3800 safe limit
			const chunks = chunkMarkdownText(finalText, 3800);

			if (cfg.accessToken && cfg.phoneNumberId) {
				try {
					for (const chunk of chunks) {
						const payload = buildWhatsappPayload(run.senderPhone, chunk);
						await whatsappApi(cfg.accessToken, cfg.phoneNumberId, "/messages", payload);
					}
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
				} catch (err) {
					this.log("warn", `WhatsApp reply delivery failed: ${err.message}`);
				}
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

	const botBridge = new WhatsappBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.accessToken && localConfig.phoneNumberId) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `WhatsApp bot start note: ${err.message}`);
		});
	}

	// Register AI tool "whatsapp" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "whatsapp",
		description: "Send text messages or notifications to WhatsApp phone numbers via WhatsApp Cloud API.",
		promptSnippet: "send messages to WhatsApp contacts",
		promptGuidelines: [
			"Confirm target phone number and message text with the user once before action=send",
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
				phone_number: {
					type: "string",
					description: "send: target recipient phone number with country code (e.g. 8613800000000).",
				},
				text: {
					type: "string",
					description: "send: text content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const to = args.phone_number?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("phone_number is required.");
					if (!localConfig.accessToken || !localConfig.phoneNumberId) {
						throw new Error("WhatsApp Cloud API credentials are not configured.");
					}
					const payload = buildWhatsappPayload(to, args.text || "");
					const res = await whatsappApi(localConfig.accessToken, localConfig.phoneNumberId, "/messages", payload);
					return JSON.stringify(res, null, 2);
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
							phoneNumberId: localConfig.phoneNumberId || "",
							defaultRecipient: localConfig.defaultRecipient || "",
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

					if (localConfig.botEnabled && localConfig.accessToken && localConfig.phoneNumberId) {
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

					if (!testCfg.accessToken || !testCfg.phoneNumberId) {
						reply({ type: "test_config_done", success: false, message: "Missing Access Token or Phone Number ID" });
						break;
					}

					try {
						const res = await whatsappApi(testCfg.accessToken, testCfg.phoneNumberId, "", null, {
							method: "GET",
							timeoutMs: 10000,
						});
						const name = res.verified_name || res.display_phone_number || "WhatsApp Account";
						reply({
							type: "test_config_done",
							success: true,
							message: `Connection verified! Target account: ${name} (ID: ${res.id})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `Connection failed: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const to = msg.to?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("to recipient is required.");
					if (!localConfig.accessToken || !localConfig.phoneNumberId) {
						throw new Error("WhatsApp Cloud API credentials are not configured.");
					}
					const payload = buildWhatsappPayload(to, msg.text || "");
					const res = await whatsappApi(localConfig.accessToken, localConfig.phoneNumberId, "/messages", payload);
					reply({ type: "send_done", success: true, res });
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
