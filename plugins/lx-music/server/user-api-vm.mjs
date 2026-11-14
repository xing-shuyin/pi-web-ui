import vm from "node:vm";
import crypto from "node:crypto";
import zlib from "node:zlib";

const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function createLxRequest(activeTimers, wrapAbort, revive, toError) {
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
					// resp.body/raw 是宿主对象（Buffer/JSON.parse 产物），跨界前必须重建为沙箱对象。
					callback(null, revive(resp), revive(parsedBody));
				}
			})
			.catch((err) => {
				clearTimeout(timer);
				if (activeTimers) activeTimers.delete(timer);
				if (typeof callback === "function") {
					// 宿主 Error 实例同样携带宿主 realm：在沙箱内重建，`err.message` 用法不变。
					callback(toError(err), null, null);
				}
			});

		// 返回值必须经沙箱 realm 包装：裸宿主闭包一旦进入沙箱，脚本即可经
		// `.constructor` 拿到宿主 Function 构造器完成逃逸（见 SANDBOX_BOOTSTRAP）。
		return wrapAbort(() => {
			clearTimeout(timer);
			if (activeTimers) activeTimers.delete(timer);
			controller.abort();
		});
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

// node:vm 的 context 不是安全边界（Node 官方文档明示）：任何宿主 realm 的函数/构造器/类实例
// 一旦进入沙箱，脚本即可沿 `.constructor` 拿到宿主 Function 构造器，进而触达宿主 process/require。
// 本文件的目标是「不把宿主 realm 引用递进沙箱」，而不是宣称 vm 能抵御刻意攻击；真要执行不可信
// 代码仍需 OS 级隔离（独立进程 / 权限收敛）。为此的约定：
//   1. 宿主函数一律先在沙箱内跑这段 bootstrap、用「沙箱 realm 创建的包装函数」包一层再暴露；
//   2. 跨界数据统一由 revive 重建为沙箱对象（数组/TypedArray/Buffer → 沙箱新对象，宿主类实例拒绝透传）；
//   3. 宿主抛错/拒绝也必须重建为沙箱 Error —— 直接透传宿主 Error 实例同样是一条逃逸通道；
//   4. 内建与桥接函数在 bootstrap 时捕获到闭包里：脚本改写 globalThis.Uint8Array / Object.keys
//      之类不再影响桥接层行为；桥接对象交给宿主后立刻从全局删除，脚本看不到也改不了。
const SANDBOX_BOOTSTRAP = `
(() => {
	const SandboxUint8Array = Uint8Array;
	const SandboxFunction = Function;
	const SandboxWeakSet = WeakSet;
	const SandboxPromise = Promise;
	const objectKeys = Object.keys;
	const isArray = Array.isArray;
	const objectToString = Object.prototype.toString;
	const reflectApply = Reflect.apply;

	const tagOf = (value) => reflectApply(objectToString, value, []);
	const isTypedArrayTag = (tag) =>
		typeof tag === "string" && tag.length > 6 && tag.slice(-6) === "Array]" && tag !== "[object Array]";

	const revive = (value, seen) => {
		if (value === null || typeof value !== "object") return value;
		seen = seen || new SandboxWeakSet();
		if (seen.has(value)) return undefined;
		seen.add(value);
		if (isArray(value)) {
			// 必须自己建沙箱数组：value.map(...) 由宿主 Array.prototype 执行，会吐回宿主数组。
			const out = [];
			for (let i = 0; i < value.length; i++) out.push(revive(value[i], seen));
			return out;
		}
		const tag = tagOf(value);
		if (tag === "[object ArrayBuffer]" || isTypedArrayTag(tag)) {
			try {
				return new SandboxUint8Array(value);
			} catch {
				return undefined;
			}
		}
		if (tag !== "[object Object]") return undefined;
		const out = {};
		for (const key of objectKeys(value)) {
			const item = value[key];
			// 只有沙箱 realm 的函数可以留在返回值里；宿主函数一律丢弃。
			out[key] = typeof item === "function" ? (item instanceof SandboxFunction ? item : undefined) : revive(item, seen);
		}
		return out;
	};

	// 宿主 throw/reject 的实例同样携带宿主 realm：只取 name/message/code 这些纯数据，
	// 在沙箱内重建 Error，脚本侧 err.message / err instanceof Error 语义不变。
	const toError = (reason) => {
		let name = "Error";
		let message;
		let code;
		if (reason !== null && typeof reason === "object") {
			try {
				if (typeof reason.name === "string" && reason.name) name = reason.name;
				if (typeof reason.message === "string") message = reason.message;
				if (typeof reason.code === "string") code = reason.code;
			} catch {}
		}
		if (message === undefined) {
			try {
				message = String(reason);
			} catch {
				message = "宿主调用失败";
			}
		}
		const ctor =
			name === "TypeError" ? TypeError : name === "RangeError" ? RangeError : name === "SyntaxError" ? SyntaxError : Error;
		const err = new ctor(message);
		if (name !== "Error" && err.name !== name) err.name = name;
		if (code !== undefined) err.code = code;
		return err;
	};

	const wrapHost = (fn) => (...args) => {
		try {
			const result = fn(...args);
			if (result && typeof result.then === "function") {
				return SandboxPromise.resolve(result).then(
					(value) => revive(value),
					(reason) => {
						throw toError(reason);
					},
				);
			}
			return revive(result);
		} catch (reason) {
			throw toError(reason);
		}
	};
	const wrapIn = (fn) => (...args) => fn(...args.map((arg) => revive(arg)));
	const wrapCallback = (fn) => (...args) => fn(...args);

	Object.defineProperty(globalThis, "__piUserApiBridge", {
		value: { revive, toError, wrapHost, wrapIn, wrapCallback },
		writable: false,
		configurable: true,
		enumerable: false,
	});
})();
`;

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

		// lx 对象在沙箱 bootstrap 之后组装（见 try 块）：所有暴露给脚本的函数都经
		// 沙箱 realm 的 __wrapHost/__wrapIn 包装，杜绝宿主函数引用直接进入沙箱。
		const buildLx = (wrapHost, wrapIn, wrapCallback, revive, toError) => ({
			EVENT_NAMES: {
				request: "request",
				inited: "inited",
				updateAlert: "updateAlert",
			},
			on: wrapHost((eventName, handler) => {
				if (eventName === "request") {
					// handler 是脚本定义的沙箱函数；宿主稍后调用它时参数也要先重建为沙箱对象。
					requestHandler = wrapIn(handler);
				}
			}),
			send: wrapHost((eventName, data) => {
				if (eventName === "inited") {
					if (data?.name) apiMeta.name = data.name;
					if (data?.version) apiMeta.version = data.version;
					if (data?.description) apiMeta.description = data.description;
				}
			}),
			request: wrapHost(createLxRequest(timers, wrapCallback, revive, toError)),
			utils: {
				crypto: {
					// 沙箱传入的 Uint8Array 来自另一个 V8 realm，先拷贝成宿主 Buffer 再交给 Node API；
					// 返回的宿主 Buffer 由 __wrapHost 的 __revive 重建为沙箱 Uint8Array。
					aesEncrypt: wrapHost((buffer, mode, key, iv) => {
						const cipher = crypto.createCipheriv(mode, Buffer.from(key), Buffer.from(iv));
						return Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);
					}),
					rsaEncrypt: wrapHost((buffer, key) => {
						const padded = Buffer.concat([Buffer.alloc(128 - buffer.length), Buffer.from(buffer)]);
						return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, padded);
					}),
					randomBytes: wrapHost((size) => crypto.randomBytes(size)),
					md5: wrapHost((str) => crypto.createHash("md5").update(str).digest("hex")),
				},
				buffer: {
					from: wrapHost((...args) => Buffer.from(...args)),
					bufToString: wrapHost((buf, format) => Buffer.from(Buffer.from(buf), "binary").toString(format)),
				},
				zlib: {
					inflate: wrapHost(
						(buf) =>
							new Promise((resolve, reject) => {
								zlib.inflate(Buffer.from(buf), (err, data) => (err ? reject(err) : resolve(data)));
							}),
					),
					deflate: wrapHost(
						(data) =>
							new Promise((resolve, reject) => {
								zlib.deflate(Buffer.from(data), (err, buf) => (err ? reject(err) : resolve(buf)));
							}),
					),
				},
			},
			currentScriptInfo: {
				name: apiMeta.name,
				version: apiMeta.version,
			},
			version: "2.0.0",
			env: "desktop",
		});

		// 定时器句柄整数化：宿主 Timeout 对象不进入沙箱。
		let timerSeq = 0;
		const timerMap = new Map();
		const sandboxSetTimeout = (fn, delay, ...args) => {
			const timerId = ++timerSeq;
			const t = setTimeout(() => {
				timerMap.delete(timerId);
				timers.delete(t);
				fn(...args);
			}, delay);
			timers.add(t);
			timerMap.set(timerId, t);
			return timerId;
		};
		const sandboxClearTimeout = (timerId) => {
			const t = timerMap.get(Number(timerId));
			if (!t) return;
			timerMap.delete(Number(timerId));
			timers.delete(t);
			clearTimeout(t);
		};
		const sandboxSetInterval = (fn, delay, ...args) => {
			const timerId = ++timerSeq;
			const t = setInterval(fn, delay, ...args);
			timers.add(t);
			timerMap.set(timerId, t);
			return timerId;
		};
		const sandboxClearInterval = (timerId) => {
			const t = timerMap.get(Number(timerId));
			if (!t) return;
			timerMap.delete(Number(timerId));
			timers.delete(t);
			clearInterval(t);
		};

		// 只有纯数据先入 context；宿主函数在 bootstrap 之后经沙箱包装逐个挂载。
		// Math/Date/JSON/RegExp 等脚本环境自带（V8 context 内建），不再注入宿主版本。
		const context = {
			process: { env: {} },
		};
		context.globalThis = context;
		context.window = context;

		try {
			vm.createContext(context);
			vm.runInContext(SANDBOX_BOOTSTRAP, context);
			// 桥接对象只给宿主用：读完立即从全局删除，脚本侧拿不到也改不了。
			const bridge = vm.runInContext("globalThis.__piUserApiBridge", context);
			vm.runInContext("delete globalThis.__piUserApiBridge", context);
			const wrapHost = bridge.wrapHost;
			const wrapIn = bridge.wrapIn;
			const wrapCallback = bridge.wrapCallback;
			const revive = bridge.revive;
			const toError = bridge.toError;

			context.lx = revive(buildLx(wrapHost, wrapIn, wrapCallback, revive, toError));
			context.console = revive({
				log: wrapHost((...args) => this.log(`[UserApi:${id}]`, ...args)),
				error: wrapHost((...args) => console.error(`[UserApi:${id}]`, ...args)),
				warn: wrapHost((...args) => console.warn(`[UserApi:${id}]`, ...args)),
			});
			context.setTimeout = wrapHost(sandboxSetTimeout);
			context.clearTimeout = wrapHost(sandboxClearTimeout);
			context.setInterval = wrapHost(sandboxSetInterval);
			context.clearInterval = wrapHost(sandboxClearInterval);
			context.atob = wrapHost((s) => Buffer.from(s, "base64").toString("binary"));
			context.btoa = wrapHost((s) => Buffer.from(s, "binary").toString("base64"));
			context.process = revive({ env: {} });

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
