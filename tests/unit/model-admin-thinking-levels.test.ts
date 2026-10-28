// 思考档位（models.json 模型级 thinkingLevelMap）回归 —— issue #771。
//
// pi-ai 的 getSupportedThinkingLevels() 只有在模型带 thinkingLevelMap 且 xhigh/max
// 有显式映射时才开放这两个档位，所以自定义服务商（vLLM / 聚合网关）必须：
//   1. 刷新模型列表时把网关自报的 reasoning_levels 推导成 thinkingLevelMap；
//   2. 保存 / 合并 / 下发时保留该字段（不能被 UI 认识的字段白名单抹掉）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildThinkingLevelMapFromMeta,
	mergeProviderConfigEntry,
	ModelAdminService,
	sanitizeThinkingLevelMap,
	type ModelAdminHost,
} from "../../server/model-admin.js";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig } from "../../server/protocol.js";

describe("buildThinkingLevelMapFromMeta", () => {
	it("网关报全 7 档（none…max）时映射到 pi 的 off…max", () => {
		const map = buildThinkingLevelMapFromMeta({
			reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		});
		expect(map).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("supported_reasoning_levels[].effort 形状（OpenAI 风格枚举对象）", () => {
		const map = buildThinkingLevelMapFromMeta({
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
		});
		expect(map).toEqual({ minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: null });
		// off 永不隐藏：网关没报 none/off 时缺键（= 仍可选），不写 null
		expect(map && "off" in map).toBe(false);
	});

	it("只报 low/high/max 的网关：其余档位显式 null（下拉不再出现它们）", () => {
		expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ["low", "high", "max"] })).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("字典与逗号串形状也能解析", () => {
		expect(buildThinkingLevelMapFromMeta({ reasoningLevels: { low: true, high: true, medium: false } })).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(buildThinkingLevelMapFromMeta({ engineering: "x", thinking_levels: "low,high,max" })).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("无元数据 / 只报「关思考」/ 与 pi 默认能力一致时不产出映射", () => {
		expect(buildThinkingLevelMapFromMeta(undefined)).toBeUndefined();
		expect(buildThinkingLevelMapFromMeta({ id: "m" })).toBeUndefined();
		expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ["none"] })).toBeUndefined();
		expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ["minimal", "low", "medium", "high"] })).toBeUndefined();
	});

	it("别名字面值归一化（MEDIUM / extra-high / X_HIGH）", () => {
		expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ["MEDIUM", "extra-high"] })).toEqual({
			minimal: null,
			low: null,
			medium: "MEDIUM",
			high: null,
			xhigh: "extra-high",
			max: null,
		});
	});
});

describe("sanitizeThinkingLevelMap", () => {
	it("只保留 pi 认识的 7 个键，非法值丢弃", () => {
		expect(sanitizeThinkingLevelMap({ low: "low", high: null, max: 3, bogus: "x", xhigh: "  " } as unknown)).toEqual({
			low: "low",
			high: null,
		});
	});

	it("空对象 / 非对象 → undefined", () => {
		expect(sanitizeThinkingLevelMap({})).toBeUndefined();
		expect(sanitizeThinkingLevelMap(null)).toBeUndefined();
		expect(sanitizeThinkingLevelMap(["low"])).toBeUndefined();
	});
});

/** 覆盖内置 provider 的 models.json 条目：thinkingLevelMap 是 UI 不认识的字段。 */
const storedEntry = {
	api: "openai-completions",
	baseUrl: "https://gateway.test/v1",
	models: [
		{
			id: "auto/deepseek-v4.1-flash",
			thinkingLevelMap: {
				off: "none",
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			contextWindow: 1000000,
		},
	],
};

function makeHost(agentDir: string, notices: ServerMessage[]) {
	return {
		agentDir,
		emit: (msg: ServerMessage) => {
			notices.push(msg);
		},
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () => ({ refresh: async () => {}, setRuntimeApiKey: async () => {} }) as unknown as ModelRuntime,
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	} satisfies ModelAdminHost;
}

/** 表单只带 UI 认识的字段（前端草稿往返）。 */
const formRows: UiModelConfigEntry[] = [{ id: "auto/deepseek-v4.1-flash", reasoning: true, contextWindow: 1000000 }];
const formConfig: UiProviderConfig = {
	providerId: "gateway",
	api: "openai-completions",
	baseUrl: "https://gateway.test/v1",
	models: formRows,
};

describe("mergeProviderConfigEntry / 保存 / 下发往返", () => {
	it("表单没带 thinkingLevelMap → 磁盘上的手写映射原样保留", () => {
		const merged = mergeProviderConfigEntry({ models: storedEntry.models }, formConfig, formRows);
		expect((merged.models as Record<string, unknown>[])[0].thinkingLevelMap).toEqual(
			storedEntry.models[0].thinkingLevelMap,
		);
	});

	it("表单带了 thinkingLevelMap → 覆盖磁盘值（未知键被净化掉）", () => {
		const rows: UiModelConfigEntry[] = [
			{ id: "auto/deepseek-v4.1-flash", reasoning: true, thinkingLevelMap: { low: "low", bogus: "x" } as never },
		];
		const merged = mergeProviderConfigEntry({ models: storedEntry.models }, { ...formConfig, models: rows }, rows);
		expect((merged.models as Record<string, unknown>[])[0].thinkingLevelMap).toEqual({ low: "low" });
	});

	it("保存 → models.json 保留映射，models_config 下发给浏览器时也带着它", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-thinking-levels-"));
		const configPath = join(agentDir, "models.json");
		writeFileSync(configPath, JSON.stringify({ providers: { gateway: storedEntry } }, null, 2) + "\n");
		const notices: ServerMessage[] = [];
		try {
			const service = new ModelAdminService(makeHost(agentDir, notices));
			await service.saveModelConfig("gateway", formConfig);

			const written = JSON.parse(readFileSync(configPath, "utf8")) as {
				providers: Record<string, { models: Record<string, unknown>[] }>;
			};
			expect(written.providers.gateway.models[0].thinkingLevelMap).toEqual(storedEntry.models[0].thinkingLevelMap);

			// listModelsConfig（saveModelConfig 尾部的 writeModelsConfigAndReload 会推一次）
			const pushed = notices.filter((msg) => msg.type === "models_config").pop() as
				{ providers: UiProviderConfig[] } | undefined;
			expect(pushed?.providers[0].models[0].thinkingLevelMap).toEqual(storedEntry.models[0].thinkingLevelMap);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
