/**
 * cookie 有效期（秒）。三个签发点（`/__pi/auth` 登录表单、setup 保存、鉴权中间件刷新）共用这一个常量，
 * 省得改一处漏两处。今天是「一年」：cookie 里装的就是主口令本体，只能靠换口令吊销，所以这张卡
 * 短期不可延长得太随意——降到小时级 + 滑动续期属于第二层（会话 sid，见交付报告）。
 */
export const TOKEN_COOKIE_MAX_AGE_SECONDS = 31536000;

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

export function decodeCookieToken(raw: string): string {
	if (!raw) return "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
