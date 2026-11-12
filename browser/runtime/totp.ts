/**
 * TOTP（RFC 6238）纯逻辑：Base32 解码、HOTP/TOTP 计算、`otpauth://` 解析与校验。
 *
 * 这里只放**不碰 Electron / 不碰磁盘**的东西，便于单测。机密（secret）只在主进程里存在：
 * 渲染层拿到的一律是 `PublicTotpEntry`（`publicTotp` 投影，无 secret），要 6 位码就发
 * `totp.code { id }` 让主进程算——和 `provider headers 不下发浏览器` 同一条口径。
 */
import { createHmac, randomUUID } from "node:crypto";

export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

/** 一条 TOTP 记录（机密形态，只在主进程内出现；落盘时 secret 换成 `enc:`）。 */
export interface TotpEntry {
	id: string;
	/** 用户可改的展示名；默认取 `issuer:account`。 */
	label: string;
	issuer: string;
	account: string;
	/** Base32（大写、无空格无填充），机密。 */
	secret: string;
	algorithm: TotpAlgorithm;
	digits: number;
	period: number;
	/** 扫码时的页面 origin（`https://github.com`），用于按站点自动匹配；空串=不绑定。 */
	origin: string;
	createdAt: number;
	/** 排序权重，越小越靠前。 */
	order: number;
}

/** 发给渲染层的形态：与 `TotpEntry` 相比**没有 secret**。 */
export type PublicTotpEntry = Omit<TotpEntry, "secret">;

export interface TotpCode {
	code: string;
	/** 当前时间窗剩余毫秒。 */
	remainingMs: number;
	period: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULTS = { algorithm: "SHA1" as TotpAlgorithm, digits: 6, period: 30 };

/** Base32（RFC 4648，无填充要求）解码；大小写与空格/`-` 容错。 */
export function base32Decode(input: string): Buffer {
	const clean = String(input ?? "")
		.replace(/[\s-]/g, "")
		.replace(/=+$/g, "")
		.toUpperCase();
	if (!clean) throw new Error("TOTP secret is empty");
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of clean) {
		const value = BASE32_ALPHABET.indexOf(char);
		if (value < 0) throw new Error(`TOTP secret is not valid Base32 (bad character "${char}")`);
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	if (!bytes.length) throw new Error("TOTP secret is too short");
	return Buffer.from(bytes);
}

/** RFC 4226 HOTP：counter 个时间窗的第 N 个动态码。 */
export function hotp(secret: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm): string {
	const message = Buffer.alloc(8);
	// 计数器是 64 位大端；JS number 在 2^53 内精确，超出由 BigInt 兜住
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac(algorithm.toLowerCase(), secret).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	return String(binary % 10 ** digits).padStart(digits, "0");
}

/** 按当前时间算码（`now` 为毫秒时间戳，便于单测固定时间）。 */
export function totpCode(
	entry: Pick<TotpEntry, "secret" | "algorithm" | "digits" | "period">,
	now = Date.now(),
): TotpCode {
	const period = Math.max(1, Math.floor(entry.period || DEFAULTS.period));
	const digits = Math.min(10, Math.max(0, Math.floor(entry.digits || DEFAULTS.digits)));
	const elapsed = now % (period * 1000);
	return {
		code: hotp(base32Decode(entry.secret), Math.floor(now / 1000 / period), digits, entry.algorithm),
		remainingMs: period * 1000 - elapsed,
		period,
	};
}

function algorithm(value: unknown): TotpAlgorithm {
	const upper = String(value ?? DEFAULTS.algorithm)
		.trim()
		.toUpperCase();
	if (!(TOTP_ALGORITHMS as readonly string[]).includes(upper)) throw new Error(`Unsupported TOTP algorithm "${value}"`);
	return upper as TotpAlgorithm;
}

function digits(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULTS.digits;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 6 || parsed > 8) throw new Error("TOTP digits must be 6, 7 or 8");
	return parsed;
}

function period(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULTS.period;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) throw new Error("TOTP period must be 1..3600 seconds");
	return parsed;
}

function normalizeSecret(value: string): string {
	const clean = String(value ?? "")
		.replace(/[\s-]/g, "")
		.replace(/=+$/g, "")
		.toUpperCase();
	base32Decode(clean);
	return clean;
}

/** origin 只接受 http(s) 的 `scheme://host[:port]`，其他一律视为不绑定。 */
export function normalizeOrigin(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "";
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
}

export interface OtpauthDraft {
	issuer: string;
	account: string;
	secret: string;
	algorithm: TotpAlgorithm;
	digits: number;
	period: number;
	label: string;
}

/** 解析 `otpauth://totp/Issuer:account?...`（也接受整段扫码文本，前后空白/换行容错）。 */
export function parseOtpauth(value: unknown): OtpauthDraft {
	const raw = String(value ?? "").trim();
	if (!raw) throw new Error("Empty QR code");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("This is not an otpauth:// link");
	}
	if (url.protocol !== "otpauth:") throw new Error("This is not an otpauth:// link");
	const type = url.hostname.toLowerCase();
	if (type !== "totp") throw new Error("Only time-based (totp) codes are supported");
	const secret = normalizeSecret(url.searchParams.get("secret") ?? "");
	const label = decodeURIComponent(url.pathname.replace(/^\/+/, "")).trim();
	// 标签形如 `Issuer:account`；冒号可能被编码成 %3A，也可能整段只有 account
	const split = label.indexOf(":");
	const labelIssuer = split > 0 ? label.slice(0, split).trim() : "";
	const account = (split > 0 ? label.slice(split + 1) : label).trim();
	const issuer = (url.searchParams.get("issuer") ?? "").trim() || labelIssuer;
	return {
		issuer,
		account,
		secret,
		algorithm: algorithm(url.searchParams.get("algorithm")),
		digits: digits(url.searchParams.get("digits")),
		period: period(url.searchParams.get("period")),
		label: [issuer, account].filter(Boolean).join(": ") || issuer || account || "TOTP",
	};
}

/** 由扫码结果 / 手工 URI 建一条新记录。 */
export function createTotpEntry(
	uri: string,
	options: { origin?: string; order?: number; now?: number } = {},
): TotpEntry {
	const draft = parseOtpauth(uri);
	return {
		id: randomUUID(),
		label: draft.label,
		issuer: draft.issuer,
		account: draft.account,
		secret: draft.secret,
		algorithm: draft.algorithm,
		digits: draft.digits,
		period: draft.period,
		origin: normalizeOrigin(options.origin),
		createdAt: options.now ?? Date.now(),
		order: options.order ?? 0,
	};
}

/** 校验并归一化（磁盘数据、IPC 入参都过这里）。 */
export function normalizeTotpEntry(value: unknown): TotpEntry {
	if (!value || typeof value !== "object") throw new Error("Invalid TOTP entry");
	const item = value as Record<string, unknown>;
	const secret = normalizeSecret(typeof item.secret === "string" ? item.secret : "");
	const issuer = typeof item.issuer === "string" ? item.issuer.trim() : "";
	const account = typeof item.account === "string" ? item.account.trim() : "";
	return {
		id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
		label:
			(typeof item.label === "string" ? item.label.trim() : "") ||
			[issuer, account].filter(Boolean).join(": ") ||
			"TOTP",
		issuer,
		account,
		secret,
		algorithm: algorithm(item.algorithm),
		digits: digits(item.digits),
		period: period(item.period),
		origin: normalizeOrigin(item.origin),
		createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now(),
		order: Number.isFinite(item.order) ? Number(item.order) : 0,
	};
}

export function normalizeTotpEntries(value: unknown): TotpEntry[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("Invalid TOTP data");
	const entries = value.map(normalizeTotpEntry);
	// 按 order 稳定排序，order 相同的保持写入顺序
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
		.map(({ entry }) => entry);
}

/** 投影成不含机密的形态（发给渲染层 / 日志）。 */
export function publicTotp(entry: TotpEntry): PublicTotpEntry {
	const { secret: _secret, ...rest } = entry;
	return rest;
}

export function sortTotpEntries(entries: TotpEntry[]): TotpEntry[] {
	return entries
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((entry, order) => (entry.order === order ? entry : { ...entry, order }));
}

/** 按 id 顺序重排（面板上移/下移、拖动排序都走这里）。 */
export function reorderTotpEntries(entries: TotpEntry[], ids: unknown): TotpEntry[] {
	const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const next: TotpEntry[] = [];
	for (const id of wanted) {
		const entry = byId.get(id);
		if (!entry) continue;
		next.push(entry);
		byId.delete(id);
	}
	// 未列出的（别的窗口刚加的）排在后面，不丢数据
	for (const entry of sortTotpEntries([...byId.values()])) next.push(entry);
	return next.map((entry, order) => (entry.order === order ? entry : { ...entry, order }));
}

/** 该记录是否绑定到当前页面 origin。 */
export function totpMatchesUrl(entry: Pick<TotpEntry, "origin">, url: string): boolean {
	if (!entry.origin) return false;
	return normalizeOrigin(url) === entry.origin;
}

/** 导出成 otpauth:// URI（面板的「导出 / 迁移」用，唯一会带出 secret 的出口）。 */
export function toOtpauthUri(entry: TotpEntry): string {
	const label = [entry.issuer, entry.account].filter(Boolean).join(":");
	const url = new URL(`otpauth://totp/${encodeURIComponent(label || entry.label)}`);
	url.searchParams.set("secret", entry.secret);
	if (entry.issuer) url.searchParams.set("issuer", entry.issuer);
	if (entry.algorithm !== DEFAULTS.algorithm) url.searchParams.set("algorithm", entry.algorithm);
	if (entry.digits !== DEFAULTS.digits) url.searchParams.set("digits", String(entry.digits));
	if (entry.period !== DEFAULTS.period) url.searchParams.set("period", String(entry.period));
	return url.toString();
}
