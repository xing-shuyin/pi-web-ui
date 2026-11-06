// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getClientId, _resetClientIdCacheForTest } from "../../web/src/use-chat";

describe("getClientId 跨刷新持久化守护", () => {
	beforeEach(() => {
		_resetClientIdCacheForTest();
		window.name = "";
		sessionStorage.clear();
	});

	it("首次调用生成 UUID 并同时写入 window.name 与 sessionStorage", () => {
		const id = getClientId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(window.name).toBe(`pi-web-client-id:${id}`);
		expect(sessionStorage.getItem("pi-web-client-id")).toBe(id);
	});

	it("页面刷新但 sessionStorage 丢失时，能从 window.name 完美恢复", () => {
		const id1 = getClientId();
		_resetClientIdCacheForTest();
		sessionStorage.clear();

		const id2 = getClientId();
		expect(id2).toBe(id1);
		expect(sessionStorage.getItem("pi-web-client-id")).toBe(id1);
	});

	it("window.name 被外部清空时，能从 sessionStorage 恢复", () => {
		const id1 = getClientId();
		_resetClientIdCacheForTest();
		window.name = "";

		const id2 = getClientId();
		expect(id2).toBe(id1);
		expect(window.name).toBe(`pi-web-client-id:${id1}`);
	});

	it("window.name 原本已有内容时，采用非破坏性追加与正则提取", () => {
		window.name = "custom-tab-name";
		const id = getClientId();
		expect(id).toBeTruthy();
		expect(window.name).toBe(`custom-tab-name__PI_CID__:${id}`);

		_resetClientIdCacheForTest();
		sessionStorage.clear();

		const restored = getClientId();
		expect(restored).toBe(id);
	});

	it("模拟新开标签页（window.name 与 sessionStorage 均为空），生成新客户端 ID", () => {
		const id1 = getClientId();

		_resetClientIdCacheForTest();
		window.name = "";
		sessionStorage.clear();

		const id2 = getClientId();
		expect(id2).not.toBe(id1);
	});
});
