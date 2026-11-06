import { describe, expect, it } from "vitest";
import { grantView, type PageState } from "../../plugins/page-picker/extension/src/shared/page-state.js";

const state = (over: Partial<PageState> = {}): PageState => ({
	origin: "http://localhost:5173",
	authorized: false,
	aiControl: true,
	...over,
});

describe("grantView", () => {
	it("还没查到（undefined）→ 说「正在查」，不预告结论", () => {
		const view = grantView(undefined);
		expect(view.status).toContain("检查");
		expect(view.label).toBe("让 AI 操作本页…");
		expect(view.done).toBe(false);
	});

	it("查不到（null，后台没响应）→ 明说是查不到，而不是「未授权」", () => {
		const view = grantView(null);
		expect(view.status).toContain("查不到");
		expect(view.status).not.toContain("未授权");
		expect(view.label).toBe("让 AI 操作本页…");
	});

	it("非 http/https 页面 → 说明模型只能操作普通网页", () => {
		const view = grantView(state({ origin: "" }));
		expect(view.kind).toBe("warn");
		expect(view.hint).toContain("http");
	});

	it("未授权 → primary 按钮 + 「未授权」", () => {
		const view = grantView(state());
		expect(view.status).toBe("未授权");
		expect(view.kind).toBe("warn");
		expect(view.done).toBe(false);
		expect(view.hint).toContain("http://localhost:5173");
	});

	it("已授权 + 总开关开着 → 绿色「模型可操作本页」，按钮不再是催促的样子", () => {
		const view = grantView(state({ authorized: true, title: "开发预览页" }));
		expect(view.status).toContain("已授权");
		expect(view.kind).toBe("ok");
		expect(view.done).toBe(true);
		expect(view.hint).toContain("开发预览页");
	});

	it("已授权但总开关关着 → 必须说出来（否则用户会以为功能坏了）", () => {
		const view = grantView(state({ authorized: true, aiControl: false }));
		expect(view.kind).toBe("warn");
		expect(view.done).toBe(true);
		expect(view.status).toContain("总开关");
		expect(view.hint).toContain("总开关");
	});

	it("标题等于 origin（没记到标题）时回落显示 origin，不出现「http://…」重复两遍", () => {
		const view = grantView(state({ authorized: true, title: "http://localhost:5173" }));
		expect(view.hint).toContain("http://localhost:5173");
		expect(view.hint).not.toContain("「http://localhost:5173」");
	});
});
