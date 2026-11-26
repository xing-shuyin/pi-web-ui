/**
 * cookie 有效期（秒）。所有签发点（`/__pi/auth` 登录表单、`/__pi/session/exchange`、
 * setup 保存、鉴权中间件滑动续期）共用这一个常量。
 * 7 天配合每次有效请求滑动续期：既满足浏览器「记住我」持久 cookie（> 24h），又避免一年期长效凭证。
 */
export const TOKEN_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type TlsProbe = {
	socket?: unknown;
	secure?: boolean;
	headers?: Record<string, string | string[] | undefined>;
};

export function isTlsRequest(req: TlsProbe): boolean {
	if ((req.socket as { encrypted?: boolean } | undefined | null)?.encrypted) return true;
	if (req.secure === true) return true;
	const proto = req.headers?.["x-forwarded-proto"];
	const first = Array.isArray(proto) ? proto[0] : proto;
	if (typeof first === "string" && first.split(",")[0]?.trim().toLowerCase() === "https") return true;
	const fwd = req.headers?.forwarded;
	const fwdFirst = Array.isArray(fwd) ? fwd[0] : fwd;
	if (typeof fwdFirst === "string" && /(?:^|[;,]\s*)proto=https(?:[;,]|$)/i.test(fwdFirst)) return true;
	return false;
}

export function buildPiWebTokenCookie(encodedValue: string, maxAge: number, secure: boolean): string {
	return `pi_web_token=${encodedValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearPiWebTokenCookies(): [string, string] {
	return [buildPiWebTokenCookie("", 0, false), buildPiWebTokenCookie("", 0, true)];
}

export function decodeCookieToken(raw: string): string {
	if (!raw) return "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
