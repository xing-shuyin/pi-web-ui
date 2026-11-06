import type { Express, Request } from "express";
import { hostWithoutPort, isLoopbackHost } from "./host-guard.js";
import { isLoopbackAddress } from "./server-config.js";
import { captureWindowsScreenshot } from "./system-screenshot-windows.js";

type Capture = (token: string, locale: "zh" | "en", signal: AbortSignal, hideWindow: boolean) => Promise<string | null>;

export function isLocalScreenshotRequest(req: Pick<Request, "headers" | "socket">): boolean {
	if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
	if (req.headers.forwarded || req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) return false;
	const host = req.headers.host ?? "";
	if (!isLoopbackHost(hostWithoutPort(host))) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		const url = new URL(origin);
		return ["http:", "https:"].includes(url.protocol) && url.host === host;
	} catch {
		return false;
	}
}

export function registerSystemScreenshotRoutes(
	app: Express,
	options: { platform?: NodeJS.Platform; capture?: Capture } = {},
): void {
	const platform = options.platform ?? process.platform;
	const capture = options.capture ?? captureWindowsScreenshot;
	let busy = false;
	app.get("/api/system-screenshot", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json({ available: platform === "win32" && isLocalScreenshotRequest(req) });
	});
	app.post("/api/system-screenshot", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!isLocalScreenshotRequest(req)) {
			res.status(403).json({ error: "local-only" });
			return;
		}
		if (platform !== "win32") {
			res.status(501).json({ error: "unsupported" });
			return;
		}
		const { token, locale, hideWindow = true } = req.body ?? {};
		if (
			typeof token !== "string" ||
			!/^[a-f0-9]{32}$/.test(token) ||
			(locale !== "zh" && locale !== "en") ||
			typeof hideWindow !== "boolean"
		) {
			res.status(400).json({ error: "invalid-request" });
			return;
		}
		if (busy) {
			res.status(409).json({ error: "busy" });
			return;
		}
		busy = true;
		const controller = new AbortController();
		const disconnect = () => controller.abort();
		res.once("close", disconnect);
		try {
			const dataUrl = await capture(token, locale, controller.signal, hideWindow);
			if (!res.destroyed) res.json({ cancelled: dataUrl === null, ...(dataUrl ? { dataUrl } : {}) });
		} catch (error) {
			const reason = error instanceof Error ? error.message : "capture-failed";
			const code = ["window-not-focused", "screen-too-large", "screenshot-timeout"].includes(reason)
				? reason
				: "capture-failed";
			if (!res.destroyed) res.status(500).json({ error: code });
		} finally {
			res.off("close", disconnect);
			busy = false;
		}
	});
}
