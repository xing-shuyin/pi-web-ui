import { describe, expect, it } from "vitest";
import {
	DEFAULT_CODEMODE_INLINE_BUDGET,
	DEFAULT_CODEMODE_MODE,
	normalizeCodemodeInlineBudget,
	normalizeCodemodeMode,
} from "../../server/client-state.js";
import { sanitizePresetSettings } from "../../server/preset-share.js";
import { parseCodemodeArgs } from "../../web/src/tool-args.js";

describe("codemode 进阶特性与配置增强", () => {
	describe("规范化函数 (normalizeCodemodeMode & normalizeCodemodeInlineBudget)", () => {
		it("规范化 codemodeMode：仅允许 'on' 与 'only'，其余默认回落 'on'", () => {
			expect(normalizeCodemodeMode("on")).toBe("on");
			expect(normalizeCodemodeMode("only")).toBe("only");
			expect(normalizeCodemodeMode("invalid")).toBe("on");
			expect(normalizeCodemodeMode(undefined)).toBe("on");
			expect(normalizeCodemodeMode(null)).toBe("on");
			expect(normalizeCodemodeMode(123)).toBe("on");
			expect(DEFAULT_CODEMODE_MODE).toBe("on");
		});

		it("规范化 codemodeInlineBudget：正数向下取整，其余回落 3000", () => {
			expect(normalizeCodemodeInlineBudget(5000)).toBe(5000);
			expect(normalizeCodemodeInlineBudget(4500.8)).toBe(4500);
			expect(normalizeCodemodeInlineBudget(0)).toBe(3000);
			expect(normalizeCodemodeInlineBudget(-100)).toBe(3000);
			expect(normalizeCodemodeInlineBudget(Number.NaN)).toBe(3000);
			expect(normalizeCodemodeInlineBudget(Number.POSITIVE_INFINITY)).toBe(3000);
			expect(normalizeCodemodeInlineBudget("5000")).toBe(3000);
			expect(DEFAULT_CODEMODE_INLINE_BUDGET).toBe(3000);
		});
	});

	describe("预设分享净化 (sanitizePresetSettings)", () => {
		it("接受合法的 codemodeMode 和 codemodeInlineBudget", () => {
			const res = sanitizePresetSettings({
				codemodeMode: "only",
				codemodeInlineBudget: 6000,
			});
			expect(res.settings.codemodeMode).toBe("only");
			expect(res.settings.codemodeInlineBudget).toBe(6000);
			expect(res.rejected).toEqual([]);
		});

		it("拒绝非法的 codemodeMode 值", () => {
			const res = sanitizePresetSettings({
				codemodeMode: "banana",
			});
			expect(res.settings.codemodeMode).toBeUndefined();
			expect(res.rejected).toContain("codemodeMode");
		});

		it("拒绝非法的 codemodeInlineBudget 值", () => {
			const res = sanitizePresetSettings({
				codemodeInlineBudget: -10,
			});
			expect(res.settings.codemodeInlineBudget).toBeUndefined();
			expect(res.rejected).toContain("codemodeInlineBudget");
		});
	});

	describe("参数解析与指令头识别 (parseCodemodeArgs)", () => {
		it("解析 JSON 包装的源码与 // @options: 首行", () => {
			const jsonInput = JSON.stringify({
				code: '// @options: {"timeout_ms": 15000, "max_output_tokens": 2000}\nconst x = 1;\nreturn x;',
			});
			const parsed = parseCodemodeArgs(jsonInput);
			expect(parsed.code).toContain("const x = 1;");
			expect(parsed.options).toEqual({ timeout_ms: 15000, max_output_tokens: 2000 });
		});

		it("解析直接透传的原始 JS 源码", () => {
			const rawInput = '// @options: {"max_output_tokens": 500}\nconsole.log("hello");';
			const parsed = parseCodemodeArgs(rawInput);
			expect(parsed.code).toContain('console.log("hello");');
			expect(parsed.options).toEqual({ max_output_tokens: 500 });
		});
	});

	describe("生成的图像文本识别正则", () => {
		it("能准确从输出中提取 [Image saved to <path> (<mime>, <size>)]", () => {
			const output = `Script completed
Wall time 2.1 seconds
Output:
==> text 1/2 <==
[Image saved to /tmp/pi-codemode-123.png (image/png, 45.2 KB)]
==> text 2/2 <==
[Image saved to /tmp/pi-codemode-456.jpg (image/jpeg, 12.0 KB)]
<console_output>
done
</console_output>`;

			const regex = /\[Image saved to (.*?) \((.*?)\)\]/g;
			const list: { path: string; info: string }[] = [];
			let m: RegExpExecArray | null;
			while ((m = regex.exec(output)) !== null) {
				list.push({ path: m[1], info: m[2] });
			}

			expect(list).toHaveLength(2);
			expect(list[0]).toEqual({ path: "/tmp/pi-codemode-123.png", info: "image/png, 45.2 KB" });
			expect(list[1]).toEqual({ path: "/tmp/pi-codemode-456.jpg", info: "image/jpeg, 12.0 KB" });
		});
	});
});
