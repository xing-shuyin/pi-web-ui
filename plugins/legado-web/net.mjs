export const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

export function normCharset(raw) {
	return String(raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
}

function isUtf8(cs) {
	return !cs || cs === "utf-8" || cs === "utf8";
}

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

export function detectCharset(contentType, headBytes) {
	const ct = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
	if (ct) return ct[1];
	const head = headBytes.toString("latin1").slice(0, 4000);
	const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /charset=([\w-]+)/i.exec(head);
	return m ? m[1] : "utf-8";
}

let gbkEncodeMap = null;
function gbkBytes(ch) {
	if (!gbkEncodeMap) {
		gbkEncodeMap = new Map();
		let dec = null;
		try {
			dec = new TextDecoder("gbk", { fatal: false });
		} catch {}
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

const jar = new Map();

export function jarClear() {
	jar.clear();
}

function ipv4Bytes(hostname) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!m) return null;
	const b = m.slice(1).map(Number);
	if (b.some((v) => v > 255)) return null;
	return b;
}

export function isPrivateHost(hostname) {
	const h = String(hostname ?? "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (!h) return true;
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	const v4 = ipv4Bytes(h);
	if (v4) {
		const [a, b] = v4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a >= 224 && a <= 255)
		);
	}
	if (h.includes(":")) {
		if (h === "::" || h === "::1") return true;
		const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
		if (mapped) return isPrivateHost(mapped[1]);
		if (/^f[ce][0-9a-f]{2}:/.test(h)) return true;
		return false;
	}
	return false;
}

function allowedPrivateHosts() {
	return new Set(
		String(process.env.LEGADO_ALLOW_PRIVATE_HOSTS ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

async function resolveTargetPrivate(hostname) {
	const allowed = allowedPrivateHosts();
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (allowed.has(bare)) return false;
	if (isPrivateHost(bare)) return true;
	const isIpLiteral = ipv4Bytes(bare) !== null || bare.includes(":");
	if (isIpLiteral) return false;
	try {
		const { lookup } = await import("node:dns/promises");
		const res = await lookup(bare, { all: true });
		if (!res || res.length === 0) return true;
		return res.some((r) => isPrivateHost(r.address));
	} catch {
		return true;
	}
}

const HOP_BY_HOP = /^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection)$/i;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

	const MAX_REDIRECTS = 5;
	let currentUrl = target;
	let resp;
	for (let hop = 0; ; hop++) {
		let hostname;
		try {
			hostname = new URL(currentUrl).hostname;
		} catch {
			throw new Error(`非法的目标地址：${currentUrl}`);
		}
		if (await resolveTargetPrivate(hostname)) {
			throw new Error(`拒绝抓取内网/回环地址：${hostname}（如为本机自建书源站，可用 LEGADO_ALLOW_PRIVATE_HOSTS 放行）`);
		}
		resp = await fetch(currentUrl, {
			method: String(req?.method ?? "GET").toUpperCase(),
			headers,
			body: hop === 0 ? body : undefined,
			signal: AbortSignal.timeout(Number(req?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
			redirect: "manual",
		});
		if (resp.status < 300 || resp.status >= 400 || !REDIRECT_STATUSES.has(resp.status)) break;
		const location = resp.headers.get("location");
		if (!location) break;
		let next;
		try {
			next = new URL(location, currentUrl);
		} catch {
			throw new Error(`重定向地址非法：${location}`);
		}
		if (!/^https?:$/i.test(next.protocol)) throw new Error(`重定向到不支持的协议：${next.protocol}`);
		if (hop >= MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳，已中止`);
		currentUrl = next.href;
	}
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
	} catch {}

	const contentType = resp.headers.get("content-type") ?? "";
	const outHeaders = {};
	resp.headers.forEach((v, k) => {
		outHeaders[k] = v;
	});
	return {
		url: currentUrl || resp.url || target,
		status: resp.status,
		headers: outHeaders,
		body: decodeBytes(buf, charset || detectCharset(contentType, buf.subarray(0, 4000))),
		bytes: buf.length,
	};
}

export function describeFetchError(err) {
	const cause = err?.cause?.code ?? err?.cause?.message ?? "";
	const isTimeout = err?.name === "TimeoutError" || /timeout/i.test(String(cause));
	return `${isTimeout ? "连接超时" : String(err?.message ?? err)}${cause ? ` [${cause}]` : ""}`;
}
