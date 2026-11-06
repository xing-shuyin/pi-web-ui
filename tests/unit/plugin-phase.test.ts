import { describe, expect, it } from "vitest";
import { countPluginPhases, pluginPhase } from "../../web/src/plugin-phase.js";

describe("pluginPhase", () => {
	it("error 优先 → failed（禁用也盖不住失败）", () => {
		expect(pluginPhase({ error: "boom" }, false)).toBe("failed");
		expect(pluginPhase({ error: "boom", active: true }, true)).toBe("failed");
	});
	it("禁用 → disabled", () => {
		expect(pluginPhase({}, true)).toBe("disabled");
		expect(pluginPhase({ active: true }, true)).toBe("disabled");
	});
	it("active → active；旧服务端（无字段）→ idle 不误报", () => {
		expect(pluginPhase({ active: true }, false)).toBe("active");
		expect(pluginPhase({}, false)).toBe("idle");
		expect(pluginPhase({ active: false }, false)).toBe("idle");
	});
});

describe("countPluginPhases", () => {
	it("四相计数", () => {
		const ps = [{ id: "a", active: true }, { id: "b", active: true }, { id: "c", error: "x" }, { id: "d" }];
		expect(countPluginPhases(ps, new Set(["b"]))).toEqual({ active: 1, disabled: 1, failed: 1, idle: 1 });
	});
});
