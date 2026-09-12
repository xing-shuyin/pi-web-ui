/**
 * legado-web 的公共抓取层 —— 书源站请求（绕 CORS 不需要：这里就是服务端）＋ 编码处理 ＋ cookie jar。
 *
 * 三个使用方共用这一份实现，保证 UI、AI 工具、同步 JS 规则行为完全一致：
 *   - index.mjs 的 `/proxy` HTTP 路由（浏览器里的内嵌前端走这条）
 *   - engine-host.mjs 的异步 transport（AI 工具跑规则链路）
 *   - sync-worker.mjs 的同步桥（书源 JS 规则里的 java.ajax/connect/get/post）
 *
 * 编码：GBK 等非 UTF-8 用内置 TextDecoder 解码；编码方向用惰性构建的反查表
 * （遍历 GBK 双字节空间反向建映射，约 20ms，只在用到时构建）——零 npm 依赖。
 */

export const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/** 编码名归一（TextDecoder 认的标签形式）。 */
export function normCharset(raw) {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

function isUtf8(cs) {
	return !cs || cs === "utf-8" || cs === "utf8";
}

/** 字节 → 文本；utf-8 解出替换字符时自动回退 GBK。 */
export function decodeBytes(buf, charset) {
	const cs = normCharset(charset);
	if (isUtf8(cs)) {
		const s = buf.toString("utf8");
		if (!s.includes("\uFFFD")) return s;
		try {
			return new TextDecoder("gbk").decode(buf);
		} catch {
			return s;
		}
	}
	try {
		return new TextDecoder(cs).decode(buf);
	} catch {
		return buf.toString("utf8");
	}
}

/** 从响应头 / HTML 头部嗅探编码。 */
export function detectCharset(contentType, headBytes) {
	const ct = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
	if (ct) return ct[1];
	const head = headBytes.toString("latin1").slice(0, 4000);
	const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /charset=([\w-]+)/i.exec(head);
	return m ? m[1] : "utf-8";
}

/** char → GBK 双字节反查表（惰性）。 */
let gbkEncodeMap = null;
function gbkBytes(ch) {
	if (!gbkEncodeMap) {
		gbkEncodeMap = new Map();
		let dec = null;
		try {
			dec = new TextDecoder("gbk", { fatal: false });
		} catch {
			/* 无 GBK 支持：退化成 UTF-8 字节 */
		}
		if (dec) {
			for (let b1 = 0x81; b1 <= 0xfe; b1++) {
				for (let b2 = 0x40; b2 <= 0xfe; b2++) {
					if (b2 === 0x7f) continue;
					const s = dec.decode(Uint8Array.of(b1, b2));
					if (s.length === 1 && s !== "\uFFFD" && !gbkEncodeMap.has(s)) gbkEncodeMap.set(s, [b1, b2]);
				}
			}
		}
	}
	return gbkEncodeMap.get(ch) ?? null;
}

/** 按 charset 把字符串编成字节（GBK 系走反查表；表里没有的字符退化成 UTF-8 字节）。 */
export function encodeText(text, charset) {
	const cs = normCharset(charset);
	if (isUtf8(cs)) return Buffer.from(text, "utf8");
	const out = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 128) {
			out.push(cp);
			continue;
		}
		const pair = gbkBytes(ch);
		if (pair) out.push(pair[0], pair[1]);
		else out.push(...Buffer.from(ch, "utf8"));
	}
	return Buffer.from(out);
}

/** 按 charset 把 URL 里的非 ASCII 字符转百分号编码（ASCII 段原样，避免二次编码）。 */
export function encodeUrlCharset(target, charset) {
	const cs = normCharset(charset);
	let raw;
	try {
		raw = decodeURIComponent(target);
	} catch {
		return target;
	}
	if (isUtf8(cs)) return raw;
	let out = "";
	for (const ch of raw) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 128) out += ch;
		else out += [...encodeText(ch, cs)].map((b) => "%" + b.toString(16).padStart(2, "0").toUpperCase()).join("");
	}
	return out;
}

// ---------------------------------------------------------------------------
// cookie jar（host → "k=v; k2=v2"，单用户自部署够用）
// ---------------------------------------------------------------------------

const jar = new Map();

export function jarClear() {
	jar.clear();
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** fetch 会拒绝的逐跳头。 */
const HOP_BY_HOP = /^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection)$/i;

/**
 * 抓一个书源站地址。
 * @param {object} req
 * @param {string} req.url 目标地址（http/https）
 * @param {string} [req.method]
 * @param {Record<string,string>} [req.headers] 书源声明的头（**不接受浏览器头**）
 * @param {string|Buffer} [req.body]
 * @param {string} [req.charset] 影响 URL 重编码与 body 编码
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{url:string,status:number,headers:Record<string,string>,body:string,bytes:number}>}
 */
export async function proxyFetch(req) {
	const targetRaw = String(req?.url ?? "");
	if (!targetRaw || !/^https?:\/\//i.test(targetRaw)) throw new Error("缺少合法 url（http(s)://…）");

	const charset = String(req?.charset ?? "");
	const target = encodeUrlCharset(targetRaw, charset);
	const headers = { "User-Agent": DEFAULT_UA, Accept: "text/html,application/json,*/*", ...(req?.headers ?? {}) };
	for (const k of Object.keys(headers)) {
		if (HOP_BY_HOP.test(k)) delete headers[k];
	}

	let jarHost = "";
	try {
		jarHost = new URL(target).host;
		const saved = jar.get(jarHost);
		if (saved && !headers.Cookie && !headers.cookie) headers.Cookie = saved;
	} catch {
		throw new Error(`非法的目标地址：${target}`);
	}

	let body;
	if (req?.body === undefined || req?.body === null) body = undefined;
	else if (Buffer.isBuffer(req.body)) body = req.body;
	else body = encodeText(String(req.body), charset);

	const resp = await fetch(target, {
		method: String(req?.method ?? "GET").toUpperCase(),
		headers,
		body,
		redirect: "follow",
		signal: AbortSignal.timeout(Number(req?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
	});
	const buf = Buffer.from(await resp.arrayBuffer());

	try {
		const setCookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
		if (jarHost && setCookies.length) {
			const pairs = setCookies.map((c) => String(c).split(";")[0]).filter(Boolean);
			if (pairs.length) {
				const prev = jar.get(jarHost);
				jar.set(jarHost, prev ? `${prev}; ${pairs.join("; ")}` : pairs.join("; "));
			}
		}
	} catch {
		/* jar 尽力而为 */
	}

	const contentType = resp.headers.get("content-type") ?? "";
	const outHeaders = {};
	resp.headers.forEach((v, k) => {
		outHeaders[k] = v;
	});
	return {
		url: resp.url || target,
		status: resp.status,
		headers: outHeaders,
		body: decodeBytes(buf, charset || detectCharset(contentType, buf.subarray(0, 4000))),
		bytes: buf.length,
	};
}

/** 把底层错误转成人话（带上 ENOTFOUND/超时等错误码，便于前端与 AI 区分「域名黑洞/被墙」与「站点拒绝」）。 */
export function describeFetchError(err) {
	const cause = err?.cause?.code ?? err?.cause?.message ?? "";
	const isTimeout = err?.name === "TimeoutError" || /timeout/i.test(String(cause));
	return `${isTimeout ? "连接超时" : String(err?.message ?? err)}${cause ? ` [${cause}]` : ""}`;
}
