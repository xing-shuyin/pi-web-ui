import type { FetchOptions } from "../types";
import { apiBase } from "./apiBase";

export interface ProxyResponse {
	url: string;
	body: string;
	headers: Record<string, string>;
	status: number;
	/** 本次是否走了本机真浏览器抓取 */
	viaBrowser?: boolean;
	/** 直连命中站点盾页（且未成功走浏览器回退） */
	challenge?: boolean;
	browserError?: string;
}

export type ProxyTransport = (target: string, opts: FetchOptions) => Promise<ProxyResponse>;

export type SyncProxyTransport = (
	target: string,
	method: string,
	headers: Record<string, string>,
	body?: string,
) => string;

let injected: ProxyTransport | null = null;
let injectedSync: SyncProxyTransport | null = null;

export function setProxyTransport(t: ProxyTransport | null): void {
	injected = t;
}

export function getProxyTransport(): ProxyTransport | null {
	return injected;
}

export function setSyncTransport(t: SyncProxyTransport | null): void {
	injectedSync = t;
}

export function getSyncTransport(): SyncProxyTransport | null {
	return injectedSync;
}

export function buildProxyUrl(target: string, charset?: string, browser?: boolean): string {
	const prefix = `${apiBase()}/proxy`;
	const cs = charset?.trim();
	return `${prefix}?url=${encodeURIComponent(target)}${cs ? `&charset=${encodeURIComponent(cs)}` : ""}${browser ? "&browser=1" : ""}`;
}

export async function fetchText(target: string, opts: FetchOptions = {}): Promise<ProxyResponse> {
	if (injected) return injected(target, opts);
	const res = await fetch(buildProxyUrl(target, opts.charset, opts.browser), {
		method: opts.method ?? "GET",
		headers: {
			"Content-Type": "application/json",
			...(opts.headers ?? {}),
		},
		body:
			opts.method && opts.method.toUpperCase() !== "GET"
				? JSON.stringify({
						headers: opts.headers ?? {},
						body: opts.body ?? "",
						charset: opts.charset ?? "",
						browser: opts.browser ?? false,
					})
					: undefined,
	});
	if (!res.ok) {
		let detail = "";
		try {
			const j = (await res.json()) as { error?: string };
			if (j?.error) detail = j.error;
		} catch {}
		throw new Error(`代理请求失败 ${res.status}${detail ? `（${detail}）` : ""} ${target}`);
	}
	const data = (await res.json()) as ProxyResponse;
	return data;
}

export function parseHeader(header?: string): Record<string, string> {
	if (!header) return {};
	try {
		const o = JSON.parse(header) as Record<string, string>;
		return o && typeof o === "object" ? o : {};
	} catch {
		return {};
	}
}
