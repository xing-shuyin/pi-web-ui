import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		// 文件本身可能合法地包含 U+FFFD（如该书源合集里的占位符），不能一见 FFFD 就整包按 GBK 重解
		// （UTF-8 中文按 GBK 解会产生 \ 或 " 等字符，直接破坏 JSON 结构导致解析失败）。
		// 只有当 buffer 不是合法 UTF-8 时才回退到 GBK。
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(buf);
			return s;
		} catch {
			// 非法 UTF-8 序列：按 GBK 解（老行为，兼容 GBK 书源站）
		}
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

// ---- 可选真浏览器抓取（Chrome 仅检测、不捆绑；没装就不启用） ----

const CHROME_ENV_VAR = "LEGADO_CHROME_PATH";
const BROWSER_MAX_BYTES = 8 * 1024 * 1024;
const BROWSER_TIMEOUT_MS = 30_000;

let chromeCache = null;

/** 按平台列出候选浏览器路径（纯函数，方便单测）。 */
export function chromeCandidates(platform = process.platform, env = process.env) {
	const fromEnv = String(env?.[CHROME_ENV_VAR] ?? "").trim();
	const paths = fromEnv ? [fromEnv] : [];
	const whichNames = [];
	if (platform === "win32") {
		const bases = [env?.ProgramFiles, env?.["ProgramFiles(x86)"], env?.LOCALAPPDATA].filter(Boolean);
		for (const base of bases) {
			paths.push(
				join(base, "Google/Chrome/Application/chrome.exe"),
				join(base, "Microsoft/Edge/Application/msedge.exe"),
				join(base, "BraveSoftware/Brave-Browser/Application/brave.exe"),
				join(base, "Vivaldi/Application/vivaldi.exe"),
			);
		}
		whichNames.push("chrome.exe", "msedge.exe");
	} else if (platform === "darwin") {
		paths.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
		);
		whichNames.push("google-chrome", "chromium", "chromium-browser", "microsoft-edge");
	} else {
		whichNames.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge");
	}
	return { paths, whichNames };
}

function execFileAsync(file, args, opts) {
	return new Promise((resolve, reject) => {
		execFile(file, args, opts, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stdout, stderr }));
			else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** 探测本机 Chrome/Chromium（带缓存）。 @returns {Promise<{found:boolean,path:string|null}>} */
export async function findChrome({ rescan = false } = {}) {
	if (chromeCache && !rescan) return chromeCache;
	const { paths, whichNames } = chromeCandidates();
	for (const p of paths) {
		try {
			if (p && existsSync(p)) {
				chromeCache = { found: true, path: p };
				return chromeCache;
			}
		} catch {}
	}
	const lookup = process.platform === "win32" ? "where" : "which";
	for (const name of whichNames) {
		try {
			const { stdout } = await execFileAsync(lookup, [name], { timeout: 8000 });
			const hit = stdout
				.split(/\r?\n/)
				.map((s) => s.trim())
				.find((s) => s && existsSync(s));
			if (hit) {
				chromeCache = { found: true, path: hit };
				return chromeCache;
			}
		} catch {}
	}
	chromeCache = { found: false, path: null };
	return chromeCache;
}

/** 盾页特征（服务端指纹/行为风控，直接换头也过不去的那种）。 */
export function isChallengePage(status, body) {
	if (status !== 403 && status !== 503) return false;
	const s = String(body ?? "").slice(0, 20_000);
	return (
		s.includes("Just a moment") ||
		s.includes("challenges.cloudflare.com") ||
		s.includes("challenge_required") ||
		s.includes("__gatekeeper_challenge") ||
		s.includes("人人书云CDN") ||
		/人机验证|安全验证|访问验证/.test(s)
	);
}

/**
 * 用本机真浏览器（headless --dump-dom）抓一页，返回渲染后 HTML。
 * 需要本机装有 Chrome/Edge 等 Chromium 内核浏览器；没装则抛错（调用方负责降级）。
 */
export async function fetchViaBrowser({ url, chromePath, timeoutMs = BROWSER_TIMEOUT_MS } = {}) {
	const target = String(url ?? "");
	if (!/^https?:\/\//i.test(target)) throw new Error(`缺少合法 url（http(s)://…）`);
	let hostname = "";
	try {
		hostname = new URL(target).hostname;
	} catch {
		throw new Error(`非法的目标地址：${target}`);
	}
	if (await resolveTargetPrivate(hostname)) {
		throw new Error(`拒绝抓取内网/回环地址：${hostname}`);
	}
	const chrome = chromePath ?? (await findChrome()).path;
	if (!chrome) throw new Error("未检测到本机 Chrome/Chromium，浏览器抓取不可用（装一个即可用，无需配置）");
	const profile = mkdtempSync(join(tmpdir(), "legado-chrome-"));
	try {
		const args = [
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${profile}`,
			"--virtual-time-budget=12000",
			`--timeout=${Math.max(5000, Math.min(Number(timeoutMs) || BROWSER_TIMEOUT_MS, 120_000))}`,
			"--dump-dom",
			target,
		];
		if (String(process.env.LEGADO_CHROME_NO_SANDBOX ?? "").trim() === "1") args.push("--no-sandbox");
		const { stdout } = await execFileAsync(chrome, args, {
			timeout: (Number(timeoutMs) || BROWSER_TIMEOUT_MS) + 10_000,
			maxBuffer: BROWSER_MAX_BYTES,
		});
		const html = String(stdout ?? "");
		if (!html.trim()) throw new Error("浏览器抓取返回空页面（可能仍被站点拦截）");
		if (isChallengePage(200, html) || isChallengePage(403, html) || isChallengePage(503, html)) {
			throw new Error("真浏览器仍被站点盾拦截（需人工过验证或换源）");
		}
		return { url: target, status: 200, headers: {}, body: html, bytes: Buffer.byteLength(html), viaBrowser: true };
	} finally {
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {}
	}
}

/**
 * 抓一个书源站地址。
 * @param {object} req
 * @param {string} req.url 目标地址（http/https）
 * @param {string} [req.method]
 * @param {Record<string,string>} [req.headers] 书源声明的头（**不接受浏览器头**）
 * @param {string|Buffer} [req.body]
 * @param {string} [req.charset] 影响 URL 重编码与 body 编码
 * @param {boolean} [req.browser] 命中盾页时是否回退到本机真浏览器抓取（需书源开启 allowBrowser）
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
	const out = {
		url: currentUrl || resp.url || target,
		status: resp.status,
		headers: outHeaders,
		body: decodeBytes(buf, charset || detectCharset(contentType, buf.subarray(0, 4000))),
		bytes: buf.length,
	};
	// 盾页 + 书源开了浏览器抓取 + 本机有 Chrome → 用真浏览器重抓一次
	if (req?.browser && isChallengePage(out.status, out.body)) {
		const chrome = await findChrome();
		if (!chrome.found) {
			out.challenge = true;
			return out;
		}
		try {
			return await fetchViaBrowser({ url: out.url, chromePath: chrome.path, timeoutMs: req?.timeoutMs });
		} catch (err) {
			out.challenge = true;
			out.browserError = describeFetchError(err);
			return out;
		}
	}
	return out;
}

export function describeFetchError(err) {
	const cause = err?.cause?.code ?? err?.cause?.message ?? "";
	const isTimeout = err?.name === "TimeoutError" || /timeout/i.test(String(cause));
	return `${isTimeout ? "连接超时" : String(err?.message ?? err)}${cause ? ` [${cause}]` : ""}`;
}
