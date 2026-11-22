/**
 * 模型错误分类单源（issue #978）。
 *
 * 判据只有一处：`server/model-error.ts` 的 `classifyModelError`。这一组用例同时守两件事：
 * 分类结果对不对（网关错误页 / 配额 / 鉴权 / 模型拒答 / 认不出），以及别处没有第二份
 * 状态码提取、HTML 清洗或关键词表（先有第二份实现，就会先有一份分叉的文案）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyModelError,
	extractModelErrorStatus,
	formatModelErrorBrief,
	MODEL_ERROR_SUMMARY_CAP,
	modelErrorKindLabel,
	modelErrorReport,
	summarizeModelErrorText,
} from "../../server/model-error.js";
import { withRetrySummary } from "../../server/serialize.js";
import type { UiMessage } from "../../server/protocol.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 真实报文：网关（nginx 系）默认错误页，原样被 SDK 当成 errorMessage。 */
const GATEWAY_408 =
	"408 <html><body><h1>408 Request Time-out</h1>\nYour browser didn't send a complete request in time.\n</body></html>";

function serverSources(dir = join(ROOT, "server"), out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) serverSources(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function readServerSource(rel: string): string {
	return readFileSync(join(ROOT, "server", rel), "utf8");
}

describe("classifyModelError 分类", () => {
	it("HTML 网关错误页 → gateway，摘要不含标签，原文完整保留", () => {
		const info = classifyModelError(GATEWAY_408);
		expect(info.kind).toBe("gateway");
		expect(info.status).toBe(408);
		expect(info.raw).toBe(GATEWAY_408);
		expect(info.summary).not.toMatch(/<[^>]*>/);
		expect(info.summary).not.toContain("\n");
		// 状态码单独展示：只去掉开头的裸状态码（页面标题里的「408 Request Time-out」保留）。
		expect(info.summary.startsWith("408 408")).toBe(false);
		expect(info.summary).toContain("Request Time-out");
		expect(info.summary).toContain("didn't send a complete request");
	});

	it("429 insufficient_quota → quota（重试也没用的一类）", () => {
		const info = classifyModelError("429 insufficient_quota");
		expect(info.kind).toBe("quota");
		expect(info.status).toBe(429);
	});

	it("401 invalid_api_key → auth", () => {
		const info = classifyModelError("401 invalid_api_key");
		expect(info.kind).toBe("auth");
		expect(info.status).toBe(401);
	});

	it("纯文本拒答（无状态码、无关键词）→ unknown，原文一字不少", () => {
		const text = "I'm sorry, but I can't help with that.";
		const info = classifyModelError(text);
		expect(info.kind).toBe("unknown");
		expect(info.status).toBeUndefined();
		expect(info.summary).toBe(text);
		expect(info.raw).toBe(text);
	});

	it("502 Bad Gateway / 504 网关超时页 → gateway", () => {
		expect(classifyModelError("502 Bad Gateway").kind).toBe("gateway");
		expect(classifyModelError("504 <html><body><h1>504 Gateway Time-out</h1></body></html>")).toMatchObject({
			kind: "gateway",
			status: 504,
		});
	});

	it("400 context_length_exceeded → model", () => {
		expect(classifyModelError("400 This model's maximum context length is 128000 tokens").kind).toBe("model");
	});

	it("配额关键词先于鉴权：403 带 billing 归 quota", () => {
		expect(classifyModelError("403 Your billing plan has expired").kind).toBe("quota");
	});

	it("JSON 错误体里的代码也能识别（code/status 字段）", () => {
		const info = classifyModelError('{"error":{"message":"Incorrect API key provided","code":401}}');
		expect(info.status).toBe(401);
		expect(info.kind).toBe("auth");
	});

	it("空文本不炸：unknown + 空摘要", () => {
		expect(classifyModelError("")).toEqual({ kind: "unknown", summary: "", raw: "" });
	});
});

describe("摘要清洗与状态码提取", () => {
	it("去标签、还原实体、折叠空白、截断", () => {
		expect(summarizeModelErrorText("<b>boom</b>\n\n  &amp;  gone")).toBe("boom & gone");

		const long = "x".repeat(MODEL_ERROR_SUMMARY_CAP * 2);
		const summary = summarizeModelErrorText(long);
		expect(summary.length).toBeLessThanOrEqual(MODEL_ERROR_SUMMARY_CAP);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("纯标签正文清洗成空串（原文仍可展开）", () => {
		expect(summarizeModelErrorText("<html><body></body></html>")).toBe("");
	});

	it("状态码只认 100-599，且不会把数字串当状态码", () => {
		expect(extractModelErrorStatus("HTTP 502 from upstream")).toBe(502);
		expect(extractModelErrorStatus("status: 429")).toBe(429);
		expect(extractModelErrorStatus("12345 tokens over budget")).toBeUndefined();
		expect(extractModelErrorStatus("no code here")).toBeUndefined();
	});
});

describe("服务端文案口径（通知 / verdict 与气泡同源）", () => {
	it("简报 = 分类标签 · HTTP 状态码 · 摘要", () => {
		expect(formatModelErrorBrief(classifyModelError(GATEWAY_408), "zh")).toBe(
			"网关/代理错误 · HTTP 408 · 408 Request Time-out Your browser didn't send a complete request in time.",
		);
		expect(formatModelErrorBrief(classifyModelError("Out of memory"), "en")).toBe("Model call failed · Out of memory");
	});

	it("四种分类各有中文标签，认不出回退到 unknown", () => {
		const labels = (["gateway", "auth", "quota", "model", "unknown"] as const).map((kind) =>
			modelErrorKindLabel(kind, "zh"),
		);
		expect(new Set(labels).size).toBe(5);
		expect(modelErrorKindLabel("unknown", "en")).toBe("Model call failed");
	});
});

describe("线上投影（errorInfo 不重复带原文）", () => {
	it("modelErrorReport 只留分类/状态码/摘要，原文仍在 errorMessage 上", () => {
		const report = modelErrorReport(classifyModelError(GATEWAY_408));
		expect(report).toEqual({ kind: "gateway", status: 408, summary: expect.any(String) });
		expect(Object.hasOwn(report, "raw")).toBe(false);
	});
});

describe("重试收尾（已重试 N 次后失败）", () => {
	const errorBubble: UiMessage = {
		id: "a-1",
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: GATEWAY_408,
		errorInfo: modelErrorReport(classifyModelError(GATEWAY_408)),
	};

	it("只给回合结尾那条错误气泡补次数", () => {
		const out = withRetrySummary([errorBubble], { attempt: 3, maxAttempts: 3, errorMessage: GATEWAY_408 });
		expect(out[0].errorInfo?.retries).toEqual({ attempt: 3, maxAttempts: 3 });
		expect(out[0].errorMessage).toBe(GATEWAY_408);
		expect(errorBubble.errorInfo?.retries).toBeUndefined();
	});

	it("原文对不上就不认领（上一轮的次数不会被这一轮冒领）", () => {
		const msgs = [{ ...errorBubble, errorMessage: "429 insufficient_quota" }];
		expect(withRetrySummary(msgs, { attempt: 3, maxAttempts: 3, errorMessage: GATEWAY_408 })).toBe(msgs);
	});

	it("没有收尾记录 / 没重试过 / 结尾不是错误气泡时原样返回", () => {
		expect(withRetrySummary([errorBubble], null)).toEqual([errorBubble]);
		expect(withRetrySummary([errorBubble], { attempt: 0, maxAttempts: 3, errorMessage: GATEWAY_408 })).toEqual([
			errorBubble,
		]);
		const ok: UiMessage = { id: "a-2", role: "assistant", content: [{ type: "text", text: "ok" }] };
		expect(withRetrySummary([ok], { attempt: 2, maxAttempts: 2, errorMessage: "" })).toEqual([ok]);
	});
});

describe("单源守卫：没有第二份错误分类/清洗实现", () => {
	it("classifyModelError 只定义一次", () => {
		const owners = serverSources().filter((file) => /function classifyModelError\b/.test(readFileSync(file, "utf8")));
		expect(owners.map((file) => relative(ROOT, file).replaceAll("\\", "/"))).toEqual(["server/model-error.ts"]);
	});

	it("配额/鉴权/HTML 关键词表只在 model-error.ts 里", () => {
		// 只找「拿关键词/正则做判定」的痕迹（`<!doctype|` 是探测正则的写法；
		// 直接输出 HTML 页面的地方不算），避免把设备中心的页面模板误判成第二套实现。
		const secondImplementation = /insufficient_quota|invalid_api_key|<html\[|<!doctype\|/;
		const offenders = serverSources()
			.filter((file) => !file.endsWith(join("server", "model-error.ts")))
			.filter((file) => secondImplementation.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => relative(ROOT, file).replaceAll("\\", "/"))).toEqual([]);
	});

	it("气泡 / 通知 / verdict 都走同一个入口", () => {
		expect(readServerSource("serialize.ts")).toContain("classifyModelError");
		expect(readServerSource("subagent-helpers.ts")).toContain("classifyModelError");
		expect(readServerSource("subagent-notify.ts")).toContain("formatModelErrorBrief");
		expect(readServerSource("subagents.ts")).toContain("formatModelErrorBrief");
	});

	it("序列化层自己不再清洗 HTML", () => {
		expect(readServerSource("serialize.ts")).not.toMatch(/replace\(\s*\/<\^?>|replace\(\s*\/<\[\^>\]\*>\/g/);
	});
});
