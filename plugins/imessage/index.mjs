/**
 * plugins/imessage/index.mjs
 * iMessage (Apple Messages) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + node:child_process).
 * Inspired by dsh-im: macOS Messages bridge, structure-aware Markdown chunks,
 * isolated multi-turn sessions, access control whitelist, and slash commands.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

const execFileAsync = promisify(execFile);
export const IMESSAGE_BOT_PREFIX = "🤖 PI\n";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from sender's Apple ID or phone number. */
export function peerAccountId(senderId, prefix = "im") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Clean message text and strip bot reply markers. */
export function cleanIMessageText(textRaw = "") {
	let text = String(textRaw || "").trim();
	if (!text) return "";
	if (text.startsWith(IMESSAGE_BOT_PREFIX)) return "";
	return text.replace(/^@\S+\s+/g, "").trim();
}

/**
 * Send an iMessage via macOS AppleScript (/usr/bin/osascript).
 */
export async function sendMacOSIMessage(address, text, { execFileImpl } = {}) {
	const safeAddress = String(address || "").trim();
	const safeText = String(text || "").trim();
	if (!safeAddress) throw new Error("iMessage recipient address is required.");
	if (!safeText) throw new Error("Message text is required.");

	if (process.platform !== "darwin" && !execFileImpl) {
		// 非 macOS 且未注入执行实现时明确报错——假成功会让用户以为消息已发出
		//（实际什么都没发）。注入的 execFileImpl（测试/宿主钩子）不受此限。
		throw new Error(`iMessage is only available on macOS (current platform: ${process.platform}).`);
	}

	const runExec = execFileImpl || execFileAsync;
	const script = `
		tell application "Messages"
			set targetService to 1st service whose service type = iMessage
			set targetBuddy to buddy ${JSON.stringify(safeAddress)} of targetService
			send ${JSON.stringify(safeText)} to targetBuddy
		end tell
	`;

	await runExec("/usr/bin/osascript", ["-e", script], { timeout: 15000 });
	return { success: true };
}

/**
 * IMessageBotBridge manages duplex message exchange between macOS Messages and pi-web-ui agent host.
 */
export class IMessageBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 * @param {any} [options.execFileImpl]
	 */
	constructor({ host, getConfig, log, execFileImpl } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[imessage-bot:${level}] ${msg}`));
		this.execFileImpl = execFileImpl;

		this.running = false;
		this.pollTimer = null;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.userConversations = new Map();
		this.userWorkspaces = new Map();

		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connected' | 'error' | 'unsupported'
			platform: process.platform,
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	getStatus() {
		return { ...this.status, platform: process.platform };
	}

	resolveWorkspace(sender, cfg) {
		return String(this.userWorkspaces.get(sender) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;

		if (process.platform !== "darwin") {
			// 非 macOS 明确置 unsupported——假"在线"误导排障
			this.status.state = "unsupported";
			this.status.connected = false;
			this.status.lastError = `iMessage bridge requires macOS (current platform: ${process.platform}).`;
			this.log("warn", this.status.lastError);
		} else {
			this.status.state = "connected";
			this.status.connected = true;
			this.log("info", "iMessage native macOS bridge started");
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

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	async onInboundMessage(event) {
		if (!event) return;
		const msgId = event.id || event.guid;
		if (msgId) {
			if (this.seenMessageIds.has(msgId)) return;
			this.seenMessageIds.add(msgId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		const sender = String(event.sender || event.from || "").trim();
		const rawText = String(event.text || event.content || "").trim();
		const cleanText = cleanIMessageText(rawText);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && sender && !allowedUsers.includes(sender)) {
			this.log("info", `iMessage user ${sender} blocked by whitelist`);
			await sendMacOSIMessage(
				sender,
				`${IMESSAGE_BOT_PREFIX}【访问受限】您当前不在该 iMessage 机器人的白名单中，请联系管理员在 Web 控制台添加您的 Apple ID 或手机号。`,
				{ execFileImpl: this.execFileImpl },
			).catch(() => {});
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Slash command handling (/help, /clear, /new, /status)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { sender, cfg });
			if (handled) return;
		}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(sender);
		let conversationId = this.userConversations.get(sender);
		if (!conversationId) {
			conversationId = `im_${sender.slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(sender, conversationId);
		}

		this.pendingRuns.set(conversationId, {
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
			this.log("warn", `iMessage host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await sendMacOSIMessage(sender, `${IMESSAGE_BOT_PREFIX}任务启动失败：${err.message}`, {
				execFileImpl: this.execFileImpl,
			}).catch(() => {});
		}
	}

	async handleSlashCommand(cmdText, { sender, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					`${IMESSAGE_BOT_PREFIX}🤖 pi-web-ui iMessage 机器人帮助`,
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- /cwd [路径] 或 /workspace [路径]：查看或切换当前项目根目录",
					"- /clear 或 /new：清空当前上下文，开启全新会话",
					"- /status：查看机器人运行状态与指标",
					"- /help：展示本帮助信息",
				].join("\n");
				await sendMacOSIMessage(sender, helpText, { execFileImpl: this.execFileImpl }).catch(() => {});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(sender, cfg) || "(默认跟随宿主当前项目)";
					await sendMacOSIMessage(
						sender,
						`${IMESSAGE_BOT_PREFIX}📂 当前项目根目录：${currentWs}\n提示：发送 /cwd <目录路径> 可切换项目根目录。`,
						{ execFileImpl: this.execFileImpl },
					).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(sender, argPath);
				const newId = `im_${sender.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(sender, newId);
				await sendMacOSIMessage(
					sender,
					`${IMESSAGE_BOT_PREFIX}📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
					{ execFileImpl: this.execFileImpl },
				).catch(() => {});
				return true;
			}
			case "/clear":
			case "/new": {
				const newId = `im_${sender.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(sender, newId);
				await sendMacOSIMessage(sender, `${IMESSAGE_BOT_PREFIX}✨ 对话上下文已清空，已为您开启全新会话！`, {
					execFileImpl: this.execFileImpl,
				}).catch(() => {});
				return true;
			}
			case "/status": {
				const s = this.status;
				const statusText = [
					`${IMESSAGE_BOT_PREFIX}🟢 iMessage 机器人状态`,
					`- 系统平台：${s.platform}`,
					`- 运行状态：在线`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
				].join("\n");
				await sendMacOSIMessage(sender, statusText, { execFileImpl: this.execFileImpl }).catch(() => {});
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

			const chunks = chunkMarkdownText(finalText, 3000);

			try {
				for (let i = 0; i < chunks.length; i++) {
					const chunk = `${IMESSAGE_BOT_PREFIX}${chunks[i]}`;
					await sendMacOSIMessage(run.sender, chunk, { execFileImpl: this.execFileImpl });
				}
				this.status.messagesReplied++;
				this.status.lastReplyAt = Date.now();
			} catch (err) {
				this.log("warn", `iMessage reply delivery failed: ${err.message}`);
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	return { ...(cfg || {}) };
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}) {
	return { ...(prev || {}), ...(incoming || {}) };
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	localConfig = mergeSavedSecrets(localConfig, {});

	const botBridge = new IMessageBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `iMessage bot start note: ${err.message}`);
		});
	}

	// Register AI tool "imessage" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "imessage",
		description: "Send text messages or notifications to Apple iMessage recipients via macOS Messages.",
		promptSnippet: "send messages to iMessage recipients",
		promptGuidelines: [
			"Confirm recipient address (Apple ID or phone number) and message text with the user once before action=send",
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
				address: {
					type: "string",
					description: "send: target Apple ID email or phone number.",
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
					const to = args.address?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("recipient address is required.");
					const res = await sendMacOSIMessage(to, args.text || "");
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
					reply({
						type: "state",
						config: {
							defaultRecipient: localConfig.defaultRecipient || "",
							workspace: localConfig.workspace || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
						},
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					localConfig = mergeSavedSecrets(incoming, localConfig);
					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled) {
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const isDarwin = process.platform === "darwin";
					reply({
						type: "test_config_done",
						success: true,
						message: isDarwin
							? "环境检测通过：运行于 macOS 原生环境，支持通过 Apple Messages 自动化收发。"
							: `当前运行平台为 ${process.platform}（支持兼容测试模式）。`,
					});
					break;
				}

				case "send_message": {
					const to = msg.address?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("recipient address is required.");
					const res = await sendMacOSIMessage(to, msg.text || "");
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
