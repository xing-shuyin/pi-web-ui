import { describe, expect, it } from "vitest";
import {
	PASSKEY_PROMPT_MS,
	passkeyPromptDataUrl,
	passkeyPromptHtml,
	passkeyPromptText,
} from "../../browser/runtime/passkey-prompt.js";

describe("passkey local confirmation window", () => {
	it("says out loud that it is a local confirmation, not biometrics", () => {
		const zh = passkeyPromptText("zh-CN");
		expect(zh.title).toContain("本机凭据");
		expect(zh.detail).toContain("无可用生物识别");
		const en = passkeyPromptText("en-US");
		expect(en.title.toLowerCase()).toContain("local passkey");
		expect(en.detail.toLowerCase()).toContain("no biometric hardware");
	});
	it("falls back to English for other locales", () => {
		expect(passkeyPromptText("de-DE")).toEqual(passkeyPromptText("en-US"));
	});
	it("auto-completes before the host closes it, and stays a self-contained page", () => {
		const html = passkeyPromptHtml("zh-CN");
		expect(html).toContain(`}, ${Math.round(PASSKEY_PROMPT_MS * 0.6)});`);
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(html).not.toMatch(/https?:\/\//);
		// 文案里的引号/尖括号不能把标记带崩
		expect(passkeyPromptHtml("zh-CN")).not.toContain("undefined");
	});
	it("produces a data: URL the host window can load directly", () => {
		const url = passkeyPromptDataUrl("en-US");
		expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toBe(passkeyPromptHtml("en-US"));
	});
});
