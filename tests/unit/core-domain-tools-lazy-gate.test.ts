import { describe, expect, it } from "vitest";
import { autoActivateLazyTool, planLazyTools, replayToolGate } from "../../packages/keel/src/domains/tools/index.js";
import type { ClientSettings } from "../../packages/keel/src/settings-schema.js";
import type { ActiveToolSet } from "../../packages/keel/src/tool-catalog.js";

/**
 * 门控重放 + `load_tools` 判定（老实现 `applyToolGating()` / `loadLazyTools()` 的内核版）。
 *
 * 这些断言守的是老实现的语义，不是「能跑」：
 * - 活跃集只由 `applyAgentToolsGating` 写，按需未加载 = 临时进禁用集；
 * - `load_tools` 在按需关着时绝不活跃、开着时 `forceActive` 保它在（`ask` 预设不强加）；
 * - 已加载集合只在**有转录**的会话里用活跃集播种（新会话播种等于按需当场失效）；
 * - `load_tools` 的拒绝顺序与文案（未知 → 常驻 → 已加载 → 不在名单 → 关闭 → 预设）。
 */

interface FakeSession extends ActiveToolSet {
	active: string[];
	defs: string[];
	setActiveToolsByName(names: string[]): void;
}

/** 假会话：`setActiveToolsByName` 只保留库存里有的名字（与 SDK 同一门槛）。 */
function fakeSession(defs: string[], active: string[] = [...defs]): FakeSession {
	const session: FakeSession = {
		defs,
		active,
		getAllTools: () => session.defs.map((name) => ({ name })),
		getActiveToolNames: () => [...session.active],
		setActiveToolsByName: (names: string[]) => {
			session.active = names.filter((name) => session.defs.includes(name));
		},
	};
	return session;
}

/** 单测只关心门控读的那几个键（其余设置与门控无关）：按仓库口径收成一次显式断言。 */
const settingsOf = (patch: Partial<ClientSettings>): ClientSettings => patch as ClientSettings;

const ALL = ["bash", "read", "edit", "write", "grep", "find", "patch", "load_tools"];

describe("domains/tools · replayToolGate", () => {
	it("按需实施中：名单里未加载的工具不进活跃集，load_tools 反被保活", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch", "find"], disabledAgentTools: [] }),
		});
		expect(out.lazy).toBe(true);
		expect(out.active).not.toContain("patch");
		expect(out.active).not.toContain("find");
		expect(out.active).toContain("load_tools");
		expect(out.active).toContain("bash");
	});

	it("按需关着：load_tools 不进活跃集（它仍是已注册工具，但绝不声明给模型）", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: false, toolOnDemandTools: ["patch"], disabledAgentTools: [] }),
		});
		expect(out.active).not.toContain("load_tools");
		expect(out.active).toContain("patch");
	});

	it("名单为空等同关闭：不延迟任何工具，也不挂 load_tools", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: [], disabledAgentTools: [] }),
		});
		expect(out.lazy).toBe(false);
		expect(out.active).toContain("patch");
		expect(out.active).not.toContain("load_tools");
	});

	it("新会话不用活跃集播种（新会话的活跃集是「全部已注册」，播种等于按需当场失效）", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch"], disabledAgentTools: [] }),
			hasTranscript: false,
		});
		expect(out.loaded).toEqual([]);
		expect(out.active).not.toContain("patch");
	});

	it("从转录恢复时按活跃集播种：上次加载过的还是已加载", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch", "find"], disabledAgentTools: [] }),
			hasTranscript: true,
		});
		// 假会话一开始全部活跃 = 上次全都加载过 → 名单工具保持活跃。
		expect(out.loaded.sort()).toEqual(["find", "patch"]);
		expect(out.active).toContain("patch");
	});

	it("禁用永远做减法：已加载也不复活被关闭的工具", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch"], disabledAgentTools: ["patch"] }),
		});
		expect(out.active).not.toContain("patch");
	});

	it("ask 预设不加强 load_tools（该预设本来无工具）", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch"], disabledAgentTools: [] }),
			preset: "ask",
		});
		expect(out.active).toEqual([]);
	});

	it("计划模式剔写工具（模式闸门是门控的输入，不是执行期才判）", () => {
		const session = fakeSession(ALL);
		const out = replayToolGate({
			session,
			settings: settingsOf({ toolLazyLoading: false, toolOnDemandTools: [], disabledAgentTools: [] }),
			planMode: true,
		});
		expect(out.active).not.toContain("write");
		expect(out.active).not.toContain("edit");
		expect(out.active).toContain("read");
	});
});

describe("domains/tools · autoActivateLazyTool（issue #652）", () => {
	const settings = settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["find"], disabledAgentTools: [] });

	it("直呼未加载的名单工具：补进已加载集，下一轮真的活跃", () => {
		const session = fakeSession(ALL);
		replayToolGate({ session, settings });
		expect(session.active).not.toContain("find");
		expect(autoActivateLazyTool({ session, settings, toolName: "find" })).toBe(true);
		expect(session.active).toContain("find");
	});

	it("已经活跃的工具不再动（不重复重放）", () => {
		const session = fakeSession(ALL);
		replayToolGate({ session, settings });
		expect(autoActivateLazyTool({ session, settings, toolName: "find" })).toBe(true);
		expect(autoActivateLazyTool({ session, settings, toolName: "find" })).toBe(false);
	});

	it("核心工具 / 不在名单 / 库存里没有 / 按需没生效：一律不动", () => {
		const session = fakeSession(ALL);
		replayToolGate({ session, settings });
		expect(autoActivateLazyTool({ session, settings, toolName: "bash" })).toBe(false);
		expect(autoActivateLazyTool({ session, settings, toolName: "grep" })).toBe(false);
		expect(autoActivateLazyTool({ session, settings, toolName: "terminal" })).toBe(false);
		expect(
			autoActivateLazyTool({
				session,
				settings: { ...settings, toolLazyLoading: false },
				toolName: "find",
			}),
		).toBe(false);
	});
});

describe("domains/tools · planLazyTools（load_tools 的拒绝顺序）", () => {
	const settings = settingsOf({ toolLazyLoading: true, toolOnDemandTools: ["patch", "find"], disabledAgentTools: [] });
	const base = {
		all: ALL,
		active: ["bash", "read", "edit", "write", "grep", "load_tools"],
		loaded: new Set<string>(),
		onDemand: ["patch", "find"],
		disabled: new Set<string>(),
		preset: "standard",
		lang: "en",
	};

	it("名单内未加载的接受，其余按老实现的顺序与文案拒绝", () => {
		const plan = planLazyTools({ ...base, names: ["patch", "read", "nope", "grep"] });
		expect(plan.accepted).toEqual(["patch"]);
		expect(plan.rejected.map((r) => r.name)).toEqual(["read", "nope", "grep"]);
		expect(plan.rejected[0].reason).toBe("always available without loading");
		expect(plan.rejected[1].reason).toBe("unknown tool name (use a catalog name)");
		expect(plan.rejected[2].reason).toBe(
			"always available without loading (not in the on-demand list, call it directly)",
		);
	});

	it("已加载且已活跃 = 已经加载过了", () => {
		const plan = planLazyTools({
			...base,
			all: [...ALL, "patch"],
			active: [...base.active, "patch"],
			loaded: new Set(["patch"]),
			names: ["patch"],
		});
		expect(plan.rejected[0].reason).toBe("already loaded");
	});

	it("只标记没激活（半吊子状态）按未加载处理并修正，而不是回「已经加载过了」", () => {
		const plan = planLazyTools({ ...base, loaded: new Set(["patch"]), names: ["patch"] });
		expect(plan.accepted).toEqual(["patch"]);
	});

	it("被关闭 / 当前模式拦截优先于预设判定", () => {
		const plan = planLazyTools({ ...base, disabled: new Set(["patch"]), names: ["patch"] });
		expect(plan.rejected[0].reason).toBe("disabled, or blocked in the current mode");
	});

	it("预设不允许：核心集之外的名单工具在 ask 预设下拒绝", () => {
		const plan = planLazyTools({ ...base, preset: "ask", names: ["patch"] });
		expect(plan.rejected[0].reason).toBe("not allowed by the current preset");
	});
});
