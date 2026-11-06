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

export async function listDir(dir = "") {
	const r = await fetch(url("/ws/list", { dir }));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

export function imageUrl(path) {
	return url("/ws/image", { path });
}

export async function probe(path) {
	const r = await fetch(url("/ws/probe", { path }));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

export async function readImageBlob(path) {
	const r = await fetch(imageUrl(path));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.blob();
}

export async function readImage(path) {
	const blob = await readImageBlob(path);
	return blob.arrayBuffer();
}

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
	} catch {}
	if (!r.ok) throw new Error(data.error || `HTTP ${r.status} ${text.slice(0, 120)}`);
	return data;
}

export async function fetchSettings() {
	const r = await fetch(url("/ws/settings"));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

export async function saveSettings(values) {
	const r = await fetch(url("/ws/settings"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(values ?? {}),
	});
	const text = await r.text();
	let data = {};
	try {
		data = JSON.parse(text);
	} catch {}
	if (!r.ok) throw new Error(data.error || `HTTP ${r.status} ${text.slice(0, 120)}`);
	return data;
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i;
