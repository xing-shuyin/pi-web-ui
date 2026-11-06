import vm from "node:vm";
import crypto from "node:crypto";
import zlib from "node:zlib";

const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function createLxRequest(activeTimers) {
	return function lxRequest(url, options = {}, callback) {
		const method = (options.method || "GET").toUpperCase();
		const headers = {
			"User-Agent": DEFAULT_UA,
			...options.headers,
		};
		let body = options.body;

		if (options.form) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = typeof options.form === "string" ? options.form : new URLSearchParams(options.form).toString();
		} else if (options.formData && typeof options.formData === "object") {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = new URLSearchParams(options.formData).toString();
		}

		const timeoutMs =
			typeof options.timeout === "number" && options.timeout > 0 ? Math.min(options.timeout, 30000) : 15000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		if (activeTimers) activeTimers.add(timer);

		fetch(url, {
			method,
			headers,
			body: ["GET", "HEAD"].includes(method) ? undefined : body,
			signal: controller.signal,
		})
			.then(async (res) => {
				clearTimeout(timer);
				if (activeTimers) activeTimers.delete(timer);
				const buf = Buffer.from(await res.arrayBuffer());
				let rawStr = buf.toString("utf8");
				let parsedBody = rawStr;
				try {
					parsedBody = JSON.parse(rawStr);
				} catch {}

				const resp = {
					statusCode: res.status,
					statusMessage: res.statusText,
					headers: Object.fromEntries(res.headers.entries()),
					bytes: buf.length,
					raw: buf,
					body: parsedBody,
				};
				if (typeof callback === "function") {
					callback(null, resp, parsedBody);
				}
			})
			.catch((err) => {
				clearTimeout(timer);
				if (activeTimers) activeTimers.delete(timer);
				if (typeof callback === "function") {
					callback(err, null, null);
				}
			});

		return () => {
			clearTimeout(timer);
			if (activeTimers) activeTimers.delete(timer);
			controller.abort();
		};
	};
}

function normalizeMusicInfo(source, raw) {
	const songId = String(raw.id || raw.songmid || raw.hash || "");
	const hash = raw.hash || (source === "kg" ? songId : "");
	const albumId = String(raw.albumId || raw.meta?.albumId || "");
	return {
		...raw,
		id: songId,
		songmid: raw.songmid || songId,
		songId,
		hash,
		source,
		name: raw.name || "",
		singer: raw.singer || "",
		albumName: raw.album || raw.albumName || "",
		albumId,
		albumMid: raw.albumMid || albumId,
		strMediaMid: raw.strMediaMid || songId,
		copyrightId: raw.copyrightId || songId,
		interval: raw.duration || raw.interval || "03:00",
		types: [
			{ type: "128k", size: "" },
			{ type: "320k", size: "" },
			{ type: "flac", size: "" },
			{ type: "hires", size: "" },
		],
		_types: {
			"128k": {},
			"320k": {},
			flac: {},
			hires: {},
			flac24bit: {},
		},
		meta: {
			songId,
			albumId,
			hash,
			strMediaMid: raw.strMediaMid || songId,
			...raw.meta,
		},
	};
}

const QUALITY_FALLBACK_LADDER = {
	master: ["master", "hires", "flac24bit", "flac", "320k", "128k"],
	atmos_plus: ["atmos_plus", "atmos", "hires", "flac", "320k", "128k"],
	atmos: ["atmos", "hires", "flac", "320k", "128k"],
	hires: ["hires", "flac24bit", "flac", "320k", "128k"],
	flac24bit: ["flac24bit", "hires", "flac", "320k", "128k"],
	flac: ["flac", "320k", "128k"],
	"320k": ["320k", "128k"],
	"128k": ["128k"],
};

async function verifyAudioPlayable(url, source = "", timeoutMs = 2000) {
	if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const headers = {
			"User-Agent": DEFAULT_UA,
			Range: "bytes=0-1024",
		};
		if (url.includes("kuwo.cn")) headers["Referer"] = "http://www.kuwo.cn/";
		else if (url.includes("kugou.com")) headers["Referer"] = "http://www.kugou.com/";
		else if (url.includes("163.com") || url.includes("126.net")) headers["Referer"] = "https://music.163.com/";
		else if (url.includes("qq.com")) headers["Referer"] = "https://y.qq.com/";

		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (res.status === 404 || res.status >= 500) return false;

		const contentType = (res.headers.get("content-type") || "").toLowerCase();
		if (contentType.includes("text/html") || contentType.includes("application/json")) {
			return false;
		}

		return true;
	} catch {
		return true;
	}
}

export class UserApiEngine {
	constructor(options = {}) {
		this.apis = new Map();
		this.activeId = null;
		this.log = options.log || console.log;
	}

	importScript(id, scriptContent) {
		let requestHandler = null;
		const timers = new Set();

		const cleanScript = (scriptContent || "").replace(/^\uFEFF\s*/, "").trim();
		if (!cleanScript) {
			return { ok: false, error: "脚本内容不能为空" };
		}

		const nameMatch = cleanScript.match(/@name\s+(.+)/);
		const verMatch = cleanScript.match(/@version\s+(.+)/);
		const descMatch = cleanScript.match(/@description\s+(.+)/);
		const authorMatch = cleanScript.match(/@author\s+(.+)/);

		let apiMeta = {
			name: nameMatch ? nameMatch[1].trim() : `自定义音源_${id}`,
			version: verMatch ? verMatch[1].trim() : "1.0.0",
			description: descMatch ? descMatch[1].trim() : "",
			author: authorMatch ? authorMatch[1].trim() : "",
		};

		const lx = {
			EVENT_NAMES: {
				request: "request",
				inited: "inited",
				updateAlert: "updateAlert",
			},
			on: (eventName, handler) => {
				if (eventName === "request") {
					requestHandler = handler;
				}
			},
			send: (eventName, data) => {
				if (eventName === "inited") {
					if (data?.name) apiMeta.name = data.name;
					if (data?.version) apiMeta.version = data.version;
					if (data?.description) apiMeta.description = data.description;
				}
			},
			request: createLxRequest(timers),
			utils: {
				crypto: {
					aesEncrypt(buffer, mode, key, iv) {
						const cipher = crypto.createCipheriv(mode, key, iv);
						return Buffer.concat([cipher.update(buffer), cipher.final()]);
					},
					rsaEncrypt(buffer, key) {
						buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
						return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
					},
					randomBytes(size) {
						return crypto.randomBytes(size);
					},
					md5(str) {
						return crypto.createHash("md5").update(str).digest("hex");
					},
				},
				buffer: {
					from(...args) {
						return Buffer.from(...args);
					},
					bufToString(buf, format) {
						return Buffer.from(buf, "binary").toString(format);
					},
				},
				zlib: {
					inflate(buf) {
						return new Promise((resolve, reject) => {
							zlib.inflate(buf, (err, data) => (err ? reject(err) : resolve(data)));
						});
					},
					deflate(data) {
						return new Promise((resolve, reject) => {
							zlib.deflate(data, (err, buf) => (err ? reject(err) : resolve(buf)));
						});
					},
				},
			},
			currentScriptInfo: {
				name: apiMeta.name,
				version: apiMeta.version,
			},
			version: "2.0.0",
			env: "desktop",
		};

		const sandboxSetTimeout = (fn, delay, ...args) => {
			const t = setTimeout(() => {
				timers.delete(t);
				fn(...args);
			}, delay);
			timers.add(t);
			return t;
		};
		const sandboxClearTimeout = (t) => {
			timers.delete(t);
			clearTimeout(t);
		};
		const sandboxSetInterval = (fn, delay, ...args) => {
			const t = setInterval(fn, delay, ...args);
			timers.add(t);
			return t;
		};
		const sandboxClearInterval = (t) => {
			timers.delete(t);
			clearInterval(t);
		};

		const context = {
			console: {
				log: (...args) => this.log(`[UserApi:${id}]`, ...args),
				error: (...args) => console.error(`[UserApi:${id}]`, ...args),
				warn: (...args) => console.warn(`[UserApi:${id}]`, ...args),
			},
			setTimeout: sandboxSetTimeout,
			clearTimeout: sandboxClearTimeout,
			setInterval: sandboxSetInterval,
			clearInterval: sandboxClearInterval,
			Buffer,
			fetch: globalThis.fetch,
			URL,
			URLSearchParams,
			Math,
			Date,
			JSON,
			RegExp,
			encodeURIComponent,
			decodeURIComponent,
			atob: (s) => Buffer.from(s, "base64").toString("binary"),
			btoa: (s) => Buffer.from(s, "binary").toString("base64"),
			TextEncoder,
			TextDecoder,
			process: { env: {} },
			lx,
		};

		context.globalThis = context;
		context.window = context;

		try {
			vm.createContext(context);
			vm.runInContext(cleanScript, context, { timeout: 8000 });

			if (this.apis.has(id)) {
				this.cleanupTimers(id);
			}

			this.apis.set(id, {
				id,
				meta: apiMeta,
				handler: requestHandler,
				script: cleanScript,
				timers,
			});

			if (!this.activeId) this.activeId = id;
			return { ok: true, meta: apiMeta };
		} catch (err) {
			for (const t of timers) clearTimeout(t);
			return { ok: false, error: String(err?.message || err) };
		}
	}

	cleanupTimers(id) {
		const target = this.apis.get(id);
		if (target?.timers) {
			for (const t of target.timers) {
				clearTimeout(t);
				clearInterval(t);
			}
			target.timers.clear();
		}
	}

	setActive(id) {
		if (this.apis.has(id) || id === null) {
			this.activeId = id;
			return true;
		}
		return false;
	}

	removeScript(id) {
		this.cleanupTimers(id);
		this.apis.delete(id);
		if (this.activeId === id) {
			const keys = [...this.apis.keys()];
			this.activeId = keys.length ? keys[0] : null;
		}
	}

	listApis() {
		const list = [];
		for (const [id, item] of this.apis.entries()) {
			list.push({
				id,
				name: item.meta.name,
				version: item.meta.version,
				description: item.meta.description,
				author: item.meta.author,
				active: id === this.activeId,
			});
		}
		return list;
	}

	async resolveUrl(source, rawMusicInfo, quality = "128k") {
		if (!this.activeId) return null;
		const target = this.apis.get(this.activeId);
		if (!target || !target.handler) return null;

		const musicInfo = normalizeMusicInfo(source, rawMusicInfo);
		const ladder = QUALITY_FALLBACK_LADDER[quality] || [quality, "320k", "128k"];

		for (const q of ladder) {
			try {
				const res = await target.handler({
					action: "musicUrl",
					source,
					info: {
						type: q,
						musicInfo,
					},
				});

				let candidateUrl = null;
				if (typeof res === "string" && res.startsWith("http")) candidateUrl = res;
				else if (res?.url && typeof res.url === "string" && res.url.startsWith("http")) candidateUrl = res.url;

				if (candidateUrl) {
					const isPlayable = await verifyAudioPlayable(candidateUrl, source);
					if (isPlayable) {
						return { url: candidateUrl, quality: q };
					}
					this.log(`[UserApi:${this.activeId}] 音源返回了失效死链 (404/不可达): ${candidateUrl}，正在尝试平滑降级`);
				}
			} catch (err) {
				this.log(`[UserApi:${this.activeId}] 音质档位 ${q} 请求未命中: ${err.message}`);
			}
		}

		return null;
	}

	async probeApi(id) {
		const target = this.apis.get(id);
		if (!target || !target.handler) {
			return { ok: false, error: "音源未加载或未注册处理函数" };
		}
		const testSong = {
			id: "186016",
			name: "晴天",
			singer: "周杰伦",
			album: "叶惠美",
			source: "wy",
		};
		try {
			const res = await target.handler({
				action: "musicUrl",
				source: "wy",
				info: {
					type: "128k",
					musicInfo: normalizeMusicInfo("wy", testSong),
				},
			});
			const url = typeof res === "string" ? res : res?.url;
			if (!url || !url.startsWith("http")) {
				return { ok: false, error: "未返回有效播放链接" };
			}
			const playable = await verifyAudioPlayable(url, "wy", 3000);
			if (!playable) {
				return {
					ok: false,
					error: "上游服务已失效 (HTTP 404 或返回非音频内容)，建议切换其他可用音源",
					url,
				};
			}
			return { ok: true, message: "音源正常可用", url };
		} catch (err) {
			return { ok: false, error: err.message || "请求异常" };
		}
	}
}
