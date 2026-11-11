/**
 * 书源 Cookie 导入（纯函数）：把用户从真浏览器复制的 Cookie 并进书源 header JSON。
 * 场景：源站开盾/需登录时，用户在浏览器里正常访问一次，把 document.cookie
 * （或请求头里的 Cookie 整串）粘过来，服务端之后代发这些 Cookie。
 */

/** 解析 Cookie 串（document.cookie 或 Cookie 请求头格式：k=v; k2=v2） */
export function parseCookieString(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of String(raw ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		const k = part.slice(0, i).trim();
		const v = part.slice(i + 1).trim();
		if (!k || k.startsWith("$")) continue;
		out[k] = v;
	}
	return out;
}

/**
 * 把 Cookie 按 key 合并进书源 header JSON（保留 UA 等原有字段；同名 key 用新的覆盖）。
 * @returns 新的 header JSON 串与本次写入的 key 数量
 */
export function mergeCookieIntoHeader(header: unknown, cookieStr: string): { header: string; count: number } {
	const incoming = parseCookieString(cookieStr);
	const count = Object.keys(incoming).length;
	if (!count) throw new Error("没解析出 Cookie：请粘贴 document.cookie 或请求头里的 Cookie 整串（形如 a=1; b=2）");
	let obj: Record<string, unknown> = {};
	const raw = String(header ?? "").trim();
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not-object");
			obj = parsed as Record<string, unknown>;
		} catch {
			throw new Error("该源原有 header 不是合法 JSON 对象，先手动修好再导入 Cookie");
		}
	}
	const prev = typeof obj["Cookie"] === "string" ? parseCookieString(obj["Cookie"]) : {};
	const all = { ...prev, ...incoming };
	obj = { ...obj, Cookie: Object.entries(all).map(([k, v]) => `${k}=${v}`).join("; ") };
	return { header: JSON.stringify(obj), count };
}
