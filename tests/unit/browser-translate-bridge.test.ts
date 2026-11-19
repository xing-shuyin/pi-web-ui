import { describe, expect, it } from "vitest";
import { parseTranslateBridgeRequest, translateEndpoint } from "../../desktop/translate-bridge.js";

describe("翻译桥 URL 派生", () => {
	it("保留 origin 与 token，丢掉 Agent 的 path/hash", () => {
		expect(translateEndpoint("http://127.0.0.1:8787/?token=abc#x")).toBe(
			"http://127.0.0.1:8787/api/translate?token=abc",
		);
		expect(translateEndpoint("http://127.0.0.1:8787/agent/chat?token=abc")).toBe(
			"http://127.0.0.1:8787/api/translate?token=abc",
		);
		expect(translateEndpoint("https://example.com/")).toBe("https://example.com/api/translate");
	});
});

describe("翻译桥请求校验", () => {
	it("接受合法请求", () => {
		expect(parseTranslateBridgeRequest({ texts: ["hi"], target: "zh-CN", style: "natural" })).toEqual({
			texts: ["hi"],
			target: "zh-CN",
			style: "natural",
		});
	});
	it("拒绝注入型参数", () => {
		expect(() => parseTranslateBridgeRequest({ texts: [] })).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: ["ok"], target: "../../etc/passwd" })).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: ["ok"], style: "<script>" })).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: ["x".repeat(2001)] })).toThrow();
	});
});
