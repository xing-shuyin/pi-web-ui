import { describe, expect, it } from "vitest";
import { parseKernelStatus, splitKernelUptime } from "../../web/src/kernel-status.js";

describe("parseKernelStatus", () => {
	it("系统托管 → supervised，带出托管者/版本/形态/uptime", () => {
		const model = parseKernelStatus({
			ok: true,
			kernel: {
				mode: "service",
				supervisor: "systemd",
				serviceName: "pi-web-ui",
				version: "0.121.3",
				installKind: "global-npm",
				uptimeMs: 3 * 60 * 60 * 1000,
				minShell: 1,
			},
		});
		expect(model.tone).toBe("supervised");
		expect(model.supervisor).toBe("systemd");
		expect(model.version).toBe("0.121.3");
		expect(model.installKind).toBe("global-npm");
		expect(model.serviceName).toBe("pi-web-ui");
	});

	it("裸进程 → standalone（关掉客户端就停，必须说清楚）", () => {
		expect(parseKernelStatus({ ok: true, kernel: { mode: "standalone", supervisor: null } }).tone).toBe("standalone");
	});

	it("老内核没有 kernel 块 / 响应异常 → unknown，不抛", () => {
		expect(parseKernelStatus({ ok: true }).tone).toBe("unknown");
		expect(parseKernelStatus(null).tone).toBe("unknown");
		expect(parseKernelStatus("nope").tone).toBe("unknown");
		expect(parseKernelStatus({ kernel: { supervisor: 42, mode: "weird" } }).tone).toBe("unknown");
	});

	it("字段类型不对时按缺省处理（不把脏数据带进 UI）", () => {
		const model = parseKernelStatus({
			kernel: { mode: "standalone", supervisor: null, version: 123, uptimeMs: "long", installKind: {} },
		});
		expect(model.version).toBeUndefined();
		expect(model.uptimeMs).toBeUndefined();
		expect(model.installKind).toBeUndefined();
	});
});

describe("splitKernelUptime（文案交给 i18n）", () => {
	it("缺省/0 → null，不产生半个单位", () => {
		expect(splitKernelUptime(undefined)).toBeNull();
		expect(splitKernelUptime(0)).toBeNull();
	});

	it("分级：不到 1 分钟 / 分钟 / 小时 / 天", () => {
		expect(splitKernelUptime(30_000)).toEqual({ unit: "minutes", minutes: 0 });
		expect(splitKernelUptime(5 * 60_000)).toEqual({ unit: "minutes", minutes: 5 });
		expect(splitKernelUptime(2 * 60 * 60_000 + 7 * 60_000)).toEqual({ unit: "hours", hours: 2, minutes: 7 });
		expect(splitKernelUptime(26 * 60 * 60_000)).toEqual({ unit: "days", days: 1, hours: 2 });
	});
});
