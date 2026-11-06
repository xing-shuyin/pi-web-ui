import { createHash, createHmac } from "node:crypto";
import { DingtalkBotBridge } from "./bridge.mjs";
import { sendMedia } from "./media.mjs";
import { DingTalkStream } from "./stream.mjs";

export const SECRET_APP_SECRET = "dingtalk.appSecret";
export const SECRET_WEBHOOK_SECRET = "dingtalk.webhookSecret";

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function peerAccountId(senderId, prefix = "dt") {
	const raw = String(senderId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

export function signDingtalkWebhook(timestamp, secret) {
	if (!secret) return "";
	const stringToSign = `${timestamp}\n${secret}`;
	return createHmac("sha256", secret).update(stringToSign).digest("base64");
}

export function buildSignedWebhookUrl(rawUrl, secret) {
	const urlStr = String(rawUrl ?? "").trim();
	if (!urlStr || !secret) return urlStr;
	const timestamp = Date.now();
	const sign = encodeURIComponent(signDingtalkWebhook(timestamp, secret));
	const delimiter = urlStr.includes("?") ? "&" : "?";
	return `${urlStr}${delimiter}timestamp=${timestamp}&sign=${sign}`;
}

export function buildDingtalkMessage({ msgType = "markdown", title = "通知", text = "" } = {}) {
	const safeTitle = String(title || "通知").trim();
	const safeText = String(text || "").trim();

	if (msgType === "text") {
		return {
			msgtype: "text",
			text: { content: safeText },
		};
	}

	return {
		msgtype: "markdown",
		markdown: {
			title: safeTitle,
			text: safeText.startsWith("#") ? safeText : `### ${safeTitle}\n\n${safeText}`,
		},
	};
}

export { DingtalkBotBridge } from "./bridge.mjs";

export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.appSecret;
	delete c.webhookSecret;
	delete c.hasAppSecret;
	delete c.hasWebhookSecret;
	return c;
}

export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingAppSecret = savedSecrets[SECRET_APP_SECRET] || prev.appSecret || "";
	const existingWebhookSecret = savedSecrets[SECRET_WEBHOOK_SECRET] || prev.webhookSecret || "";

	if (incoming.clearAppSecret || !out.appKey?.trim()) {
		out.appSecret = "";
	} else if (typeof incoming.appSecret === "string" && incoming.appSecret.trim()) {
		out.appSecret = incoming.appSecret.trim();
	} else {
		out.appSecret = existingAppSecret;
	}

	if (incoming.clearWebhookSecret || !out.webhookUrl?.trim()) {
		out.webhookSecret = "";
	} else if (typeof incoming.webhookSecret === "string" && incoming.webhookSecret.trim()) {
		out.webhookSecret = incoming.webhookSecret.trim();
	} else {
		out.webhookSecret = existingWebhookSecret;
	}

	delete out.clearAppSecret;
	delete out.clearWebhookSecret;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new DingtalkBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	let stream;
	async function startBot() {
		if (stream) return;
		await botBridge.start();
		botBridge.status.connected = false;
		stream = new DingTalkStream({
			config: () => localConfig,
			onMessage: (event) => botBridge.onInboundMessage(event),
			onState: (connected) => {
				botBridge.status.connected = connected;
				botBridge.status.state = connected ? "connected" : "reconnecting";
			},
			log: (message) => {
				botBridge.error(new Error(message));
			},
		});
		try {
			await stream.connect();
		} catch (error) {
			stream.close();
			stream = null;
			await botBridge.stop();
			throw error;
		}
	}
	async function stopBot() {
		stream?.close();
		stream = null;
		await botBridge.stop();
	}
	if (localConfig.botEnabled) startBot().catch((error) => botBridge.error(error));

	async function sendWebhookMessage(cfg, { msgType = "markdown", title = "通知", text = "" } = {}) {
		const url = cfg.webhookUrl?.trim();
		if (!url) throw new Error("DingTalk Webhook URL is not configured.");
		const secret = cfg.webhookSecret?.trim();
		const finalUrl = buildSignedWebhookUrl(url, secret);

		const body = buildDingtalkMessage({ msgType, title, text });
		const res = await fetch(finalUrl, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`DingTalk Webhook HTTP ${res.status}`);
		const json = await res.json();
		if (json.errcode !== 0) throw new Error(`DingTalk error ${json.errcode}: ${json.errmsg}`);
		return { success: true, res: json };
	}

	async function getAccessToken(cfg) {
		const appKey = cfg.appKey?.trim();
		const appSecret = cfg.appSecret?.trim();
		if (!appKey || !appSecret) throw new Error("DingTalk AppKey or AppSecret is missing.");

		const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appKey, appSecret }),
		});
		if (!res.ok) throw new Error(`DingTalk OAuth HTTP ${res.status}`);
		const json = await res.json();
		if (!json.accessToken) throw new Error(`Failed to get access token: ${JSON.stringify(json)}`);
		return json.accessToken;
	}

	host.registerTool?.({
		name: "dingtalk",
		description:
			"Send text, markdown, images, AMR audio, files, or MP4 video to DingTalk. Native media requires an enterprise robot, recipient, and a local file; video also requires a cover image.",
		promptSnippet: "send alerts or status messages to DingTalk group chats",
		promptGuidelines: [
			"Confirm recipient and message text with the user once before action=send or webhook",
			"Use action=webhook to push status notifications to the configured group",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["webhook", "media", "status"],
					description: "Send a configured webhook notification, native robot media, or query bridge status.",
				},
				mediaType: { type: "string", enum: ["image", "audio", "file", "video"] },
				path: { type: "string", description: "Local media file path, up to 20MB." },
				coverPath: { type: "string", description: "Local video cover image path." },
				duration: { type: "number", description: "Audio or video duration in seconds." },
				openConversationId: { type: "string", description: "Target group conversation ID; exclusive with userId." },
				userId: { type: "string", description: "Target staff ID for a direct message." },
				text: {
					type: "string",
					description: "webhook: text or markdown body to send.",
				},
				title: {
					type: "string",
					description: "webhook: optional title for markdown card.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "webhook": {
					const res = await sendWebhookMessage(localConfig, {
						title: args.title || "通知",
						text: args.text || "",
					});
					return JSON.stringify(res, null, 2);
				}
				case "media":
					return JSON.stringify(await sendMedia(localConfig, args), null, 2);
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	host.onClientMessage?.(async (msg, reply) => {
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							appKey: localConfig.appKey || "",
							robotCode: localConfig.robotCode || "",
							webhookUrl: localConfig.webhookUrl || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							botEnabled: Boolean(localConfig.botEnabled),
							allowedSenders: localConfig.allowedSenders || [],
							hasAppSecret: Boolean(secrets[SECRET_APP_SECRET]),
							hasWebhookSecret: Boolean(secrets[SECRET_WEBHOOK_SECRET]),
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
						if (localConfig.appSecret) {
							await host.secrets.set(SECRET_APP_SECRET, localConfig.appSecret);
						} else if (incoming.clearAppSecret) {
							await host.secrets.delete?.(SECRET_APP_SECRET);
						}

						if (localConfig.webhookSecret) {
							await host.secrets.set(SECRET_WEBHOOK_SECRET, localConfig.webhookSecret);
						} else if (incoming.clearWebhookSecret) {
							await host.secrets.delete?.(SECRET_WEBHOOK_SECRET);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					await stopBot();
					if (localConfig.botEnabled) await startBot();

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);
					const results = { appOk: false, webhookOk: false, messages: [] };

					if (testCfg.appKey && testCfg.appSecret) {
						try {
							await getAccessToken(testCfg);
							results.appOk = true;
							results.messages.push("钉钉企业应用认证成功 (OAuth AccessToken 获取正常)");
						} catch (err) {
							results.messages.push(`钉钉企业应用连接失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 AppKey / AppSecret");
					}

					if (testCfg.webhookUrl) {
						try {
							await sendWebhookMessage(testCfg, {
								title: "测试通知",
								text: "【pi-web-ui 钉钉测试】连接配置成功！",
							});
							results.webhookOk = true;
							results.messages.push("钉钉 Webhook 测试推送成功");
						} catch (err) {
							results.messages.push(`钉钉 Webhook 推送失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 Webhook URL");
					}

					reply({
						type: "test_config_done",
						success: results.appOk || results.webhookOk,
						results,
					});
					break;
				}

				case "send_media": {
					const res = await sendMedia(localConfig, msg.payload || {});
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "send_webhook": {
					const res = await sendWebhookMessage(localConfig, msg.payload || {});
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await startBot();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await stopBot();
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
		await stopBot();
	};
}
