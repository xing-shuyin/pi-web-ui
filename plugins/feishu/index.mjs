/**
 * plugins/feishu/index.mjs
 * Feishu (Lark) Open Platform & Webhook integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto).
 */

import { createHmac } from "node:crypto";
import { FeishuBotBridge } from "./bot-bridge.mjs";
import { createMedia } from "./media.mjs";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export { FeishuBotBridge, chunkMarkdownText };

export const SECRET_APP_SECRET = "app.secret";
export const SECRET_WEBHOOK_SECRET = "webhook.secret";

export const PRESETS = {
	feishu: {
		label: "飞书 (国内版)",
		baseUrl: "https://open.feishu.cn",
		hint: "飞书开放平台 (open.feishu.cn) → 企业自建应用 → 凭证与基础信息获取 App ID 与 App Secret；开启机器人能力并授予 im:chat / im:message 读写权限",
	},
	lark: {
		label: "Lark (国际版)",
		baseUrl: "https://open.larksuite.com",
		hint: "Lark Developer Console (open.larksuite.com) → Custom App → App ID / App Secret; enable bot capability and im:chat / im:message permissions",
	},
	webhook: {
		label: "仅自定义机器人 Webhook",
		baseUrl: "https://open.feishu.cn",
		hint: "飞书群设置 → 群机器人 → 添加自定义机器人，复制 Webhook 地址与可选安全密钥。支持单向推送文本、富文本与卡片消息",
	},
	custom: {
		label: "自定义 / 私有化网关",
		baseUrl: "",
		hint: "企业私有化部署或自建代理网关，填入 Open API 根地址 (如 https://open.example.com)",
	},
};

/**
 * Redact sensitive secrets from configuration before sending to browser.
 */
export function redactConfig(cfg, { hasAppSecret = false, hasWebhookSecret = false } = {}) {
	const c = { ...(cfg || {}) };
	c.hasAppSecret = Boolean(c.appSecret || hasAppSecret);
	c.hasWebhookSecret = Boolean(c.webhookSecret || hasWebhookSecret);
	c.appSecret = "";
	c.webhookSecret = "";
	return c;
}

/**
 * Strip secrets and secret-presence flags before storing config in plaintext storage.
 */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.appSecret;
	delete c.webhookSecret;
	delete c.hasAppSecret;
	delete c.hasWebhookSecret;
	return c;
}

/**
 * Merge saved secrets into incoming config.
 * Empty secret string retains existing saved secret unless clear flag is set.
 */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingAppSecret = savedSecrets[SECRET_APP_SECRET] || prev.appSecret || "";
	const existingWebhookSecret = savedSecrets[SECRET_WEBHOOK_SECRET] || prev.webhookSecret || "";

	if (incoming.clearAppSecret || !out.appId?.trim()) {
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

/**
 * Sign Feishu custom bot webhook request with HMAC-SHA256.
 */
export function signWebhook(timestampSec, secret) {
	if (!secret) return "";
	const stringToSign = `${timestampSec}\n${secret}`;
	return createHmac("sha256", stringToSign).update("").digest("base64");
}

/**
 * Parse Feishu message content JSON into human-readable text and subject.
 */
export function parseFeishuMessageContent(msgType, contentRaw) {
	let parsed = {};
	if (typeof contentRaw === "string") {
		try {
			parsed = JSON.parse(contentRaw);
		} catch {
			parsed = { text: contentRaw };
		}
	} else if (contentRaw && typeof contentRaw === "object") {
		parsed = contentRaw;
	}

	let subject = "";
	let text = "";
	let preview = "";

	switch (msgType) {
		case "text": {
			text = String(parsed.text || "").trim();
			preview = text;
			break;
		}
		case "post": {
			const postBody = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0] || {};
			subject = String(postBody.title || "").trim();
			const lines = [];
			const contentBlocks = Array.isArray(postBody.content) ? postBody.content : [];
			for (const row of contentBlocks) {
				if (!Array.isArray(row)) continue;
				const rowParts = [];
				for (const elem of row) {
					if (!elem) continue;
					if (elem.tag === "text") rowParts.push(elem.text || "");
					else if (elem.tag === "a") rowParts.push(elem.text ? `[${elem.text}](${elem.href || ""})` : elem.href || "");
					else if (elem.tag === "at") rowParts.push(`@${elem.user_name || elem.user_id || "某人"}`);
					else if (elem.tag === "img") rowParts.push("[图片]");
					else if (elem.tag === "media") rowParts.push("[视频]");
					else if (elem.tag === "emotion") rowParts.push(`[${elem.emoji_type || "表情"}]`);
					else if (elem.tag === "code_block") rowParts.push(`\n\`\`\`\n${elem.text || ""}\n\`\`\`\n`);
				}
				if (rowParts.length) lines.push(rowParts.join(""));
			}
			text = lines.join("\n").trim();
			preview = subject ? `${subject}: ${text}` : text;
			break;
		}
		case "interactive": {
			subject = String(parsed.header?.title?.content || "").trim();
			const parts = [];
			const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
			for (const el of elements) {
				if (!el) continue;
				if (el.tag === "markdown" && el.content) parts.push(el.content);
				else if (el.tag === "div" && el.text?.content) parts.push(el.text.content);
				else if (el.tag === "hr") parts.push("---");
			}
			text = parts.join("\n\n").trim() || JSON.stringify(parsed, null, 2);
			preview = subject ? `[卡片] ${subject}` : `[卡片] ${text.slice(0, 80)}`;
			break;
		}
		case "image":
			subject = "[图片消息]";
			text = `[图片: ${parsed.image_key || "未知"}]`;
			preview = text;
			break;
		case "file":
			subject = `[文件] ${parsed.file_name || ""}`;
			text = `[文件: ${parsed.file_name || parsed.file_key || "未知"}]`;
			preview = text;
			break;
		case "audio":
			subject = "[语音消息]";
			text = `[语音: ${parsed.file_key || "未知"}]`;
			preview = text;
			break;
		case "media":
			subject = `[视频] ${parsed.file_name || ""}`;
			text = `[视频: ${parsed.file_name || parsed.file_key || "未知"}]`;
			preview = text;
			break;
		case "sticker":
			subject = "[表情消息]";
			text = `[表情包: ${parsed.file_key || "未知"}]`;
			preview = text;
			break;
		case "share_chat":
			subject = `[分享群名片] ${parsed.chat_id || ""}`;
			text = `[分享群名片: ${parsed.chat_id || "未知"}]`;
			preview = text;
			break;
		case "share_user":
			subject = `[分享个人名片] ${parsed.user_id || ""}`;
			text = `[分享个人名片: ${parsed.user_id || "未知"}]`;
			preview = text;
			break;
		case "merge_forward":
			subject = "[合并转发消息]";
			text = "[合并转发聊天记录]";
			preview = text;
			break;
		case "system":
			subject = "[系统通知]";
			text = String(parsed.text || JSON.stringify(parsed));
			preview = text;
			break;
		default:
			text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
			preview = text.slice(0, 100);
			break;
	}

	return {
		subject: subject || (text ? text.slice(0, 40).replace(/[\r\n]+/g, " ") : `[${msgType || "消息"}]`),
		text: text || `[${msgType || "未知类型"}]`,
		preview: (preview || text || "").slice(0, 140).replace(/[\r\n]+/g, " "),
		raw: parsed,
	};
}

/**
 * Build message payload for Feishu Open API / Webhook.
 */
export function buildMessageContent({ msgType = "text", text = "", title = "", cardTemplate = "blue" } = {}) {
	const safeText = String(text || "");
	const safeTitle = String(title || "");

	if (msgType === "text") {
		return {
			msg_type: "text",
			content: JSON.stringify({ text: safeText }),
		};
	}

	if (msgType === "post") {
		return {
			msg_type: "post",
			content: JSON.stringify({
				zh_cn: {
					title: safeTitle,
					content: safeText.split("\n").map((line) => [{ tag: "text", text: line }]),
				},
			}),
		};
	}

	if (msgType === "interactive") {
		const card = {
			config: { wide_screen_mode: true },
			header: safeTitle
				? {
						template: cardTemplate || "blue",
						title: { tag: "plain_text", content: safeTitle },
					}
				: undefined,
			elements: [
				{
					tag: "markdown",
					content: safeText,
				},
			],
		};
		return {
			msg_type: "interactive",
			content: JSON.stringify(card),
		};
	}

	return {
		msg_type: "text",
		content: JSON.stringify({ text: safeText }),
	};
}

/**
 * Format a raw Feishu message item into unified UI/AI structure.
 */
export function formatMessageItem(rawMsg, seenIds = new Set()) {
	const msgId = rawMsg.message_id || rawMsg.id || "";
	const msgType = rawMsg.msg_type || "text";
	const parsed = parseFeishuMessageContent(msgType, rawMsg.body?.content || rawMsg.content);
	const createTimeMs = Number(rawMsg.create_time || rawMsg.createTimeMs || Date.now());
	const sender = rawMsg.sender || {};
	const senderId = sender.id || sender.sender_id || "";
	const senderType = sender.sender_type || (senderId ? "user" : "bot");
	const senderName =
		sender.sender_name || sender.name || (senderType === "user" ? `用户(${senderId.slice(-6)})` : "飞书机器人");

	return {
		id: msgId,
		uid: msgId,
		chatId: rawMsg.chat_id || rawMsg.chatId || "",
		msgType,
		senderId,
		senderType,
		senderName,
		subject: parsed.subject,
		text: parsed.text,
		preview: parsed.preview,
		date: new Date(createTimeMs).toISOString(),
		createTimeMs,
		seen: seenIds.has(msgId) || Boolean(rawMsg.seen),
		deleted: Boolean(rawMsg.deleted),
		parentId: rawMsg.parent_id || "",
		rootId: rawMsg.root_id || "",
		mentions: rawMsg.mentions || [],
		reactions: rawMsg.reactions || [],
		rawContent: parsed.raw,
	};
}

/**
 * Protect URLs during machine translation.
 */
export function protectUrls(text) {
	const urls = [];
	const protectedText = String(text || "").replace(/https?:\/\/[^\s<>'")]+/g, (match) => {
		const placeholder = `__URL_${urls.length}__`;
		urls.push(match);
		return placeholder;
	});
	return { protectedText, urls };
}

/**
 * Restore protected URLs after machine translation.
 */
export function restoreProtectedUrls(text, urls = []) {
	return String(text || "").replace(/__URL_(\d+)__/g, (_, idx) => urls[Number(idx)] || "");
}

/**
 * Fast Google GTX translation fallback.
 */
export async function fastTranslateText(text, targetLang = "zh-CN") {
	if (!text?.trim()) return "";
	const { protectedText, urls } = protectUrls(text);
	const sl = "auto";
	const tl = targetLang.startsWith("zh") ? "zh-CN" : targetLang;
	const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(protectedText)}`;
	const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
	if (!res.ok) throw new Error(`Google Translate error ${res.status}`);
	const json = await res.json();
	const translated = Array.isArray(json?.[0]) ? json[0].map((part) => part?.[0] || "").join("") : "";
	return restoreProtectedUrls(translated, urls);
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	let seenIds = new Set((await host.storage.get("seen_ids")) || []);
	let webhookHistory = (await host.storage.get("webhook_history")) || [];
	let customChats = (await host.storage.get("custom_chats")) || [];

	const tokenCache = {
		token: "",
		expiresAt: 0,
		key: "",
	};

	let isPolling = false;

	const media = createMedia({ host, getToken: getTenantAccessToken, getBaseUrl });
	const botBridge = new FeishuBotBridge({
		downloadResource: (cfg, opts) => media.download(cfg, opts),
		host,
		getConfig: () => localConfig,
		sendMessage: (cfg, opts) => sendMessage(cfg, opts),
		replyMessage: (cfg, opts) => replyMessage(cfg, opts),
		reactMessage: (cfg, msgId, emoji) => reactMessage(cfg, msgId, emoji),
		log: (lvl, msg) => host.log?.(lvl, msg),
	});
	await botBridge.restoreSessionRoutes();

	if (localConfig.botEnabled && hasAppConfig(localConfig)) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `Feishu bot auto-start note: ${err.message}`);
		});
	}

	function getBaseUrl(cfg) {
		const preset = PRESETS[cfg.preset || "feishu"];
		const url = cfg.baseUrl?.trim() || preset?.baseUrl || "https://open.feishu.cn";
		return url.replace(/\/+$/, "");
	}

	async function getTenantAccessToken(cfg, force = false) {
		const appId = cfg.appId?.trim();
		const appSecret = cfg.appSecret?.trim();
		if (!appId || !appSecret) {
			throw new Error("Feishu App ID or App Secret is not configured.");
		}
		const baseUrl = getBaseUrl(cfg);
		const cacheKey = `${baseUrl}|${appId}|${appSecret}`;
		const now = Date.now();

		if (!force && tokenCache.token && tokenCache.key === cacheKey && tokenCache.expiresAt > now + 60000) {
			return tokenCache.token;
		}

		const resp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
		});

		if (!resp.ok) {
			throw new Error(`Feishu token request failed with HTTP ${resp.status}`);
		}

		const data = await resp.json();
		if (data.code !== 0) {
			throw new Error(`Feishu auth failed [${data.code}]: ${data.msg || "unknown error"}`);
		}

		tokenCache.token = data.tenant_access_token;
		tokenCache.expiresAt = now + (Number(data.expire || 7200) - 120) * 1000;
		tokenCache.key = cacheKey;
		return tokenCache.token;
	}

	async function feishuApi(cfg, method, path, { query = {}, body = null } = {}, retryAuth = true) {
		const baseUrl = getBaseUrl(cfg);
		const token = await getTenantAccessToken(cfg);

		const url = new URL(`${baseUrl}${path}`);
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null && v !== "") {
				url.searchParams.set(k, String(v));
			}
		}

		const headers = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		};

		const resp = await fetch(url.toString(), {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!resp.ok) {
			throw new Error(`Feishu API ${method} ${path} failed with HTTP ${resp.status}`);
		}

		const data = await resp.json();
		if (data.code === 99991663 || data.code === 99991661) {
			if (retryAuth) {
				await getTenantAccessToken(cfg, true);
				return feishuApi(cfg, method, path, { query, body }, false);
			}
		}

		if (data.code !== 0) {
			let errorTip = `[${data.code}] ${data.msg || "API call failed"}`;
			if (data.code === 99991672 || data.code === 99991668) {
				errorTip +=
					" (请检查应用是否已开通对应权限，如 im:chat:readonly 或 im:message:readonly，并在飞书开放平台发布版本)";
			}
			throw new Error(errorTip);
		}

		return data.data || {};
	}

	function hasAppConfig(cfg) {
		return Boolean(cfg.appId?.trim() && cfg.appSecret?.trim());
	}

	function hasWebhookConfig(cfg) {
		return Boolean(cfg.webhookUrl?.trim());
	}

	async function listChats(cfg, limit = 50) {
		const items = [];

		if (hasAppConfig(cfg)) {
			try {
				const res = await feishuApi(cfg, "GET", "/open-apis/im/v1/chats", {
					query: { page_size: Math.min(limit, 100) },
				});
				const rawItems = Array.isArray(res.items) ? res.items : [];
				for (const item of rawItems) {
					items.push({
						id: item.chat_id,
						chatId: item.chat_id,
						name: item.name || `群聊 (${item.chat_id.slice(-6)})`,
						avatar: item.avatar || "",
						chatMode: item.chat_mode || "group",
						chatType: item.chat_type || "group",
						desc: item.description || "",
						ownerId: item.owner_id || "",
						isCustom: false,
					});
				}
			} catch (err) {
				host.log?.("warn", `Feishu listChats failed: ${err.message}`);
			}
		}

		for (const custom of customChats) {
			if (!items.some((i) => i.id === custom.id)) {
				items.push({
					id: custom.id,
					chatId: custom.id,
					name: custom.name || custom.id,
					avatar: "",
					chatMode: custom.chatMode || "p2p",
					chatType: custom.chatType || "custom",
					desc: custom.description || "自定义快捷会话",
					ownerId: "",
					isCustom: true,
				});
			}
		}

		if (hasWebhookConfig(cfg)) {
			items.unshift({
				id: "__webhook__",
				chatId: "__webhook__",
				name: "自定义机器人 Webhook",
				avatar: "",
				chatMode: "webhook",
				chatType: "webhook",
				desc: "单向推送通道 (Webhook 推送记录)",
				ownerId: "",
				isCustom: false,
				isWebhook: true,
			});
		}

		return items;
	}

	async function listMessages(cfg, chatId = "", limit = 30) {
		if (chatId === "__webhook__" || (!chatId && !hasAppConfig(cfg) && hasWebhookConfig(cfg))) {
			return webhookHistory.slice(0, limit);
		}

		if (!hasAppConfig(cfg)) {
			if (hasWebhookConfig(cfg)) return webhookHistory.slice(0, limit);
			return [];
		}

		const targetChatId = chatId || cfg.defaultChatId?.trim();
		if (!targetChatId) {
			const chats = await listChats(cfg, 1);
			const firstChat = chats.find((c) => c.id !== "__webhook__");
			if (!firstChat) return [];
			return listMessages(cfg, firstChat.id, limit);
		}

		const res = await feishuApi(cfg, "GET", "/open-apis/im/v1/messages", {
			query: {
				container_id_type: "chat",
				container_id: targetChatId,
				sort_type: "ByCreateTimeDesc",
				page_size: Math.min(limit, 50),
			},
		});

		const rawItems = Array.isArray(res.items) ? res.items : [];
		return rawItems.map((item) => formatMessageItem(item, seenIds));
	}

	async function readMessage(cfg, messageId, chatId = "") {
		if (!messageId) throw new Error("messageId is required.");

		if (messageId.startsWith("wh_")) {
			const found = webhookHistory.find((w) => w.id === messageId);
			if (found) {
				found.seen = true;
				await host.storage.set("webhook_history", webhookHistory);
				return found;
			}
		}

		if (!hasAppConfig(cfg)) {
			throw new Error("Feishu app credentials are required to read messages.");
		}

		const res = await feishuApi(cfg, "GET", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
		const rawItems = Array.isArray(res.items) ? res.items : [res];
		const item = rawItems[0] || {};
		const formatted = formatMessageItem(item, seenIds);

		if (!seenIds.has(messageId)) {
			seenIds.add(messageId);
			await host.storage.set("seen_ids", Array.from(seenIds).slice(-1000));
		}
		formatted.seen = true;
		await updateUnreadStatus();
		return formatted;
	}

	async function searchMessages(cfg, query = "", chatId = "", limit = 20) {
		const q = String(query || "")
			.trim()
			.toLowerCase();
		if (!q) return listMessages(cfg, chatId, limit);

		const all = await listMessages(cfg, chatId, 60);
		return all
			.filter((m) => {
				return (
					m.text?.toLowerCase().includes(q) ||
					m.subject?.toLowerCase().includes(q) ||
					m.senderName?.toLowerCase().includes(q) ||
					m.senderId?.toLowerCase().includes(q) ||
					m.id?.toLowerCase().includes(q)
				);
			})
			.slice(0, limit);
	}

	async function sendWebhook(
		cfg,
		{ webhookUrl = "", webhookSecret = "", msgType = "text", text = "", title = "", cardTemplate = "blue" } = {},
	) {
		if (!["text", "post", "interactive"].includes(msgType))
			throw new Error("Webhook 不支持媒体发送，请使用自建应用 send/reply。");
		const targetUrl = webhookUrl?.trim() || cfg.webhookUrl?.trim();
		const secret = webhookSecret?.trim() || cfg.webhookSecret?.trim();
		if (!targetUrl) throw new Error("Webhook URL is not configured.");

		const payload = buildMessageContent({ msgType, text, title, cardTemplate });
		const body = { ...payload };

		if (secret) {
			const timestamp = Math.floor(Date.now() / 1000).toString();
			body.timestamp = timestamp;
			body.sign = signWebhook(timestamp, secret);
		}

		const resp = await fetch(targetUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			throw new Error(`Feishu Webhook HTTP ${resp.status}`);
		}

		const data = await resp.json();
		if (data.code !== 0 && data.StatusCode !== 0) {
			throw new Error(`Feishu Webhook error [${data.code || data.StatusCode}]: ${data.msg || "unknown error"}`);
		}

		const historyItem = {
			id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			uid: `wh_${Date.now()}`,
			chatId: "__webhook__",
			msgType,
			senderId: "webhook",
			senderType: "bot",
			senderName: "自定义机器人",
			subject: title || text.slice(0, 40),
			text,
			preview: text.slice(0, 100),
			date: new Date().toISOString(),
			createTimeMs: Date.now(),
			seen: true,
			deleted: false,
			rawContent: body,
		};

		webhookHistory.unshift(historyItem);
		if (webhookHistory.length > 50) webhookHistory = webhookHistory.slice(0, 50);
		await host.storage.set("webhook_history", webhookHistory);

		return { success: true, id: historyItem.id, msg: "Webhook message sent successfully" };
	}

	async function sendMessage(
		cfg,
		{
			receiveId = "",
			receiveIdType = "chat_id",
			msgType = "text",
			text = "",
			title = "",
			cardTemplate = "blue",
			filePath = "",
			duration,
		} = {},
	) {
		if (receiveId === "__webhook__" || (!receiveId && !hasAppConfig(cfg) && hasWebhookConfig(cfg))) {
			return sendWebhook(cfg, { msgType, text, title, cardTemplate });
		}

		if (!hasAppConfig(cfg)) {
			if (hasWebhookConfig(cfg)) {
				return sendWebhook(cfg, { msgType, text, title, cardTemplate });
			}
			throw new Error("Feishu app credentials or Webhook URL must be configured.");
		}

		const targetId = receiveId?.trim() || cfg.defaultChatId?.trim();
		if (!targetId) {
			throw new Error("Target receiveId (or defaultChatId) is required.");
		}

		let idType = receiveIdType;
		if (targetId.startsWith("ou_")) idType = "open_id";
		else if (targetId.startsWith("oc_")) idType = "chat_id";
		else if (targetId.includes("@")) idType = "email";

		const payload = ["image", "audio", "file", "media"].includes(msgType)
			? await media.upload(cfg, { filePath, msgType, duration })
			: buildMessageContent({ msgType, text, title, cardTemplate });
		const body = {
			receive_id: targetId,
			...payload,
		};

		const res = await feishuApi(cfg, "POST", "/open-apis/im/v1/messages", {
			query: { receive_id_type: idType },
			body,
		});

		return {
			success: true,
			messageId: res.message_id,
			chatId: res.chat_id,
			msg: "Message sent successfully",
		};
	}

	async function replyMessage(
		cfg,
		{
			messageId,
			msgType = "text",
			text = "",
			title = "",
			cardTemplate = "blue",
			replyInThread = false,
			filePath = "",
			duration,
		} = {},
	) {
		if (!messageId) throw new Error("messageId is required.");
		if (!hasAppConfig(cfg)) throw new Error("Feishu app credentials are required to reply to messages.");

		const payload = ["image", "audio", "file", "media"].includes(msgType)
			? await media.upload(cfg, { filePath, msgType, duration })
			: buildMessageContent({ msgType, text, title, cardTemplate });
		const body = {
			...payload,
			reply_in_thread: Boolean(replyInThread),
		};

		const res = await feishuApi(cfg, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
			body,
		});

		return {
			success: true,
			messageId: res.message_id,
			chatId: res.chat_id,
			msg: "Reply sent successfully",
		};
	}

	async function recallMessage(cfg, messageId) {
		if (!messageId) throw new Error("messageId is required.");
		if (!hasAppConfig(cfg)) throw new Error("Feishu app credentials are required to recall messages.");

		await feishuApi(cfg, "DELETE", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
		return { success: true, messageId, msg: "Message recalled successfully" };
	}

	async function reactMessage(cfg, messageId, emojiType = "THUMBSUP") {
		if (!messageId) throw new Error("messageId is required.");
		if (!hasAppConfig(cfg)) throw new Error("Feishu app credentials are required to add reactions.");

		await feishuApi(cfg, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
			body: {
				reaction_type: { emoji_type: emojiType.toUpperCase() },
			},
		});

		return { success: true, messageId, emojiType, msg: "Reaction added" };
	}

	async function countUnread(cfg) {
		if (!hasAppConfig(cfg)) {
			if (hasWebhookConfig(cfg)) return { unread: 0, status: "webhook" };
			return { unread: 0, status: "unconfigured" };
		}
		try {
			const msgs = await listMessages(cfg, "", 20);
			const unread = msgs.filter((m) => !m.seen && !seenIds.has(m.id)).length;
			return { unread, status: "ok" };
		} catch (err) {
			return { unread: 0, status: "error", error: err.message };
		}
	}

	async function updateUnreadStatus() {
		const { unread, status } = await countUnread(localConfig);
		let label = "🐦 --";
		let title = "点击打开飞书工作台";

		if (status === "unconfigured") {
			label = "🐦 未配置";
			title = "飞书插件尚未配置凭证或 Webhook";
		} else if (status === "webhook") {
			label = "🐦 Webhook";
			title = "已配置飞书自定义机器人 Webhook (单向推送)";
		} else if (status === "ok") {
			label = unread > 0 ? `🐦 ${unread} 未读` : "🐦 ✓";
			title = unread > 0 ? `飞书有 ${unread} 条新消息` : "飞书消息已全部读完";
		}

		host.ui?.update?.("feishu-unread", { label, hint: title });
	}

	async function pollNewMessages() {
		if (isPolling) return;
		isPolling = true;
		try {
			if (!hasAppConfig(localConfig)) return;
			const msgs = await listMessages(localConfig, "", 15);
			let newlyArrived = 0;
			for (const m of msgs) {
				if (!seenIds.has(m.id)) {
					newlyArrived++;
				}
			}
			if (newlyArrived > 0) {
				host.notify?.("info", `飞书收到 ${newlyArrived} 条新消息`);
				host.broadcast?.({ kind: "feishu-new-message", count: newlyArrived });
			}
			await updateUnreadStatus();
		} catch (err) {
			host.log?.("warn", `Feishu poll failed: ${err.message}`);
		} finally {
			isPolling = false;
		}
	}

	// 轮询调度：宿主的 registerBackgroundTask 是纯「后台任务面板」登记（只消费
	// id/label/status/stop，不产生任何调度）——此前把 intervalSec/run 传给它，
	// 轮询从未被调度，新消息通知/未读徽标只剩面板「立即轮询」一条触发路径。
	// 与 webmail 同口径：插件自建 setInterval，面板任务负责可见性与一键停止。
	let pollTimer = null;
	const pollSecLabel = () => `每 ${Math.max(15, Math.floor(Number(localConfig.pollSec) || 60))}s`;
	const restartPoller = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (hasAppConfig(localConfig)) {
			const sec = Math.max(15, Math.floor(Number(localConfig.pollSec) || 60));
			pollTimer = setInterval(() => void pollNewMessages(), sec * 1000);
			void pollNewMessages(); // 立即来一轮
			bgTask?.update({ status: pollSecLabel() });
		} else {
			bgTask?.update({ status: "未配置" });
		}
	};
	const bgTask = host.registerBackgroundTask?.({
		id: "feishu-poll",
		label: "🐦 飞书轮询",
		status: hasAppConfig(localConfig) ? pollSecLabel() : "未配置",
		stop: () => {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
			host.log?.("info", "Feishu polling stopped from background panel");
		},
	});
	restartPoller();

	// Register AI tool "feishu" adhering strictly to tool-prompt-hygiene rules
	host.registerTool?.({
		name: "feishu",
		description:
			"Browse chats, read/send/reply/recall messages, add emoji reactions, and post custom bot webhook cards via Feishu (Lark) Open Platform.",
		promptSnippet: "interact with Feishu/Lark chats, read or send messages, and post webhook cards",
		promptGuidelines: [
			"Confirm target chat/recipient and message content with the user once before action=send, reply, or webhook",
			"Use action=chats first if the target chat_id is unknown",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["chats", "list", "read", "search", "send", "reply", "recall", "react", "webhook"],
					description: "The Feishu action to perform.",
				},
				chat_id: {
					type: "string",
					description: "Chat ID (e.g. oc_xxx), open_id (ou_xxx), or virtual '__webhook__'.",
				},
				message_id: {
					type: "string",
					description: "Message ID (om_xxx) for read, reply, recall, or react.",
				},
				query: {
					type: "string",
					description: "search: keyword to search within messages.",
				},
				limit: {
					type: "number",
					description: "chats/list/search: maximum number of items (default 20, max 100).",
				},
				msg_type: {
					type: "string",
					enum: ["text", "post", "interactive", "image", "audio", "file", "media"],
					description: "send/reply: text, card, image, opus audio, file or mp4 video; webhook supports text/cards.",
				},
				file_path: {
					type: "string",
					description: "send/reply: local media path; absolute paths require host filesystem authorization.",
				},
				duration: { type: "number", description: "send/reply audio/video: actual duration in milliseconds." },
				text: {
					type: "string",
					description: "send/reply/webhook: message body (plain text or markdown for cards).",
				},
				title: {
					type: "string",
					description: "send/reply/webhook: optional title for post or card message.",
				},
				card_template: {
					type: "string",
					enum: [
						"blue",
						"wathet",
						"turquoise",
						"green",
						"yellow",
						"orange",
						"red",
						"violet",
						"purple",
						"indigo",
						"grey",
					],
					description: "send/reply/webhook: header color template for interactive card.",
				},
				reply_in_thread: {
					type: "boolean",
					description: "reply: whether to reply inside the thread topic (default false).",
				},
				emoji_type: {
					type: "string",
					description: "react: emoji code (e.g. THUMBSUP, OK, HEART, APPLAUSE, DONE, FIRE).",
				},
				receive_id: {
					type: "string",
					description: "send: target receiver ID (chat_id, open_id, user_id, or email).",
				},
				receive_id_type: {
					type: "string",
					enum: ["chat_id", "open_id", "user_id", "email"],
					description: "send: receiver ID type (default chat_id).",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			const cfg = localConfig;

			switch (action) {
				case "chats": {
					const chats = await listChats(cfg, args.limit || 50);
					return JSON.stringify(
						chats.map((c) => ({
							id: c.id,
							name: c.name,
							chatMode: c.chatMode,
							chatType: c.chatType,
							description: c.desc || c.description || "",
						})),
						null,
						2,
					);
				}
				case "list": {
					const msgs = await listMessages(cfg, args.chat_id || "", args.limit || 20);
					return JSON.stringify(
						msgs.map((m) => ({
							id: m.id,
							chatId: m.chatId,
							sender: m.senderName,
							type: m.msgType,
							date: m.date,
							subject: m.subject,
							preview: m.preview,
							seen: m.seen,
						})),
						null,
						2,
					);
				}
				case "read": {
					if (!args.message_id) throw new Error("message_id is required for action=read");
					const item = await readMessage(cfg, args.message_id, args.chat_id || "");
					return JSON.stringify(item, null, 2);
				}
				case "search": {
					const results = await searchMessages(cfg, args.query || "", args.chat_id || "", args.limit || 20);
					return JSON.stringify(
						results.map((m) => ({
							id: m.id,
							chatId: m.chatId,
							sender: m.senderName,
							subject: m.subject,
							text: m.text,
							date: m.date,
						})),
						null,
						2,
					);
				}
				case "send": {
					const res = await sendMessage(cfg, {
						receiveId: args.receive_id || args.chat_id || "",
						receiveIdType: args.receive_id_type || "chat_id",
						msgType: args.msg_type || "text",
						filePath: args.file_path || "",
						duration: args.duration,
						text: args.text || "",
						title: args.title || "",
						cardTemplate: args.card_template || "blue",
					});
					return JSON.stringify(res, null, 2);
				}
				case "reply": {
					if (!args.message_id) throw new Error("message_id is required for action=reply");
					const res = await replyMessage(cfg, {
						messageId: args.message_id,
						msgType: args.msg_type || "text",
						filePath: args.file_path || "",
						duration: args.duration,
						text: args.text || "",
						title: args.title || "",
						cardTemplate: args.card_template || "blue",
						replyInThread: Boolean(args.reply_in_thread),
					});
					return JSON.stringify(res, null, 2);
				}
				case "recall": {
					if (!args.message_id) throw new Error("message_id is required for action=recall");
					const res = await recallMessage(cfg, args.message_id);
					return JSON.stringify(res, null, 2);
				}
				case "react": {
					if (!args.message_id) throw new Error("message_id is required for action=react");
					const res = await reactMessage(cfg, args.message_id, args.emoji_type || "THUMBSUP");
					return JSON.stringify(res, null, 2);
				}
				case "webhook": {
					const res = await sendWebhook(cfg, {
						msgType: args.msg_type || "text",
						text: args.text || "",
						title: args.title || "",
						cardTemplate: args.card_template || "blue",
					});
					return JSON.stringify(res, null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	// 回包回显请求里的 __rid：新宿主只有「上行 send / 下行 onData」，没有请求-回调
	// 配对，客户端据此把回包配到发起的那次请求上（不带 __rid 时行为不变）。
	host.onClientMessage?.(async (msg, replyRaw) => {
		const __rid = msg && msg.__rid;
		const reply = (payload) =>
			__rid === undefined
				? replyRaw(payload)
				: replyRaw(payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, __rid } : payload);
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					const safeConfig = redactConfig(localConfig, {
						hasAppSecret: Boolean(secrets[SECRET_APP_SECRET]),
						hasWebhookSecret: Boolean(secrets[SECRET_WEBHOOK_SECRET]),
					});
					const status = await countUnread(localConfig);
					reply({
						type: "state",
						config: safeConfig,
						status,
						presets: PRESETS,
						customChats,
						botStatus: botBridge.getStatus(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);
					botBridge.syncRouteAccount();

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
					tokenCache.token = "";
					tokenCache.expiresAt = 0;

					// 配置变了（含 pollSec、首次配好 appId/appSecret）：按新配置重启轮询
					restartPoller();
					if (localConfig.botEnabled && hasAppConfig(localConfig)) {
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}
					await updateUnreadStatus();
					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);
					const results = { appOk: false, webhookOk: false, messages: [] };

					if (hasAppConfig(testCfg)) {
						try {
							await getTenantAccessToken(testCfg, true);
							results.appOk = true;
							results.messages.push("飞书企业应用认证成功 (tenant_access_token 获取正常)");
						} catch (err) {
							results.messages.push(`飞书企业应用连接失败: ${err.message}`);
						}
					} else {
						results.messages.push("未配置 App ID / App Secret");
					}

					if (hasWebhookConfig(testCfg)) {
						try {
							await sendWebhook(testCfg, {
								msgType: "text",
								text: "【pi-web-ui 飞书测试】连接配置成功！",
							});
							results.webhookOk = true;
							results.messages.push("飞书 Webhook 测试推送成功");
						} catch (err) {
							results.messages.push(`飞书 Webhook 推送失败: ${err.message}`);
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

				case "list_chats": {
					const chats = await listChats(localConfig, msg.limit || 50);
					reply({ type: "chats_list", items: chats });
					break;
				}

				case "add_custom_chat": {
					const custom = msg.chat || {};
					if (custom.id?.trim()) {
						if (!customChats.some((c) => c.id === custom.id.trim())) {
							customChats.push({
								id: custom.id.trim(),
								name: custom.name?.trim() || custom.id.trim(),
								chatMode: custom.chatMode || "p2p",
								chatType: "custom",
								desc: custom.description?.trim() || "自定义快捷会话",
							});
							await host.storage.set("custom_chats", customChats);
						}
					}
					const chats = await listChats(localConfig, 50);
					reply({ type: "chats_list", items: chats });
					break;
				}

				case "remove_custom_chat": {
					const targetId = msg.id?.trim();
					if (targetId) {
						customChats = customChats.filter((c) => c.id !== targetId);
						await host.storage.set("custom_chats", customChats);
					}
					const chats = await listChats(localConfig, 50);
					reply({ type: "chats_list", items: chats });
					break;
				}

				case "list_messages": {
					const msgs = await listMessages(localConfig, msg.chatId || "", msg.limit || 30);
					reply({ type: "messages_list", items: msgs, chatId: msg.chatId || "" });
					break;
				}

				case "read_message": {
					const item = await readMessage(localConfig, msg.messageId, msg.chatId || "");
					reply({ type: "message_read", item });
					break;
				}

				case "search_messages": {
					const items = await searchMessages(localConfig, msg.query || "", msg.chatId || "", msg.limit || 20);
					reply({ type: "messages_list", items, chatId: msg.chatId || "", isSearch: true });
					break;
				}

				case "send_message": {
					const res = await sendMessage(localConfig, msg.payload || {});
					await updateUnreadStatus();
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "reply_message": {
					const res = await replyMessage(localConfig, msg.payload || {});
					reply({ type: "reply_done", success: true, res });
					break;
				}

				case "recall_message": {
					const res = await recallMessage(localConfig, msg.messageId);
					reply({ type: "recall_done", success: true, res });
					break;
				}

				case "react_message": {
					const res = await reactMessage(localConfig, msg.messageId, msg.emojiType);
					reply({ type: "react_done", success: true, res });
					break;
				}

				case "mark_seen": {
					if (Array.isArray(msg.messageIds)) {
						for (const id of msg.messageIds) seenIds.add(id);
						await host.storage.set("seen_ids", Array.from(seenIds).slice(-1000));
						await updateUnreadStatus();
					}
					reply({ type: "mark_seen_done", success: true });
					break;
				}

				case "translate_message": {
					const rawText = msg.text || "";
					const targetLang = msg.targetLang || "zh-CN";
					const model = msg.model;

					let translation = "";
					if (model && host.complete) {
						try {
							const prompt = `Translate the following Feishu message into ${targetLang}. Keep emojis, names, code blocks and formatting intact. Return ONLY the translated text:\n\n${rawText}`;
							const resp = await host.complete({
								model,
								messages: [{ role: "user", content: prompt }],
							});
							translation = resp.text?.trim() || "";
						} catch (llmErr) {
							host.log?.("warn", `Feishu LLM translation failed, falling back: ${llmErr.message}`);
						}
					}

					if (!translation) {
						translation = await fastTranslateText(rawText, targetLang);
					}

					reply({ type: "translate_done", translation, targetLang });
					break;
				}

				case "get_bot_status": {
					reply({ type: "bot_status", status: botBridge.getStatus() });
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

				case "poll_now": {
					await pollNewMessages();
					reply({ type: "poll_done", success: true });
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

	await updateUnreadStatus();

	// activate 返回的函数被宿主登记为 deactivate（server/plugins.ts）：反激活时停掉轮询与 Bot
	return async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		await botBridge.stop().catch(() => {});
	};
}
