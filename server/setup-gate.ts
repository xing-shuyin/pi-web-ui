import { isLoopbackAddress } from "./server-config.js";
import { hostWithoutPort, isLoopbackHost } from "./host-guard.js";

/**
 * `/setup` 的门禁（只允许本机、禁反代、禁跨站）。
 *
 * 单独成模块是为了**可测**：它原来是 `server/index.ts` 里的导出，而 `index.ts` 在模块顶层
 * 就会抢内核锁并 `httpServer.listen()`，任何想测这个判据的用例都会顺带起一个真服务
 * （实例锁被占时还会直接 `process.exit(1)`，整批用例红）。判据本身与启动无关，就该住在
 * 一个没有副作用的模块里。
 */
export function setupGate(
	req: { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> },
	res: { status: (c: number) => { end: (m: string) => void } },
	next: () => void,
): void {
	if (!isLoopbackAddress(req.socket?.remoteAddress)) {
		res.status(403).end("setup page is only available from localhost");
		return;
	}
	if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) {
		res.status(403).end("setup page cannot be accessed through a reverse proxy");
		return;
	}
	const hostHeader = typeof req.headers.host === "string" ? req.headers.host : "";
	const host = hostWithoutPort(hostHeader);
	if (!host || !isLoopbackHost(host)) {
		res.status(403).end("setup page Host header must be localhost");
		return;
	}
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
	if (origin) {
		try {
			const u = new URL(origin);
			if (!isLoopbackHost(u.hostname)) {
				res.status(403).end("cross-origin setup request rejected");
				return;
			}
		} catch {
			res.status(403).end("invalid origin");
			return;
		}
	}
	const secFetchSite =
		typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"].toLowerCase() : "";
	const secFetchMode =
		typeof req.headers["sec-fetch-mode"] === "string" ? req.headers["sec-fetch-mode"].toLowerCase() : "";
	if (secFetchSite === "cross-site" && secFetchMode !== "navigate") {
		res.status(403).end("cross-site request to setup rejected");
		return;
	}
	next();
}
