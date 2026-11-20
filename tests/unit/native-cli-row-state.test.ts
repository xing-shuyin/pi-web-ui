import { describe, expect, it } from "vitest";
import { nativeCliRowState } from "../../web/src/native-cli.js";
import type { NativeCliStatus } from "../../server/protocol.js";

const status = (patch: Partial<NativeCliStatus>): NativeCliStatus => ({ phase: "running", updatedAt: 0, ...patch });

describe("nativeCliRowState（左栏 CLI 行指示器）", () => {
	it("done 之后（进程活着、本轮结束）不再算在跑", () => {
		expect(nativeCliRowState({ status: status({ phase: "running", activity: "idle" }) })).toBe("idle");
	});

	it("提交与工具执行期间算在跑", () => {
		expect(nativeCliRowState({ status: status({ phase: "working", activity: "working" }) })).toBe("busy");
		expect(nativeCliRowState({ status: status({ phase: "running", activity: "working" }) })).toBe("busy");
	});

	it("启动中算在跑，等输入/授权单独成一态", () => {
		expect(nativeCliRowState({ status: status({ phase: "starting" }) })).toBe("busy");
		expect(nativeCliRowState({ status: status({ phase: "waiting_input", activity: "waiting_input" }) })).toBe(
			"waiting",
		);
		expect(nativeCliRowState({ status: status({ phase: "waiting_approval" }) })).toBe("waiting");
	});

	it("退出、断开、错误都算已结束", () => {
		for (const phase of ["exited", "disconnected", "error"] as const)
			expect(nativeCliRowState({ status: status({ phase }) })).toBe("ended");
	});

	it("没有任何 hook 事件的引擎保持旧行为：活进程按在跑", () => {
		expect(nativeCliRowState({ status: status({ phase: "running", nativeEvents: false }) })).toBe("busy");
	});

	it("有 hook 通道但还没收到事件时按进程状态处置，不空转", () => {
		expect(nativeCliRowState({ status: status({ phase: "running" }) })).toBe("idle");
	});

	it("只有磁盘历史、没有活进程的 CLI 会话算已结束", () => {
		expect(nativeCliRowState(undefined)).toBe("ended");
	});

	it("活进程还没报状态时按在跑，报错则直接算结束", () => {
		expect(nativeCliRowState({})).toBe("busy");
		expect(nativeCliRowState({}, "spawn failed")).toBe("ended");
	});
});
