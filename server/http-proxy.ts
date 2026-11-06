/**
 * server/http-proxy.ts
 *
 * Propagates HTTP proxy settings from ~/.pi/agent/settings.json and environment
 * variables (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) to process.env and sets up
 * undici's global dispatcher with EnvHttpProxyAgent, ensuring that Node's
 * native fetch() and SDK HTTP calls route through the configured proxy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type * as UndiciType from "undici";
import { request as proxyRequest, type IncomingMessage } from "node:http";
import type express from "express";

export type ProxyHit = { prefix: string; pluginId: string; host: string; port: number };

export function proxyForwardPath(hit: ProxyHit, url: string): string {
	let fwd = String(url ?? "/").slice(hit.prefix.length);
	if (!fwd.startsWith("/")) fwd = `/${fwd}`;
	return fwd || "/";
}

export function proxyHttp(hit: ProxyHit, req: express.Request, res: express.Response): void {
	if (hit.pluginId === "live-preview" && req.path === hit.prefix) {
		res.redirect(302, `${hit.prefix}/${req.url.slice(req.path.length)}`);
		return;
	}
	const fwdPath = proxyForwardPath(hit, req.url ?? "/");
	const headers: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		if (k.toLowerCase() === "host") continue;
		if (hit.pluginId === "live-preview" && ["cookie", "authorization", "x-pi-token"].includes(k.toLowerCase()))
			continue;
		if (k.toLowerCase() === "content-length" && req.method !== "GET" && req.method !== "HEAD") continue;
		headers[k] = v as string | string[];
	}
	headers["x-pi-proxy-prefix"] = hit.prefix;
	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
		const b = req.body;
		if (Buffer.isBuffer(b)) body = b;
		else if (typeof b === "string") body = Buffer.from(b);
		else if (b !== undefined) {
			body = Buffer.from(JSON.stringify(b));
			if (!headers["content-type"]) headers["content-type"] = "application/json";
		}
		if (body) headers["content-length"] = String(body.length);
	}
	let upstream: IncomingMessage | undefined;
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		upstream?.destroy();
		up.destroy();
	};
	const cleanup = () => {
		req.off("aborted", onAborted);
		req.off("error", onRequestError);
		res.off("close", onClose);
		res.off("error", onResponseError);
		res.off("finish", cleanup);
	};
	const onAborted = () => {
		cancel();
		res.destroy();
		cleanup();
	};
	const onRequestError = () => onAborted();
	const onResponseError = () => {
		cancel();
		cleanup();
	};
	const onClose = () => {
		if (!res.writableFinished) cancel();
		cleanup();
	};
	const fail = () => {
		cancel();
		if (res.destroyed || res.writableEnded) return;
		if (!res.headersSent) res.status(502).end("proxy target unreachable");
		else res.destroy();
	};
	const up = proxyRequest(
		{ host: hit.host, port: hit.port, method: req.method, path: fwdPath, headers, timeout: 30000 },
		(upRes) => {
			upstream = upRes;
			upRes.on("aborted", fail);
			upRes.on("error", fail);
			upRes.on("close", () => {
				if (!upRes.complete) fail();
			});
			if (cancelled || res.destroyed) {
				upRes.destroy();
				return;
			}
			const out: Record<string, string | string[]> = {};
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (v === undefined) continue;
				const lk = k.toLowerCase();
				if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "upgrade") continue;
				out[k] = v as string | string[];
			}
			res.writeHead(upRes.statusCode ?? 502, out);
			upRes.pipe(res);
		},
	);
	up.on("timeout", () => up.destroy(new Error("proxy timeout")));
	up.on("error", fail);
	req.on("aborted", onAborted);
	req.on("error", onRequestError);
	res.on("close", onClose);
	res.on("error", onResponseError);
	res.on("finish", cleanup);
	if (req.aborted || res.destroyed) onAborted();
	else if (body) up.end(body);
	else req.pipe(up);
}

export interface ProxyConfig {
	httpProxy?: string;
	envHttpProxy?: string;
	envHttpsProxy?: string;
	envAllProxy?: string;
}

export function resolveProxySettings(agentDir: string): ProxyConfig {
	let httpProxy: string | undefined;
	const settingsPath = join(agentDir, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { httpProxy?: unknown };
			if (typeof parsed.httpProxy === "string" && parsed.httpProxy.trim()) {
				httpProxy = parsed.httpProxy.trim();
			}
		} catch {}
	}

	return {
		httpProxy,
		envHttpProxy: process.env.HTTP_PROXY,
		envHttpsProxy: process.env.HTTPS_PROXY,
		envAllProxy: process.env.ALL_PROXY,
	};
}

/**
 * Initialize HTTP proxy support:
 * 1. If httpProxy is present in settings.json and env is not set, populate HTTP_PROXY and HTTPS_PROXY.
 * 2. If any proxy is configured (settings or env), set up undici's global dispatcher with EnvHttpProxyAgent
 *    so that global fetch() uses the proxy.
 */
export function initHttpProxy(agentDir: string): { active: boolean; proxyUrl?: string } {
	const config = resolveProxySettings(agentDir);

	if (config.httpProxy) {
		process.env.HTTP_PROXY ??= config.httpProxy;
		process.env.HTTPS_PROXY ??= config.httpProxy;
	}

	const effectiveProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
	if (!effectiveProxy) {
		return { active: false };
	}

	try {
		let undici: typeof UndiciType;
		try {
			undici = createRequire(import.meta.url)("undici") as typeof UndiciType;
		} catch (err) {
			console.warn("[proxy] undici not installed, HTTP proxy support disabled:", err);
			return { active: false, proxyUrl: effectiveProxy };
		}
		const dispatcher = withUndiciErrorListener(
			new undici.EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: 300_000,
				headersTimeout: 300_000,
			}),
		);
		undici.setGlobalDispatcher(dispatcher);
		undici.install?.();
		return { active: true, proxyUrl: effectiveProxy };
	} catch (err) {
		console.warn("[proxy] Failed to configure global undici proxy dispatcher:", err);
		return { active: false, proxyUrl: effectiveProxy };
	}
}

function withUndiciErrorListener(dispatcher: unknown): UndiciType.Dispatcher {
	if (dispatcher instanceof EventEmitter) {
		dispatcher.on("error", () => {});
	}
	return dispatcher as UndiciType.Dispatcher;
}
