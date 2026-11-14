import { SHAPE_LIST, isShape } from "./gen-providers.mjs";
import * as U from "./gen-util.mjs";

export const secretKey = (id) => `svc:${U.slugId(id)}`;

export function defaultConfig() {
	return {
		version: 1,
		defaultService: "",
		outputDir: "generated",
		filenameTemplate: "{date}-{time}-{slug}",
		returnImage: true,
		maxImages: 4,
		timeoutSec: 300,
		services: [],
	};
}

function strList(v, max = 50) {
	const arr = Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[\n,]/) : [];
	const out = [];
	for (const x of arr) {
		const s = U.str(x);
		if (!s || out.includes(s)) continue;
		out.push(s);
		if (out.length >= max) break;
	}
	return out;
}

function jsonObj(v) {
	if (v && typeof v === "object" && !Array.isArray(v)) return v;
	const s = U.str(v);
	if (!s) return {};
	try {
		const parsed = JSON.parse(s);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

const SHAPE_FIELDS = Object.fromEntries(SHAPE_LIST.map((s) => [s.id, s.fields]));

function pruneShapeFields(service) {
	const keep = new Set(SHAPE_FIELDS[service.shape] ?? []);
	const optional = new Set(["query", "extraHeaders", "extraBody", "sizeMap", "qualityMap"]);
	const out = { ...service };
	for (const key of [
		"editFields",
		"responseFormat",
		"mode",
		"endpoint",
		"outputFormat",
		"strength",
		"stabilityModel",
		"modalities",
		"workflow",
		"workflowFile",
		"authStyle",
		"authHeaderName",
		"authQueryParam",
	]) {
		if (!keep.has(key) && !optional.has(key)) delete out[key];
	}
	return out;
}

export function normalizeService(raw, fallbackId = "svc") {
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const shape = isShape(r.shape) ? U.str(r.shape) : "openai-images";
	const shapeMeta = SHAPE_LIST.find((s) => s.id === shape);
	const models = strList(r.models, 50);
	const defaultModel = U.str(r.defaultModel);
	const sizes = strList(r.sizes, 20);
	const qualities = strList(r.qualities, 12);
	const svc = {
		id: U.slugId(r.id, fallbackId),
		name: U.str(r.name) || shapeMeta?.label || shape,
		shape,
		baseUrl: U.trimSlash(r.baseUrl) || shapeMeta?.defaultBaseUrl || "",
		enabled: r.enabled !== false,
		models,
		defaultModel: defaultModel || models[0] || "",
		sizes: sizes.length ? sizes : U.ASPECTS.slice(0, 6),
		defaultSize: U.str(r.defaultSize) || sizes[0] || "",
		qualities,
		defaultQuality: U.str(r.defaultQuality) || qualities[0] || "",
		timeoutSec: U.clampInt(r.timeoutSec ?? 0, 0, 1800, 0),
		authStyle: U.str(r.authStyle) || "bearer",
		authHeaderName: U.str(r.authHeaderName),
		authQueryParam: U.str(r.authQueryParam),
		query: jsonObj(r.query),
		extraHeaders: jsonObj(r.extraHeaders),
		extraBody: jsonObj(r.extraBody),
		sizeMap: jsonObj(r.sizeMap),
		qualityMap: jsonObj(r.qualityMap),
		notes: U.str(r.notes).slice(0, 300),
	};
	if (shape === "openai-images") {
		const ef = U.str(r.editFields);
		svc.editFields = ["openai", "indexed", "both"].includes(ef) ? ef : "openai";
		const rf = U.str(r.responseFormat);
		svc.responseFormat = ["b64_json", "url", "omit"].includes(rf) ? rf : "omit";
	}
	if (shape === "gemini") {
		const mode = U.str(r.mode);
		svc.mode = ["auto", "generateContent", "predict"].includes(mode) ? mode : "auto";
	}
	if (shape === "openrouter-chat") {
		svc.modalities = strList(r.modalities, 4);
	}
	if (shape === "stability") {
		svc.endpoint = ["core", "ultra", "sd3"].includes(U.str(r.endpoint)) ? U.str(r.endpoint) : "sd3";
		svc.outputFormat = ["png", "jpeg", "webp"].includes(U.str(r.outputFormat)) ? U.str(r.outputFormat) : "png";
		svc.strength = Number.isFinite(Number(r.strength)) ? Math.min(1, Math.max(0, Number(r.strength))) : 0.65;
		svc.stabilityModel = U.str(r.stabilityModel);
	}
	if (shape === "comfyui") {
		svc.workflow = typeof r.workflow === "string" ? r.workflow : "";
		svc.workflowFile = U.normalizeRel(r.workflowFile);
		svc.outputFormat = ["png", "jpeg", "webp"].includes(U.str(r.outputFormat)) ? U.str(r.outputFormat) : "png";
	}
	return pruneShapeFields(svc);
}

export function normalizeConfig(raw) {
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const base = defaultConfig();
	const rawServices = Array.isArray(r.services) ? r.services.slice(0, 40) : [];
	const seen = new Set();
	const services = [];
	for (const item of rawServices) {
		const svc = normalizeService(item, `svc${services.length + 1}`);
		let id = svc.id;
		let n = 2;
		while (seen.has(id)) id = `${svc.id}-${n++}`;
		seen.add(id);
		services.push({ ...svc, id });
	}
	const defaultService = U.slugId(r.defaultService, "");
	const cfg = {
		version: 1,
		defaultService: services.some((s) => s.id === defaultService) ? defaultService : "",
		outputDir: U.normalizeRel(r.outputDir) || base.outputDir,
		filenameTemplate: U.str(r.filenameTemplate) || base.filenameTemplate,
		returnImage: r.returnImage !== false,
		maxImages: U.clampInt(r.maxImages ?? base.maxImages, 1, 8, base.maxImages),
		timeoutSec: U.clampInt(r.timeoutSec ?? base.timeoutSec, 10, 1800, base.timeoutSec),
		services,
	};
	return cfg;
}

export function enabledServices(cfg) {
	return (cfg?.services ?? []).filter((s) => s && s.enabled !== false);
}

export function pickService(cfg, id) {
	const want = U.slugId(id, "");
	if (want) {
		const known = (cfg?.services ?? []).find((s) => s.id === want);
		if (known) return known.enabled === false ? null : known;
	}
	const list = enabledServices(cfg);
	const byDefault = cfg?.defaultService ? list.find((s) => s.id === cfg.defaultService) : null;
	return byDefault ?? list[0] ?? null;
}

export function maskConfig(cfg, hasKey) {
	return {
		...cfg,
		services: (cfg?.services ?? []).map((s) => ({
			...s,
			hasKey: typeof hasKey === "function" ? Boolean(hasKey(s.id)) : false,
		})),
	};
}

const SIZES_WIDE = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const Q = ["1k", "2k", "4k"];

export const PRESETS = [
	{
		id: "antigravity",
		label: "本地 Antigravity 反代（8045）",
		labelEn: "Local Antigravity proxy (8045)",
		service: {
			name: "本地 Antigravity",
			shape: "openai-images",
			baseUrl: "http://127.0.0.1:8045/v1",
			models: ["gemini-3.1-flash-image", "imagen-3.0-generate-002", "gemini-3-pro-image"],
			defaultModel: "gemini-3.1-flash-image",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			qualities: Q,
			defaultQuality: "2k",
			editFields: "indexed",
			responseFormat: "omit",
			notes: "Antigravity-Manager 反代：gemini-3.1-flash-image 走 /v1/images/generations；pro 版需账号有配额",
		},
	},
	{
		id: "openai",
		label: "OpenAI",
		labelEn: "OpenAI",
		service: {
			name: "OpenAI",
			shape: "openai-images",
			baseUrl: "https://api.openai.com/v1",
			models: ["gpt-image-1", "dall-e-3", "dall-e-2"],
			defaultModel: "gpt-image-1",
			sizes: ["1024x1024", "1536x1024", "1024x1536"],
			defaultSize: "1024x1024",
			qualities: ["low", "medium", "high"],
			defaultQuality: "medium",
			editFields: "openai",
			responseFormat: "omit",
			notes: "gpt-image-1 只认像素尺寸与 low/medium/high；dall-e-3 尺寸 1024x1024/1792x1024/1024x1792",
		},
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		labelEn: "OpenRouter",
		service: {
			name: "OpenRouter",
			shape: "openrouter-chat",
			baseUrl: "https://openrouter.ai/api/v1",
			models: [
				"black-forest-labs/flux.2-pro",
				"black-forest-labs/flux.2-flex",
				"black-forest-labs/flux.2-klein",
				"black-forest-labs/flux-1-schnell",
				"google/gemini-2.5-flash-image",
				"recraft-ai/recraft-v3",
			],
			defaultModel: "black-forest-labs/flux.2-flex",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			notes: "走 chat/completions + modalities；画幅由模型自己决定（部分模型认 size，可用「额外请求体」补）",
		},
	},
	{
		id: "google",
		label: "Google AI Studio（Gemini / Imagen）",
		labelEn: "Google AI Studio (Gemini / Imagen)",
		service: {
			name: "Google AI Studio",
			shape: "gemini",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			models: [
				"imagen-3.0-generate-002",
				"imagen-3.0-fast-generate-001",
				"gemini-2.5-flash-image",
				"imagen-4.0-generate-001",
			],
			defaultModel: "imagen-3.0-generate-002",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			qualities: Q,
			defaultQuality: "1k",
			authStyle: "x-goog-api-key",
			mode: "auto",
			notes: "gemini-*-image 走 generateContent（认 imageSize 1K/2K/4K）；imagen-* 自动改走 predict",
		},
	},
	{
		id: "siliconflow",
		label: "硅基流动 SiliconFlow",
		labelEn: "SiliconFlow",
		service: {
			name: "硅基流动",
			shape: "openai-images",
			baseUrl: "https://api.siliconflow.cn/v1",
			models: [
				"black-forest-labs/FLUX.1-schnell",
				"black-forest-labs/FLUX.1-dev",
				"stabilityai/stable-diffusion-3-5-large",
				"Kwai-Kolors/Kolors",
			],
			defaultModel: "black-forest-labs/FLUX.1-schnell",
			sizes: ["1024x1024", "1024x768", "768x1024", "1280x720", "720x1280"],
			defaultSize: "1024x1024",
			editFields: "openai",
			responseFormat: "omit",
			notes: '支持 FLUX.1 系列、SD3.5 与 Kolors；Kolors 在「额外请求体」填 {"image_size":"1024x1024"}',
		},
	},
	{
		id: "dashscope",
		label: "阿里百炼（通义万相 Wanx）",
		labelEn: "Aliyun DashScope (Wanx)",
		service: {
			name: "通义万相",
			shape: "openai-images",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			models: ["wanx2.1-t2i-turbo", "wanx2.1-t2i-plus", "wanx-v1"],
			defaultModel: "wanx2.1-t2i-turbo",
			sizes: ["1024*1024", "768*1024", "1024*768", "1280*720", "720*1280"],
			defaultSize: "1024*1024",
			editFields: "openai",
			responseFormat: "url",
			notes: "通义万相 2.1 极速版与高画质版，兼容 OpenAI 端点；尺寸格式使用 1024*1024",
		},
	},
	{
		id: "zhipu",
		label: "智谱 GLM（CogView）",
		labelEn: "Zhipu GLM (CogView)",
		service: {
			name: "智谱 GLM",
			shape: "openai-images",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			models: ["cogview-4", "cogview-3-plus", "cogview-3"],
			defaultModel: "cogview-4",
			sizes: ["1024x1024", "1344x768", "768x1344", "1440x720", "720x1440"],
			defaultSize: "1024x1024",
			editFields: "openai",
			responseFormat: "omit",
		},
	},
	{
		id: "ark",
		label: "火山方舟（豆包 Seedream）",
		labelEn: "Volcengine Ark (Seedream)",
		service: {
			name: "火山方舟",
			shape: "openai-images",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
			models: [
				"doubao-seedream-4-0-t2i",
				"doubao-seedream-3-0-t2i-250415",
				"doubao-seedream-3-0-i2i",
				"seendance-2.5",
				"seedance-2.5",
			],
			defaultModel: "doubao-seedream-4-0-t2i",
			sizes: ["1024x1024", "864x1152", "1152x864", "1280x720", "720x1280"],
			defaultSize: "1024x1024",
			editFields: "openai",
			responseFormat: "omit",
			extraBody: { watermark: false },
			notes: "火山方舟/豆包系列：支持 Seedream 4.0/3.0 与最新 Seendance 2.5 系列模型，支持多尺寸生图与去水印",
		},
	},
	{
		id: "xai",
		label: "xAI Grok",
		labelEn: "xAI Grok",
		service: {
			name: "xAI Grok",
			shape: "openai-images",
			baseUrl: "https://api.x.ai/v1",
			models: ["grok-2-image-1212"],
			defaultModel: "grok-2-image-1212",
			sizes: ["1024x1024"],
			defaultSize: "1024x1024",
			editFields: "openai",
			responseFormat: "url",
		},
	},
	{
		id: "stability",
		label: "Stability AI",
		labelEn: "Stability AI",
		service: {
			name: "Stability AI",
			shape: "stability",
			baseUrl: "https://api.stability.ai",
			models: ["sd3.5-large", "sd3.5-large-turbo", "sd3.5-medium", "core", "ultra"],
			defaultModel: "sd3.5-large",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			endpoint: "sd3",
			outputFormat: "png",
			stabilityModel: "sd3.5-large",
			authStyle: "bearer",
			notes: "支持 SD3.5 系列、Ultra 与 Core；使用 sd3 端点时 stabilityModel 填具体模型",
		},
	},
	{
		id: "comfyui",
		label: "本地 ComfyUI（8188）",
		labelEn: "Local ComfyUI (8188)",
		service: {
			name: "本地 ComfyUI",
			shape: "comfyui",
			baseUrl: "http://127.0.0.1:8188",
			models: ["(workflow 决定)"],
			defaultModel: "",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			qualities: Q,
			defaultQuality: "1k",
			workflow: "",
			outputFormat: "png",
			authStyle: "none",
			notes:
				"ComfyUI 菜单「工作流 → 导出（API 格式）」把 JSON 粘进 workflow；模板里可用 {{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{batch}} {{image1}} 占位",
		},
	},
	{
		id: "generic",
		label: "自定义 OpenAI 兼容端点",
		labelEn: "Custom OpenAI-compatible endpoint",
		service: {
			name: "自定义端点",
			shape: "openai-images",
			baseUrl: "http://127.0.0.1:8080/v1",
			models: [],
			defaultModel: "",
			sizes: SIZES_WIDE,
			defaultSize: "1:1",
			editFields: "openai",
			responseFormat: "omit",
			notes: "OneAPI / NewAPI / LocalAI / 自建反代等：填 baseUrl + 模型名即可",
		},
	},
];

export function presetService(presetId, existingIds = []) {
	const p = PRESETS.find((x) => x.id === presetId) ?? PRESETS[PRESETS.length - 1];
	const svc = normalizeService(structuredClone(p.service), p.id);
	let id = svc.id;
	let n = 2;
	while (existingIds.includes(id)) id = `${svc.id}-${n++}`;
	return { ...svc, id };
}

export function findServiceInConfig(cfg, id) {
	const sid = U.slugId(id, "");
	if (!sid) return null;
	return (cfg?.services ?? []).find((s) => s.id === sid) ?? null;
}

export function upsertServiceInConfig(cfg, patch = {}) {
	const current = normalizeConfig(cfg);
	const rawId = U.slugId(patch.id || patch.serviceId, "");
	const presetId = U.slugId(patch.preset, "");

	let base = {};
	const existing = rawId ? current.services.find((s) => s.id === rawId) : null;
	if (existing) {
		base = structuredClone(existing);
	} else if (presetId) {
		const preset = PRESETS.find((p) => p.id === presetId);
		if (preset) {
			base = structuredClone(preset.service);
		}
	}

	const id = existing ? existing.id : rawId || (presetId ? presetId : "custom-service");
	let finalId = id;
	if (!existing) {
		let n = 2;
		const existingIds = current.services.map((s) => s.id);
		while (existingIds.includes(finalId)) finalId = `${id}-${n++}`;
	}

	const merged = normalizeService(
		{
			...base,
			...patch,
			id: finalId,
		},
		finalId,
	);

	let nextServices;
	if (existing) {
		nextServices = current.services.map((s) => (s.id === existing.id ? merged : s));
	} else {
		nextServices = [...current.services, merged];
	}

	let defaultService = current.defaultService;
	if (patch.setDefault === true || !defaultService || !nextServices.some((s) => s.id === defaultService)) {
		defaultService = merged.id;
	}

	const nextConfig = normalizeConfig({
		...current,
		services: nextServices,
		defaultService,
	});

	return {
		config: nextConfig,
		service: merged,
		isNew: !existing,
		previous: existing ? structuredClone(existing) : null,
	};
}

export function removeServiceFromConfig(cfg, id) {
	const current = normalizeConfig(cfg);
	const sid = U.slugId(id, "");
	if (!sid || !current.services.some((s) => s.id === sid)) return null;

	const nextServices = current.services.filter((s) => s.id !== sid);
	let defaultService = current.defaultService;
	if (defaultService === sid) {
		const firstEnabled = nextServices.find((s) => s.enabled !== false);
		defaultService = firstEnabled ? firstEnabled.id : nextServices[0]?.id || "";
	}

	const nextConfig = normalizeConfig({
		...current,
		services: nextServices,
		defaultService,
	});

	return { config: nextConfig, removedId: sid };
}
