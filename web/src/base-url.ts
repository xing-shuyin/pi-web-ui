/**
 * 应用根（base path）解析：让服务端相对 URL（/ws、/api、/plugins、/themes）
 * 兼容 nginx 子路径反代部署（页面在 http://host/pi/，nginx 用
 * `location /pi/ { proxy_pass http://backend/; }` 剥离前缀转发给后端）。
 *
 * 背景：官方 dist 的静态资源引用是根绝对路径（/assets/...），页面能在
 * /pi/ 上正常加载，说明 nginx 已正确把 /pi/ 路由到后端；但浏览器侧 JS 里
 * 硬编码的根相对 URL（如插件 bundle `/plugins/<id>/client/entry.mjs`）仍会
 * 落在网站根，绕过 /pi/ 转发规则 → 404 / 加载失败。这里用页面自身的
 * baseURI 推导应用根，把这类 URL 统一加上前缀，零配置适配任意子路径。
 *
 * 也天然兼容 `vite build --base=/pi/`（页面加载时 baseURI 与构建期写入
 * import.meta.env.BASE_URL 一致，推导结果相同）。根部署（baseURI 为 /）时
 * 全部退化为传统根路径，行为与旧版本完全一致。
 *
 * 类型说明：本文件会被 web（DOM lib）与 tests/unit（ES2023，无 DOM）两个
 * tsconfig 编译，因此浏览器对象通过 globalThis 弱类型访问，不依赖 lib.dom。
 */

let cachedBase: string | null = null;

/** 从页面路径纯函数推导应用根："" / "/" → "/"，"/pi/" / "/pi" / "/pi/index.html"
 *  → "/pi/"。无参时读 document.baseURI（浏览器环境），读不到则退回 Vite 构建
 *  期的 base（根部署固定为 "/"）。 */
export function resolveBase(pathname?: string): string {
	if (pathname === undefined) {
		const doc = (
			globalThis as unknown as {
				document?: { baseURI?: string };
			}
		).document;
		if (doc && typeof doc.baseURI === "string" && doc.baseURI) {
			try {
				pathname = new URL(doc.baseURI).pathname;
			} catch {
				/* baseURI 异常，走 fallback */
			}
		}
		if (pathname === undefined) {
			// 非浏览器环境（单测等）：退回 Vite 构建期 base（根部署为 "/"）。
			const viteBase = (
				import.meta as unknown as {
					env?: { BASE_URL?: string };
				}
			).env?.BASE_URL;
			return viteBase || "/";
		}
	}
	if (!pathname || pathname === "/") return "/";
	// /pi/index.html → /pi/；/pi（无尾斜杠）→ /pi/
	let p = pathname.replace(/index\.html$/i, "");
	if (!p.endsWith("/")) p += "/";
	return p;
}

/** 应用根（模块级缓存；SPA 页面 URL 不变）——"/" 或 "/pi/"。 */
export function appBase(): string {
	if (cachedBase === null) cachedBase = resolveBase();
	return cachedBase;
}

/** 纯函数：把服务端相对路径加上应用根前缀（appUrl 的实际实现）。 */
export function withAppBase(path: string, base: string): string {
	return base === "/" ? path : base + path.replace(/^\/+/, "");
}

/** 把服务端相对路径带上应用根前缀：
 *  appUrl("/plugins/x.js") 在 /pi/ 部署下 → "/pi/plugins/x.js"；根部署原样返回。 */
export function appUrl(path: string): string {
	return withAppBase(path, appBase());
}
