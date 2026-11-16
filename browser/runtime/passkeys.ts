/**
 * Passkey（WebAuthn 凭据）的纯逻辑：字段形状、投影、按站点匹配、与 CDP 的对象互转。
 *
 * 这里不碰 Electron / 不碰磁盘，方便单测。真正的“谁在生成私钥”由 Chromium 的虚拟认证器负责
 * （`desktop` 侧用 CDP `WebAuthn.addVirtualAuthenticator` 挂一个 platform 认证器），
 * 私钥（`privateKey`，PKCS8 base64）由我们自己的加密存储保管——和密码/TOTP 同一条 safeStorage 口径。
 *
 * 口径说明：虚拟认证器的 user verification 由客户端“代为确认”（原生对话框/直接放行），
 * 不是 Windows Hello 的生物识别；凭据只在本浏览器里有效，不参与系统/手机的 passkey 同步。
 */
import { randomUUID } from "node:crypto";

export interface StoredPasskey {
	/** 我们自己的条目 id（面板里删除用）。 */
	id: string;
	/** Relying Party id（通常是不带 www 的主域）。 */
	rpId: string;
	/** 创建时的页面 origin，面板里显示。 */
	origin: string;
	/** base64 的凭据 id（WebAuthn 的 rawId）。 */
	credentialId: string;
	/** base64 的 PKCS8 私钥（落盘前加密）。 */
	privateKey: string;
	userHandle: string;
	userName: string;
	userDisplayName: string;
	signCount: number;
	label: string;
	createdAt: string;
}

/** 发给渲染层的投影：**没有私钥**（和 `passwords.list` 去掉明文同一条口径）。 */
export type PublicPasskey = Omit<StoredPasskey, "privateKey">;

/** CDP `WebAuthn.Credential` 的字段子集（我们真正用的那些）。 */
export interface CdpCredential {
	credentialId: string;
	isResidentCredential: boolean;
	rpId: string;
	privateKey: string;
	userHandle?: string;
	signCount: number;
	userName?: string;
	userDisplayName?: string;
}

export function publicPasskey(entry: StoredPasskey): PublicPasskey {
	const { privateKey, ...rest } = entry;
	return rest;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * 磁盘/外部来的数据一律先过这里：缺关键字段（私钥、凭据 id、rpId）的条目直接丢，
 * 不猜、不补——一条坏数据不该让整个 passkey 列表解析失败。
 */
export function normalizePasskeys(value: unknown): StoredPasskey[] {
	if (!Array.isArray(value)) return [];
	const out: StoredPasskey[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const credentialId = text(entry.credentialId);
		const privateKey = text(entry.privateKey);
		const rpId = text(entry.rpId).toLowerCase();
		if (!credentialId || !privateKey || !rpId || seen.has(credentialId)) continue;
		seen.add(credentialId);
		out.push({
			id: text(entry.id) || randomUUID(),
			rpId,
			origin: text(entry.origin),
			credentialId,
			privateKey,
			userHandle: text(entry.userHandle),
			userName: text(entry.userName),
			userDisplayName: text(entry.userDisplayName),
			signCount: num(entry.signCount),
			label: text(entry.label) || text(entry.userName) || rpId,
			createdAt: text(entry.createdAt) || new Date().toISOString(),
		});
	}
	return out;
}

/**
 * 某个 host 能用哪些 passkey：WebAuthn 的 rpId 是“站点后缀”语义——
 * `rpId=example.com` 对 `www.example.com` 有效，反过来不行。只做精确/后缀比对，不做通配。
 */
export function passkeysForHost(entries: StoredPasskey[], host: string): StoredPasskey[] {
	const target = host.toLowerCase();
	if (!target) return [];
	return entries.filter((entry) => {
		const rpId = entry.rpId.toLowerCase();
		return rpId === target || target.endsWith(`.${rpId}`);
	});
}

/** CDP 抓到的凭据 → 我们的条目（同一个 credentialId 视为同一条，重新注册时就覆盖）。 */
export function passkeyFromCredential(
	credential: CdpCredential,
	origin: string,
	now = new Date().toISOString(),
): StoredPasskey | null {
	if (!credential?.credentialId || !credential.privateKey || !credential.rpId) return null;
	const userName = text(credential.userName);
	return {
		id: randomUUID(),
		rpId: credential.rpId.toLowerCase(),
		origin,
		credentialId: credential.credentialId,
		privateKey: credential.privateKey,
		userHandle: text(credential.userHandle),
		userName,
		userDisplayName: text(credential.userDisplayName),
		signCount: num(credential.signCount),
		label: userName || credential.rpId,
		createdAt: now,
	};
}

/** 我们的条目 → `WebAuthn.addCredential` 要的形状（不带我们自己的 id/label 这些本地字段）。 */
export function toCdpCredential(entry: StoredPasskey): CdpCredential {
	return {
		credentialId: entry.credentialId,
		isResidentCredential: true,
		rpId: entry.rpId,
		privateKey: entry.privateKey,
		...(entry.userHandle ? { userHandle: entry.userHandle } : {}),
		signCount: entry.signCount,
		...(entry.userName ? { userName: entry.userName } : {}),
		...(entry.userDisplayName ? { userDisplayName: entry.userDisplayName } : {}),
	};
}

/** 同一条凭据的新版信息（登录后 signCount 会涨）合并回列表；不存在就追加。 */
export function upsertPasskey(entries: StoredPasskey[], entry: StoredPasskey): StoredPasskey[] {
	const index = entries.findIndex((item) => item.credentialId === entry.credentialId);
	if (index < 0) return [...entries, entry];
	const next = entries.slice();
	next[index] = { ...next[index], ...entry, id: next[index].id, createdAt: next[index].createdAt };
	return next;
}
