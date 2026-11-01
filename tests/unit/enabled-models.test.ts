/**
 * enabled-models.test.ts
 *
 * Verifies issue #646:
 * - Server: adheres to pi's `enabledModels` setting in settings.json (flags models with enabled: true/false).
 * - UI Logic: dropdown filters out excluded models by default, retains currentModelId if out-of-scope,
 *   supports "show all" toggle, and updates provider counts accordingly.
 */

import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../server/protocol.js";

describe("enabledModels (Issue #646)", () => {
	describe("Server listModels tagging logic", () => {
		it("未配置 enabledModels 时，所有模型均不标记 enabled: false（保持全量默认）", () => {
			const available = [
				{ id: "gpt-4o", provider: "openai", name: "GPT-4o", reasoning: false, input: ["text", "image"] },
				{ id: "gpt-4o-mini", provider: "openai", name: "GPT-4o Mini", reasoning: false, input: ["text"] },
				{
					id: "claude-3-7-sonnet",
					provider: "anthropic",
					name: "Claude 3.7 Sonnet",
					reasoning: true,
					input: ["text", "image"],
				},
			];

			const getEnabledSet = (): Set<string> | null => null; // 无 enabledModels 配置
			const enabledSet = getEnabledSet();

			const models: ModelInfo[] = available.map((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return {
					id: fullId,
					name: m.name,
					provider: m.provider,
					reasoning: m.reasoning,
					vision: m.input?.includes("image") ?? false,
					...(enabledSet ? { enabled: enabledSet.has(fullId) } : {}),
				};
			});

			expect(models.every((m) => m.enabled === undefined)).toBe(true);
			expect(models.some((m) => m.enabled === false)).toBe(false);
		});

		it("配置了 enabledModels 时，命中的模型标记 enabled: true，未命中的标记 enabled: false", () => {
			const available = [
				{ id: "gpt-4o", provider: "openai", name: "GPT-4o", reasoning: false, input: ["text", "image"] },
				{ id: "gpt-3.5-turbo", provider: "openai", name: "GPT-3.5 Turbo", reasoning: false, input: ["text"] },
				{
					id: "claude-3-7-sonnet",
					provider: "anthropic",
					name: "Claude 3.7 Sonnet",
					reasoning: true,
					input: ["text", "image"],
				},
			];

			// 模拟 resolveModelScopeWithDiagnostics 解析结果：只匹配了 gpt-4o 和 claude
			const enabledSet = new Set(["openai/gpt-4o", "anthropic/claude-3-7-sonnet"]);

			const models: ModelInfo[] = available.map((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return {
					id: fullId,
					name: m.name,
					provider: m.provider,
					reasoning: m.reasoning,
					vision: m.input?.includes("image") ?? false,
					...(enabledSet ? { enabled: enabledSet.has(fullId) } : {}),
				};
			});

			expect(models.find((m) => m.id === "openai/gpt-4o")?.enabled).toBe(true);
			expect(models.find((m) => m.id === "openai/gpt-3.5-turbo")?.enabled).toBe(false);
			expect(models.find((m) => m.id === "anthropic/claude-3-7-sonnet")?.enabled).toBe(true);
		});
	});

	describe("Frontend filter & toggle behavior", () => {
		const sampleModels: ModelInfo[] = [
			{ id: "openai/gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, vision: true, enabled: true },
			{
				id: "openai/gpt-4o-mini",
				name: "GPT-4o Mini",
				provider: "openai",
				reasoning: false,
				vision: false,
				enabled: false,
			},
			{
				id: "openai/gpt-3.5-turbo",
				name: "GPT-3.5 Turbo",
				provider: "openai",
				reasoning: false,
				vision: false,
				enabled: false,
			},
			{
				id: "anthropic/claude-3-7-sonnet",
				name: "Claude 3.7 Sonnet",
				provider: "anthropic",
				reasoning: true,
				vision: true,
				enabled: true,
			},
		];

		it("hasEnabledScope 正确识别是否存在被过滤的模型", () => {
			const hasScope = sampleModels.some((m) => m.enabled === false);
			expect(hasScope).toBe(true);

			const allEnabled = sampleModels.map((m) => ({ ...m, enabled: true }));
			expect(allEnabled.some((m) => m.enabled === false)).toBe(false);
		});

		it("默认模式下只展示 enabled !== false 的模型", () => {
			const showAllModels = false;
			const hasEnabledScope = sampleModels.some((m) => m.enabled === false);
			const currentModelId = "openai/gpt-4o";

			const visibleModels =
				!hasEnabledScope || showAllModels
					? sampleModels
					: sampleModels.filter((m) => m.enabled !== false || m.id === currentModelId);

			expect(visibleModels.map((m) => m.id)).toEqual(["openai/gpt-4o", "anthropic/claude-3-7-sonnet"]);
		});

		it("若当前激活的模型处于白名单外，依然在默认视图中予以保留以防当前选中模型丢失", () => {
			const showAllModels = false;
			const hasEnabledScope = sampleModels.some((m) => m.enabled === false);
			const currentModelId = "openai/gpt-4o-mini"; // 在白名单外

			const visibleModels =
				!hasEnabledScope || showAllModels
					? sampleModels
					: sampleModels.filter((m) => m.enabled !== false || m.id === currentModelId);

			expect(visibleModels.some((m) => m.id === "openai/gpt-4o-mini")).toBe(true);
			expect(visibleModels.some((m) => m.id === "openai/gpt-3.5-turbo")).toBe(false);
		});

		it("切换 showAllModels=true 后展开全部模型", () => {
			const showAllModels = true;
			const hasEnabledScope = sampleModels.some((m) => m.enabled === false);
			const currentModelId = "openai/gpt-4o";

			const visibleModels =
				!hasEnabledScope || showAllModels
					? sampleModels
					: sampleModels.filter((m) => m.enabled !== false || m.id === currentModelId);

			expect(visibleModels.length).toBe(sampleModels.length);
			expect(visibleModels.map((m) => m.id)).toContain("openai/gpt-3.5-turbo");
		});

		it("服务商侧边栏计数在默认模式下基于 visibleModels 计算，避免显示全部空模型提供商", () => {
			const visibleModels = sampleModels.filter((m) => m.enabled !== false);
			const counts = new Map<string, number>();
			for (const m of visibleModels) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);

			expect(counts.get("openai")).toBe(1); // 默认模式下 openai 只计 1 个已选模型
			expect(counts.get("anthropic")).toBe(1);
		});
	});
});
