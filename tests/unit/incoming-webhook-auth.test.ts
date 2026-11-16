import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { incomingWebhookToken, isSelfAuthenticatedWebhook } from "../../server/device-center/hub-webhooks.js";

/**
 * 入站 webhook 自带 token：主 Web app 的全局认证必须按这一条放行。
 *
 * 历史缺陷：配置了 `PI_WEB_TOKEN` 的部署里，公网回调被主 app 的登录闸门提前拒成 401，
 * Hub 侧的验签根本没机会跑；当时的 e2e 测试只起独立 Hub，测不到主 app 这一层。
 * 这里补两层守卫：
 *   1) 纯函数：哪些请求算「自带凭据」，且不能把豁免放宽到别的 rooms 路由；
 *   2) 源码接线：主 app 的认证闸门必须调用同一个判定，Hub 侧不得再写第二份取值逻辑。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

function req(overrides: Record<string, unknown> = {}): Request {
	return {
		method: "POST",
		path: "/api/rooms/group-1/webhooks/incoming/hook-1",
		headers: {},
		query: {},
		body: {},
		...overrides,
	} as unknown as Request;
}

describe("incoming webhook self-authentication (pure)", () => {
	it("accepts every documented token carrier", () => {
		expect(isSelfAuthenticatedWebhook(req({ query: { token: "t" } }))).toBe(true);
		expect(isSelfAuthenticatedWebhook(req({ headers: { "x-webhook-token": "t" } }))).toBe(true);
		expect(isSelfAuthenticatedWebhook(req({ headers: { authorization: "Bearer t" } }))).toBe(true);
		expect(isSelfAuthenticatedWebhook(req({ body: { token: "t" } }))).toBe(true);
	});

	it("does not widen the exemption", () => {
		// 没有凭据：交回主 app 的口令校验（行为与修复前一致）。
		expect(isSelfAuthenticatedWebhook(req())).toBe(false);
		expect(isSelfAuthenticatedWebhook(req({ query: { token: "" } }))).toBe(false);
		expect(isSelfAuthenticatedWebhook(req({ headers: { authorization: "Basic t" } }))).toBe(false);
		// 只认这一条精确路径：其它 rooms 路由与 GET 探测都不算。
		expect(isSelfAuthenticatedWebhook(req({ path: "/api/rooms/group-1/messages" }))).toBe(false);
		expect(isSelfAuthenticatedWebhook(req({ path: "/api/rooms/group-1/webhooks/incoming" }))).toBe(false);
		expect(isSelfAuthenticatedWebhook(req({ method: "GET" }))).toBe(false);
	});

	it("resolves carriers in one documented order", () => {
		const both = req({ query: { token: "query" }, headers: { "x-webhook-token": "header" } });
		expect(incomingWebhookToken(both)).toBe("query");
		expect(incomingWebhookToken(req())).toBeUndefined();
	});
});

describe("incoming webhook auth wiring (single source)", () => {
	it("main app lets self-authenticated incoming webhooks reach the Hub forwarder", () => {
		const source = readFileSync(join(root, "server", "index.ts"), "utf8");
		const gate = source.slice(source.indexOf("const ok = tokenOk(req);"), source.indexOf("const isHtml ="));
		expect(gate).toContain("isSelfAuthenticatedWebhook(req)");
		// 不允许用更宽的路径判断替代单源判定：那会把整个 /api/rooms 变成免登录。
		expect(gate).not.toMatch(/startsWith\("\/api\/rooms"\)/);
	});

	it("Hub validates with the same extractor instead of a second copy", () => {
		const source = readFileSync(join(root, "server", "device-center", "hub.ts"), "utf8");
		expect(source).toContain("incomingWebhookToken(req)");
		// 第二份取值逻辑一旦出现，两边就会漂移（这正是本缺陷的成因）。
		expect(source).not.toContain('req.headers["x-webhook-token"]');
	});
});
