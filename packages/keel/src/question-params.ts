import { Type, type TSchema } from "typebox";

// 结构化提问的唯一 schema 单源：富档给 ask_user_question，转发档给 communicate / conversation consult。
// 转发档少声明富字段但不减能力——TypeBox 默认不写 additionalProperties:false，富字段照样通过校验原样转发。

/** 富选项：浏览器弹窗里渲染的单个选项。 */
export function questionOptionSchema() {
	return Type.Object({
		label: Type.String({ minLength: 1, description: "Display label (1-5 words)" }),
		description: Type.Optional(Type.String({ description: "Short explanation of impact/tradeoff" })),
		preview: Type.Optional(Type.String({ description: "Optional preview (markdown/HTML/code)" })),
		recommended: Type.Optional(Type.Boolean({ description: "Highlight as recommended option" })),
	});
}

/** 富问题：一条问题（含富选项、联动、动态选项）。 */
export function richQuestionSchema() {
	const options = Type.Array(questionOptionSchema(), {
		description: "2-4 choices (recommended option first)",
		minItems: 2,
		maxItems: 4,
	});
	return Type.Object({
		id: Type.String({ minLength: 1, description: "Unique identifier (snake_case)" }),
		question: Type.String({ minLength: 1, description: "Question text (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional context under question" })),
		header: Type.Optional(Type.String({ description: "Optional short header" })),
		options: Type.Optional(options),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple choices (default: false)" })),
		dependsOn: Type.Optional(
			Type.Object({
				questionId: Type.String({ description: "Prior question ID" }),
				value: Type.Optional(
					Type.Union([Type.String(), Type.Array(Type.String())], {
						description: "Show when prior answer matches",
					}),
				),
			}),
		),
		optionsMap: Type.Optional(
			Type.Record(Type.String(), Type.Array(questionOptionSchema(), { minItems: 2, maxItems: 4 }), {
				description: "Dynamic options keyed by prior answer",
			}),
		),
	});
}

/** 富问题列表：弹窗能力的事实源。 */
export function richQuestionsSchema(description = "Questions to ask (prefer 1).") {
	return Type.Array(richQuestionSchema(), { description, minItems: 1, maxItems: 3 });
}

/** 弹窗专属字段：模型不需要声明，导出 schema 里省略；运行时照常接收。 */
const ASK_HIDDEN_QUESTION_FIELDS = ["header", "dependsOn", "optionsMap"] as const;

/** 纯装饰的 JSON Schema 关键字：发给模型前删掉，运行时校验留在原处。 */
const DECORATION_KEYS = ["description", "minItems", "maxItems", "minLength", "minimum", "maximum"] as const;

function stripDecoration(node: unknown): void {
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		// `properties` 的键是字段名（可能就叫 description），只下沉不删除。
		if (key === "properties") {
			if (value && typeof value === "object") for (const child of Object.values(value)) stripDecoration(child);
			continue;
		}
		if ((DECORATION_KEYS as readonly string[]).includes(key)) {
			delete record[key];
			continue;
		}
		stripDecoration(value);
	}
}

/**
 * `ask_user_question` 的导出参数：富档的派生视图 —— 去掉弹窗专属字段与装饰关键字，
 * 模型只看到「问什么、给哪些选项」。字段定义仍只有 {@link richQuestionSchema} 一处。
 */
export function askQuestionsSchema(): TSchema {
	const schema = richQuestionsSchema() as unknown as { items: { properties: Record<string, unknown> } };
	for (const key of ASK_HIDDEN_QUESTION_FIELDS) delete schema.items.properties[key];
	const optionItems = (
		schema.items.properties.options as { items?: { properties?: Record<string, unknown> } } | undefined
	)?.items;
	if (optionItems?.properties) delete optionItems.properties.preview;
	stripDecoration(schema);
	return schema as unknown as TSchema;
}

/** 转发问题列表：只声明跨对话转发时必须填的字段。 */
export function relayQuestionsSchema(description: string) {
	return Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			question: Type.String({ minLength: 1 }),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1 }),
						description: Type.Optional(Type.String()),
					}),
					{ minItems: 2, maxItems: 4 },
				),
			),
			multiSelect: Type.Optional(Type.Boolean()),
		}),
		{ description, minItems: 1, maxItems: 3 },
	);
}

/** 回答列表：`communicate reply` 与 `conversation answer` 共用。 */
export function answersSchema(description?: string) {
	return Type.Array(
		Type.Object({
			id: Type.String(),
			selected: Type.Array(Type.String()),
			custom: Type.Optional(Type.String()),
		}),
		{ minItems: 1, maxItems: 3, ...(description ? { description } : {}) },
	);
}
