import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

/**
 * Bot 没配模型时的兜底：本机默认模型 → 工作区/项目模型 → 当前会话正在用的模型。
 *
 * 真实回归 1：dev 客户端没设「默认模型」时，`captureModel(undefined)` 直接抛
 * "Bot requires an explicit local default model"，而且抛在 `newChat` 的 try 之外——
 * 点 Bot 行没有任何反应（unhandled rejection）。
 *
 * 真实回归 2：刷新/重启后重开私聊走 `switchSession`，运行时工厂里只传 `undefined`，
 * 于是「没给 Bot 配模型」永远打不开这条转录。兜底必须在**用到模型的每个入口**都成立。
 */

const fallbackOf = protoMethod(ClientSession.prototype, "botFallbackModel") as unknown as (
	cwd?: string,
) => string | undefined;

function sessionWith(
	defaultModel: string | undefined,
	activeModel: { provider: string; id: string } | undefined,
	projectModel?: string,
) {
	return fakeClientSession({
		stateStore: {
			getDefaultModel: () => defaultModel,
			getProjectModel: () => projectModel,
		},
		conv: activeModel ? { session: { agent: { state: { model: activeModel } } } } : undefined,
	});
}

describe("Bot 私聊的模型兜底", () => {
	it("优先用本机默认模型", () => {
		const session = sessionWith("provider-a/model-a", { provider: "provider-b", id: "model-b" }, "provider-p/model-p");
		expect(fallbackOf.call(session)).toBe("provider-a/model-a");
	});

	it("没设默认模型时退到 Bot 工作区的项目模型（重开私聊的主路径）", () => {
		const session = sessionWith(undefined, { provider: "provider-b", id: "model-b" }, "provider-p/model-p");
		expect(fallbackOf.call(session, "E:/pi-web-ui")).toBe("provider-p/model-p");
	});

	it("项目也没有时退到当前会话正在用的模型", () => {
		const session = sessionWith(undefined, { provider: "provider-b", id: "model-b" });
		expect(fallbackOf.call(session, "E:/pi-web-ui")).toBe("provider-b/model-b");
	});

	it("三者都没有时返回 undefined（由调用方翻译成可读错误）", () => {
		expect(fallbackOf.call(sessionWith(undefined, undefined))).toBeUndefined();
	});
});
