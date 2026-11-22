import { describe, expect, it } from "vitest";
import { MAX_CLIENT_ID_LEN, validateClientId } from "../../server/ws-client-id.js";

describe("ws hello clientId 校验", () => {
	it("合法 uuid 与普通前缀通过；内部持有方前缀与未登记的 device-task 一律拒绝（issue #971）", () => {
		expect(validateClientId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
		expect(validateClientId("A_9:z")).toBe("A_9:z");
		// 服务端内部专用：外部 hello 自报即可挂到别人的账上
		expect(validateClientId("scheduler:task-1")).toBeNull();
		expect(validateClientId("plugin:demo_ui")).toBeNull();
		// 未在 Bot 执行注册表里登记的 device-task- 同样拒绝
		expect(validateClientId("device-task-forged")).toBeNull();
	});

	it("非 string（对象/数字/undefined/null）拒绝", () => {
		expect(validateClientId({ id: "x" })).toBeNull();
		expect(validateClientId(123)).toBeNull();
		expect(validateClientId(undefined)).toBeNull();
		expect(validateClientId(null)).toBeNull();
		expect(validateClientId(["x"])).toBeNull();
	});

	it("空串与超长（>128）拒绝", () => {
		expect(validateClientId("")).toBeNull();
		expect(validateClientId("a".repeat(MAX_CLIENT_ID_LEN))).toBe("a".repeat(MAX_CLIENT_ID_LEN));
		expect(validateClientId("a".repeat(MAX_CLIENT_ID_LEN + 1))).toBeNull();
	});

	it("路径穿越/特殊字符拒绝（clientId 会成为 uploads/<clientId>/ 目录名）", () => {
		expect(validateClientId("../etc/passwd")).toBeNull();
		expect(validateClientId("..\\win")).toBeNull();
		expect(validateClientId("a/b")).toBeNull();
		expect(validateClientId("a b")).toBeNull();
		expect(validateClientId("a.b")).toBeNull();
		expect(validateClientId("a%2fb")).toBeNull();
		expect(validateClientId("中文")).toBeNull();
		expect(validateClientId("a\nb")).toBeNull();
	});
});
