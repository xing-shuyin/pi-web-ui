import { describe, expect, it } from "vitest";
import {
	applyBotToolGate,
	botToolGateHostOf,
	type BotToolGateHost,
} from "../../packages/keel/src/domains/tools/index.js";
import type { BotToolFace } from "../../packages/keel/src/contracts/bots.js";

/** 假会话的活动集：`getAllTools` 返回注册表，`setActiveToolsByName` 记下最后一次写入。 */
function fakeHost(names: string[]): BotToolGateHost & { written: () => string[] | undefined } {
	let written: string[] | undefined;
	return {
		getAllTools: () => names.map((name) => ({ name })),
		setActiveToolsByName: (next: string[]) => {
			written = [...next];
		},
		written: () => written,
	};
}

function face(allowed: string[], extra: unknown[] = []): BotToolFace {
	return {
		allows: (name: string) => allowed.includes(name),
		tools: () => extra,
	};
}

describe("domains/tools · applyBotToolGate", () => {
	it("活动集 = 白名单 ∩ 全部工具（老 applyToolGating 的 Bot 早返回）", () => {
		const host = fakeHost(["read", "bash", "edit", "device_collab"]);
		const active = applyBotToolGate({ host, face: face(["read", "bash", "device_collab"]) });
		expect(active).toEqual(["read", "bash", "device_collab"]);
		expect(host.written()).toEqual(["read", "bash", "device_collab"]);
	});

	it("白名单里没有的工具（包括专属工具）一律不进活动集", () => {
		const host = fakeHost(["read", "write", "device_collab"]);
		expect(applyBotToolGate({ host, face: face(["read"]) })).toEqual(["read"]);
	});

	it("判定抛错按拒绝处理（fail-closed），不把整张工具表放行", () => {
		const host = fakeHost(["read", "bash"]);
		const active = applyBotToolGate({
			host,
			face: {
				allows: (name: string) => {
					if (name === "bash") throw new Error("capability revoked");
					return true;
				},
				tools: () => [],
			},
		});
		expect(active).toEqual(["read"]);
	});

	it("白名单为空时活动集为空（不是回落到「全部」）", () => {
		const host = fakeHost(["read", "bash"]);
		expect(applyBotToolGate({ host, face: face([]) })).toEqual([]);
		expect(host.written()).toEqual([]);
	});
});

describe("domains/tools · botToolGateHostOf", () => {
	it("只认结构：有读有写才给句柄", () => {
		const host = botToolGateHostOf({ getAllTools: () => [], setActiveToolsByName: () => {} });
		expect(host).toBeDefined();
	});

	it("缺写口 / 缺读口 / 空对象都给 undefined（调用方据此报错，而不是当没门禁）", () => {
		expect(botToolGateHostOf({ getAllTools: () => [] })).toBeUndefined();
		expect(botToolGateHostOf({ setActiveToolsByName: () => {} })).toBeUndefined();
		expect(botToolGateHostOf({})).toBeUndefined();
		expect(botToolGateHostOf(undefined)).toBeUndefined();
	});
});
