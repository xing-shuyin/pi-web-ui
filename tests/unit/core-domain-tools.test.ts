import { describe, expect, it } from "vitest";
import {
	appendLoadedTools,
	resolveActiveToolNames,
	type ToolGatingInput,
} from "../../packages/keel/src/domains/tools/index.js";

const allSupported = () => true;

function gating(over: Partial<ToolGatingInput> = {}): ToolGatingInput {
	return {
		catalog: [],
		disabled: [],
		onDemand: [],
		loaded: [],
		platformSupported: allSupported,
		...over,
	};
}

describe("domains/tools · resolveActiveToolNames", () => {
	it("无禁用/无按需时原样放行，且保持 catalog 顺序", () => {
		expect(resolveActiveToolNames(gating({ catalog: ["write", "bash", "read"] }))).toEqual(["write", "bash", "read"]);
	});

	it("disabled 里的工具被减掉", () => {
		const active = resolveActiveToolNames(
			gating({ catalog: ["bash", "read", "edit"], disabled: ["read", "not-in-catalog"] }),
		);
		expect(active).toEqual(["bash", "edit"]);
	});

	it("onDemand 里未加载的工具被减掉", () => {
		const active = resolveActiveToolNames(
			gating({ catalog: ["bash", "browser_page", "phone"], onDemand: ["browser_page", "phone"] }),
		);
		expect(active).toEqual(["bash"]);
	});

	it("onDemand 里已加载的工具放行", () => {
		const active = resolveActiveToolNames(
			gating({
				catalog: ["bash", "browser_page", "phone"],
				onDemand: ["browser_page", "phone"],
				loaded: ["browser_page"],
			}),
		);
		expect(active).toEqual(["bash", "browser_page"]);
	});

	it("disabled 与 onDemand 重叠只算一次，且已加载也复活不了被禁用的工具", () => {
		const base = gating({ catalog: ["bash", "phone"], onDemand: ["phone"], disabled: ["phone"] });
		const both = resolveActiveToolNames(base);
		const onlyDisabled = resolveActiveToolNames({ ...base, onDemand: [] });
		const onlyOnDemand = resolveActiveToolNames({ ...base, disabled: [] });
		expect(both).toEqual(["bash"]);
		expect(both).toEqual(onlyDisabled);
		expect(onlyOnDemand).toEqual(["bash"]);
		expect(resolveActiveToolNames({ ...base, loaded: ["phone"] })).toEqual(["bash"]);
	});

	it("平台不支持的被剔除（回调只对存活项生效）", () => {
		const asked: string[] = [];
		const active = resolveActiveToolNames(
			gating({
				catalog: ["bash", "powershell", "grep"],
				disabled: ["grep"],
				platformSupported: (name) => {
					asked.push(name);
					return name !== "powershell";
				},
			}),
		);
		expect(active).toEqual(["bash"]);
		expect(asked).toEqual(["bash", "powershell"]);
	});

	it("结果去重（catalog 有重复项）", () => {
		expect(resolveActiveToolNames(gating({ catalog: ["bash", "read", "bash", "read"] }))).toEqual(["bash", "read"]);
	});

	it("名单里的孤儿项（不在 catalog）不影响结果", () => {
		const active = resolveActiveToolNames(
			gating({
				catalog: ["bash"],
				disabled: ["uninstalled_plugin_tool"],
				onDemand: ["another_uninstalled_tool"],
				loaded: ["another_uninstalled_tool"],
			}),
		);
		expect(active).toEqual(["bash"]);
	});

	it("空输入等于空结果", () => {
		expect(resolveActiveToolNames(gating())).toEqual([]);
	});

	it("输入数组一律不被修改（不可变性）", () => {
		const catalog = Object.freeze(["bash", "read", "phone", "powershell"]);
		const disabled = Object.freeze(["read"]);
		const onDemand = Object.freeze(["phone", "powershell"]);
		const loaded = Object.freeze(["powershell"]);
		const snapshot = () => [catalog.join(","), disabled.join(","), onDemand.join(","), loaded.join(",")];
		const before = snapshot();
		const active = resolveActiveToolNames({ catalog, disabled, onDemand, loaded, platformSupported: allSupported });
		expect(active).toEqual(["bash", "powershell"]);
		expect(snapshot()).toEqual(before);
		expect(active).not.toBe(catalog);
	});
});

describe("domains/tools · appendLoadedTools", () => {
	it("已加载项永不删除，只往后追加（返回新数组）", () => {
		const current = Object.freeze(["phone"]);
		const result = appendLoadedTools(current, ["browser_page"], 10);
		expect(result.names).toEqual(["phone", "browser_page"]);
		expect(result.rejected).toEqual([]);
		expect(result.names).not.toBe(current);
		expect(current).toEqual(["phone"]);
	});

	it("去重保序：重复请求与前缀里的重名都算 duplicate，不重复追加", () => {
		const result = appendLoadedTools(["phone"], ["browser_page", "phone", "browser_page"], 10);
		expect(result.names).toEqual(["phone", "browser_page"]);
		expect(result.rejected).toEqual([
			{ name: "phone", reason: "duplicate" },
			{ name: "browser_page", reason: "duplicate" },
		]);
	});

	it("cap 溢出：保留先加载的，后到的进 rejected", () => {
		const result = appendLoadedTools(["phone"], ["a_tool", "b_tool", "c_tool"], 3);
		expect(result.names).toEqual(["phone", "a_tool", "b_tool"]);
		expect(result.rejected).toEqual([{ name: "c_tool", reason: "cap" }]);
	});

	it("cap 已满时一个都不追加", () => {
		const result = appendLoadedTools(["phone", "browser_page"], ["c_tool"], 2);
		expect(result.names).toEqual(["phone", "browser_page"]);
		expect(result.rejected).toEqual([{ name: "c_tool", reason: "cap" }]);
	});

	it("已超 cap 的前缀原样保留，不删已有项", () => {
		const result = appendLoadedTools(["phone", "browser_page", "c_tool"], ["d_tool"], 1);
		expect(result.names).toEqual(["phone", "browser_page", "c_tool"]);
		expect(result.rejected).toEqual([{ name: "d_tool", reason: "cap" }]);
	});

	it("cap 非法或为 0 时不追加", () => {
		expect(appendLoadedTools([], ["a_tool"], 0)).toEqual({
			names: [],
			rejected: [{ name: "a_tool", reason: "cap" }],
		});
		expect(appendLoadedTools([], ["a_tool"], -5).names).toEqual([]);
		expect(appendLoadedTools([], ["a_tool"], Number.POSITIVE_INFINITY).names).toEqual(["a_tool"]);
	});

	it("输入不被就地修改（不可变性）", () => {
		const current = Object.freeze(["phone"]);
		const added = Object.freeze(["a_tool", "b_tool"]);
		const result = appendLoadedTools(current, added, 10);
		expect(current).toEqual(["phone"]);
		expect(added).toEqual(["a_tool", "b_tool"]);
		expect(result.names).toEqual(["phone", "a_tool", "b_tool"]);
	});
});
