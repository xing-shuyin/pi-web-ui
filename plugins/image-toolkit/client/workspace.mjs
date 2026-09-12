/**
 * 工作区通道：调用插件自己服务端注册的 /plugins-api/image-toolkit/ws/* 路由。
 *
 * 基址按页面路径推导（与插件 iframe 同款做法）：nginx 子路径反代（页面在 /pi/）
 * 时请求必须落在 /pi/plugins-api/... 才能被转发规则命中，所以不能用根绝对路径。
 */

function apiBase() {
	try {
		let p = location.pathname.replace(/index\.html$/i, "");
		if (!p.endsWith("/")) p += "/";
		return `${p}plugins-api/image-toolkit`;
	} catch {
		return "/plugins-api/image-toolkit";
	}
}

function url(path, params) {
	const u = `${apiBase()}${path}`;
	if (!params) return u;
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	const s = q.toString();
	return s ? `${u}?${s}` : u;
}

/** 列目录（相对工作区，一层）。 */
export async function listDir(dir = "") {
	const r = await fetch(url("/ws/list", { dir }));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

/** 图片原始字节的直链（可直接喂 <img> 做缩略图，@PI_WEB_TOKEN 的 cookie 会自动带上）。 */
export function imageUrl(path) {
	return url("/ws/image", { path });
}

/** 元数据（服务端只读文件头，不解码像素）。 */
export async function probe(path) {
	const r = await fetch(url("/ws/probe", { path }));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

/** 取回图片字节（交给 createImageBitmap 解码）。 */
export async function readImageBlob(path) {
	const r = await fetch(imageUrl(path));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.blob();
}

/** 保存字节到工作区（原始 body，绕开 JSON 体积上限）。 */
export async function saveImage(path, blob, overwrite = false) {
	const r = await fetch(url("/ws/save", { path, overwrite: overwrite ? "1" : "0" }), {
		method: "POST",
		headers: { "Content-Type": blob.type || "application/octet-stream" },
		body: blob,
	});
	const text = await r.text();
	let data = {};
	try {
		data = JSON.parse(text);
	} catch {
		/* 非 JSON（例如 413/500 的 HTML） */
	}
	if (!r.ok) throw new Error(data.error || `HTTP ${r.status} ${text.slice(0, 120)}`);
	return data;
}

/** 插件声明式设置（客户端用来初始化默认值）。 */
export async function fetchSettings() {
	const r = await fetch(url("/ws/settings"));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i;
