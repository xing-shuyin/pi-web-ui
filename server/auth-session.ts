import { createHash, randomBytes } from "node:crypto";

/**
 * 服务端会话存储（issue #969 第二层）：
 * - Cookie `pi_web_token` 只放随机 `sid`（不再放主口令本体）；
 * - 每次有效请求（HTTP / WS）滑动续期 `expiresAt = now + ttlMs`；
 * - 支持单设备吊销（`revoke` / `revokeById`）与全部下线（`revokeAll`，含口令轮换时清空）。
 *
 * 公开列表只暴露 `id`（`sid` 的单向摘要），绝不把别的设备的 `sid` 令牌吐给前端。
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_COUNT = 256;

export interface AuthSession {
	sid: string;
	id: string;
	createdAt: number;
	lastSeen: number;
	expiresAt: number;
	ip?: string;
	userAgent?: string;
}

export interface PublicAuthSession {
	id: string;
	current: boolean;
	createdAt: number;
	lastSeen: number;
	expiresAt: number;
	ip?: string;
	userAgent?: string;
}

export interface CreateSessionMeta {
	ip?: string;
	userAgent?: string;
}

function sessionPublicId(sid: string): string {
	return createHash("sha256").update(sid).digest("hex").slice(0, 16);
}

function normalizeIp(raw: string | undefined): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

function normalizeUserAgent(raw: string | undefined): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, 200);
}

export interface AuthSessionStore {
	create(meta?: CreateSessionMeta, now?: number): { sid: string; session: AuthSession };
	verify(sid: string, now?: number): AuthSession | undefined;
	peek(sid: string, now?: number): AuthSession | undefined;
	list(currentSid?: string, now?: number): PublicAuthSession[];
	revoke(sid: string): boolean;
	revokeById(id: string): { revoked: boolean; sid?: string };
	revokeAll(): string[];
	size(now?: number): number;
}

export function createAuthSessionStore(options?: { ttlMs?: number; maxSessions?: number }): AuthSessionStore {
	const ttlMs = options?.ttlMs ?? SESSION_TTL_MS;
	const maxSessions = options?.maxSessions ?? SESSION_MAX_COUNT;
	const sessions = new Map<string, AuthSession>();

	function prune(now: number): void {
		for (const [sid, session] of sessions) {
			if (now >= session.expiresAt) sessions.delete(sid);
		}
		if (sessions.size < maxSessions) return;
		let oldestSid: string | undefined;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [sid, session] of sessions) {
			if (session.lastSeen < oldestSeen) {
				oldestSeen = session.lastSeen;
				oldestSid = sid;
			}
		}
		if (oldestSid !== undefined) sessions.delete(oldestSid);
	}

	return {
		create(meta: CreateSessionMeta = {}, now: number = Date.now()) {
			prune(now);
			const sid = randomBytes(32).toString("base64url");
			const session: AuthSession = {
				sid,
				id: sessionPublicId(sid),
				createdAt: now,
				lastSeen: now,
				expiresAt: now + ttlMs,
				ip: normalizeIp(meta.ip),
				userAgent: normalizeUserAgent(meta.userAgent),
			};
			sessions.set(sid, session);
			return { sid, session };
		},

		verify(sid: string, now: number = Date.now()) {
			if (!sid) return undefined;
			const session = sessions.get(sid);
			if (!session) return undefined;
			if (now >= session.expiresAt) {
				sessions.delete(sid);
				return undefined;
			}
			session.lastSeen = now;
			session.expiresAt = now + ttlMs;
			return session;
		},

		peek(sid: string, now: number = Date.now()) {
			if (!sid) return undefined;
			const session = sessions.get(sid);
			if (!session) return undefined;
			if (now >= session.expiresAt) {
				sessions.delete(sid);
				return undefined;
			}
			return session;
		},

		list(currentSid?: string, now: number = Date.now()): PublicAuthSession[] {
			const out: PublicAuthSession[] = [];
			for (const [sid, session] of sessions) {
				if (now >= session.expiresAt) {
					sessions.delete(sid);
					continue;
				}
				out.push({
					id: session.id,
					current: Boolean(currentSid && sid === currentSid),
					createdAt: session.createdAt,
					lastSeen: session.lastSeen,
					expiresAt: session.expiresAt,
					...(session.ip ? { ip: session.ip } : {}),
					...(session.userAgent ? { userAgent: session.userAgent } : {}),
				});
			}
			out.sort((a, b) => b.lastSeen - a.lastSeen);
			return out;
		},

		revoke(sid: string): boolean {
			if (!sid) return false;
			return sessions.delete(sid);
		},

		revokeById(id: string): { revoked: boolean; sid?: string } {
			if (!id) return { revoked: false };
			for (const [sid, session] of sessions) {
				if (session.id === id) {
					sessions.delete(sid);
					return { revoked: true, sid };
				}
			}
			return { revoked: false };
		},

		revokeAll(): string[] {
			const sids = Array.from(sessions.keys());
			sessions.clear();
			return sids;
		},

		size(now: number = Date.now()): number {
			for (const [sid, session] of sessions) {
				if (now >= session.expiresAt) sessions.delete(sid);
			}
			return sessions.size;
		},
	};
}
