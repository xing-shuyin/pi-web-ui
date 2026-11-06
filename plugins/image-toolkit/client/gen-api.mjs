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
	const u = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
	if (!params) return u;
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	}
	const s = q.toString();
	return s ? `${u}?${s}` : u;
}

async function request(path, init, query) {
	const res = await fetch(url(path, query), init);
	const text = await res.text();
	let data = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {}
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status} ${text.slice(0, 160)}`);
	return data;
}

const postJson = (path, body) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const getConfig = () => request("/gen/config").catch(() => request("/config"));

export const saveConfig = (config, apiKeys) =>
	postJson("/gen/config", { config, apiKeys }).catch(() => postJson("/config", { config, apiKeys }));

export const addPreset = (preset) =>
	postJson("/gen/service/preset", { preset }).catch(() => postJson("/service/preset", { preset }));

export const probe = (id, opts = {}) =>
	postJson("/gen/probe", { id, ...opts }).catch(() => postJson("/probe", { id, ...opts }));

export async function fetchModels(id, opts = {}) {
	try {
		return await postJson("/gen/models", { id, ...opts });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/\b404\b|not found/i.test(msg)) {
			return await postJson("/probe", { id, ...opts });
		}
		throw err;
	}
}

export const generate = (input) => postJson("/gen/generate", input).catch(() => postJson("/generate", input));

export const getJobs = () =>
	request("/gen/jobs")
		.catch(() => request("/jobs"))
		.then((d) => d.jobs ?? []);
export const removeJob = (id) => postJson("/gen/jobs/remove", { id }).catch(() => postJson("/jobs/remove", { id }));
export const clearJobs = () => postJson("/gen/jobs/clear", {}).catch(() => postJson("/jobs/clear", {}));

export const imageUrl = (path) => url("/gen/image", { path });

export const listDir = (dir = "") => request("/ws/list", undefined, { dir });

export const readText = (path) => request("/ws/text", undefined, { path }).then((d) => d.text ?? "");

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
