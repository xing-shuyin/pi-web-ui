import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

export type LookupAddress = { address: string; family?: number };
export type LookupAllFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookupAll: LookupAllFn = async (hostname: string) => {
	return await dnsLookup(hostname, { all: true, verbatim: true });
};

function parseIpv4Octets(input: string): [number, number, number, number] | null {
	const m = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const a = Number(m[1]);
	const b = Number(m[2]);
	const c = Number(m[3]);
	const d = Number(m[4]);
	if (a > 255 || b > 255 || c > 255 || d > 255) return null;
	return [a, b, c, d];
}

function isBlockedIpv4Octets([a, b]: [number, number, number, number]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

function expandIpv6Words(rawInput: string): number[] | null {
	const input = rawInput.split("%")[0].toLowerCase();
	if (!input.includes(":")) return null;

	let working = input;
	const lastColon = working.lastIndexOf(":");
	const tail = working.slice(lastColon + 1);
	if (tail.includes(".")) {
		const octets = parseIpv4Octets(tail);
		if (!octets) return null;
		const hi = ((octets[0] << 8) | octets[1]).toString(16);
		const lo = ((octets[2] << 8) | octets[3]).toString(16);
		working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const doubleColonParts = working.split("::");
	if (doubleColonParts.length > 2) return null;

	const parseSide = (side: string): number[] | null => {
		if (!side) return [];
		const parts = side.split(":");
		const words: number[] = [];
		for (const p of parts) {
			if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
			words.push(parseInt(p, 16));
		}
		return words;
	};

	if (doubleColonParts.length === 2) {
		const left = parseSide(doubleColonParts[0]);
		const right = parseSide(doubleColonParts[1]);
		if (!left || !right) return null;
		const missing = 8 - (left.length + right.length);
		if (missing < 1) return null;
		return [...left, ...new Array(missing).fill(0), ...right];
	}

	const full = parseSide(working);
	if (!full || full.length !== 8) return null;
	return full;
}

function extractEmbeddedIpv4(w: number[]): [number, number, number, number] | null {
	const isMapped = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff;
	const isTranslated = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0;
	const isCompatible =
		w[0] === 0 &&
		w[1] === 0 &&
		w[2] === 0 &&
		w[3] === 0 &&
		w[4] === 0 &&
		w[5] === 0 &&
		!(w[6] === 0 && (w[7] === 0 || w[7] === 1));
	const isNat64 = w[0] === 0x0064 && w[1] === 0xff9b && w[3] === 0 && w[4] === 0 && w[5] === 0;

	if (isMapped || isTranslated || isCompatible || isNat64) {
		return [(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff];
	}
	return null;
}

export function isBlockedHost(hostname: string): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}

	if (host.includes(":")) {
		const words = expandIpv6Words(host);
		if (!words) return true;
		const embeddedV4 = extractEmbeddedIpv4(words);
		if (embeddedV4) {
			return isBlockedIpv4Octets(embeddedV4);
		}
		const allZeroPrefix =
			words[0] === 0 &&
			words[1] === 0 &&
			words[2] === 0 &&
			words[3] === 0 &&
			words[4] === 0 &&
			words[5] === 0 &&
			words[6] === 0;
		if (allZeroPrefix && (words[7] === 0 || words[7] === 1)) return true;
		if ((words[0] & 0xffc0) === 0xfe80) return true;
		if ((words[0] & 0xfe00) === 0xfc00) return true;
		if ((words[0] & 0xff00) === 0xff00) return true;
		if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
		return false;
	}

	const v4 = parseIpv4Octets(host);
	if (v4) {
		return isBlockedIpv4Octets(v4);
	}

	if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(host)) {
		return true;
	}

	return false;
}

export function validateFetchUrl(raw: string): { ok: true; url: string } | { ok: false; reason: "scheme" | "host" } {
	let u: URL;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return { ok: false, reason: "scheme" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
	if (isBlockedHost(u.hostname)) return { ok: false, reason: "host" };
	return { ok: true, url: u.toString() };
}

export async function resolveAndValidateUrl(
	raw: string,
	opts: { lookup?: LookupAllFn } = {},
): Promise<{ ok: true; url: string; addresses: string[] } | { ok: false; reason: "scheme" | "host" }> {
	const sync = validateFetchUrl(raw);
	if (!sync.ok) return sync;

	const u = new URL(sync.url);
	const bareHost = u.hostname.replace(/^\[|\]$/g, "");
	if (isIP(bareHost) !== 0) {
		return { ok: true, url: sync.url, addresses: [bareHost] };
	}

	const lookupFn = opts.lookup ?? defaultLookupAll;
	try {
		const records = await lookupFn(bareHost);
		if (!Array.isArray(records) || records.length === 0) {
			return { ok: false, reason: "host" };
		}
		const addresses: string[] = [];
		for (const rec of records) {
			const addr = typeof rec?.address === "string" ? rec.address.trim() : "";
			if (!isIP(addr) || isBlockedHost(addr)) {
				return { ok: false, reason: "host" };
			}
			addresses.push(addr);
		}
		return { ok: true, url: sync.url, addresses };
	} catch {
		return { ok: false, reason: "host" };
	}
}

export interface SafeFetchOptions {
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
	lookup?: LookupAllFn;
	skipDnsLookup?: boolean;
	timeoutMs?: number;
	maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class FetchUrlError extends Error {
	constructor(
		public readonly reason: "scheme" | "host",
		url: string,
	) {
		super(reason === "scheme" ? `Blocked URL scheme: ${url}` : `Blocked private or internal host: ${url}`);
	}
}

export function readBeforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

async function resolveWithoutDns(raw: string): ReturnType<typeof resolveAndValidateUrl> {
	const check = validateFetchUrl(raw);
	return check.ok ? { ...check, addresses: [] } : check;
}

async function pinnedFetch(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
	const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
	const connect = buildConnector({
		lookup: (_host, options, callback) => {
			const family = typeof options === "number" ? options : options.family;
			const records = addresses
				.map((address) => ({ address, family: isIP(address) }))
				.filter((record) => !family || record.family === Number(family));
			if (!records.length) return callback(new Error("No validated address for requested family"), "", 0);
			if (typeof options === "object" && options.all) callback(null, records);
			else callback(null, records[0].address, records[0].family);
		},
	});
	const dispatcher = new Agent({
		connect: (options, callback) => {
			if (options.hostname.replace(/^\[|\]$/g, "") !== hostname) {
				callback(new Error("Unexpected connection hostname"), null);
				return;
			}
			connect(options, callback);
		},
	});
	const signal = init.signal!;
	const destroy = () => {
		void dispatcher.destroy().catch(() => {});
	};
	signal.addEventListener("abort", destroy, { once: true });
	try {
		signal.throwIfAborted();
		const headers = new Headers(init.headers);
		headers.delete("host");
		const response = await undiciFetch(url, {
			...init,
			headers: Array.from(headers.entries()),
			dispatcher,
		} as unknown as Parameters<typeof undiciFetch>[1]);
		void dispatcher
			.close()
			.catch(() => dispatcher.destroy())
			.catch(() => {})
			.finally(() => {
				signal.removeEventListener("abort", destroy);
			});
		return response as unknown as Response;
	} catch (error) {
		signal.removeEventListener("abort", destroy);
		await dispatcher.destroy().catch(() => {});
		throw error;
	}
}

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
	const useDns = !opts.fetcher || !!opts.lookup || opts.skipDnsLookup === false;
	const deadline = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
	const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
	const maxRedirects = opts.maxRedirects ?? 5;

	let currentUrl = url;
	let currentInit: RequestInit = { ...init, signal, redirect: "manual" };

	for (let hop = 0; hop <= maxRedirects; hop++) {
		signal.throwIfAborted();
		const check = useDns
			? await readBeforeAbort(resolveAndValidateUrl(currentUrl, { lookup: opts.lookup }), signal)
			: await resolveWithoutDns(currentUrl);
		if (!check.ok) throw new FetchUrlError(check.reason, currentUrl);
		currentUrl = check.url;

		const res = opts.fetcher
			? await readBeforeAbort(opts.fetcher(currentUrl, currentInit), signal)
			: await pinnedFetch(currentUrl, currentInit, check.addresses);
		if (!REDIRECT_STATUSES.has(res.status)) {
			return res;
		}

		const location = res.headers?.get?.("location");
		if (!location) {
			return res;
		}
		if (res.body) await readBeforeAbort(res.body.getReader().cancel(), signal);
		if (hop === maxRedirects) {
			throw new Error(`Too many redirects (> ${maxRedirects})`);
		}

		let nextUrl: string;
		try {
			nextUrl = new URL(location, currentUrl).toString();
		} catch {
			throw new FetchUrlError("scheme", location);
		}
		if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
			const headers = new Headers(currentInit.headers);
			for (const name of ["authorization", "cookie", "proxy-authorization", "host"]) headers.delete(name);
			currentInit = { ...currentInit, headers };
		}
		if (
			res.status === 303 ||
			((res.status === 301 || res.status === 302) && currentInit.method?.toUpperCase() === "POST")
		) {
			const headers = new Headers(currentInit.headers);
			headers.delete("content-length");
			headers.delete("content-type");
			currentInit = {
				...currentInit,
				method: currentInit.method?.toUpperCase() === "HEAD" ? "HEAD" : "GET",
				body: undefined,
				headers,
			};
		}
		currentUrl = nextUrl;
	}

	throw new Error(`Too many redirects (> ${maxRedirects})`);
}
