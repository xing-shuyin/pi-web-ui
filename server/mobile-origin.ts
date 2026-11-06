import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";

/** Origins of bundled Capacitor assets; never accept a wildcard or a null origin. */
const MOBILE_ORIGINS = new Set(["capacitor://localhost", "https://localhost"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HEADERS = new Set(["authorization", "content-type", "x-pi-token", "x-requested-with"]);

type MobileRequest = Pick<IncomingMessage, "headers" | "url">;
export interface MobileOriginOptions {
	tokenConfigured: () => boolean;
	/** Receives only explicit credentials: cookies must never authorize a mobile request. */
	authorize: (request: MobileRequest) => boolean;
}

export function isMobileOrigin(origin: unknown): origin is string {
	return typeof origin === "string" && MOBILE_ORIGINS.has(origin);
}

function explicitCredentials(request: MobileRequest): MobileRequest {
	return {
		url: request.url,
		headers: {
			authorization: request.headers.authorization,
			"x-pi-token": request.headers["x-pi-token"],
		},
	};
}

/** Used in addition to the normal Host admission and WebSocket token checks. */
export function mobileOriginAuthorized(request: MobileRequest, options: MobileOriginOptions): boolean {
	return (
		isMobileOrigin(request.headers.origin) &&
		options.tokenConfigured() &&
		options.authorize(explicitCredentials(request))
	);
}

/**
 * Native clients use bundled assets and authenticate every remote request.
 * Preflight admits only the fixed app origins; actual requests still require a
 * configured server token. Browser same-origin and existing allowlists are untouched.
 */
export function mobileCors(options: MobileOriginOptions): RequestHandler {
	return (request, response, next) => {
		const origin = request.headers.origin;
		if (!isMobileOrigin(origin)) {
			next();
			return;
		}
		response.vary("Origin");
		response.setHeader("Access-Control-Allow-Origin", origin);
		response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
		let pathname: string;
		try {
			pathname = new URL(request.url, "http://localhost").pathname;
		} catch {
			response.status(400).end("invalid request URL");
			return;
		}
		if (pathname === "/setup" || pathname === "/api/setup" || pathname.startsWith("/api/setup/")) {
			response.status(403).end("setup requires a local browser");
			return;
		}
		if (!options.tokenConfigured()) {
			response.status(403).json({ error: "Configure a server access token before connecting the mobile app." });
			return;
		}
		if (request.method === "OPTIONS") {
			const requestedMethod = request.headers["access-control-request-method"];
			const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
				.split(",")
				.map((header) => header.trim().toLowerCase())
				.filter(Boolean);
			if (
				typeof requestedMethod !== "string" ||
				!METHODS.has(requestedMethod) ||
				requestedHeaders.some((header) => !HEADERS.has(header))
			) {
				response.status(403).end("mobile preflight not allowed");
				return;
			}
			response.vary("Access-Control-Request-Headers");
			response.setHeader("Access-Control-Allow-Methods", [...METHODS].join(", "));
			response.setHeader("Access-Control-Allow-Headers", [...HEADERS].join(", "));
			response.setHeader("Access-Control-Max-Age", "600");
			response.status(204).end();
			return;
		}
		if (!mobileOriginAuthorized(request, options)) {
			response.status(401).json({ error: "An explicit server access token is required." });
			return;
		}
		next();
	};
}
