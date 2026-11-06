import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "./attachments.js";

export interface PluginLlmRequest {
	prompt: string;
	system?: string;
	model?: string;
	maxChars?: number;
	timeoutMs?: number;
	images?: Array<{ data: string; mimeType: string }>;
	signal?: AbortSignal;
}

export type PluginLlmResult =
	{ ok: true; text: string; model: string; usage?: { input: number; output: number } } | { ok: false; error: string };

export interface PluginLlmEnv {
	cwd: string;
	agentDir: string;
	fallbackModel?: { provider: string; id: string };
}

const MAX_PROMPT_CHARS = 8000;
const MAX_SYSTEM_CHARS = 4000;
const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 32000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_INFLIGHT = 4;

let inflight = 0;

export function llmInflight(): number {
	return inflight;
}

function fail(error: string): PluginLlmResult {
	return { ok: false, error };
}

function validateImages(images: PluginLlmRequest["images"]): Array<{ type: "image"; data: string; mimeType: string }> {
	if (images === undefined) return [];
	if (!Array.isArray(images) || images.length > 8) throw new Error("images must be an array of at most 8 images");
	let total = 0;
	return Array.from(images, (image) => {
		if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string")
			throw new Error("invalid image data/mimeType");
		const { data, mimeType } = image;
		if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw new Error("unsupported image MIME type");
		if (
			!data.length ||
			data.length > 4 * Math.ceil(1048576 / 3) ||
			data.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(data)
		)
			throw new Error("invalid or oversized image base64");
		const bytes = Buffer.from(data, "base64");
		if (bytes.toString("base64") !== data) throw new Error("invalid image base64 padding");
		if (bytes.length > 1048576 || (total += bytes.length) > 6 * 1048576)
			throw new Error("image exceeds 1 MiB or total images exceed 6 MiB");
		const valid =
			mimeType === "image/jpeg"
				? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
				: mimeType === "image/png"
					? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
					: bytes.length >= 12 &&
						bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
						bytes.subarray(8, 12).equals(Buffer.from("WEBP"));
		if (!valid) throw new Error("image signature does not match MIME type");
		return { type: "image", data, mimeType };
	});
}

export async function completeWithIsolatedSession(env: PluginLlmEnv, req: PluginLlmRequest): Promise<PluginLlmResult> {
	const prompt = String(req?.prompt ?? "");
	if (!prompt.trim()) return fail("llm.complete: prompt 为空");
	if (prompt.length > MAX_PROMPT_CHARS)
		return fail(`llm.complete: prompt 超长（${prompt.length} > ${MAX_PROMPT_CHARS} 字），请裁剪后重发`);
	const system = String(req?.system ?? "");
	if (system.length > MAX_SYSTEM_CHARS)
		return fail(`llm.complete: system 超长（${system.length} > ${MAX_SYSTEM_CHARS} 字），请裁剪后重发`);
	let images: ReturnType<typeof validateImages>;
	try {
		images = validateImages(req?.images);
	} catch (err) {
		return fail(`llm.complete: ${(err as Error).message}`);
	}
	const signal = req?.signal;
	if (signal?.aborted) return fail("llm.complete: cancelled");
	if (inflight >= MAX_INFLIGHT) return fail(`llm.complete: 并发已满（${MAX_INFLIGHT} 路在飞），请稍后重试`);
	const maxChars = Math.min(
		Math.max(Number(req?.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, 1),
		MAX_MAX_CHARS,
	);
	const timeoutMs = Math.min(
		Math.max(Number(req?.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
		MAX_TIMEOUT_MS,
	);

	inflight += 1;
	let stopped: PluginLlmResult | undefined;
	let dispose: (() => void) | undefined;
	let abort: (() => Promise<void>) | undefined;
	let resolveStop!: (result: PluginLlmResult) => void;
	const interruption = new Promise<PluginLlmResult>((resolve) => {
		resolveStop = resolve;
	});
	const stop = (result: PluginLlmResult) => {
		if (stopped) return;
		stopped = result;
		try {
			void abort?.().catch(() => {});
		} catch {}
		dispose?.();
		resolveStop(result);
	};
	const onAbort = () => stop(fail("llm.complete: cancelled"));
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const timer = setTimeout(() => stop(fail(`llm.complete: 超时（约${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
	const run = (async (): Promise<PluginLlmResult> => {
		try {
			if (stopped) return stopped;
			const modelRuntime = await ModelRuntime.create({
				authPath: join(env.agentDir, "auth.json"),
				modelsPath: join(env.agentDir, "models.json"),
			});
			if (stopped) return stopped;
			const services = await createAgentSessionServices({
				cwd: env.cwd,
				agentDir: env.agentDir,
				resourceLoaderOptions: {
					skillsOverride: (res) => ({ ...res, skills: [] }),
				},
				modelRuntime,
			});
			if (stopped) return stopped;
			let model;
			let modelName = "default";
			const spec = parseModelSpec(req?.model);
			if (spec) {
				model = services.modelRuntime.getModel(spec.provider, spec.id);
				if (!model) return fail(`llm.complete: 找不到模型 ${spec.spec}`);
				modelName = spec.spec;
			}
			if (!model && env.fallbackModel) {
				model = services.modelRuntime.getModel(env.fallbackModel.provider, env.fallbackModel.id);
				if (model) modelName = `${env.fallbackModel.provider}/${env.fallbackModel.id}`;
			}
			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(env.cwd),
				...(model ? { model } : {}),
				noTools: "all",
			});
			let disposed = false;
			abort = () => srv.session.abort();
			dispose = () => {
				if (disposed) return;
				disposed = true;
				try {
					srv.session.dispose();
				} catch {}
			};
			if (stopped) {
				dispose();
				return stopped;
			}
			if (images.length && !srv.session.model?.input?.includes("image"))
				return fail("llm.complete: selected model does not support image inputs");
			const text = system.trim() ? `系统指令：${system.trim()}\n\n---\n\n任务：${prompt}` : prompt;
			await srv.session.prompt(text, { expandPromptTemplates: false, ...(images.length ? { images } : {}) });
			if (stopped) return stopped;
			const raw = srv.session.getLastAssistantText() ?? "";
			let usage: { input: number; output: number } | undefined;
			try {
				const stats = srv.session.getSessionStats();
				usage = { input: stats.tokens.input, output: stats.tokens.output };
			} catch {}
			return { ok: true, text: raw.slice(0, maxChars), model: modelName, ...(usage ? { usage } : {}) };
		} finally {
			try {
				dispose?.();
			} catch {}
		}
	})();
	void run
		.catch(() => {})
		.finally(() => {
			inflight -= 1;
		});
	try {
		return await Promise.race([run, interruption]);
	} catch (err) {
		return fail(`llm.complete: ${(err as Error).message}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
