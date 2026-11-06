import { createHash } from "node:crypto";
import { WhatsappBotBridge as Bridge } from "./bridge.mjs";
import { sendMedia } from "./media.mjs";

export const SECRET_ACCESS_TOKEN = "whatsapp.accessToken";
const GRAPH_API_BASE = "https://graph.facebook.com/v20.0";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(senderId, prefix = "wa") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

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

export class WhatsappBotBridge extends Bridge {
	constructor(options = {}) {
		super({
			...options,
			api: whatsappApi,
			payload: buildWhatsappPayload,
			extractText: extractWhatsappText,
			stripMarkers: stripInternalMarkers,
			accountId: peerAccountId,
		});
	}
}

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.accessToken;
	delete c.hasAccessToken;
	return c;
}

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

	host.registerTool?.({
		name: "whatsapp",
		description: "Send text, images, audio, documents or videos to WhatsApp phone numbers via WhatsApp Cloud API.",
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
					enum: ["send", "send_media", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				phone_number: {
					type: "string",
					description: "send: target recipient phone number with country code (e.g. 8613800000000).",
				},
				media_type: { type: "string", enum: ["image", "audio", "document", "video"] },
				path: { type: "string", description: "Workspace file path to upload." },
				media_id: { type: "string", description: "Existing WhatsApp media ID instead of path." },
				mime_type: { type: "string", description: "Upload MIME type." },
				filename: { type: "string" },
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
				case "send_media": {
					const to = args.phone_number?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("phone_number is required.");
					return JSON.stringify(
						await sendMedia(host, localConfig, to, {
							type: args.media_type,
							path: args.path,
							mediaId: args.media_id,
							caption: args.text,
							filename: args.filename,
							mimeType: args.mime_type,
						}),
					);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	host.route?.("POST", "/inbox", async (req, res) => {
		if (!botBridge.running || !localConfig.botEnabled) return res.status(503).json({ error: "Bot is stopped" });
		const messages =
			req.body?.entry?.flatMap((entry) => entry.changes?.flatMap((change) => change.value?.messages || []) || []) || [];
		if (messages.length > 100) return res.status(413).json({ error: "Too many messages" });
		for (const message of messages) await botBridge.onInboundMessage(message);
		res.json({ ok: true });
	});

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
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
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

				case "send_media": {
					const to = msg.to?.trim() || localConfig.defaultRecipient?.trim();
					if (!to) throw new Error("to recipient is required.");
					const result = await sendMedia(host, localConfig, to, { ...msg, type: msg.mediaType });
					reply({ type: "send_done", success: true, res: result });
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
					reply({ type: "bot_status", success: botBridge.getStatus().connected, status: botBridge.getStatus() });
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
