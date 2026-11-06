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
