/**
 * 内置默认提示词配置的存量收敛（issue: 提示词配置改为内置默认）：
 * - 已下线的来源（`{{guidelines}}` / `{{pi_docs}}`）不得留在 promptDisabled / promptOverrides 里；
 * - soul 覆盖与内置默认逐字相同时收敛为空（等于没覆盖，面板不该显示「已改」）。
 * 事实源：server/client-state.ts 的 normalizePromptDisabled / normalizePromptOverrides。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore, normalizePromptDisabled, normalizePromptOverrides } from "../../server/client-state.js";
import { BUILTIN_SOUL, DEFAULT_PROMPT_DISABLED } from "../../server/prompt-composer.js";

describe("normalizePromptDisabled — 剔除已下线来源", () => {
	it("存量里的 guidelines / pi_docs 被剔除，其余保留", () => {
		const out = normalizePromptDisabled({
			promptDisabled: ["plugin_dev", "pi_docs", "guidelines"],
			_promptPluginDevConfigured: true,
		});
		expect(out).toEqual(["plugin_dev"]);
	});

	it("没有存过 promptDisabled 时用出厂默认", () => {
		expect(normalizePromptDisabled(null)).toEqual([...DEFAULT_PROMPT_DISABLED]);
		expect(normalizePromptDisabled({ _promptPluginDevConfigured: true })).toEqual([...DEFAULT_PROMPT_DISABLED]);
	});
});

describe("normalizePromptOverrides — 剔除死键与等于内置默认的 soul 覆盖", () => {
	it("已下线来源键（guidelines / pi_docs）直接丢弃", () => {
		const out = normalizePromptOverrides({
			guidelines: "旧行为准则",
			pi_docs: "旧文档指引",
			append: "使用uv fnm gh",
		});
		expect(out).toEqual({ append: "使用uv fnm gh" });
	});

	it("soul 覆盖与内置默认（纯英文）逐字相同 → 丢弃；不同则保留", () => {
		expect(normalizePromptOverrides({ soul: BUILTIN_SOUL })).toEqual({});
		expect(normalizePromptOverrides({ soul: `  ${BUILTIN_SOUL}\n` })).toEqual({});
		expect(normalizePromptOverrides({ soul: "自定义人格" })).toEqual({ soul: "自定义人格" });
		// 中文旧文案不再是内置默认 → 当作用户自己的覆盖保留
		expect(normalizePromptOverrides({ soul: "# Core Engineering Principles\n- **Think First**" })).toEqual({
			soul: "# Core Engineering Principles\n- **Think First**",
		});
	});
});

describe("ClientStateStore 载入时跑收敛（老存档升级）", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-prompt-converge-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("老存档里等于内置默认的 soul 覆盖与已下线停用项被清掉，append 覆盖保留", () => {
		writeFileSync(
			file,
			JSON.stringify({
				__settings__: {
					projects: [],
					settings: {
						promptTemplate: "{{soul}}\n\n{{context}}\n\n{{tools}}\n\n{{skills}}\n\n{{cwd}}\n\n{{append}}",
						promptOverrides: { soul: BUILTIN_SOUL, append: "使用uv fnm gh" },
						promptDisabled: ["plugin_dev", "pi_docs", "guidelines"],
						_promptPluginDevConfigured: true,
					},
				},
			}),
			"utf8",
		);
		const s = store.getSettings("c1");
		expect(s.promptOverrides).toEqual({ append: "使用uv fnm gh" });
		expect(s.promptDisabled).toEqual(["plugin_dev"]);
		expect(s.promptTemplate).toBe("{{soul}}\n\n{{context}}\n\n{{tools}}\n\n{{skills}}\n\n{{cwd}}\n\n{{append}}");
	});
});
