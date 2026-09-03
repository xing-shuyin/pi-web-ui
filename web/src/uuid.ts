/**
 * UUID 生成助手。
 *
 * 为什么不用 crypto.randomUUID()：
 *   它只在安全上下文（HTTPS 或 localhost）可用——通过普通 HTTP 局域网 IP /
 *   远程主机访问 pi-web-ui 时它是 undefined；Safari < 15.4 更是完全没有。
 *   之前 WebSocket onopen 里调用它抛异常，hello 发不出去，整个会话挂死。
 *
 * 兜底用 crypto.getRandomValues()（RFC 4122 v4）——它在非安全上下文和所有
 * 现代浏览器都可用；实在没有（极端环境）才退到 Math.random。
 */
export function randomUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
