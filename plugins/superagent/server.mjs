import { createHash, createHmac, createDecipheriv, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const PROVIDERS = ["github", "feishu"];
const SECRET_KEYS = ["githubSecret", "githubToken", "feishuVerificationToken", "feishuEncryptKey", "feishuAppSecret"];
const MAX_BODY = 1024 * 1024;
const defaults = () => ({
	github: { mode: "observe", mappings: [], allowedAuthors: [], allowedRepos: [] },
	feishu: { mode: "observe", mappings: [], allowedAuthors: [], appId: "" },
});
const digest = (s) => createHash("sha256").update(s).digest("hex");
const equal = (a, b) => {
	const left = Buffer.from(String(a ?? ""));
	const right = Buffer.from(String(b ?? ""));
	return left.length === right.length && timingSafeEqual(left, right);
};
const fault = (status, message) => Object.assign(new Error(message), { status });
const header = (req, name) => {
	const value = req.get?.(name) ?? req.headers?.[name.toLowerCase()];
	return typeof value === "string" ? value : "";
};
const string = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const text = (value) => string(value, 24000);
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const threadPattern = /^#[1-9]\d*$/;

function normalizeConfig(input) {
	if (!input || typeof input !== "object") throw fault(400, "Invalid configuration");
	const config = defaults();
	for (const provider of PROVIDERS) {
		const source = input[provider] ?? {};
		if (source.mode !== undefined && !["observe", "auto"].includes(source.mode)) throw fault(400, "Invalid mode");
		const target = config[provider];
		target.mode = source.mode ?? "observe";
		for (const key of provider === "github" ? ["allowedAuthors", "allowedRepos"] : ["allowedAuthors"]) {
			if (source[key] !== undefined && (!Array.isArray(source[key]) || source[key].length > 500))
				throw fault(400, "Invalid allowlist");
			target[key] = [
				...new Set(
					(source[key] ?? []).map((v) => {
						if (typeof v !== "string" || !v.trim() || v.length > 200) throw fault(400, "Invalid allowlist entry");
						if (key === "allowedRepos" && !repoPattern.test(v.trim())) throw fault(400, "Invalid repository");
						return v.trim();
					}),
				),
			];
		}
		if (source.mappings !== undefined && (!Array.isArray(source.mappings) || source.mappings.length > 500))
			throw fault(400, "Invalid mappings");
		const seen = new Set();
		target.mappings = (source.mappings ?? []).map((entry) => {
			if (
				!entry ||
				typeof entry.channelId !== "string" ||
				typeof entry.roomId !== "string" ||
				!entry.roomId.trim() ||
				entry.roomId.length > 200 ||
				!entry.channelId.trim() ||
				entry.channelId.length > 200
			)
				throw fault(400, "Invalid room mapping");
			const channelId = entry.channelId.trim();
			const identity = provider === "github" ? channelId.toLowerCase() : channelId;
			if ((provider === "github" && !repoPattern.test(channelId)) || seen.has(identity))
				throw fault(400, "Invalid or duplicate channel");
			seen.add(identity);
			return { channelId, roomId: entry.roomId.trim() };
		});
		if (provider === "feishu") target.appId = string(source.appId).trim();
	}
	return config;
}

function localMutation(req) {
	const address = req.socket?.remoteAddress;
	if (!address || !/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i.test(address))
		throw fault(403, "Configuration and work item actions require a local connection");
	const origin = header(req, "origin");
	if (origin) {
		let parsed;
		try {
			parsed = new URL(origin);
		} catch {
			throw fault(403, "Invalid origin");
		}
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.host !== header(req, "host"))
			throw fault(403, "Cross-origin mutation denied");
	}
}

function raw(req) {
	if (!Buffer.isBuffer(req.rawBody)) throw fault(503, "Host rawBody Buffer support is required");
	if (req.rawBody.length > MAX_BODY) throw fault(413, "Webhook too large");
	return req.rawBody;
}
function parse(bytes) {
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw fault(400, "Invalid JSON");
	}
}
function githubEvent(event, body, eventId) {
	if (event === "ping") return null;
	if (
		!["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"].includes(event)
	)
		return null;
	const actions = {
		issues: ["opened", "edited", "reopened", "closed"],
		issue_comment: ["created", "edited"],
		pull_request: ["opened", "edited", "reopened", "closed", "synchronize", "ready_for_review"],
		pull_request_review: ["submitted", "edited"],
		pull_request_review_comment: ["created", "edited"],
	};
	if (!actions[event].includes(body.action)) return null;
	if (body.sender?.type === "Bot") return null;
	const subject = body.issue ?? body.pull_request;
	const content = body.comment ?? body.review ?? subject;
	const channelId = string(body.repository?.full_name);
	const number = subject?.number;
	if (
		!repoPattern.test(channelId) ||
		!Number.isSafeInteger(number) ||
		number <= 0 ||
		!Number.isSafeInteger(body.sender?.id) ||
		body.sender.id <= 0
	)
		throw fault(400, "Missing GitHub identity");
	if (String(content?.body ?? "").includes("<!-- pi-superagent:")) return null;
	const kind =
		event === "pull_request" && body.action === "closed" && body.pull_request?.merged === true
			? "pull_request.merged"
			: `${event}.${body.action}`;
	const title = string(subject?.title, 500).trim() || `${channelId} #${number}`;
	return {
		provider: "github",
		channelId,
		threadId: `#${number}`,
		eventId,
		title,
		text: text(content?.body).trim() ? text(content.body) : `${kind}: ${title}`,
		authorId: String(body.sender.id),
		kind,
	};
}
function feishuEvent(body) {
	if (body.header?.event_type !== "im.message.receive_v1") return null;
	const event = body.event;
	if (event?.sender?.sender_type !== "user") return null;
	const message = event.message;
	if (message?.message_type !== "text") return null;
	const authorId = string(event.sender.sender_id?.open_id);
	const channelId = string(message.chat_id);
	const eventId = string(body.header.event_id);
	const messageId = string(message.message_id);
	if (!authorId || !channelId || !eventId || !messageId) throw fault(400, "Missing Feishu identity");
	let content;
	try {
		content = JSON.parse(message.content);
	} catch {
		throw fault(400, "Invalid Feishu message content");
	}
	return {
		provider: "feishu",
		channelId,
		eventId,
		authorId,
		threadId: string(message.root_id || message.parent_id || messageId),
		title: text(content.text).slice(0, 200),
		text: text(content.text),
		kind: "message.text",
	};
}

export function createSuperagent(
	host,
	{ fetch: fetchImpl = host.fetch?.bind(host) ?? globalThis.fetch, now = Date.now, pollMs = 15000 } = {},
) {
	let disposed = false;
	let running;
	let ingress = Promise.resolve();
	let appToken;
	let deliverySignal;
	const unregister = [];
	const config = () => normalizeConfig(host.storage.get("config", defaults()));
	const secret = (key) => host.secrets?.get(key) ?? "";
	const canDeliver = (cfg, provider) =>
		cfg[provider].mappings.length > 0 &&
		Boolean(provider === "github" ? secret("githubToken") : cfg.feishu.appId && secret("feishuAppSecret"));
	const items = () => {
		if (!host.workItems?.ingest) throw fault(503, "Host workItems API is required");
		return host.workItems;
	};
	const sameChannel = (provider, a, b) => (provider === "github" ? a.toLowerCase() === b.toLowerCase() : a === b);
	const mapped = (cfg, event) =>
		cfg[event.provider].mappings.find((row) => sameChannel(event.provider, row.channelId, event.channelId));
	const autoAllowed = (cfg, event) => {
		const source = cfg[event.provider];
		return (
			source?.mode === "auto" &&
			Boolean(mapped(cfg, event)) &&
			source.allowedAuthors.includes(event.authorId) &&
			(event.provider !== "github" ||
				source.allowedRepos.some((r) => r.toLowerCase() === event.channelId.toLowerCase()))
		);
	};
	const register = (method, path, handler) => {
		unregister.push(
			host.route(method, path, async (req, res) => {
				try {
					return await handler(req, res);
				} catch (error) {
					return res
						.status(error.status ?? 500)
						.json({ error: error.status ? error.message : "Superagent operation failed" });
				}
			}),
		);
	};
	const ingest = (event) => {
		const task = ingress.then(async () => {
			if (!event) return { ignored: true };
			const receipts = host.storage.get("receipts", []);
			const key = `${event.provider}:${event.eventId}`;
			const fingerprint = digest(JSON.stringify(event));
			const previous = receipts.find((r) => r.key === key);
			if (previous) {
				if (previous.fingerprint !== fingerprint) throw fault(409, "Event identity conflict");
				return { duplicate: true };
			}
			const cfg = config();
			const mapping = mapped(cfg, event);
			if (!mapping) return { ignored: true, reason: "Configure a room mapping for this channel first" };
			const authorized = autoAllowed(cfg, event);
			const result = await items().ingest({
				...event,
				roomId: mapping?.roomId,
				mode: cfg[event.provider].mode,
				authorized,
			});
			host.storage.set("receipts", [...receipts.slice(-4095), { key, fingerprint }]);
			return { accepted: true, authorized, item: result };
		});
		ingress = task.catch(() => {});
		return task;
	};

	register("GET", "/config", (_req, res) =>
		res.json({ config: config(), secrets: Object.fromEntries(SECRET_KEYS.map((key) => [key, Boolean(secret(key))])) }),
	);
	register("PUT", "/config", async (req, res) => {
		localMutation(req);
		const next = normalizeConfig(req.body?.config);
		const edits = req.body?.secrets ?? {};
		for (const [key, edit] of Object.entries(edits)) {
			if (!SECRET_KEYS.includes(key) || !edit || !["keep", "set", "clear"].includes(edit.action))
				throw fault(400, "Invalid secret operation");
			if (edit.action === "set" && (typeof edit.value !== "string" || !edit.value.trim() || edit.value.length > 4096))
				throw fault(400, "Invalid secret value");
		}
		if (Object.keys(edits).length && !host.secrets) throw fault(503, "Encrypted host secrets API is required");
		const rooms = await items().rooms();
		const ids = new Set(rooms.map((r) => r.id));
		for (const provider of PROVIDERS)
			for (const mapping of next[provider].mappings) if (!ids.has(mapping.roomId)) throw fault(400, "Unknown room");
		for (const [key, edit] of Object.entries(edits)) {
			if (edit.action === "set") host.secrets.set(key, edit.value.trim());
			if (edit.action === "clear") host.secrets.delete(key);
		}
		appToken = undefined;
		host.storage.set("config", next);
		return res.json({ ok: true });
	});
	register("GET", "/rooms", async (_req, res) => res.json({ rooms: await items().rooms() }));
	register("GET", "/items", async (req, res) =>
		res.json({
			items: await items().list({ roomId: typeof req.query?.roomId === "string" ? req.query.roomId : undefined }),
		}),
	);
	register("GET", "/item", async (req, res) => {
		const item = await items().get(string(req.query?.id));
		if (!item) throw fault(404, "Work item not found");
		return res.json({ item });
	});
	register("POST", "/items/update", async (req, res) => {
		localMutation(req);
		const patch = {
			pause: { status: "blocked" },
			resume: { status: "open" },
			complete: { status: "completed" },
			authorize: { authorized: true },
			observe: { authorized: false },
		}[req.body?.action];
		if (!patch || typeof req.body?.id !== "string") throw fault(400, "Invalid work item action");
		return res.json({ item: await items().update(req.body.id, patch) });
	});
	register("POST", "/webhooks/github", async (req, res) => {
		const key = secret("githubSecret");
		if (!key) throw fault(503, "GitHub webhook secret is not configured");
		const bytes = raw(req);
		const signature = header(req, "x-hub-signature-256");
		const expected = `sha256=${createHmac("sha256", key).update(bytes).digest("hex")}`;
		if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !equal(signature, expected))
			throw fault(401, "Invalid GitHub signature");
		const eventId = header(req, "x-github-delivery");
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId)) throw fault(400, "Missing GitHub delivery ID");
		return res.json(await ingest(githubEvent(header(req, "x-github-event"), parse(bytes), eventId)));
	});
	register("POST", "/webhooks/feishu", async (req, res) => {
		const token = secret("feishuVerificationToken");
		const encryptKey = secret("feishuEncryptKey");
		if (!token || !encryptKey) throw fault(503, "Feishu verification token and signing key are required");
		const bytes = raw(req);
		let body = parse(bytes);
		const timestamp = header(req, "x-lark-request-timestamp");
		const nonce = header(req, "x-lark-request-nonce");
		if (
			!/^\d{10}$/.test(timestamp) ||
			Math.abs(now() - Number(timestamp) * 1000) > 300000 ||
			!nonce ||
			nonce.length > 200
		)
			throw fault(401, "Invalid or expired Feishu signature timestamp");
		const expected = createHash("sha256")
			.update(timestamp + nonce + encryptKey)
			.update(bytes)
			.digest("hex");
		if (!equal(header(req, "x-lark-signature"), expected)) throw fault(401, "Invalid Feishu signature");
		if (body.encrypt !== undefined) {
			try {
				if (
					typeof body.encrypt !== "string" ||
					body.encrypt.length % 4 !== 0 ||
					!/^[A-Za-z0-9+/]+={0,2}$/.test(body.encrypt)
				)
					throw new Error("Invalid encoding");
				const encrypted = Buffer.from(body.encrypt, "base64");
				if (encrypted.length < 32 || (encrypted.length - 16) % 16 !== 0) throw new Error("Invalid ciphertext");
				const decipher = createDecipheriv(
					"aes-256-cbc",
					createHash("sha256").update(encryptKey).digest(),
					encrypted.subarray(0, 16),
				);
				body = parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]));
			} catch {
				throw fault(400, "Invalid encrypted Feishu payload");
			}
		}
		if (!equal(body.header?.token ?? body.token, token)) throw fault(401, "Invalid Feishu verification token");
		if (body.type === "url_verification") {
			if (typeof body.challenge !== "string" || body.challenge.length > 500) throw fault(400, "Invalid challenge");
			return res.json({ challenge: body.challenge });
		}
		if (!config().feishu.appId || body.header?.app_id !== config().feishu.appId)
			throw fault(401, "Unexpected Feishu app");
		return res.json(await ingest(feishuEvent(body)));
	});

	async function assertDelivery(delivery) {
		if (disposed) throw new Error("Superagent is stopped");
		const item = await items().get(delivery.workItemId);
		if (deliverySignal?.aborted) throw new Error("Delivery time budget exhausted");
		if (!item || !item.authorized || item.status === "cancelled" || item.status === "blocked")
			throw new Error("Work item is not authorized for delivery");
		if (
			!PROVIDERS.includes(delivery.provider) ||
			item.provider !== delivery.provider ||
			item.channelId !== delivery.channelId ||
			item.threadId !== delivery.threadId ||
			typeof delivery.text !== "string" ||
			!delivery.text ||
			delivery.text.length > 24000
		)
			throw new Error("Invalid delivery identity or text");
		const cfg = config();
		if (!item.manualAuthorized && (!autoAllowed(cfg, item) || mapped(cfg, item)?.roomId !== item.roomId))
			throw new Error("Channel authorization was revoked");
	}
	async function request(url, init = {}) {
		const response = await fetchImpl(url, {
			...init,
			redirect: "error",
			signal: deliverySignal
				? AbortSignal.any([AbortSignal.timeout(15000), deliverySignal])
				: AbortSignal.timeout(15000),
		});
		if (!response.ok) throw new Error(`Channel API HTTP ${response.status}`);
		return response.json();
	}
	async function githubReply(delivery) {
		const token = secret("githubToken");
		if (!token) throw new Error("GitHub API token is not configured");
		if (!repoPattern.test(delivery.channelId) || !threadPattern.test(delivery.threadId))
			throw new Error("Invalid GitHub destination");
		const base = `https://api.github.com/repos/${delivery.channelId}/issues/${delivery.threadId.slice(1)}/comments`;
		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
		};
		const marker = `<!-- pi-superagent:${digest(delivery.id)} -->`;
		for (let page = 1; page <= 20; page++) {
			const comments = await request(`${base}?per_page=100&page=${page}`, { headers });
			if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
			const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(marker));
			if (existing?.id) return String(existing.id);
			if (comments.length < 100) {
				await assertDelivery(delivery);
				if (secret("githubToken") !== token) throw new Error("GitHub credentials changed during delivery");
				const result = await request(base, {
					method: "POST",
					headers,
					body: JSON.stringify({ body: `${delivery.text}\n\n${marker}` }),
				});
				if (!result.id) throw new Error("GitHub comment ID missing");
				return String(result.id);
			}
		}
		throw new Error("GitHub comment history exceeds safe deduplication limit");
	}
	async function feishuReply(delivery) {
		const receiptKey = `feishu-delivery:${digest(delivery.id)}`;
		const fingerprint = digest(JSON.stringify([delivery.channelId, delivery.threadId, delivery.text]));
		const receipt = host.storage.get(receiptKey);
		if (receipt && receipt.fingerprint !== fingerprint) throw new Error("Feishu delivery identity conflict");
		if (receipt?.externalId) return receipt.externalId;
		if (receipt && now() - receipt.firstAttemptAt >= 45 * 60 * 1000)
			throw new Error("Ambiguous Feishu delivery requires manual reconciliation");
		const cfg = config().feishu;
		const appSecret = secret("feishuAppSecret");
		if (!cfg.appId || !appSecret) throw new Error("Feishu app credentials are not configured");
		if (!appToken || appToken.expiresAt <= now()) {
			const result = await request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ app_id: cfg.appId, app_secret: appSecret }),
			});
			if (result.code !== 0 || !result.tenant_access_token || !Number.isFinite(result.expire) || result.expire <= 60)
				throw new Error("Feishu token request failed");
			appToken = { token: result.tenant_access_token, expiresAt: now() + (result.expire - 60) * 1000 };
		}
		if (!/^om_[A-Za-z0-9_-]+$/.test(delivery.threadId)) throw new Error("Invalid Feishu thread");
		await assertDelivery(delivery);
		if (config().feishu.appId !== cfg.appId || secret("feishuAppSecret") !== appSecret)
			throw new Error("Feishu credentials changed during delivery");
		const pending = receipt ?? { fingerprint, firstAttemptAt: now() };
		host.storage.set(receiptKey, pending);
		const result = await request(
			`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(delivery.threadId)}/reply`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${appToken.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					msg_type: "text",
					content: JSON.stringify({ text: delivery.text }),
					reply_in_thread: true,
					uuid: digest(delivery.id).slice(0, 32),
				}),
			},
		);
		if (result.code !== 0 || !result.data?.message_id) {
			appToken = undefined;
			throw new Error("Feishu reply failed");
		}
		host.storage.set(receiptKey, { ...pending, externalId: result.data.message_id });
		return result.data.message_id;
	}
	async function pump() {
		if (running) return running;
		if (disposed) return { delivered: 0, failed: 0 };
		running = (async () => {
			const outcome = { delivered: 0, failed: 0 };
			const cfg = config();
			for (const provider of PROVIDERS) {
				if (disposed) break;
				if (!canDeliver(cfg, provider)) continue;
				const deliveries = await items().claimDelivery({ provider, limit: 1 });
				for (const delivery of deliveries) {
					if (disposed) break;
					try {
						deliverySignal = AbortSignal.timeout(40000);
						if (delivery.provider !== provider) throw new Error("Invalid delivery provider");
						await assertDelivery(delivery);
						const externalId = provider === "github" ? await githubReply(delivery) : await feishuReply(delivery);
						await items().completeDelivery(delivery.id, { leaseToken: delivery.leaseToken, externalId });
						outcome.delivered++;
					} catch (error) {
						await items().failDelivery(delivery.id, {
							leaseToken: delivery.leaseToken,
							error:
								error?.message === "Ambiguous Feishu delivery requires manual reconciliation"
									? error.message
									: "Channel delivery failed; check authorization, credentials, destination, and API availability",
						});
						outcome.failed++;
					} finally {
						deliverySignal = undefined;
					}
				}
			}
			return outcome;
		})().finally(() => {
			running = undefined;
		});
		return running;
	}
	register("POST", "/deliver", async (req, res) => {
		localMutation(req);
		return res.json(await pump());
	});
	for (const name of ["main.mjs", "style.css"])
		register("GET", `/assets/${name}`, async (_req, res) => {
			res.setHeader(
				"Content-Type",
				name.endsWith("css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
			);
			return res.send(await readFile(new URL(name, import.meta.url), "utf8"));
		});
	let timer;
	let retryMs = pollMs;
	let unavailable = false;
	const schedule = () => {
		if (disposed || pollMs <= 0) return;
		timer = setTimeout(async () => {
			try {
				const cfg = config();
				if (!PROVIDERS.some((provider) => canDeliver(cfg, provider))) {
					retryMs = pollMs;
					return;
				}
				await pump();
				if (disposed) return;
				if (unavailable) host.log?.("info", "Superagent outbox polling recovered");
				unavailable = false;
				retryMs = pollMs;
			} catch (error) {
				if (disposed) return;
				retryMs = Math.min(retryMs * 2, Math.max(pollMs, 5 * 60 * 1000));
				if (!unavailable) {
					unavailable = true;
					const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
					host.log?.(
						"warn",
						`Superagent outbox unavailable${status ? ` (HTTP ${error.status})` : ""}; check the device/Hub connection. Retrying with backoff up to 5 minutes.`,
					);
				}
			} finally {
				schedule();
			}
		}, retryMs);
		timer?.unref?.();
	};
	schedule();
	return {
		pump,
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			for (const remove of unregister) remove?.();
			appToken = undefined;
		},
	};
}

export default {
	activate(host) {
		const adapter = createSuperagent(host);
		return () => adapter.dispose();
	},
};
