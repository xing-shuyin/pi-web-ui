// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BOT_DRAFT_REQUEST_TIMEOUT_MS } from "../../web/src/components/DeviceGroupSection";
import { BOT_DRAFT_REQUEST_TIMEOUT_MS as SERVER_DRAFT_TIMEOUT_MS } from "../../server/bot-draft-runner.js";

/**
 * 起草 Bot 是一次真实模型调用（服务端上限 90s）。客户端的通用 15s 超时会先把它掐掉：
 * 界面显示「失败」，服务端其实还在跑，用户还会以为草案丢了。
 * 这条守卫只钉一件事：`bot-drafts` 路径的客户端超时必须比服务端上限长。
 */
describe("一句话起草的超时预算", () => {
	it("客户端超时留出服务端 90s 上限的余量", () => {
		expect(SERVER_DRAFT_TIMEOUT_MS).toBe(90_000);
		expect(BOT_DRAFT_REQUEST_TIMEOUT_MS).toBeGreaterThan(SERVER_DRAFT_TIMEOUT_MS);
	});
});
