import { buildMultipart } from "./gen-multipart.mjs";
import * as U from "./gen-util.mjs";

export class ProviderError extends Error {
	constructor(message, extra = {}) {
		super(message);
		this.name = "ProviderError";
		if (extra.status !== undefined) this.status = extra.status;
		if (extra.body !== undefined) this.body = extra.body;
	}
}

export const SHAPE_LIST = [
	{
		id: "openai-images",
		label: "OpenAI 兼容（/images/generations）",
		labelEn: "OpenAI-compatible (/images/generations)",
		defaultBaseUrl: "https://api.openai.com/v1",
		covers:
			"OpenAI / Azure / xAI / 硅基流动 / 智谱 / 火山方舟 / 阿里百炼（通义万相） / 本地反代（Antigravity、OneAPI、NewAPI、LocalAI）等",
		coversEn:
			"OpenAI / Azure / xAI / SiliconFlow / Zhipu / Volcengine Ark / DashScope (Wanx) / local proxies (Antigravity, OneAPI, NewAPI, LocalAI)",
		caps: { edit: true, n: true, size: true, quality: true, seed: false, negative: false },
		fields: ["authStyle", "editFields", "responseFormat", "sizeMap", "qualityMap", "extraHeaders", "extraBody"],
	},
	{
		id: "gemini",
		label: "Google 原生（Gemini / Imagen）",
		labelEn: "Google native (Gemini / Imagen)",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		covers: "Google AI Studio：gemini-*-image（Nano Banana）、imagen-*",
		coversEn: "Google AI Studio: gemini-*-image (Nano Banana), imagen-*",
		caps: { edit: true, n: false, size: true, quality: true, seed: false, negative: false },
		fields: ["authStyle", "mode", "sizeMap", "qualityMap", "extraBody"],
	},
	{
		id: "openrouter-chat",
		label: "OpenRouter（chat + modalities）",
		labelEn: "OpenRouter (chat + modalities)",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		covers: "OpenRouter 全系图模型（FLUX、Recraft、Gemini-Image、GPT-Image 等）",
		coversEn: "Every OpenRouter image model (FLUX, Recraft, Gemini-Image, GPT-Image, etc.)",
		caps: { edit: true, n: false, size: false, quality: false, seed: false, negative: false },
		fields: ["modalities", "extraHeaders", "extraBody"],
	},
	{
		id: "stability",
		label: "Stability AI",
		labelEn: "Stability AI",
		defaultBaseUrl: "https://api.stability.ai",
		covers: "Stability 官方：stable-image core / ultra / sd3.5",
		coversEn: "Stability official: stable-image core / ultra / sd3.5",
		caps: { edit: true, n: false, size: true, quality: false, seed: true, negative: true },
		fields: ["endpoint", "outputFormat", "strength", "extraBody"],
	},
	{
		id: "comfyui",
		label: "本地 ComfyUI",
		labelEn: "Local ComfyUI",
		defaultBaseUrl: "http://127.0.0.1:8188",
		covers: "本地 ComfyUI（任何 checkpoint / workflow，含 LoRA、ControlNet、SDXL、Flux）",
		coversEn: "Local ComfyUI (any checkpoint/workflow: LoRA, ControlNet, SDXL, Flux)",
		caps: { edit: true, n: true, size: true, quality: true, seed: true, negative: true },
		fields: ["workflow", "outputFormat"],
	},
];

const SHAPE_IDS = new Set(SHAPE_LIST.map((s) => s.id));

export function shapeOf(id) {
	return shapes[U.str(id)] ?? shapes["openai-images"];
}

export function isShape(id) {
	return SHAPE_IDS.has(U.str(id));
}

export function normalizeRequest(raw = {}) {
	const refs = (Array.isArray(raw.refs) ? raw.refs : [])
		.filter((r) => r && (Buffer.isBuffer(r.data) || r.data instanceof Uint8Array) && r.data.length)
		.slice(0, 8)
		.map((r, i) => ({
			name: U.str(r.name) || `ref${i + 1}`,
			mimeType: U.str(r.mimeType) || U.sniffImageMime(r.data) || "image/png",
			data: Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data),
		}));
	return {
		prompt: U.str(raw.prompt),
		negative: U.str(raw.negative),
		model: U.str(raw.model),
		size: U.str(raw.size),
		quality: U.str(raw.quality),
		n: U.clampInt(raw.n ?? 1, 1, 8, 1),
		seed: Number.isFinite(Number(raw.seed)) ? Math.trunc(Number(raw.seed)) : undefined,
		refs,
		extra: raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra) ? raw.extra : {},
	};
}

export function substVars(text, vars) {
	return String(text).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function keyVars(service, key) {
	return { key: key ?? "", baseUrl: service.baseUrl ?? "" };
}

export function authHeaders(service, key) {
	const style = U.str(service.authStyle) || "bearer";
	const k = U.str(key);
	const out = {};
	if (!k) return out;
	if (style === "bearer") out.Authorization = `Bearer ${k}`;
	else if (style === "x-api-key") out["x-api-key"] = k;
	else if (style === "x-goog-api-key") out["x-goog-api-key"] = k;
	else if (style === "api-key") out["api-key"] = k;
	else if (style === "header") out[U.str(service.authHeaderName) || "x-api-key"] = k;
	return out;
}

function extraHeaders(service, key) {
	const out = {};
	const raw = service.extraHeaders;
	if (!raw || typeof raw !== "object") return out;
	for (const [k, v] of Object.entries(raw)) {
		if (!k || v === undefined || v === null) continue;
		out[k] = substVars(String(v), keyVars(service, key));
	}
	return out;
}

function extraBodyFields(service, key) {
	const raw = service.extraBody;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v === undefined || v === null) continue;
		out[k] = typeof v === "string" ? substVars(v, keyVars(service, key)) : v;
	}
	return out;
}

function withQuery(url, service, key) {
	const q = new URLSearchParams();
	if (service.query && typeof service.query === "object") {
		for (const [k, v] of Object.entries(service.query)) {
			if (v === undefined || v === null || v === "") continue;
			q.set(k, substVars(String(v), keyVars(service, key)));
		}
	}
	if ((U.str(service.authStyle) || "") === "query" && U.str(key)) {
		q.set(U.str(service.authQueryParam) || "key", U.str(key));
	}
	const s = q.toString();
	return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
}

async function readResponse(res) {
	const ct = String(res.headers?.get?.("content-type") ?? "").toLowerCase();
	let buf = Buffer.alloc(0);
	try {
		buf = Buffer.from(await res.arrayBuffer());
	} catch {
		buf = Buffer.alloc(0);
	}
	const looksJson = ct.includes("json") || buf.length === 0 || buf[0] === 0x7b || buf[0] === 0x5b;
	if (looksJson) {
		try {
			return { kind: "json", json: JSON.parse(buf.toString("utf8")), buf, ct };
		} catch {}
	}
	return { kind: "binary", json: null, buf, ct };
}

function errorText(json, buf) {
	const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
	if (json && typeof json === "object") {
		const j = json;
		const candidates = [
			pick(j.error?.message),
			pick(j.error?.msg),
			pick(j.error),
			pick(j.message),
			pick(j.msg),
			pick(j.detail),
			Array.isArray(j.detail) ? pick(j.detail[0]?.msg) : "",
			pick(j.error_message),
		];
		const hit = candidates.find(Boolean);
		if (hit) return hit;
		try {
			return U.truncate(JSON.stringify(json), 400);
		} catch {}
	}
	return U.truncate(buf?.toString("utf8") ?? "", 400);
}

function single(build, parse) {
	return async (service, req, deps) => {
		const built = build(service, req, deps);
		deps.onProgress?.({ stage: "request" });
		const res = await doFetch(deps, built.url, built);
		if (!res.ok) {
			const { json, buf } = await readResponse(res);
			const msg = errorText(json, buf);
			throw new ProviderError(`${res.status} ${res.statusText || ""} ${msg}`.trim(), { status: res.status, body: msg });
		}
		return parse(await readResponse(res), { service, req, deps });
	};
}

async function doFetch(deps, url, built) {
	const init = {
		method: built.method || "POST",
		headers: built.headers,
		body: built.body,
		signal: deps.signal ?? AbortSignal.timeout(deps.timeoutMs ?? 300_000),
	};
	try {
		return await deps.fetch(url, init);
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		throw new ProviderError(`请求失败：${m}（${url}）`);
	}
}

async function imageFromAny(v, deps, fallbackMime = "") {
	const picked = typeof v === "string" ? v : (v?.url ?? v?.image_url?.url ?? v?.b64_json ?? v?.base64 ?? v?.image);
	const s = U.str(picked);
	if (!s) return null;
	if (s.startsWith("data:")) {
		const d = U.parseDataUri(s);
		if (!d || !d.data.length) return null;
		return { data: d.data, mimeType: U.sniffImageMime(d.data) || d.mimeType || fallbackMime || "image/png" };
	}
	if (/^https?:\/\//i.test(s)) {
		const res = await doFetch(deps, s, { method: "GET", headers: {} });
		if (!res.ok) throw new ProviderError(`下载生成结果失败：${res.status}`, { status: res.status });
		const buf = Buffer.from(await res.arrayBuffer());
		const ct = String(res.headers?.get?.("content-type") ?? "")
			.split(";")[0]
			.trim();
		return { data: buf, mimeType: U.sniffImageMime(buf) || ct || fallbackMime || "image/png" };
	}
	if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length < 64) return null;
	const buf = U.b64ToBuffer(s);
	if (buf.length < 32) return null;
	return { data: buf, mimeType: U.sniffImageMime(buf) || fallbackMime || "image/png" };
}

function blockedReason(json) {
	const j = json ?? {};
	const cand = Array.isArray(j.candidates) ? j.candidates[0] : null;
	const fr = U.str(cand?.finishReason ?? cand?.finish_reason);
	const pf = U.str(j.promptFeedback?.blockReason ?? j.prompt_feedback?.block_reason);
	const pred = Array.isArray(j.predictions) ? j.predictions[0] : null;
	const rai = U.str(pred?.raiFilteredReason);
	const finish = U.str(j.finish_reason ?? j.finishReason);
	if (rai) return `被服务商安全策略过滤：${rai}`;
	if (pf) return `被拒绝：${pf}`;
	if (fr && /SAFETY|PROHIBITED|BLOCK|RECITATION|IMAGE_/i.test(fr)) return `被安全策略拦截（${fr}）`;
	if (finish && /CONTENT_FILTERED|BLOCKED/i.test(finish)) return `被安全策略拦截（${finish}）`;
	return "";
}

const openaiImages = {
	id: "openai-images",
	caps: { edit: true, n: true },
	build(service, req, ctx) {
		const base = U.trimSlash(service.baseUrl) || "https://api.openai.com/v1";
		const extra = extraBodyFields(service, ctx.key);
		const headers = { ...authHeaders(service, ctx.key), ...extraHeaders(service, ctx.key) };
		const wantJson = U.str(service.responseFormat) !== "omit";
		const responseFormat = U.str(service.responseFormat) === "url" ? "url" : "b64_json";

		if (req.refs.length) {
			const style = U.str(service.editFields) || "openai";
			const parts = [];
			if (style === "openai" || style === "both") {
				req.refs.forEach((r, i) => {
					parts.push({
						name: i === 0 ? "image" : "image[]",
						filename: r.name,
						contentType: r.mimeType,
						data: r.data,
					});
				});
			}
			if (style === "indexed" || style === "both") {
				req.refs.forEach((r, i) => {
					parts.push({ name: `image${i + 1}`, filename: r.name, contentType: r.mimeType, data: r.data });
				});
			}
			parts.push({ name: "prompt", value: req.prompt });
			if (req.model) parts.push({ name: "model", value: req.model });
			if (req.size) parts.push({ name: "size", value: req.size });
			if (req.quality) parts.push({ name: "quality", value: req.quality });
			if (req.n > 1) parts.push({ name: "n", value: String(req.n) });
			if (wantJson) parts.push({ name: "response_format", value: responseFormat });
			for (const [k, v] of Object.entries(extra)) {
				parts.push({ name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
			}
			const mp = buildMultipart(parts);
			headers["Content-Type"] = mp.contentType;
			return { url: withQuery(`${base}/images/edits`, service, ctx.key), method: "POST", headers, body: mp.body };
		}

		const body = { prompt: req.prompt, ...extra };
		if (req.model) body.model = req.model;
		if (req.n > 1) body.n = req.n;
		if (req.size) body.size = req.size;
		if (req.quality) body.quality = req.quality;
		if (wantJson) body.response_format = responseFormat;
		headers["Content-Type"] = "application/json";
		return {
			url: withQuery(`${base}/images/generations`, service, ctx.key),
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
	},
	async parse(payload, ctx) {
		const { json, buf, ct } = payload;
		if (!json && /^image\//.test(ct || "")) {
			return { images: [{ data: buf, mimeType: ct.split(";")[0] }], text: "" };
		}
		const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.images) ? json.images : [];
		const images = [];
		let text = "";
		for (const it of items) {
			const img = await imageFromAny(it, ctx.deps);
			if (img) images.push(img);
			const revised = U.str(it?.revised_prompt ?? it?.revisedPrompt);
			if (revised) text = text ? `${text}\n${revised}` : revised;
		}
		if (!images.length) {
			const single = await imageFromAny(json, ctx.deps);
			if (single) images.push(single);
		}
		return { images, text, meta: { shape: "openai-images" } };
	},
};
openaiImages.run = single(openaiImages.build, openaiImages.parse);

const gemini = {
	id: "gemini",
	caps: { edit: true, n: false },
	modeOf(service, req) {
		const m = U.str(service.mode);
		if (m === "generateContent" || m === "predict") return m;
		return /imagen/i.test(req.model) ? "predict" : "generateContent";
	},
	build(service, req, ctx) {
		const base = U.trimSlash(service.baseUrl) || "https://generativelanguage.googleapis.com/v1beta";
		const mode = gemini.modeOf(service, req);
		const model = req.model || "gemini-2.5-flash-image";
		const headers = {
			...authHeaders(service, ctx.key),
			...extraHeaders(service, ctx.key),
			"Content-Type": "application/json",
		};
		const extra = extraBodyFields(service, ctx.key);
		const aspect = U.normalizeAspect(req.size) || (/^\d+x\d+$/i.test(req.size) ? U.pixelsFor(req.size).aspect : "");
		const quality = U.qualityLabel(req.quality);
		let body;
		if (mode === "predict") {
			const params = { sampleCount: req.n, ...extra };
			if (aspect) params.aspectRatio = aspect;
			body = { instances: [{ prompt: req.prompt }], parameters: params };
		} else {
			const parts = [{ text: req.prompt }];
			for (const r of req.refs) {
				parts.push({ inlineData: { mimeType: r.mimeType, data: r.data.toString("base64") } });
			}
			const imageConfig = {};
			if (aspect) imageConfig.aspectRatio = aspect;
			if (quality) imageConfig.imageSize = quality;
			const generationConfig = { responseModalities: ["TEXT", "IMAGE"], ...extra };
			if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
			body = { contents: [{ role: "user", parts }], generationConfig };
		}
		return {
			url: withQuery(`${base}/models/${encodeURIComponent(model)}:${mode}`, service, ctx.key),
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
	},
	async parse(payload, ctx) {
		const { json } = payload;
		const images = [];
		const texts = [];
		const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
		for (const c of candidates) {
			for (const p of Array.isArray(c?.content?.parts) ? c.content.parts : []) {
				const inl = p?.inlineData ?? p?.inline_data;
				if (inl?.data) {
					const data = U.b64ToBuffer(inl.data);
					images.push({
						data,
						mimeType: U.sniffImageMime(data) || U.str(inl.mimeType ?? inl.mime_type) || "image/png",
					});
				}
				if (typeof p?.text === "string" && p.text.trim()) texts.push(p.text.trim());
			}
		}
		const predictions = Array.isArray(json?.predictions) ? json.predictions : [];
		for (const p of predictions) {
			const b64 = p?.bytesBase64Encoded ?? p?.bytes_base64_encoded;
			if (b64) {
				const data = U.b64ToBuffer(b64);
				images.push({
					data,
					mimeType: U.sniffImageMime(data) || U.str(p.mimeType ?? p.mime_type) || "image/png",
				});
			}
		}
		const text = texts.join("\n").slice(0, 2000);
		const reason = images.length ? "" : blockedReason(json);
		return { images, text: reason || text, meta: { shape: "gemini", blocked: Boolean(reason) } };
	},
};
gemini.run = single(gemini.build, gemini.parse);

const openrouterChat = {
	id: "openrouter-chat",
	caps: { edit: true, n: false },
	build(service, req, ctx) {
		const base = U.trimSlash(service.baseUrl) || "https://openrouter.ai/api/v1";
		const content = [{ type: "text", text: req.prompt }];
		for (const r of req.refs) {
			content.push({ type: "image_url", image_url: { url: `data:${r.mimeType};base64,${r.data.toString("base64")}` } });
		}
		const modalities =
			Array.isArray(service.modalities) && service.modalities.length ? service.modalities : ["image", "text"];
		const body = {
			model: req.model,
			messages: [{ role: "user", content }],
			modalities,
			...extraBodyFields(service, ctx.key),
		};
		return {
			url: withQuery(`${base}/chat/completions`, service, ctx.key),
			method: "POST",
			headers: {
				...authHeaders(service, ctx.key),
				...extraHeaders(service, ctx.key),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		};
	},
	async parse(payload, ctx) {
		const { json } = payload;
		const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
		const images = [];
		for (const im of Array.isArray(choice?.message?.images) ? choice.message.images : []) {
			const img = await imageFromAny(im, ctx.deps);
			if (img) images.push(img);
		}
		const content = choice?.message?.content;
		let text = typeof content === "string" ? content : "";
		if (!Array.isArray(content) && typeof content !== "string") text = "";
		if (Array.isArray(content)) {
			text = content
				.map((p) => (typeof p === "string" ? p : U.str(p?.text ?? "")))
				.filter(Boolean)
				.join("\n");
		}
		if (!images.length && text) {
			for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
				const img = await imageFromAny(m[1], ctx.deps);
				if (img) images.push(img);
			}
		}
		const reason = images.length ? "" : blockedReason(json) || (text ? "" : U.str(json?.error?.message));
		return { images, text: (reason ? `${reason}\n` : "") + text.slice(0, 2000), meta: { shape: "openrouter-chat" } };
	},
};
openrouterChat.run = single(openrouterChat.build, openrouterChat.parse);

const stability = {
	id: "stability",
	caps: { edit: true, n: false, negative: true, seed: true },
	build(service, req, ctx) {
		const base = U.trimSlash(service.baseUrl) || "https://api.stability.ai";
		const endpoint = U.str(service.endpoint) || "sd3";
		const headers = {
			...authHeaders(service, ctx.key),
			...extraHeaders(service, ctx.key),
			accept: "image/*",
		};
		const parts = [{ name: "prompt", value: req.prompt }];
		const outputFormat = U.str(service.outputFormat) || "png";
		parts.push({ name: "output_format", value: outputFormat });
		const aspect = U.normalizeAspect(req.size);
		if (aspect) parts.push({ name: "aspect_ratio", value: aspect });
		if (req.negative) parts.push({ name: "negative_prompt", value: req.negative });
		if (Number.isFinite(req.seed)) parts.push({ name: "seed", value: String(req.seed) });
		if (service.stabilityModel) parts.push({ name: "model", value: U.str(service.stabilityModel) });
		if (req.refs.length) {
			parts.push({ name: "mode", value: "image-to-image" });
			parts.push({ name: "strength", value: String(Number(service.strength) || 0.65) });
			parts.push({
				name: "image",
				filename: req.refs[0].name,
				contentType: req.refs[0].mimeType,
				data: req.refs[0].data,
			});
		}
		for (const [k, v] of Object.entries(extraBodyFields(service, ctx.key))) {
			parts.push({ name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
		}
		const mp = buildMultipart(parts);
		headers["Content-Type"] = mp.contentType;
		return {
			url: `${base}/v2beta/stable-image/generate/${encodeURIComponent(endpoint)}`,
			method: "POST",
			headers,
			body: mp.body,
		};
	},
	async parse(payload, ctx) {
		const { json, buf, ct } = payload;
		if (!json && /^image\//.test(ct || "")) return { images: [{ data: buf, mimeType: ct.split(";")[0] }], text: "" };
		if (json && typeof json.image === "string") {
			const data = U.b64ToBuffer(json.image);
			const mime = U.sniffImageMime(data) || `image/${U.str(ctx.service.outputFormat) || "png"}`;
			const finish = U.str(json.finish_reason);
			if (finish && finish !== "SUCCESS")
				return { images: [], text: `被服务商拦截：${finish}`, meta: { blocked: true } };
			return { images: [{ data, mimeType: mime }], text: "" };
		}
		return { images: [], text: errorText(json, buf) };
	},
};
stability.run = single(stability.build, stability.parse);

const comfyui = {
	id: "comfyui",
	caps: { edit: true, n: true, seed: true, negative: true },
	renderWorkflow(template, req, vars = {}) {
		const px = U.pixelsFor(req.size, req.quality);
		const table = {
			prompt: req.prompt,
			negative: req.negative,
			width: px.width,
			height: px.height,
			aspect: px.aspect || U.normalizeAspect(req.size),
			batch: req.n,
			seed: Number.isFinite(req.seed) ? req.seed : Math.floor(Math.random() * 2 ** 31),
			model: req.model,
			...vars,
			...req.extra,
		};
		const text = String(template).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, k) => {
			if (!(k in table)) return m;
			const v = table[k];
			if (v === undefined || v === null) return "";
			return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v)).slice(1, -1);
		});
		return JSON.parse(text);
	},
	async uploadRef(service, ref, ctx) {
		const base = U.trimSlash(service.baseUrl) || "http://127.0.0.1:8188";
		const mp = buildMultipart([
			{ name: "image", filename: ref.name, contentType: ref.mimeType, data: ref.data },
			{ name: "overwrite", value: "true" },
		]);
		const headers = {
			...authHeaders(service, ctx.key),
			...extraHeaders(service, ctx.key),
			"Content-Type": mp.contentType,
		};
		const res = await doFetch(ctx.deps, `${base}/upload/image`, { method: "POST", headers, body: mp.body });
		const payload = await readResponse(res);
		if (!res.ok)
			throw new ProviderError(`ComfyUI 上传参考图失败：${res.status} ${errorText(payload.json, payload.buf)}`);
		const name = U.str(payload.json?.name);
		if (!name) throw new ProviderError("ComfyUI 上传参考图失败：响应里没有 name");
		const sub = U.str(payload.json?.subfolder);
		return sub ? `${sub}/${name}` : name;
	},
	async run(service, req, deps) {
		const base = U.trimSlash(service.baseUrl) || "http://127.0.0.1:8188";
		const ctx = { service, req, key: deps.key, deps };
		let template = U.str(service.workflow);
		if (!template && U.str(service.workflowFile) && deps.readText) {
			template = await deps.readText(U.str(service.workflowFile));
		}
		if (!template) {
			throw new ProviderError(
				"ComfyUI 需要 workflow 模板（把 ComfyUI 里的「工作流 → 导出（API 格式）」JSON 粘到服务配置里）",
			);
		}
		const vars = {};
		if (req.refs.length) {
			deps.onProgress?.({ stage: "upload", detail: `${req.refs.length} 张参考图` });
			for (let i = 0; i < req.refs.length; i++) {
				const name = await comfyui.uploadRef(service, req.refs[i], ctx);
				vars[`image${i + 1}`] = name;
				if (i === 0) vars.image = name;
			}
		}
		let workflow;
		try {
			workflow = comfyui.renderWorkflow(template, req, vars);
		} catch (err) {
			throw new ProviderError(`workflow 模板不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
		}
		const clientId = `pi-webui-${U.randomHex(6)}`;
		deps.onProgress?.({ stage: "queue" });
		const headers = {
			...authHeaders(service, ctx.key),
			...extraHeaders(service, ctx.key),
			"Content-Type": "application/json",
		};
		const queued = await doFetch(deps, `${base}/prompt`, {
			method: "POST",
			headers,
			body: JSON.stringify({ prompt: workflow, client_id: clientId }),
		});
		const qPayload = await readResponse(queued);
		if (!queued.ok || qPayload.json?.error) {
			const detail = errorText(qPayload.json, qPayload.buf);
			const nodeErrors = qPayload.json?.node_errors ? U.truncate(JSON.stringify(qPayload.json.node_errors), 600) : "";
			throw new ProviderError(`ComfyUI 拒绝任务：${detail}${nodeErrors ? ` | ${nodeErrors}` : ""}`, {
				status: queued.status,
			});
		}
		const promptId = U.str(qPayload.json?.prompt_id ?? qPayload.json?.promptId);
		if (!promptId) throw new ProviderError("ComfyUI 未返回 prompt_id");

		const deadline = Date.now() + (deps.timeoutMs ?? 300_000);
		let entry = null;
		for (let i = 0; Date.now() < deadline; i++) {
			await new Promise((r) => setTimeout(r, i === 0 ? 800 : 1200));
			const res = await doFetch(deps, `${base}/history/${encodeURIComponent(promptId)}`, {
				method: "GET",
				headers: {},
			});
			if (!res.ok) continue;
			const payload = await readResponse(res);
			const hit = payload.json?.[promptId];
			if (hit && (hit.outputs || hit.status?.completed || hit.status?.status_str === "error")) {
				entry = hit;
				break;
			}
			deps.onProgress?.({ stage: "running", detail: `${i + 1}s` });
		}
		if (!entry) throw new ProviderError("ComfyUI 任务超时（可在服务配置里调大超时秒数）");
		if (entry.status?.status_str === "error") {
			const msg = (Array.isArray(entry.status.messages) ? entry.status.messages : [])
				.map((m) =>
					Array.isArray(m)
						? m.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")
						: String(m),
				)
				.join(" | ");
			throw new ProviderError(`ComfyUI 执行失败：${U.truncate(msg, 500)}`);
		}
		const files = [];
		for (const out of Object.values(entry.outputs ?? {})) {
			for (const img of Array.isArray(out?.images) ? out.images : []) {
				files.push(img);
			}
		}
		if (!files.length) throw new ProviderError("ComfyUI 跑完了但没有输出图片（检查 workflow 里有没有 SaveImage 节点）");
		deps.onProgress?.({ stage: "download", detail: `${files.length} 张` });
		const images = [];
		for (const f of files.slice(0, 8)) {
			const q = new URLSearchParams({
				filename: U.str(f.filename),
				subfolder: U.str(f.subfolder),
				type: U.str(f.type) || "output",
			});
			const res = await doFetch(deps, `${base}/view?${q.toString()}`, {
				method: "GET",
				headers: authHeaders(service, ctx.key),
			});
			if (!res.ok) continue;
			const buf = Buffer.from(await res.arrayBuffer());
			const ct = String(res.headers?.get?.("content-type") ?? "")
				.split(";")[0]
				.trim();
			images.push({ data: buf, mimeType: U.sniffImageMime(buf) || ct || "image/png" });
		}
		return { images, text: "", meta: { shape: "comfyui", promptId } };
	},
};

const shapes = {
	"openai-images": openaiImages,
	gemini,
	"openrouter-chat": openrouterChat,
	stability,
	comfyui,
};

export function renderComfyWorkflow(template, rawReq, vars = {}) {
	return comfyui.renderWorkflow(template, normalizeRequest(rawReq), vars);
}

function applyMaps(service, req) {
	const out = { ...req };
	const map = (v, table) => {
		if (!table || typeof table !== "object") return v;
		const hit = table[v];
		return hit === undefined || hit === null || hit === "" ? v : String(hit);
	};
	out.size = map(req.size, service.sizeMap);
	out.quality = map(req.quality, service.qualityMap);
	if (!out.model) out.model = U.str(service.defaultModel);
	return out;
}

export async function generateImage(service, rawReq, deps = {}) {
	const ctx = {
		fetch: deps.fetch ?? globalThis.fetch,
		key: U.str(deps.key),
		timeoutMs: U.clampInt(deps.timeoutMs ?? 300_000, 1000, 1_800_000, 300_000),
		signal: deps.signal,
		onProgress: deps.onProgress,
		readText: deps.readText,
	};
	const shape = shapeOf(service?.shape);
	const req = applyMaps(service, normalizeRequest(rawReq));
	if (!req.prompt) throw new ProviderError("prompt 不能为空");
	if (req.refs.length && shape.caps.edit !== true) throw new ProviderError(`${shape.id} 形状不支持参考图/图生图`);
	if (shape.caps.n !== true && req.n > 1) {
		const results = await Promise.all(
			Array.from({ length: req.n }, (_, i) =>
				shape
					.run(service, { ...req, n: 1 }, ctx)
					.then((r) => ({ ok: true, r }))
					.catch((err) => ({ ok: false, err, i })),
			),
		);
		const images = [];
		const texts = [];
		let firstErr = null;
		for (const r of results) {
			if (r.ok) {
				images.push(...r.r.images);
				if (r.r.text) texts.push(r.r.text);
			} else if (!firstErr) {
				firstErr = r.err;
			}
		}
		if (!images.length) throw firstErr ?? new ProviderError("未返回图片");
		return { images, text: texts.join("\n"), meta: { shape: shape.id, partial: images.length < req.n } };
	}
	const out = await shape.run(service, req, ctx);
	if (!out.images.length) {
		throw new ProviderError(out.text ? `未返回图片：${U.truncate(out.text, 400)}` : "未返回图片（供应商没有给出原因）");
	}
	return out;
}

export function buildRequest(shapeId, service, rawReq, key = "") {
	const shape = shapeOf(shapeId);
	if (typeof shape.build !== "function") return null;
	return shape.build(service, applyMaps(service, normalizeRequest(rawReq)), { key, deps: {} });
}

export function parseResponse(shapeId, payload, ctx = {}) {
	const shape = shapeOf(shapeId);
	return shape.parse(payload, {
		service: ctx.service ?? {},
		req: ctx.req ?? {},
		deps: ctx.deps ?? { fetch: globalThis.fetch },
	});
}

export async function probeService(service, deps = {}) {
	const ctx = {
		fetch: deps.fetch ?? globalThis.fetch,
		key: U.str(deps.key),
		timeoutMs: U.clampInt(deps.timeoutMs ?? 20_000, 1000, 120_000, 20_000),
		signal: deps.signal,
		onProgress: undefined,
		readText: deps.readText,
	};
	const shape = shapeOf(service?.shape);
	const base = U.trimSlash(service.baseUrl) || "";
	const headers = { ...authHeaders(service, ctx.key), ...extraHeaders(service, ctx.key) };
	try {
		if (shape.id === "comfyui") {
			const res = await doFetch(ctx, `${base}/system_stats`, { method: "GET", headers: {} });
			const p = await readResponse(res);
			if (!res.ok) return { ok: false, detail: `${res.status} ${errorText(p.json, p.buf)}`, models: [] };
			const ver = U.str(p.json?.system?.comfyui_version);
			const models = await comfyNodeChoices(ctx, base, "CheckpointLoaderSimple", "ckpt_name");
			const detail = [
				ver ? `ComfyUI ${ver}` : "ComfyUI 可达",
				models.length ? `${models.length} 个 checkpoint` : "没读到 checkpoint 列表",
			].join(" · ");
			return { ok: true, detail, models };
		}
		if (shape.id === "stability") {
			const res = await doFetch(ctx, `${base}/v1/user/account`, { method: "GET", headers });
			const p = await readResponse(res);
			if (!res.ok) return { ok: false, detail: `${res.status} ${errorText(p.json, p.buf)}`, models: [] };
			const credits = p.json?.credits;
			return {
				ok: true,
				detail: `${credits === undefined ? "账号可用" : `余额 ${credits}`} · 该形状模型名由端点决定（core/ultra/sd3）`,
				models: [],
			};
		}
		const url = withQuery(`${base}/models`, service, ctx.key);
		const res = await doFetch(ctx, url, { method: "GET", headers });
		const p = await readResponse(res);
		if (!res.ok) return { ok: false, detail: `${res.status} ${errorText(p.json, p.buf)}`, models: [] };
		const models = listModelsFrom(p.json, shape.id);
		return { ok: true, detail: models.length ? `可见 ${models.length} 个模型` : "端点可达（未返回模型列表）", models };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err), models: [] };
	}
}

async function comfyNodeChoices(ctx, base, node, field) {
	try {
		const res = await doFetch(ctx, `${base}/object_info/${encodeURIComponent(node)}`, { method: "GET", headers: {} });
		if (!res.ok) return [];
		const p = await readResponse(res);
		const list = p.json?.[node]?.input?.required?.[field]?.[0];
		return Array.isArray(list)
			? list
					.map((x) => U.str(x))
					.filter(Boolean)
					.slice(0, 300)
			: [];
	} catch {
		return [];
	}
}

export function listModelsFrom(json, shapeId) {
	const out = [];
	if (Array.isArray(json?.data)) {
		for (const m of json.data) {
			const id = U.str(m?.id ?? m?.name);
			if (id) out.push(id);
		}
	}
	if (Array.isArray(json?.models)) {
		for (const m of json.models) {
			const name = U.str(m?.name).replace(/^models\//, "");
			if (
				name &&
				(shapeId !== "gemini" ||
					!Array.isArray(m?.supportedGenerationMethods) ||
					m.supportedGenerationMethods.includes("generateContent") ||
					m.supportedGenerationMethods.includes("predict"))
			) {
				out.push(name);
			}
		}
	}
	return [...new Set(out)].slice(0, 200);
}
