import { describe, expect, it } from "vitest";
import {
	resolveModelProtocol,
	isProtocolSupportedByEngine,
	isModelProtocolSupportedByEngine,
} from "../../server/model-resolver.js";

describe("多引擎实际协议类型（Protocol-Based）针对性过滤规范", () => {
	it("resolveModelProtocol 准确解析实际协议，绝不依据名字猜测", () => {
		expect(resolveModelProtocol("openai-completions")).toBe("openai-completions");
		expect(resolveModelProtocol("openai-responses")).toBe("openai-responses");
		expect(resolveModelProtocol("anthropic-messages")).toBe("anthropic-messages");
		expect(resolveModelProtocol("google-generative-ai")).toBe("google-generative-ai");

		expect(resolveModelProtocol(undefined, "anthropic")).toBe("anthropic-messages");
		expect(resolveModelProtocol(undefined, "google")).toBe("google-generative-ai");
		expect(resolveModelProtocol(undefined, "deepseek")).toBe("openai-completions");
		expect(resolveModelProtocol(undefined, "openai")).toBe("openai-completions");
		expect(resolveModelProtocol(undefined, "custom-provider")).toBe("openai-completions");
	});

	it("DSH 引擎：按实际协议过滤（放行 OpenAI 兼容协议，严打 Anthropic 协议）", () => {
		expect(isProtocolSupportedByEngine("dsh", "openai-completions", "my-gateway")).toBe(true);
		expect(
			isModelProtocolSupportedByEngine("dsh", {
				api: "openai-completions",
				providerId: "oneapi-proxy",
				modelId: "claude-3-7-sonnet",
			}),
		).toBe(true);

		expect(isProtocolSupportedByEngine("dsh", "anthropic-messages", "deepseek-anthropic-gw")).toBe(false);
		expect(
			isModelProtocolSupportedByEngine("dsh", {
				api: "anthropic-messages",
				providerId: "deepseek-proxy",
				modelId: "deepseek-chat",
			}),
		).toBe(false);

		expect(isProtocolSupportedByEngine("dsh", undefined, "anthropic")).toBe(false);

		expect(isProtocolSupportedByEngine("dsh", "google-generative-ai", "google")).toBe(false);
		expect(isProtocolSupportedByEngine("dsh", undefined, "google")).toBe(false);

		expect(isProtocolSupportedByEngine("dsh", "openai-completions", "deepseek")).toBe(true);
		expect(isProtocolSupportedByEngine("dsh", "openai-responses", "openai")).toBe(true);
		expect(isProtocolSupportedByEngine("dsh", undefined, "deepseek")).toBe(true);
	});

	it("Claude Code 引擎：严格只认 Anthropic Messages 协议", () => {
		expect(isProtocolSupportedByEngine("claude", "anthropic-messages", "local-proxy")).toBe(true);
		expect(
			isModelProtocolSupportedByEngine("claude", {
				api: "anthropic-messages",
				providerId: "custom-proxy",
				modelId: "deepseek-r1-via-claude-api",
			}),
		).toBe(true);

		expect(isProtocolSupportedByEngine("claude", "openai-completions", "oneapi")).toBe(false);
		expect(
			isModelProtocolSupportedByEngine("claude", {
				api: "openai-completions",
				providerId: "oneapi",
				modelId: "claude-3-5-sonnet",
			}),
		).toBe(false);

		expect(isProtocolSupportedByEngine("claude", undefined, "anthropic")).toBe(true);
	});

	it("Pi Durable 引擎与 Pi 原生引擎支持主流标准协议全集", () => {
		expect(isProtocolSupportedByEngine("pi", "openai-completions")).toBe(true);
		expect(isProtocolSupportedByEngine("pi", "anthropic-messages")).toBe(true);
		expect(isProtocolSupportedByEngine("pi", "google-generative-ai")).toBe(true);

		expect(resolveModelProtocol(undefined, "google-vertex", "gemini-2.5-flash")).toBe("google-vertex");
		expect(isProtocolSupportedByEngine("durable", "google-vertex")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", undefined, "google-vertex")).toBe(true);
		expect(isProtocolSupportedByEngine("dsh", undefined, "google-vertex")).toBe(false);
		expect(isProtocolSupportedByEngine("claude", "google-vertex")).toBe(false);
		expect(isProtocolSupportedByEngine("durable", "unsupported-api")).toBe(false);

		expect(isProtocolSupportedByEngine("durable", "openai-completions")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "openai-responses")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "anthropic-messages")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "google-generative-ai")).toBe(true);
	});
});
