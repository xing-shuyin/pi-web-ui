export const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;

export const MIN_HEALTH_TIMEOUT_MS = 1_000;

export const DEFAULT_DESKTOP_PORT = 8790;

export function resolveHealthTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_WEB_HEALTH_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_HEALTH_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HEALTH_TIMEOUT_MS;
	return Math.max(MIN_HEALTH_TIMEOUT_MS, Math.floor(parsed));
}

export function buildDesktopLoadUrl(baseUrl: string, env: Record<string, string | undefined> = process.env): string {
	const token = env.PI_WEB_TOKEN?.trim();
	if (!token) return baseUrl;
	try {
		const u = new URL(baseUrl);
		if (!u.searchParams.has("token")) {
			u.searchParams.set("token", token);
		}
		return u.toString();
	} catch {
		return baseUrl;
	}
}

export interface AgentConnectionState {
	agentUrl: string;
	agentReady: boolean;
	agentError?: string;
}

/**
 * 判定内核切换/同步时是否需要重新加载 Agent 页（issue #1004）：
 * 仅有相同 URL 不算已连接——若上次预连接因内核未就绪而失败（agentError）或尚未就绪（!agentReady），
 * 必须重新触发 connectAgent 以清掉错误状态并加载已健康的内核。
 */
export function needsAgentReconnect(state: AgentConnectionState | undefined | null, targetUrl: string): boolean {
	return !state || state.agentUrl !== targetUrl || !state.agentReady || Boolean(state.agentError);
}

export interface WaitForHealthOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	shouldAbort?: () => Error | null | undefined;
	fetchFn?: (url: string) => Promise<{ ok: boolean }>;
}

export async function waitForHealth(url: string, opts: number | WaitForHealthOptions = {}): Promise<void> {
	const options: WaitForHealthOptions = typeof opts === "number" ? { timeoutMs: opts } : opts;
	const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
	const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 200);
	const fetchImpl = options.fetchFn ?? ((u: string) => fetch(u));
	const deadline = Date.now() + timeoutMs;
	const healthUrl = `${url.replace(/\/+$/, "")}/api/health`;

	for (;;) {
		const abortErr = options.shouldAbort?.();
		if (abortErr) throw abortErr;
		try {
			const res = await fetchImpl(healthUrl);
			if (res.ok) return;
		} catch {}
		const abortAfter = options.shouldAbort?.();
		if (abortAfter) throw abortAfter;
		if (Date.now() >= deadline) {
			throw new Error(`server 未在 ${timeoutMs}ms 内就绪：${url}`);
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}
