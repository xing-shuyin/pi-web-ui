import type { ServerFileConfig } from "./server-config.js";

export interface SetupRuntimeConfig {
	token: string;
	host: string;
	port: number;
	allowHosts: readonly string[];
	allowOrigins: readonly string[];
}

export type SetupSaveResult =
	| { ok: false; status: 400 | 500; error: string }
	| {
			ok: true;
			nextToken: string;
			tokenApplied: boolean;
			restartRequired: boolean;
			saved: ServerFileConfig;
	  };

export function saveSetupConfig(
	input: unknown,
	previous: ServerFileConfig,
	current: SetupRuntimeConfig,
	save: (config: ServerFileConfig) => void,
): SetupSaveResult {
	const body = (input ?? {}) as Record<string, unknown>;
	const next = { ...previous };
	const nextToken = typeof body.token === "string" ? body.token.trim() : current.token;
	if (typeof body.token === "string") {
		if (nextToken) next.token = nextToken;
		else delete next.token;
	}
	const fields = [
		["host", (s: string) => /^[A-Za-z0-9.:_-]+$/.test(s) && s.length <= 253],
		["allowHosts", (s: string) => /^[A-Za-z0-9.,:_\-\s]+$/.test(s)],
		["allowOrigins", (s: string) => s.length <= 2000],
	] as const;
	for (const [key, valid] of fields) {
		const value = body[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return { ok: false, status: 400, error: `${key} 必须是字符串` };
		const s = value.trim();
		if (s && !valid(s)) return { ok: false, status: 400, error: `${key} 格式不合法：${s}` };
		if (s) next[key] = s;
		else delete next[key];
	}
	if (body.port !== undefined && body.port !== "" && body.port !== null) {
		const p = typeof body.port === "string" || typeof body.port === "number" ? Number(body.port) : NaN;
		if (!Number.isInteger(p) || p <= 0 || p > 65535) {
			return { ok: false, status: 400, error: `port 必须是 1-65535：${String(body.port)}` };
		}
		next.port = p;
	} else if (body.port === "") {
		delete next.port;
	}
	const norm = (s: string) =>
		s
			.split(",")
			.map((x) => x.trim().toLowerCase())
			.filter(Boolean)
			.join(",");
	const restartRequired =
		(typeof body.host === "string" && body.host.trim() !== current.host) ||
		(body.port !== undefined && body.port !== "" && body.port !== null && Number(body.port) !== current.port) ||
		(typeof body.allowHosts === "string" && norm(body.allowHosts) !== current.allowHosts.join(",")) ||
		(typeof body.allowOrigins === "string" && norm(body.allowOrigins) !== current.allowOrigins.join(","));
	try {
		save(next);
	} catch (err) {
		return { ok: false, status: 500, error: `写入配置失败：${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, nextToken, tokenApplied: nextToken !== current.token, restartRequired, saved: next };
}
