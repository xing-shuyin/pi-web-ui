import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getServerBlock, pick, type ServerLang } from "./i18n.js";

type CompleteSimpleArgs = Parameters<ModelRuntime["completeSimple"]>;
export type VisionModel = CompleteSimpleArgs[0];
export type VisionContext = CompleteSimpleArgs[1];

export interface VisionModelRef {
	provider: string;
	id: string;
	label: string;
}

const TRANSCRIBE_TIMEOUT_MS = Number(process.env.PI_WEB_VISION_TIMEOUT_MS ?? 90_000);
const MAX_TRANSCRIBE_TOKENS = 4000;

export function findVisionModels(runtime: ModelRuntime): VisionModelRef[] {
	const out: VisionModelRef[] = [];
	for (const p of runtime.getProviders()) {
		if (!runtime.hasConfiguredAuth(p.id)) continue;
		for (const m of runtime.getModels(p.id)) {
			if (m.input?.includes("image")) {
				out.push({
					provider: p.id,
					id: m.id,
					label: `${m.name ?? m.id} (${p.id})`,
				});
			}
		}
	}
	return out;
}

/**
 * Evidence-first transcription prompt, modeled on modlens' output contract:
 * full verbatim text, reading-order layout blocks, entities/relations, chart
 * axes & data. Emphasizes honesty over hallucination.
 *
 * Exported so the settings panel can offer a custom prompt (append to this
 * default or replace it entirely).
 */
export const SYSTEM_PROMPT = `You are a vision bridge for a text-only language model. You receive one or more images and must transcribe them into precise, structured text evidence so another model that cannot see images can answer questions about them accurately.

Follow these rules:
1. Transcribe ALL visible text verbatim, preserving wording, spelling, punctuation and line breaks. This is the most important part — the reader relies on your transcription, not on the image.
2. Describe the layout in reading order: headers, paragraphs, lists, tables, buttons, panels — say what appears where.
3. For tables/charts/diagrams: read axes, scales (note log scale), legend entries, series names, highlighted points and their coordinates, and any data values you can discern.
4. Name entities: people, products, companies, colors, style, objects, actions.
5. If part of the image is too blurry/low-resolution to read, say "（读不清）" or "unclear" for that part — NEVER invent or guess content you cannot see.
6. If there are multiple images, address them in order (图 1 / Image 1, 图 2 / Image 2, ...).
7. Output only the transcript. No preamble, no commentary about the image itself.`;

export const SYSTEM_PROMPT_ZH = `你是文本模型的视觉桥。你会收到一张或多张图片，必须把它们转写成精确的结构化文字证据，让看不到图片的模型也能准确回答相关问题。

规则：
1. 逐字转写所有可见文本，保留措辞、拼写、标点与换行。这是最重要的部分——阅读者依赖你的转写，而非图片本身。
2. 按阅读顺序描述版式：标题、段落、列表、表格、按钮、面板——说明它们出现的位置。
3. 表格/图表/示意图：读出坐标轴、刻度（注意对数轴）、图例项、系列名、高亮点及其坐标，以及能辨认的数据值。
4. 点名实体：人物、产品、公司、颜色、风格、物体、动作。
5. 图片局部太模糊/分辨率太低读不清时，对该部分写“（读不清）”或 "unclear”——绝不编造或猜测看不见的内容。
6. 多张图片时按顺序逐张处理（图 1 / Image 1，图 2 / Image 2，……）。
7. 只输出转写结果，不加开场白，不评论图片本身。`;

export function getVisionSystemPrompt(lang: ServerLang = "en"): string {
	return getServerBlock(lang, "vision.system", SYSTEM_PROMPT_ZH.split("\n"), SYSTEM_PROMPT.split("\n")).join("\n");
}

export function buildVisionBridgePrompt(mode: "append" | "replace", custom: string, lang: ServerLang = "en"): string {
	const text = custom?.trim() ?? "";
	const base = getVisionSystemPrompt(lang);
	if (mode === "replace" && text) return text;
	if (text) return `${base}\n\n${text}`;
	return base;
}

function buildUserPrompt(count: number, lang: ServerLang = "en"): string {
	if (count <= 1) {
		return pick(
			lang,
			"请逐字转写这张图片的内容，并按上述规则输出结构化文字证据。",
			"Transcribe this image verbatim and output structured text evidence following the rules above.",
			"vision.transcribe.single",
		);
	}
	return pick(
		lang,
		`请按图片顺序（图 1 到 图 ${count}）逐张转写每张图片的内容，并按上述规则输出结构化文字证据。`,
		`Transcribe each image in order (Image 1 to Image ${count}) and output structured text evidence following the rules above.`,
		"vision.transcribe.batch",
		{ count },
	);
}

export interface BridgeImage {
	data: string;
	mimeType: string;
	name?: string;
}

export interface TranscribeOptions {
	signal?: AbortSignal;
	model?: VisionModel;
	systemPrompt?: string;
	lang?: ServerLang;
}

export async function transcribeImages(
	runtime: ModelRuntime,
	images: BridgeImage[],
	options: TranscribeOptions = {},
): Promise<string> {
	const lang: ServerLang = options.lang ?? "en";
	const model =
		options.model ??
		(() => {
			const found = findVisionModels(runtime);
			if (found.length === 0) {
				throw new Error(
					pick(
						lang,
						"未找到可用的视觉模型（models.json 中没有任何 input 含 image 的模型）",
						"No vision-capable model found (no model with image input in models.json)",
						"vision.model.not.found",
					),
				);
			}
			return runtime.getModel(found[0].provider, found[0].id);
		})();
	if (!model)
		throw new Error(
			pick(
				lang,
				"视觉模型不可用（ModelRuntime.getModel 返回空）",
				"Vision model unavailable (ModelRuntime.getModel returned empty)",
				"vision.model.unavailable",
			),
		);

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS);
	const onOuterAbort = () => ac.abort();
	options.signal?.addEventListener("abort", onOuterAbort);
	try {
		const imageBlocks = images.map((img) => ({
			type: "image" as const,
			data: img.data.replace(/^data:[^;]*;base64,/, ""),
			mimeType: img.mimeType?.startsWith("image/") ? img.mimeType : "image/png",
		}));
		const context: VisionContext = {
			systemPrompt: options.systemPrompt ?? getVisionSystemPrompt(lang),
			messages: [
				{
					role: "user",
					timestamp: Date.now(),
					content: [...imageBlocks, { type: "text", text: buildUserPrompt(images.length, lang) }],
				},
			],
		};
		const msg = await runtime.completeSimple(model, context, {
			signal: ac.signal,
			maxTokens: MAX_TRANSCRIBE_TOKENS,
		});
		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			throw new Error(
				msg.errorMessage ||
					pick(
						lang,
						`视觉模型异常终止（${msg.stopReason}）`,
						`Vision model terminated abnormally (${msg.stopReason})`,
						"vision.model.terminated",
						{ "msg.stopReason": msg.stopReason },
					),
			);
		}
		const text = msg.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("\n")
			.trim();
		if (!text) {
			throw new Error(
				pick(
					lang,
					"视觉模型返回了空的转写结果",
					"Vision model returned an empty transcript",
					"vision.transcript.empty",
				),
			);
		}
		return text;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
}
