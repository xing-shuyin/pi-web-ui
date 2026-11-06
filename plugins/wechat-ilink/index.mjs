import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

const API_DEFAULT = "https://ilinkai.weixin.qq.com";
const CDN_DEFAULT = "https://novac2c.cdn.weixin.qq.com/c2c";
const APP_ID = "bot";
const MEDIA_DIR = ".pi-wechat-media";
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const CDN_UPLOAD_RETRIES = 3;
const QR_POLL_MS = 2000;
const POLL_FETCH_MS = 65000;
const API_FETCH_MS = 20000;
const PAUSE_MS = 3600_000;
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const INBOX_CAP = 100;
const PENDING_PEER_CAP = 50;
const PENDING_RUN_CAP = 50;
const PEER_LASTAT_CAP = 500;
const REPLY_CAP = 4000;
const PAIR_TIP_MS = 3600_000;

function cut(s, cap) {
	s = String(s ?? "");
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

export function encodeClientVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
	if (!m) return "0";
	const n = ((Number(m[1]) & 0xff) << 16) | ((Number(m[2]) & 0xff) << 8) | (Number(m[3]) & 0xff);
	return String(n >>> 0);
}

function randUin() {
	const n = Math.floor(Math.random() * 4294967296);
	return Buffer.from(String(n), "utf8").toString("base64");
}

function uuid() {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
	);
}

async function fetchJson(url, { method = "POST", headers = {}, body, timeoutMs = API_FETCH_MS } = {}) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function checkCwdValid(cwd) {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录不能为空" };
	let abs;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录路径非法：${trimmed}` };
	}
	try {
		if (!existsSync(abs) || !statSync(abs).isDirectory()) {
			return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
		}
	} catch {
		return { ok: false, error: `无法访问目标项目：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}` };
		}
	}
	return { ok: true, abs };
}

export function peerAccountId(peer, seq = 0) {
	const base = String(peer ?? "").trim();
	const raw = seq ? `${base}:${seq}` : base;
	if (!raw) return "wx_default";
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `wx_${hash}`;
}

export function assistantTextOf(msg) {
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
	const raw = msg.content
		.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
		.map((b) => b.text)
		.join("\n");
	return stripInternalMarkers(raw);
}

export const MEDIA_LABEL = { image: "图片", voice: "语音", video: "视频", file: "文件", unknown: "不支持的消息类型" };

export function inboundMediaKind(item) {
	const type = Number(item?.type ?? 0);
	if (type === 2) return "image";
	if (type === 3) return "voice";
	if (type === 4) return "file";
	if (type === 5) return "video";
	if (item?.image_item) return "image";
	if (item?.voice_item) return "voice";
	if (item?.file_item) return "file";
	if (item?.video_item) return "video";
	return "unknown";
}

export function inboundPartsOf(itemList) {
	const parts = [];
	for (const it of itemList ?? []) {
		if (!it || typeof it !== "object") continue;
		let handled = false;
		for (const k of Object.keys(it)) {
			const v = it[k];
			if (v && typeof v === "object" && typeof v.text === "string" && /text/i.test(k)) {
				if (v.text.trim()) parts.push({ kind: "text", text: v.text });
				handled = true;
				break;
			}
		}
		if (handled) continue;
		parts.push({ kind: inboundMediaKind(it), item: it });
	}
	return parts;
}

export function inboundTextOf(itemList) {
	return inboundPartsOf(itemList)
		.map((p) => (p.kind === "text" ? p.text : `[${MEDIA_LABEL[p.kind] ?? MEDIA_LABEL.unknown}]`))
		.join("\n")
		.trim();
}

export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

const MIME_BY_EXT = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".heic": "image/heic",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".zip": "application/zip",
};

export function mimeOfPath(filePath) {
	return MIME_BY_EXT[extname(String(filePath ?? "")).toLowerCase()] ?? "application/octet-stream";
}

export function mediaKindOfMime(mime) {
	const m = String(mime ?? "").toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	return "file";
}

export function sniffImageExt(buf) {
	const b = buf ?? Buffer.alloc(0);
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
	if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
	if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ".gif";
	if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return ".webp";
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return ".bmp";
	return "";
}

export function aesEcbPaddedSize(plaintextSize) {
	return Math.ceil((Number(plaintextSize) + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseAesKey(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, "hex");
	let decoded;
	try {
		decoded = Buffer.from(s, "base64");
	} catch {
		return null;
	}
	if (decoded.length === 16) return decoded;
	if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("latin1"))) {
		return Buffer.from(decoded.toString("latin1"), "hex");
	}
	return null;
}

export function buildMediaRef({ downloadParam, aeskeyHex, encryptType = 1 }) {
	return {
		encrypt_query_param: String(downloadParam ?? ""),
		aes_key: Buffer.from(String(aeskeyHex ?? "")).toString("base64"),
		encrypt_type: encryptType,
	};
}

export function buildImageItem({ downloadParam, aeskeyHex, cipherSize }) {
	return {
		type: MessageItemType.IMAGE,
		image_item: { media: buildMediaRef({ downloadParam, aeskeyHex }), mid_size: Number(cipherSize) || 0 },
	};
}

export function buildVideoItem({ downloadParam, aeskeyHex, cipherSize }) {
	return {
		type: MessageItemType.VIDEO,
		video_item: { media: buildMediaRef({ downloadParam, aeskeyHex }), video_size: Number(cipherSize) || 0 },
	};
}

export function buildFileItem({ downloadParam, aeskeyHex, fileName, rawSize }) {
	return {
		type: MessageItemType.FILE,
		file_item: {
			media: buildMediaRef({ downloadParam, aeskeyHex }),
			file_name: String(fileName ?? "file").slice(0, 200),
			len: String(Number(rawSize) || 0),
		},
	};
}

export function buildMediaItem({ kind, downloadParam, aeskeyHex, cipherSize, fileName, rawSize }) {
	if (kind === "image") return buildImageItem({ downloadParam, aeskeyHex, cipherSize });
	if (kind === "video") return buildVideoItem({ downloadParam, aeskeyHex, cipherSize });
	return buildFileItem({ downloadParam, aeskeyHex, fileName, rawSize });
}

export function buildCdnUploadUrl({ cdnBase, uploadParam, filekey }) {
	const b = String(cdnBase || CDN_DEFAULT).replace(/\/+$/, "");
	return `${b}/upload?encrypted_query_param=${encodeURIComponent(String(uploadParam ?? ""))}&filekey=${encodeURIComponent(String(filekey ?? ""))}`;
}

export function buildCdnDownloadUrl({ cdnBase, encryptQueryParam }) {
	const b = String(cdnBase || CDN_DEFAULT).replace(/\/+$/, "");
	return `${b}/download?encrypted_query_param=${encodeURIComponent(String(encryptQueryParam ?? ""))}`;
}

export function createIlink({ base, cdnBase, version, getToken }) {
	const appHeaders = () => ({
		"Content-Type": "application/json",
		"iLink-App-Id": APP_ID,
		"iLink-App-ClientVersion": encodeClientVersion(version),
	});
	const authHeaders = () => ({
		...appHeaders(),
		AuthorizationType: "ilink_bot_token",
		Authorization: `Bearer ${getToken() ?? ""}`,
		"X-WECHAT-UIN": randUin(),
	});
	const baseInfo = () => ({ channel_version: String(version ?? ""), bot_agent: "pi-web-ui" });
	async function postMessage(body, contextToken) {
		const send = (token) =>
			fetchJson(`${base}/ilink/bot/sendmessage`, {
				headers: authHeaders(),
				body: { ...body, msg: { ...body.msg, ...(token ? { context_token: token } : {}) } },
			});
		const r = await send(contextToken);
		if (r && typeof r.ret === "number" && r.ret !== 0) {
			if (contextToken) {
				try {
					const fallback = await send(undefined);
					if (fallback && (fallback.ret === 0 || fallback.ret === undefined)) {
						return fallback;
					}
				} catch {}
			}
			throw new Error(`sendmessage ret=${r.ret} ${r.errmsg ?? ""}`.trim());
		}
		return r;
	}
	return {
		async getQr(localTokens) {
			const r = await fetchJson(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
				headers: { ...appHeaders(), AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randUin() },
				body: { local_token_list: (localTokens ?? []).filter(Boolean).slice(0, 10) },
			});
			return r;
		},
		async qrStatus(qrcode, verifyCode) {
			let u = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
			if (verifyCode) u += `&verify_code=${encodeURIComponent(verifyCode)}`;
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), API_FETCH_MS);
			try {
				const res = await fetch(u, { headers: appHeaders(), signal: ac.signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return await res.json();
			} finally {
				clearTimeout(timer);
			}
		},
		async getUpdates(buf) {
			return fetchJson(`${base}/ilink/bot/getupdates`, {
				headers: authHeaders(),
				body: { get_updates_buf: buf || "", base_info: baseInfo() },
				timeoutMs: POLL_FETCH_MS,
			});
		},
		async sendMessage({ to, text, contextToken }) {
			return postMessage(
				{
					msg: {
						from_user_id: "",
						to_user_id: to,
						client_id: uuid(),
						message_type: 2,
						message_state: 2,
						item_list: [{ type: 1, text_item: { text: String(text ?? "") } }],
					},
					base_info: baseInfo(),
				},
				contextToken,
			);
		},
		async sendItems({ to, items, contextToken }) {
			const out = [];
			for (const item of items ?? []) {
				out.push(
					await postMessage(
						{
							msg: {
								from_user_id: "",
								to_user_id: to,
								client_id: uuid(),
								message_type: 2,
								message_state: 2,
								item_list: [item],
							},
							base_info: baseInfo(),
						},
						contextToken,
					),
				);
			}
			return out;
		},
		async getUploadUrl({ filekey, mediaType, to, rawsize, rawfilemd5, filesize, aeskeyHex }) {
			return fetchJson(`${base}/ilink/bot/getuploadurl`, {
				headers: authHeaders(),
				body: {
					filekey,
					media_type: mediaType,
					to_user_id: to,
					rawsize,
					rawfilemd5,
					filesize,
					no_need_thumb: true,
					aeskey: aeskeyHex,
					base_info: baseInfo(),
				},
			});
		},
		async uploadMedia({ plaintext, aeskey, filekey, uploadFullUrl, uploadParam, label }) {
			const ciphertext = encryptAesEcb(plaintext, aeskey);
			const full = String(uploadFullUrl ?? "").trim();
			const url = full
				? full
				: uploadParam
					? buildCdnUploadUrl({ cdnBase: cdnBase ?? CDN_DEFAULT, uploadParam, filekey })
					: "";
			if (!url) throw new Error(`${label}: getUploadUrl 未返回 upload_full_url / upload_param`);
			let lastErr;
			for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt++) {
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), API_FETCH_MS);
				try {
					const res = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/octet-stream" },
						body: new Uint8Array(ciphertext),
						signal: ac.signal,
					});
					if (res.status >= 400 && res.status < 500) {
						const msg = res.headers.get("x-error-message") || (await res.text().catch(() => ""));
						throw new Error(`${label}: CDN 上传被拒 ${res.status}${msg ? `: ${cut(msg, 200)}` : ""}`);
					}
					if (res.status !== 200) {
						const msg = res.headers.get("x-error-message") || `status ${res.status}`;
						throw new Error(`${label}: CDN 上传失败 ${msg}`);
					}
					const downloadParam = res.headers.get("x-encrypted-param");
					if (!downloadParam) throw new Error(`${label}: CDN 响应缺少 x-encrypted-param`);
					return downloadParam;
				} catch (err) {
					lastErr = err;
					if (String(err?.message ?? "").includes("上传被拒")) break;
					if (attempt === CDN_UPLOAD_RETRIES) break;
					await new Promise((r) => setTimeout(r, 500 * attempt));
				} finally {
					clearTimeout(timer);
				}
			}
			throw lastErr instanceof Error ? lastErr : new Error(`${label}: CDN 上传失败`);
		},
		async downloadMedia(item) {
			const ref = item?.media ?? item?.thumb_media;
			if (!ref || typeof ref !== "object") throw new Error("缺少媒体引用（media/full_url）");
			const full = String(ref.full_url ?? "").trim();
			const url = full
				? full
				: ref.encrypt_query_param
					? buildCdnDownloadUrl({ cdnBase: cdnBase ?? CDN_DEFAULT, encryptQueryParam: ref.encrypt_query_param })
					: "";
			if (!url) throw new Error("取不到媒体下载地址");
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), API_FETCH_MS);
			try {
				const res = await fetch(url, { signal: ac.signal });
				if (!res.ok) throw new Error(`媒体下载失败 HTTP ${res.status}`);
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length > MEDIA_MAX_BYTES) throw new Error(`媒体超过 ${MEDIA_MAX_BYTES / 1024 / 1024}MB 上限`);
				const key = parseAesKey(item?.aeskey) ?? parseAesKey(ref.aes_key);
				return key ? decryptAesEcb(buf, key) : buf;
			} finally {
				clearTimeout(timer);
			}
		},
		async typingTicket(userId, contextToken) {
			const r = await fetchJson(`${base}/ilink/bot/getconfig`, {
				headers: authHeaders(),
				body: {
					ilink_user_id: userId,
					...(contextToken ? { context_token: contextToken } : {}),
					base_info: baseInfo(),
				},
			});
			return r?.typing_ticket;
		},
		async sendTyping(userId, ticket, on) {
			if (!ticket) return;
			try {
				await fetchJson(`${base}/ilink/bot/sendtyping`, {
					headers: authHeaders(),
					body: { ilink_user_id: userId, typing_ticket: ticket, status: on ? 1 : 2, base_info: baseInfo() },
				});
			} catch {}
		},
		async notify(path) {
			try {
				await fetchJson(`${base}/ilink/bot/msg/${path}`, {
					headers: authHeaders(),
					body: { base_info: baseInfo() },
				});
			} catch {}
		},
	};
}

export default {
	activate(host) {
		const VERSION = "0.5.5";
		let cfg = {};
		try {
			cfg = host.getSettings?.() ?? {};
		} catch {
			cfg = {};
		}
		const settings = () => cfg;
		const offSettings = host.onSettingsChanged?.((v) => {
			const rebind = v?.bindActive === true && cfg.bindActive !== true;
			cfg = v ?? {};
			if (rebind) {
				st.peerDetached = {};
				save();
			}
			applyAiTool();
			pushState();
		});

		const store = host.storage;
		const secrets = host.secrets;
		const TOKEN_KEY = "bot_token";

		const st = {
			disposed: false,
			base: API_DEFAULT,
			botId: "",
			loginAt: 0,
			qr: null,
			qrTimer: null,
			qrStop: false,
			polling: false,
			pollAbort: null,
			pausedUntil: 0,
			backoffMs: BACKOFF_MIN_MS,
			lastPollAt: 0,
			lastError: "",
			inbox: [],
			peerCtx: {},
			peerLastAt: {},
			allowedPeers: [],
			pendingPeers: [],
			pairTipAt: {},
			messagesReceived: 0,
			messagesReplied: 0,
			userWorkspaces: {},
			userModels: {},
			userThinkingLevels: {},
			userPlanMode: {},
			peerSessionSeq: {},
			peerDetached: {},
			pendingRuns: new Map(),
			runIdIndex: new Map(),
			runText: new Map(),
			toolOff: null,
			bgTask: null,
		};

		function load() {
			try {
				const acct = store.get("account", {});
				st.base = typeof acct.base === "string" && acct.base ? acct.base : API_DEFAULT;
				st.botId = typeof acct.botId === "string" ? acct.botId : "";
				st.loginAt = typeof acct.loginAt === "number" ? acct.loginAt : 0;
				st.allowedPeers = Array.isArray(store.get("allowedPeers", [])) ? store.get("allowedPeers", []) : [];
				st.pendingPeers = Array.isArray(store.get("pendingPeers", [])) ? store.get("pendingPeers", []) : [];
				st.peerCtx = store.get("peerCtx", {}) ?? {};
				const stats = store.get("stats", {});
				st.messagesReceived = typeof stats.messagesReceived === "number" ? stats.messagesReceived : 0;
				st.messagesReplied = typeof stats.messagesReplied === "number" ? stats.messagesReplied : 0;
				st.userWorkspaces = store.get("userWorkspaces", {}) ?? {};
				st.userModels = store.get("userModels", {}) ?? {};
				st.userThinkingLevels = store.get("userThinkingLevels", {}) ?? {};
				st.userPlanMode = store.get("userPlanMode", {}) ?? {};
				st.peerSessionSeq = store.get("peerSessionSeq", {}) ?? {};
				st.peerDetached = store.get("peerDetached", {}) ?? {};
			} catch (err) {
				host.log("load state failed:", err?.message ?? err);
			}
		}
		function save() {
			try {
				store.set("account", { base: st.base, botId: st.botId, loginAt: st.loginAt });
				store.set("allowedPeers", st.allowedPeers.slice(0, 200));
				store.set("pendingPeers", st.pendingPeers.slice(0, PENDING_PEER_CAP));
				const ctx = {};
				for (const [k, v] of Object.entries(st.peerCtx).slice(-200)) ctx[k] = v;
				store.set("peerCtx", ctx);
				store.set("stats", { messagesReceived: st.messagesReceived, messagesReplied: st.messagesReplied });
				store.set("userWorkspaces", st.userWorkspaces);
				store.set("userModels", st.userModels);
				store.set("userThinkingLevels", st.userThinkingLevels);
				store.set("userPlanMode", st.userPlanMode);
				store.set("peerSessionSeq", st.peerSessionSeq);
				store.set("peerDetached", st.peerDetached);
			} catch (err) {
				host.log("save state failed:", err?.message ?? err);
			}
		}
		const getToken = () => {
			try {
				return secrets?.get?.(TOKEN_KEY) ?? undefined;
			} catch {
				return undefined;
			}
		};
		const isLoggedIn = () => !!getToken();
		const ilink = () => createIlink({ base: st.base, cdnBase: CDN_DEFAULT, version: VERSION, getToken });
		const getWorkspace = () => String(settings().workspace ?? "").trim();
		const getHostCwd = () => {
			try {
				return String(host.cwd ?? "").trim();
			} catch {
				return "";
			}
		};
		const resolveWorkspace = (peer) => {
			const uws = st.userWorkspaces[peer];
			if (uws && typeof uws === "string") return uws;
			return getWorkspace() || getHostCwd();
		};
		const resolveModel = (peer) => {
			const um = st.userModels[peer];
			if (um && typeof um === "string") return um;
			return String(settings().model ?? "").trim();
		};
		const resolveThinkingLevel = (peer) => {
			const ut = st.userThinkingLevels[peer];
			if (ut && typeof ut === "string") return ut;
			return String(settings().thinkingLevel ?? "").trim();
		};
		function setWorkspace(rawPath) {
			const clean = String(rawPath ?? "")
				.trim()
				.slice(0, 1024);
			cfg = { ...cfg, workspace: clean };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, workspace: clean });
			} catch (err) {
				host.log("save workspace failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				clean ? `微信通道根目录已设为：${clean}` : "微信通道根目录已清空（跟随当前项目）",
				clean ? `WeChat workspace root set to: ${clean}` : "WeChat workspace root cleared (follows current project)",
			);
			pushState();
		}

		function setModel(model, thinkingLevel) {
			const cleanModel = String(model ?? "")
				.trim()
				.slice(0, 256);
			const cleanThinking = String(thinkingLevel ?? "")
				.trim()
				.slice(0, 64);
			cfg = { ...cfg, model: cleanModel, thinkingLevel: cleanThinking };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, model: cleanModel, thinkingLevel: cleanThinking });
			} catch (err) {
				host.log("save model failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				cleanModel ? `微信通道模型已设为：${cleanModel}` : "微信通道模型已设为跟随全局",
				cleanModel ? `WeChat model set to: ${cleanModel}` : "WeChat model set to follow global",
			);
			pushState();
		}

		function setBindActive(bindActive) {
			const active = Boolean(bindActive);
			cfg = { ...cfg, bindActive: active };
			if (active) {
				st.peerDetached = {};
				save();
			}
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, bindActive: active });
			} catch (err) {
				host.log("save bindActive failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				active ? "已开启电脑手机消息同步（投递到网页当前会话）" : "已切换为独立无头会话",
				active ? "WeChat synced with active conversation" : "WeChat uses isolated headless session",
			);
			pushState();
		}

		function snapshot() {
			return {
				kind: "state",
				loggedIn: isLoggedIn(),
				botId: st.botId,
				loginAt: st.loginAt,
				polling: st.polling,
				paused: Date.now() < st.pausedUntil,
				lastPollAt: st.lastPollAt,
				lastError: st.lastError,
				qr: st.qr,
				allowedPeers: [...st.allowedPeers],
				pendingPeers: [...st.pendingPeers],
				inbox: st.inbox.slice(-30),
				pendingRuns: st.pendingRuns.size,
				workspace: getWorkspace(),
				hostCwd: getHostCwd(),
				model: String(settings().model ?? "").trim(),
				thinkingLevel: String(settings().thinkingLevel ?? "").trim(),
				bindActive: settings().bindActive === true,
				messagesReceived: st.messagesReceived,
				messagesReplied: st.messagesReplied,
			};
		}
		function pushState(to) {
			const p = snapshot();
			if (to) host.sendTo(to, p);
			else host.broadcast(p);
		}
		function pushInbox(entry) {
			st.inbox.push(entry);
			while (st.inbox.length > INBOX_CAP) st.inbox.shift();
			host.broadcast({ kind: "inbox", entry });
		}

		function allowList() {
			return String(settings().allowFrom ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		function isAllowed(peer) {
			const list = allowList();
			if (list.includes("*") || list.includes(peer)) return true;
			return st.allowedPeers.includes(peer);
		}
		function addPending(peer) {
			if (st.pendingPeers.includes(peer) || st.allowedPeers.includes(peer)) return;
			st.pendingPeers.unshift(peer);
			while (st.pendingPeers.length > PENDING_PEER_CAP) st.pendingPeers.pop();
			save();
			host.notify(
				"warning",
				`微信待配对：${peer}（在 💬 视图里允许/拒绝）`,
				`WeChat pairing pending: ${peer} (allow/deny in the 💬 view)`,
			);
			pushState();
		}

		async function sendText(to, text, contextToken) {
			const client = ilink();
			let ticket;
			if (settings().typing !== false) {
				try {
					ticket = await client.typingTicket(to, contextToken);
					await client.sendTyping(to, ticket, true);
				} catch {}
			}
			try {
				const r = await client.sendMessage({ to, text, contextToken });
				st.messagesReplied++;
				save();
				const hasMsgId = Boolean(r?.message_id);
				if (!hasMsgId) {
					host.log(
						`[wechat-ilink] 提示：向 ${to} 发送消息已受理，但未包含 message_id（若手机微信未显示，可能触发微信平台临时频控限制或内容过滤）`,
					);
				}
				pushInbox({ dir: "out", peer: to, text: cut(text, 500), at: Date.now(), delivered: hasMsgId });
			} catch (err) {
				const errMsg = err?.message ?? String(err);
				host.log(`[wechat-ilink] 发送微信消息失败：${errMsg}`);
				st.lastError = `回复微信失败：${errMsg}`;
				pushState();
				pushInbox({
					dir: "out",
					peer: to,
					text: `[发送失败] ${cut(text, 200)}: ${errMsg}`,
					at: Date.now(),
					error: true,
				});
				throw err;
			} finally {
				if (ticket) await client.sendTyping(to, ticket, false);
			}
		}

		async function sendPairSuccess(peer) {
			const text = [
				"🎉 配对成功！直接发送消息即可对话。",
				"",
				"常用快捷操作（发送 / 查看全部）：",
				"1/cwd : 查看或切换当前项目根目录",
				"2/new : 清空上下文开启全新会话 [提示]",
				"8/stop : 中止当前正在执行的任务",
				"10/help : 显示全部命令 (或发 /)",
			].join("\n");
			await sendText(peer, text, st.peerCtx[peer]);
		}

		function mediaDir(peer) {
			const base = resolveWorkspace(peer) || getHostCwd() || process.cwd();
			const dir = join(base, MEDIA_DIR);
			mkdirSync(dir, { recursive: true });
			return dir;
		}

		function safeName(raw, fallback = "file") {
			const s = basename(String(raw ?? ""))
				.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
				.replace(/^\.+/, "")
				.slice(0, 120);
			return s || fallback;
		}

		async function saveInboundMedia(part, peer) {
			const inner = part.item?.[`${part.kind}_item`] ?? part.item;
			const buf = await ilink().downloadMedia(inner);
			if (!buf.length) throw new Error("媒体内容为空");
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const tag = createHash("sha256")
				.update(String(peer ?? ""))
				.digest("hex")
				.slice(0, 8);
			const ext = sniffImageExt(buf) || extname(String(inner?.url ?? "")).toLowerCase() || ".jpg";
			const name =
				part.kind === "image"
					? `wx-${tag}-${stamp}-${randomBytes(6).toString("hex")}-img${ext}`
					: `wx-${tag}-${stamp}-${randomBytes(6).toString("hex")}-${safeName(inner?.file_name, part.kind === "video" ? "video.mp4" : "file")}`;
			const abs = join(mediaDir(peer), safeName(name, "media"));
			writeFileSync(abs, buf);
			return { kind: part.kind, path: abs, size: buf.length };
		}

		async function buildInboundPrompt(parts, peer) {
			const wantMedia = settings().inboundMedia !== false;
			const lines = [];
			const attachments = [];
			for (const p of parts) {
				if (p.kind === "text") {
					lines.push(p.text);
					continue;
				}
				const label = MEDIA_LABEL[p.kind] ?? MEDIA_LABEL.unknown;
				if (p.kind === "voice") {
					const notice = "收到语音，但当前通道未接入语音识别（ASR），无法听取内容，请改发文字。";
					await sendText(peer, notice, st.peerCtx[peer]).catch((err) =>
						host.log("voice notice failed:", err?.message ?? err),
					);
					lines.push(`[${notice}]`);
					continue;
				}
				if (!wantMedia || !["image", "file", "video"].includes(p.kind)) {
					lines.push(`[${label}（未下载，无法读取内容）]`);
					continue;
				}
				try {
					const saved = await saveInboundMedia(p, peer);
					if (saved.kind === "image") {
						const data = readFileSync(saved.path);
						const ext = sniffImageExt(data);
						if (!ext) throw new Error("不支持的图片格式，请改发 PNG/JPEG/GIF/WebP");
						const images = attachments.filter((a) => a.imageData);
						const total = images.reduce((n, a) => n + Buffer.from(a.imageData, "base64").length, 0);
						if (images.length >= 8 || data.length > 10 * 1024 * 1024 || total + data.length > 20 * 1024 * 1024)
							throw new Error("图片超过 8 张、单张 10MiB 或合计 20MiB 限制");
						attachments.push({
							path: "",
							imageData: data.toString("base64"),
							mimeType: mimeOfPath(saved.path),
							name: safeName(saved.path.split(/[\\/]/).pop(), "image"),
						});
					} else {
						attachments.push({
							path: saved.path,
							mode: "reference",
							name: safeName(saved.path.split(/[\\/]/).pop(), "file"),
						});
					}
					lines.push(
						saved.kind === "image"
							? `[图片已保存：${saved.path}（用 read 工具可直接查看）]`
							: `[文件已保存：${saved.path}（${saved.size} 字节）]`,
					);
				} catch (err) {
					const msg = err?.message ?? String(err);
					host.log(`[wechat-ilink] 入站${label}处理失败：${msg}`);
					const notice = `${label}处理失败：${msg}，未读取内容。`;
					lines.push(`[${notice}]`);
					await sendText(peer, notice, st.peerCtx[peer]).catch(() => {});
				}
			}
			return { text: lines.join("\n").trim(), attachments };
		}

		async function resolveOutboundPath(spec, peer) {
			const s = String(spec ?? "").trim();
			if (!s) throw new Error("媒体路径/URL 为空");
			if (/^https?:\/\//i.test(s)) {
				const res = await fetch(s);
				if (!res.ok) throw new Error(`下载媒体失败 HTTP ${res.status}`);
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length > MEDIA_MAX_BYTES) {
					throw new Error(`媒体超过 ${MEDIA_MAX_BYTES / 1024 / 1024}MB 上限`);
				}
				const ext = sniffImageExt(buf) || extname(new URL(s).pathname).toLowerCase() || ".bin";
				const abs = join(mediaDir(peer), `wx-remote-${Date.now()}${ext}`);
				writeFileSync(abs, buf);
				return abs;
			}
			const abs = resolve(resolveWorkspace(peer) || process.cwd(), s);
			try {
				if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("not-a-file");
			} catch {
				throw new Error(`媒体文件不存在：${abs}`);
			}
			if (statSync(abs).size > MEDIA_MAX_BYTES) {
				throw new Error(`媒体超过 ${MEDIA_MAX_BYTES / 1024 / 1024}MB 上限`);
			}
			return abs;
		}

		async function sendMediaFile(to, filePath, contextToken) {
			const buf = readFileSync(filePath);
			if (!buf.length) throw new Error("媒体文件为空");
			if (buf.length > MEDIA_MAX_BYTES) {
				throw new Error(`媒体超过 ${MEDIA_MAX_BYTES / 1024 / 1024}MB 上限`);
			}
			const mime = mimeOfPath(filePath);
			const kind = mediaKindOfMime(mime);
			const mediaType =
				kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE;
			const rawsize = buf.length;
			const rawfilemd5 = createHash("md5").update(buf).digest("hex");
			const filesize = aesEcbPaddedSize(rawsize);
			const filekey = randomBytes(16).toString("hex");
			const aeskey = randomBytes(16);
			const aeskeyHex = aeskey.toString("hex");
			const client = ilink();
			const up = await client.getUploadUrl({
				filekey,
				mediaType,
				to,
				rawsize,
				rawfilemd5,
				filesize,
				aeskeyHex,
			});
			const downloadParam = await client.uploadMedia({
				plaintext: buf,
				aeskey,
				filekey,
				uploadFullUrl: up?.upload_full_url,
				uploadParam: up?.upload_param,
				label: `发送${MEDIA_LABEL[kind] ?? "媒体"}`,
			});
			const item = buildMediaItem({
				kind,
				downloadParam,
				aeskeyHex,
				cipherSize: filesize,
				fileName: basename(filePath),
				rawSize: rawsize,
			});
			await client.sendItems({ to, items: [item], contextToken });
			st.messagesReplied++;
			save();
			pushInbox({
				dir: "out",
				peer: to,
				text: `[${MEDIA_LABEL[kind] ?? "媒体"}] ${basename(filePath)}`,
				at: Date.now(),
				delivered: true,
			});
			return kind;
		}

		const EARLY_RUN_CAP = 30;
		const EARLY_RUN_TTL_MS = 60_000;
		const earlyRuns = new Map();
		const inFlightClients = new Map();
		const inFlightConvs = new Map();
		const routes = new Map();
		const completedRuns = new Set();
		let dispatches = 0;
		function rememberCompleted(runId) {
			completedRuns.add(runId);
			while (completedRuns.size > 500) completedRuns.delete(completedRuns.values().next().value);
		}
		function finalAssistantText(message) {
			return message?.stopReason === "toolUse" || message?.content?.some((part) => part.type === "toolCall")
				? ""
				: assistantTextOf(message);
		}

		function sessionKey(value) {
			if (value.sessionId) return `session:${value.sessionId}`;
			return value.clientId && value.conversationId
				? `owner:${JSON.stringify([value.clientId, value.conversationId])}`
				: "";
		}
		function validRoute(route) {
			return (
				route &&
				route.epoch === (st.peerSessionSeq[route.to] || 0) &&
				route.account === peerAccountId(route.to, route.epoch)
			);
		}
		function saveRoutes() {
			while (routes.size > 200) routes.delete(routes.keys().next().value);
			store.set("sessionRoutes", [...routes].filter(([key]) => key.startsWith("session:")).slice(-200));
		}
		function bindRoute(identity, to, ctx) {
			const key = sessionKey(identity);
			if (!key) return null;
			const previous = routes.get(key);
			if (previous?.ambiguous || (validRoute(previous) && previous.to !== to)) {
				routes.set(key, { ambiguous: true });
				saveRoutes();
				return null;
			}
			const epoch = st.peerSessionSeq[to] || 0;
			const route = { to, ctx, epoch, account: peerAccountId(to, epoch) };
			routes.set(key, route);
			saveRoutes();
			return route;
		}

		function makeRunKey(clientId, conversationId) {
			const c = String(clientId ?? "").trim();
			const id = String(conversationId ?? "").trim();
			return c ? `${c}:${id}` : id;
		}

		function trimEarlyRuns() {
			const now = Date.now();
			for (const [id, rec] of earlyRuns) {
				if (now - rec.at > EARLY_RUN_TTL_MS) earlyRuns.delete(id);
			}
			while (earlyRuns.size >= EARLY_RUN_CAP) {
				const oldest = earlyRuns.keys().next().value;
				earlyRuns.delete(oldest);
			}
		}

		function trackRun({ conversationId, clientId, sessionId, to, contextToken, startedAt = 0, runId = "" }) {
			bindRoute({ sessionId, clientId, conversationId }, to, contextToken);
			const key = runId ? `run:${runId}` : makeRunKey(clientId, conversationId);
			if (runId && completedRuns.has(runId)) return;
			for (const [oldKey, old] of st.pendingRuns) {
				if (oldKey === key || old.to !== to || sessionKey(old) !== sessionKey({ sessionId, clientId, conversationId }))
					continue;
				const text = st.runText.get(oldKey);
				dropRun(oldKey);
				if (old.runId) rememberCompleted(old.runId);
				if (text) st.runText.set(key, text);
			}
			const existing = st.pendingRuns.get(key);
			if (existing) {
				if (existing.to !== to) {
					existing.ambiguous = true;
				} else existing.ctx = contextToken;
				return;
			}
			while (st.pendingRuns.size >= PENDING_RUN_CAP) {
				const oldest = st.pendingRuns.keys().next().value;
				dropRun(oldest);
			}

			const earlyKey = runId ? `run:${runId}` : key;
			const early = earlyRuns.get(earlyKey);
			if (early && (!startedAt || early.at >= startedAt - 500)) {
				earlyRuns.delete(earlyKey);
				earlyRuns.delete(key);
				earlyRuns.delete(conversationId);
				if (early.text) {
					st.runText.set(key, early.text);
				}
				if (early.ended) {
					if (runId) rememberCompleted(runId);
					const clean = stripInternalMarkers(st.runText.get(key) ?? "");
					const body = clean || "任务完成（无文本输出）。";
					dropRun(key);
					const out = body.length > REPLY_CAP ? `${body.slice(0, REPLY_CAP)}\n…（超长截断）` : body;
					sendText(to, out, contextToken).catch((err) => {
						const errMsg = err?.message ?? String(err);
						host.log("reply failed:", errMsg);
						host.notify?.("warning", `回复微信失败：${errMsg}`, `Failed to reply to WeChat: ${errMsg}`);
					});
					return;
				}
			} else {
				earlyRuns.delete(key);
				earlyRuns.delete(conversationId);
			}

			const timeoutMs = Math.min(900, Math.max(30, Number(settings().replyTimeoutSec ?? 180))) * 1000;
			const timer = setTimeout(() => {
				const p = st.pendingRuns.get(key);
				if (!p || p.noticed) return;
				p.noticed = true;
				sendText(to, "还在执行，稍后把结果推给你。", contextToken).catch((err) =>
					host.log("timeout notice failed:", err?.message ?? err),
				);
			}, timeoutMs);
			st.pendingRuns.set(key, {
				to,
				ctx: contextToken,
				timer,
				noticed: false,
				startedAt,
				conversationId,
				clientId,
				sessionId,
				epoch: st.peerSessionSeq[to] || 0,
				...(runId ? { runId } : {}),
			});
			if (runId) st.runIdIndex.set(runId, key);
		}
		function dropRun(runKey) {
			const p = st.pendingRuns.get(runKey);
			if (p) clearTimeout(p.timer);
			st.pendingRuns.delete(runKey);
			st.runText.delete(runKey);
			earlyRuns.delete(runKey);
			for (const [rid, key] of st.runIdIndex) {
				if (key === runKey) st.runIdIndex.delete(rid);
			}
			if (p?.conversationId) {
				earlyRuns.delete(p.conversationId);
				inFlightConvs.delete(p.conversationId);
			}
			if (p?.clientId) {
				inFlightClients.delete(p.clientId);
			}
		}

		function resetStaleRunText(convId) {
			const active = new Set();
			for (const [k, p] of st.pendingRuns) {
				if (p.conversationId === convId || k === convId) active.add(k);
			}
			for (const k of [...st.runText.keys()]) {
				if (active.has(k)) continue;
				if (k === convId || k.endsWith(`:${convId}`)) st.runText.delete(k);
			}
			inFlightConvs.delete(convId);
		}

		async function startPeerSession(peer) {
			const epoch = (st.peerSessionSeq[peer] || 0) + 1;
			st.peerSessionSeq[peer] = epoch;
			st.peerDetached[peer] = true;
			for (const [key, route] of routes) {
				if (route.to === peer) routes.delete(key);
			}
			saveRoutes();
			save();
			let failed = false;
			for (const [key, run] of [...st.pendingRuns.entries()]) {
				if (run.to !== peer) continue;
				dropRun(key);
				try {
					const result = await host.abortRun?.(run.runId || run.conversationId || key);
					if (!result?.ok) failed = true;
				} catch (err) {
					failed = true;
					host.log("reset abort failed:", err?.message ?? err);
				}
			}
			if (failed)
				await sendText(peer, "⚠️ 新会话已隔离，但未能确认旧任务停止，请在网页端检查。", st.peerCtx[peer]).catch(
					() => {},
				);
			return epoch;
		}

		async function drivePeer(peer, text, contextToken, attachments = []) {
			const generation = mediaGeneration.get(peer) || 0;
			const label = `微信:${peer}`;
			const seq = st.peerSessionSeq[peer] || 0;
			const acct = peerAccountId(peer, seq);
			const expectedPseudoClientId = `plugin:wechat-ilink:${acct}`;
			const req = { text: `[${label}] ${text}`, accountId: acct };
			if (attachments.length) req.attachments = attachments;
			const workspace = resolveWorkspace(peer);
			if (workspace) req.cwd = workspace;
			const model = resolveModel(peer);
			if (model) req.model = model;
			const thinkingLevel = resolveThinkingLevel(peer);
			if (thinkingLevel) req.thinkingLevel = thinkingLevel;

			let bindCid = null;
			if (settings().bindActive === true && st.peerDetached[peer] !== true) {
				try {
					const cid = host.getActiveConversation?.()?.conversationId;
					if (typeof cid === "string" && cid.trim()) {
						bindCid = cid.trim();
						req.conversationId = bindCid;
						resetStaleRunText(bindCid);
					}
				} catch {}
			}

			const startedAt = Date.now();
			if (bindCid) inFlightConvs.set(bindCid, startedAt);
			inFlightClients.set(expectedPseudoClientId, startedAt);

			dispatches++;
			try {
				const r = await host.chat(req);
				if (!r?.conversationId) throw new Error(r?.error || "宿主未返回实际会话 ID，消息未确认执行");
				const conversationId = r?.conversationId;
				if (st.disposed || seq !== (st.peerSessionSeq[peer] || 0) || generation !== (mediaGeneration.get(peer) || 0)) {
					if (bindCid) inFlightConvs.delete(bindCid);
					inFlightClients.delete(expectedPseudoClientId);
					try {
						const stopped = await host.abortRun?.(r.runId || conversationId);
						if (!stopped?.ok) throw new Error(stopped?.error || "宿主未确认停止");
					} catch (err) {
						host.log("stale run abort failed:", err?.message ?? err);
						if (!st.disposed)
							await sendText(peer, "⚠️ 旧任务未能确认停止，请在网页端检查；旧结果不会写入新会话。", contextToken).catch(
								() => {},
							);
					}
					return;
				}
				const clientId = r?.clientId || expectedPseudoClientId;
				const runId = typeof r?.runId === "string" ? r.runId.trim() : "";
				if (conversationId) {
					if (bindCid) inFlightConvs.delete(bindCid);
					inFlightConvs.delete(conversationId);
					inFlightClients.delete(expectedPseudoClientId);
					resetStaleRunText(conversationId);
					trackRun({ conversationId, clientId, sessionId: r.sessionId, to: peer, contextToken, startedAt, runId });
				}
			} catch (err) {
				if (bindCid) inFlightConvs.delete(bindCid);
				inFlightClients.delete(expectedPseudoClientId);
				if (st.disposed || seq !== (st.peerSessionSeq[peer] || 0) || generation !== (mediaGeneration.get(peer) || 0))
					return;
				host.log("host.chat failed:", err?.message ?? err);
				sendText(peer, `执行失败：${err?.message ?? err}`, contextToken).catch(() => {});
			} finally {
				dispatches--;
				if (!dispatches) earlyRuns.clear();
			}
		}

		const offRun = host.onRunEvent((ev) => {
			try {
				if (st.disposed) return;
				const rid = typeof ev.runId === "string" ? ev.runId.trim() : "";
				if (rid && completedRuns.has(rid)) return;
				let key = rid ? st.runIdIndex.get(rid) : sessionKey(ev);
				if (!rid && !st.pendingRuns.has(key) && ev.clientId) key = makeRunKey(ev.clientId, ev.conversationId);
				let run = st.pendingRuns.get(key);
				if (
					run &&
					((rid && run.runId && rid !== run.runId) || (ev.sessionId && run.sessionId && ev.sessionId !== run.sessionId))
				)
					run = null;

				if (!run && dispatches && (rid || (ev.clientId && inFlightClients.has(ev.clientId)))) {
					const id = rid ? `run:${rid}` : makeRunKey(ev.clientId, ev.conversationId);
					trimEarlyRuns();
					const rec = earlyRuns.get(id) ?? { text: "", ended: false, at: Date.now() };
					if (ev.type === "message") {
						rec.text = cut(finalAssistantText(ev.message), REPLY_CAP + 200);
					}
					if (ev.type === "run_end") rec.ended = true;
					earlyRuns.set(id, rec);
					return;
				}
				if (!run) {
					if (rid || ev.type !== "run_start") return;
					const binding = sessionKey(ev);
					if ([...st.pendingRuns.values()].some((pending) => sessionKey(pending) === binding)) return;
					let route = routes.get(binding);
					if (!route && ev.clientId) {
						const peers = new Set(st.allowedPeers);
						for (const peer of peers) {
							const account = peerAccountId(peer, st.peerSessionSeq[peer] || 0);
							if (ev.clientId === `plugin:wechat-ilink:${account}` && st.peerCtx[peer]) {
								route = bindRoute(ev, peer, st.peerCtx[peer]);
								break;
							}
						}
					}
					if (!validRoute(route) || !binding) return;
					key = rid ? `run:${rid}` : binding;
					run = {
						...route,
						conversationId: ev.conversationId,
						clientId: ev.clientId,
						sessionId: ev.sessionId,
						runId: rid,
					};
					if (st.pendingRuns.size >= PENDING_RUN_CAP) dropRun(st.pendingRuns.keys().next().value);
					st.pendingRuns.set(key, run);
					if (rid) st.runIdIndex.set(rid, key);
				}
				if (run.epoch !== (st.peerSessionSeq[run.to] || 0) || run.ambiguous) {
					dropRun(key);
					return;
				}
				if (ev.type === "message") {
					st.runText.set(key, cut(finalAssistantText(ev.message), REPLY_CAP + 200));
				}
				if (ev.type !== "run_end") return;
				const body = stripInternalMarkers(st.runText.get(key) ?? "") || "任务完成（无文本输出）。";
				dropRun(key);
				if (rid) {
					rememberCompleted(rid);
				}
				const out =
					body.length > REPLY_CAP
						? `${body.slice(0, REPLY_CAP)}
…（超长截断）`
						: body;
				sendText(run.to, out, run.ctx).catch((err) => host.log("reply failed:", err?.message ?? err));
			} catch (err) {
				host.log("run event failed:", err?.message ?? err);
			}
		});
		const CORE_NUMBERED_COMMANDS = {
			1: "cwd",
			一: "cwd",
			2: "new",
			二: "new",
			3: "status",
			三: "status",
			4: "model",
			四: "model",
			5: "thinking",
			五: "thinking",
			6: "plan",
			六: "plan",
			7: "compact",
			七: "compact",
			8: "stop",
			八: "stop",
			9: "reload",
			九: "reload",
			10: "help",
			十: "help",
		};

		async function handleSlashCommand(cmdText, { peer, ctx }) {
			const normalized = String(cmdText ?? "")
				.trim()
				.replace(/^／/, "/");

			let raw = normalized;
			if (/^\d+\/[a-zA-Z]/.test(raw)) {
				raw = "/" + raw;
			}
			if (!raw.startsWith("/")) return false;

			const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(raw);
			if (!match) return false;

			let rawCmd = match[1].toLowerCase();
			const args = (match[2] ?? "").trim();

			if (/^\d+\/.+/.test(rawCmd)) {
				rawCmd = rawCmd.split("/")[1] || rawCmd.split("/")[0];
			}

			const pluginCmds = (host.getPluginCommands?.() ?? []).filter(
				(c) => c && c.name && !CORE_NUMBERED_COMMANDS[c.name],
			);
			const pluginCmdMap = new Map();
			pluginCmds.forEach((c, idx) => {
				const numKey = String(11 + idx);
				pluginCmdMap.set(numKey, c.name.toLowerCase());
			});

			const cmd = CORE_NUMBERED_COMMANDS[rawCmd] ?? pluginCmdMap.get(rawCmd) ?? rawCmd;

			switch (cmd) {
				case "":
				case "?":
				case "h":
				case "help":
				case "帮助": {
					const lines = [
						"可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：",
						"1/cwd : 查看或切换当前项目根目录",
						"2/new : 清空上下文开启全新会话 [提示]",
						"3/status : 查看通道运行状态与指标",
						"4/model : 查看或切换当前模型 [名称]",
						"5/thinking : 设置思考强度 <off|low|high|max>",
						"6/plan : 开启或关闭计划模式 [on|off]",
						"7/compact : 压缩当前会话上下文 [说明]",
						"8/stop : 中止当前正在执行的任务",
						"9/reload : 重新加载扩展与配置",
						"10/help : 显示全部命令 (或发 /)",
					];
					if (pluginCmds.length > 0) {
						pluginCmds.forEach((c, idx) => {
							const num = 11 + idx;
							const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
							lines.push(`${num}/${c.name} : ${c.description || "插件命令"}${hint}`);
						});
					}
					await sendText(peer, lines.join("\n"), ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "cwd":
				case "workspace": {
					if (!args) {
						const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
						const text = [
							`📂 当前项目根目录：${currentWs}`,
							"",
							"提示：",
							"• 发送 /cwd <目录绝对路径> 可切换根目录",
							"• 发送 /cwd default 可恢复跟随全局配置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userWorkspaces[peer];
						await startPeerSession(peer);
						const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
						await sendText(peer, `📂 已恢复跟随全局根目录：${currentWs}\n✨ 已自动为您开启全新会话！`, ctx).catch(
							(err) => host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					const chk = checkCwdValid(args);
					if (!chk.ok) {
						await sendText(peer, `⚠️ 切换失败：${chk.error}`, ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					st.userWorkspaces[peer] = chk.abs;
					await startPeerSession(peer);
					await sendText(peer, `📂 已将项目根目录切换为：${chk.abs}\n✨ 已自动为您开启该目录下的全新会话！`, ctx).catch(
						(err) => host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "reset":
				case "clear":
				case "new": {
					const epoch = await startPeerSession(peer);
					if (epoch !== st.peerSessionSeq[peer] || st.disposed) return true;
					if (args) {
						await sendText(peer, "✨ 已为您开启全新会话，正在执行指令…", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						if (epoch === st.peerSessionSeq[peer] && !st.disposed) await drivePeer(peer, args, ctx);
						return true;
					}
					await sendText(peer, "✨ 对话上下文已清空，已为您开启全新会话！", ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "status": {
					let stateStr = "已停止";
					if (st.polling) {
						if (Date.now() < st.pausedUntil) {
							const mins = Math.max(1, Math.ceil((st.pausedUntil - Date.now()) / 60000));
							stateStr = `暂停中 (会话受限，约 ${mins} 分钟后恢复)`;
						} else {
							stateStr = "在线 (长轮询中)";
						}
					} else if (isLoggedIn()) {
						stateStr = "已登录 (未轮询)";
					}
					const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
					const currentModel = resolveModel(peer) || "(跟随全局默认)";
					const currentThinking = resolveThinkingLevel(peer) || "(跟随全局设置)";
					const bindActive =
						settings().bindActive === true && st.peerDetached[peer] !== true ? "投递到网页活跃会话" : "独立无头会话";
					const statusText = [
						"🟢 微信通道运行状态",
						"",
						`• 账号 ID：${st.botId || "(未命名)"}`,
						`• 通道状态：${stateStr}`,
						`• 项目根目录：${currentWs}`,
						`• 当前模型：${currentModel}`,
						`• 思考强度：${currentThinking}`,
						`• 投递模式：${bindActive}`,
						`• 已接收消息：${st.messagesReceived} 条`,
						`• 已回复消息：${st.messagesReplied} 条`,
						`• 进行中任务：${st.pendingRuns.size} 个`,
						st.loginAt ? `• 登录时间：${new Date(st.loginAt).toLocaleString()}` : "",
					]
						.filter(Boolean)
						.join("\n");
					await sendText(peer, statusText, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				case "model": {
					if (!args) {
						const currentModel = resolveModel(peer) || "(跟随全局默认)";
						const text = [
							`🤖 当前模型：${currentModel}`,
							"",
							"提示：",
							"• 发送 /model <模型ID> 可切换微信通道模型（如 /model deepseek/deepseek-chat）",
							"• 发送 /model default 可恢复跟随全局配置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userModels[peer];
						await startPeerSession(peer);
						await sendText(peer, "🤖 已恢复跟随全局默认模型。\n✨ 已自动为您开启全新会话！", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					st.userModels[peer] = args;
					await startPeerSession(peer);
					await sendText(peer, `🤖 已将模型切换为：${args}\n✨ 已自动为您开启该模型下的全新会话！`, ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "thinking": {
					const ALIAS = {
						off: "off",
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
						关闭: "off",
						极简: "minimal",
						低: "low",
						中: "medium",
						高: "high",
						极高: "xhigh",
						最大: "max",
					};
					if (!args) {
						const cur = resolveThinkingLevel(peer) || "(跟随全局设置)";
						const text = [
							`🧠 当前思考强度：${cur}`,
							"",
							"提示：",
							"• 发送 /thinking <档位> 可切换（off/minimal/low/medium/high/xhigh/max）",
							"• 发送 /thinking default 可恢复跟随全局设置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userThinkingLevels[peer];
						await startPeerSession(peer);
						await sendText(peer, "🧠 已恢复跟随全局思考强度设置。\n✨ 已自动为您开启全新会话！", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					const mapped = ALIAS[args.toLowerCase()];
					if (!mapped) {
						await sendText(
							peer,
							`⚠️ 无效的思考强度：${args}。可用档位：off / minimal / low / medium / high / xhigh / max`,
							ctx,
						).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					st.userThinkingLevels[peer] = mapped;
					await startPeerSession(peer);
					await sendText(peer, `🧠 已将思考强度设置为：${mapped}\n✨ 已自动为您开启该档位下的全新会话！`, ctx).catch(
						(err) => host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "plan": {
					const trimmed = args.toLowerCase();
					const cur = Boolean(st.userPlanMode[peer]);
					const next = trimmed === "on" ? true : trimmed === "off" ? false : !cur;
					st.userPlanMode[peer] = next;
					save();
					const msg = next
						? "📋 计划模式已开启：AI 仅生成计划方案，不实施写操作。"
						: "📋 计划模式已关闭：恢复正常模式。";
					await sendText(peer, msg, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				case "compact": {
					await sendText(peer, "🗜️ 正在请求压缩当前会话上下文…", ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					void drivePeer(peer, `/compact ${args}`.trim(), ctx);
					return true;
				}
				case "reload": {
					try {
						await host.reload?.();
						await sendText(peer, "🔄 已重新加载扩展、技能与提示模板。", ctx).catch(() => {});
					} catch (err) {
						await sendText(peer, `⚠️ 重载失败：${err?.message ?? err}`, ctx).catch(() => {});
					}
					return true;
				}
				case "stop":
				case "abort": {
					mediaGeneration.set(peer, (mediaGeneration.get(peer) || 0) + 1);
					let stopped = 0;
					let failed = 0;
					for (const [runKey, run] of st.pendingRuns.entries()) {
						if (run.to === peer) {
							try {
								const result = await host.abortRun?.(run.runId || run.conversationId || runKey);
								if (!result?.ok) {
									failed++;
									continue;
								}
								dropRun(runKey);
								stopped++;
							} catch {
								failed++;
							}
						}
					}
					const msg =
						failed > 0
							? "⚠️ 未能确认中止任务，请在网页端查看运行状态。"
							: stopped > 0
								? "⏹️ 已中止当前正在执行的任务。"
								: "当前没有正在执行的任务。";
					await sendText(peer, msg, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				default: {
					if (host.execCommand) {
						try {
							const execRes = await host.execCommand(cmd, args, {
								clientId: `plugin:wechat-ilink:${peerAccountId(peer, st.peerSessionSeq[peer] || 0)}`,
							});
							if (execRes?.ok && typeof execRes.result === "string" && execRes.result.trim()) {
								await sendText(peer, execRes.result.trim(), ctx).catch((err) =>
									host.log("reply plugin cmd failed:", err?.message ?? err),
								);
								return true;
							}
						} catch {}
					}
					return false;
				}
			}
		}

		function touchPeerLastAt(peer, at) {
			st.peerLastAt[peer] = at;
			const keys = Object.keys(st.peerLastAt);
			if (keys.length <= PEER_LASTAT_CAP) return;
			for (const k of keys.slice(0, keys.length - PEER_LASTAT_CAP)) delete st.peerLastAt[k];
		}

		const mediaGeneration = new Map();
		const inboundMediaTasks = new Set();
		async function handleInbound(m) {
			try {
				if (!m || typeof m !== "object") return;
				if (m.message_type !== 1) return;
				const peer = String(m.from_user_id ?? "");
				if (!peer) return;
				if (m.group_id || m.thread_id) return;
				const ctx = typeof m.context_token === "string" ? m.context_token : undefined;
				if (ctx) {
					st.peerCtx[peer] = ctx;
					save();
				}
				const parts = inboundPartsOf(m.item_list);
				const plain = inboundTextOf(m.item_list);
				const hasMedia = parts.some((p) => p.kind !== "text");
				touchPeerLastAt(peer, Date.now());
				pushInbox({ dir: "in", peer, text: cut(plain || "(空消息)", 500), at: Date.now() });
				if (!plain && !hasMedia) return;
				st.messagesReceived++;
				save();
				if (!isAllowed(peer)) {
					addPending(peer);
					const last = st.pairTipAt[peer] ?? 0;
					if (Date.now() - last > PAIR_TIP_MS) {
						st.pairTipAt[peer] = Date.now();
						sendText(peer, "已收到，请先在网页端 💬 视图完成配对后再对话。", ctx).catch(() => {});
					}
					return;
				}

				const epoch = st.peerSessionSeq[peer] || 0;
				const generation = mediaGeneration.get(peer) || 0;
				const { text, attachments } = await buildInboundPrompt(parts, peer);
				if (
					hasMedia &&
					(st.disposed || epoch !== (st.peerSessionSeq[peer] || 0) || generation !== (mediaGeneration.get(peer) || 0))
				)
					return;
				if (!text) return;

				const clean = text.trim();
				if (!hasMedia && (clean.startsWith("/") || clean.startsWith("／") || /^\d+\/[a-zA-Z]/.test(clean))) {
					const handled = await handleSlashCommand(clean, { peer, ctx });
					if (handled) return;
				}

				if (settings().autoDrive === false) return;
				await drivePeer(peer, text, ctx, attachments);
			} catch (err) {
				host.log("inbound failed:", err?.message ?? err);
			}
		}

		async function pollOnce() {
			const client = ilink();
			const buf = store.get("cursor", "") ?? "";
			const r = await client.getUpdates(typeof buf === "string" ? buf : "");
			const code = Number(r?.ret ?? r?.errcode ?? 0);
			if (code === -14) {
				st.pausedUntil = Date.now() + PAUSE_MS;
				st.lastError = "会话受限（-14），暂停 1 小时";
				host.log(st.lastError);
				pushState();
				return;
			}
			if (typeof r?.get_updates_buf === "string" && r.get_updates_buf) {
				store.set("cursor", r.get_updates_buf);
			}
			st.lastPollAt = Date.now();
			st.lastError = "";
			for (const m of r?.msgs ?? []) {
				if (st.disposed) return;
				if (inboundPartsOf(m?.item_list).some((p) => p.kind !== "text")) {
					if (inboundMediaTasks.size >= 4) {
						void sendText(String(m.from_user_id ?? ""), "媒体处理繁忙，请稍后重发。", m.context_token).catch(() => {});
						continue;
					}
					const task = handleInbound(m);
					inboundMediaTasks.add(task);
					void task.finally(() => inboundMediaTasks.delete(task));
				} else await handleInbound(m);
			}
		}

		async function pollLoop() {
			st.backoffMs = BACKOFF_MIN_MS;
			while (!st.disposed && st.polling && isLoggedIn()) {
				if (Date.now() < st.pausedUntil) {
					await new Promise((r) => setTimeout(r, 5000));
					continue;
				}
				try {
					await pollOnce();
					st.backoffMs = BACKOFF_MIN_MS;
				} catch (err) {
					st.lastError = String(err?.message ?? err);
					host.log("poll failed:", st.lastError, `(${st.backoffMs}ms 后重试)`);
					await new Promise((r) => setTimeout(r, st.backoffMs));
					st.backoffMs = Math.min(BACKOFF_MAX_MS, st.backoffMs * 2);
				}
			}
		}

		function startPoll() {
			if (st.polling || st.disposed || !isLoggedIn()) return;
			st.polling = true;
			st.bgTask?.update({ status: "轮询中" });
			void ilink().notify("notifystart");
			void pollLoop().finally(() => {
				st.polling = false;
				st.bgTask?.update({ status: "已停止" });
				pushState();
			});
			pushState();
		}
		function stopPoll() {
			st.polling = false;
		}

		async function startLogin() {
			if (st.disposed) return;
			if (st.qrTimer || st.qr) {
				pushState();
				return;
			}
			st.qrStop = false;
			try {
				const prev = getToken();
				const r = await ilink().getQr(prev ? [prev] : []);
				if (!r?.qrcode) throw new Error("取码失败（无 qrcode）");
				st.qr = { qrcode: r.qrcode, image: r.qrcode_img_content ?? "" };
				pushState();
				const tick = async () => {
					if (st.disposed || st.qrStop) return;
					try {
						const s = await ilink().qrStatus(st.qr.qrcode);
						const status = String(s?.status ?? "wait");
						if (status === "confirmed" && s?.bot_token) {
							try {
								secrets?.set?.(TOKEN_KEY, String(s.bot_token));
								if ((secrets?.get?.(TOKEN_KEY) ?? null) !== String(s.bot_token)) {
									throw new Error("机密回读不一致");
								}
							} catch (err) {
								host.log("save login token failed:", err?.message ?? err);
								host.notify(
									"error",
									`微信扫码成功，但登录凭据存不住：${err?.message ?? err}（请升级 pi-web-ui 到已修复机密密钥的版本后重试）`,
									`WeChat scan succeeded but the login token could not be stored: ${err?.message ?? err}`,
								);
								cancelLogin();
								return;
							}
							if (s.baseurl) st.base = String(s.baseurl);
							st.botId = String(s.ilink_bot_id ?? "");
							st.loginAt = Date.now();
							save();
							st.qr = null;
							st.qrTimer = null;
							host.notify("info", "微信登录成功，开始接收消息", "WeChat login succeeded");
							pushState();
							startPoll();
							return;
						}
						if (status === "expired" || status === "verify_code_blocked") {
							st.qr = null;
							st.qrTimer = null;
							host.notify("warning", "微信二维码已过期，请重新点登录", "WeChat QR code expired, please retry");
							pushState();
							return;
						}
						if (status === "need_verifycode") {
							host.log("登录需要手机验证码，请在手机上确认后继续等待");
						}
					} catch (err) {
						host.log("qr status failed:", err?.message ?? err);
					}
					if (!st.disposed && !st.qrStop && st.qr) {
						st.qrTimer = setTimeout(tick, QR_POLL_MS);
					}
				};
				st.qrTimer = setTimeout(tick, QR_POLL_MS);
			} catch (err) {
				st.qr = null;
				st.qrTimer = null;
				host.notify("error", `微信取码失败：${err?.message ?? err}`, `WeChat QR failed: ${err?.message ?? err}`);
				pushState();
			}
		}
		function cancelLogin() {
			st.qrStop = true;
			if (st.qrTimer) clearTimeout(st.qrTimer);
			st.qrTimer = null;
			st.qr = null;
			pushState();
		}
		async function logout() {
			cancelLogin();
			stopPoll();
			try {
				await ilink().notify("notifystop");
			} catch {}
			try {
				secrets?.delete?.(TOKEN_KEY);
			} catch {}
			st.botId = "";
			st.loginAt = 0;
			try {
				store.set("cursor", "");
			} catch {}
			host.notify("info", "微信已登出", "WeChat logged out");
			pushState();
		}

		function applyAiTool() {
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {}
				st.toolOff = null;
			}
			if (settings().aiSend === false || !isLoggedIn()) return;
			try {
				st.toolOff = host.registerAgentTool({
					name: "wechat_send",
					label: "发微信消息",
					description:
						"Send a text and/or a local media file (image/video/file) over the WeChat channel to a paired user. Relative paths resolve against the channel workspace; http(s) URLs are downloaded first.",
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "WeChat user ID (visible in the view's inbox)" },
							text: { type: "string", description: "Message text (optional when media is given)" },
							image: {
								type: "string",
								description: "Image file path or http(s) URL to send",
							},
							file: {
								type: "string",
								description: "Any other file path or http(s) URL (video/pdf/zip/...)",
							},
						},
						required: ["to"],
					},
					async execute(_id, params) {
						const to = String(params?.to ?? "").trim();
						const text = String(params?.text ?? "").trim();
						const image = String(params?.image ?? "").trim();
						const file = String(params?.file ?? "").trim();
						if (!to) throw new Error("wechat_send 需要 to");
						if (!text && !image && !file) throw new Error("wechat_send 需要 text / image / file 至少一个");
						if (!isAllowed(to)) throw new Error(`未配对用户：${to}（先在 💬 视图允许）`);
						if (text) await sendText(to, cut(stripInternalMarkers(text), REPLY_CAP), st.peerCtx[to]);
						const sent = [];
						for (const spec of [image, file]) {
							if (!spec) continue;
							const abs = await resolveOutboundPath(spec, to);
							const kind = await sendMediaFile(to, abs, st.peerCtx[to]);
							sent.push(`${MEDIA_LABEL[kind] ?? "媒体"}:${basename(abs)}`);
						}
						return sent.length ? `已发送给 ${to}：${sent.join("、")}` : `已发送给 ${to}`;
					},
				});
			} catch (err) {
				host.log("register wechat_send failed:", err?.message ?? err);
			}
		}

		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						break;
					case "login":
						void startLogin();
						break;
					case "login_cancel":
						cancelLogin();
						break;
					case "logout":
						void logout().then(() => applyAiTool());
						break;
					case "allow": {
						const peer = String(msg.peer ?? "").trim();
						const isNew = peer && !st.allowedPeers.includes(peer);
						if (isNew) {
							st.allowedPeers.push(peer);
							sendPairSuccess(peer).catch((err) => host.log("pair welcome failed:", err?.message ?? err));
						}
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						host.notify("info", `微信已配对：${peer}`, `WeChat paired: ${peer}`);
						pushState();
						break;
					}
					case "deny": {
						const peer = String(msg.peer ?? "").trim();
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						pushState();
						break;
					}
					case "set_workspace": {
						setWorkspace(msg.workspace);
						break;
					}
					case "set_model": {
						setModel(msg.model, msg.thinkingLevel);
						break;
					}
					case "set_bind_active": {
						setBindActive(msg.bindActive);
						break;
					}
					case "send": {
						const peer = String(msg.peer ?? "").trim();
						const text = String(msg.text ?? "").trim();
						const media = String(msg.media ?? "").trim();
						if (!peer || (!text && !media)) break;
						if (!isAllowed(peer)) {
							if (from) host.sendTo(from, { kind: "error", error: `未配对用户：${peer}` });
							break;
						}
						if (text) {
							sendText(peer, cut(text, REPLY_CAP), st.peerCtx[peer]).catch((err) => {
								if (from) host.sendTo(from, { kind: "error", error: String(err?.message ?? err) });
							});
						}
						if (media) {
							resolveOutboundPath(media, peer)
								.then((abs) => sendMediaFile(peer, abs, st.peerCtx[peer]))
								.catch((err) => {
									if (from) host.sendTo(from, { kind: "error", error: String(err?.message ?? err) });
								});
						}
						break;
					}
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err?.message ?? err);
			}
		});

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
			} catch (err) {
				host.log("attach push failed:", err?.message ?? err);
			}
		});
		const offCwd = host.onCwdChange?.(() => {
			try {
				pushState();
			} catch {}
		});

		load();
		const savedRoutes = store.get("sessionRoutes", []);
		for (const entry of Array.isArray(savedRoutes) ? savedRoutes.slice(-200) : []) {
			if (
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				entry[0].startsWith("session:") &&
				(entry[1]?.ambiguous || validRoute(entry[1]))
			)
				routes.set(entry[0], entry[1]);
		}
		st.bgTask = host.registerBackgroundTask({
			id: "wechat-poll",
			label: "💬 微信通道",
			status: isLoggedIn() ? "已登录" : "未登录",
			stop: () => {
				stopPoll();
				st.bgTask?.update({ status: "已停止" });
				pushState();
			},
		});
		applyAiTool();
		if (isLoggedIn()) startPoll();
		host.log(`activated (ilink ${st.base}; loggedIn=${isLoggedIn()})`);

		return () => {
			st.disposed = true;
			cancelLogin();
			stopPoll();
			try {
				void ilink().notify("notifystop");
			} catch {}
			offRun();
			offMsg();
			offAttach();
			if (offCwd) {
				try {
					offCwd();
				} catch {}
			}
			if (offSettings) {
				try {
					offSettings();
				} catch {}
			}
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {}
			}
			for (const id of [...st.pendingRuns.keys()]) dropRun(id);
			earlyRuns.clear();
			st.runIdIndex.clear();
			inFlightClients.clear();
			inFlightConvs.clear();
			routes.clear();
			completedRuns.clear();
			st.bgTask?.unregister();
		};
	},
};
