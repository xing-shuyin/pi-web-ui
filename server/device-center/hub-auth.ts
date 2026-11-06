import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DeviceHubStore } from "./store.js";
import { hashSecret } from "./store.js";

export const SESSION_COOKIE = "__Host-device_hub";
export const LOCAL_SESSION_COOKIE = "device_hub";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const NATIVE_ORIGINS = ["capacitor://localhost", "https://localhost"] as const;
export type NativeOrigin = (typeof NATIVE_ORIGINS)[number];
export function nativeOrigin(value: unknown): value is NativeOrigin {
	return NATIVE_ORIGINS.includes(value as NativeOrigin);
}
const NATIVE_TOKEN_PREFIX = "native.";
export function createNativeAccountAuth(store: DeviceHubStore) {
	function session(hash: string) {
		const state = store.snapshot();
		const current = state.sessions.find((entry) => entry.hash === hash && entry.expiresAt > Date.now());
		const account = current && state.accounts.find((entry) => entry.id === current.accountId);
		return account ? { account: { id: account.id, username: account.username }, hash } : null;
	}
	return {
		createToken: () => NATIVE_TOKEN_PREFIX + randomBytes(32).toString("hex"),
		getSession(req: IncomingMessage) {
			const value = req.headers.authorization;
			if (!value || !/^Bearer native\.[a-f0-9]{64}$/.test(value)) return null;
			return session(hashSecret(value.slice(7)));
		},
		isActive: (hash: string, accountId: string) => session(hash)?.account.id === accountId,
	};
}
function derive(password: string, salt: string): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => (error ? reject(error) : resolve(key))),
	);
}
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString("hex");
	return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const [scheme, salt, hash] = encoded.split(":");
	if (scheme !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "hex");
	const actual = await derive(password, salt);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createAccountAuth(store: DeviceHubStore, publicUrl: string) {
	const secure = new URL(publicUrl).protocol === "https:";
	const cookieName = secure ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
	return {
		cookie(token: string, clear = false): string {
			return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL / 1000}${secure ? "; Secure" : ""}`;
		},
		getToken(req: IncomingMessage): string | undefined {
			return req.headers.cookie
				?.split(";")
				.map((entry) => entry.trim())
				.find((entry) => entry.startsWith(`${cookieName}=`))
				?.slice(cookieName.length + 1);
		},
		getAccount(req: IncomingMessage): { id: string; username: string } | null {
			const token = this.getToken(req);
			if (!token || token.length > 256 || token.startsWith(NATIVE_TOKEN_PREFIX)) return null;
			const state = store.snapshot();
			const session = state.sessions.find((entry) => entry.hash === hashSecret(token) && entry.expiresAt > Date.now());
			const account = session && state.accounts.find((entry) => entry.id === session.accountId);
			return account ? { id: account.id, username: account.username } : null;
		},
	};
}

export class HubRateLimiter {
	private entries = new Map<string, { count: number; expiresAt: number }>();
	constructor(
		private limit: number,
		private windowMs: number,
	) {}
	allow(key: string): boolean {
		const now = Date.now();
		for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= 10000) return false;
			entry = { count: 0, expiresAt: now + this.windowMs };
			this.entries.set(key, entry);
		}
		return ++entry.count <= this.limit;
	}
}
