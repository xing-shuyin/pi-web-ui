import { describe, expect, it } from "vitest";
import { BROWSER_DESIGN_KINDS } from "../../browser/contracts.js";
import {
	BROWSER_DESIGN_ACTION_SIGNATURE,
	BROWSER_DESIGN_TOOL_ACTIONS,
	BROWSER_DESIGN_TOOL_KINDS,
	collectBrowserDesignArgs,
	formatBrowserDesignError,
	formatBrowserDesignResult,
	makeBrowserDesignTool,
} from "../../server/browser-design-tool.js";
import { BROWSER_DESIGN_TOOL_NAME } from "../../server/tool-manager.js";

function bridge(result: unknown = { ok: true, result: null }) {
	const calls: unknown[] = [];
	return {
		calls,
		session: {
			pageCall: async (req: unknown) => {
				calls.push(req);
				return result as never;
			},
		},
	};
}

async function run(params: Record<string, unknown>, options: { result?: unknown; canSeeImages?: boolean } = {}) {
	const fake = bridge(options.result);
	const tool = makeBrowserDesignTool(
		{ ...fake.session, ...(options.canSeeImages === undefined ? {} : { canSeeImages: () => options.canSeeImages! }) },
		"owner-1",
	) as unknown as { execute: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> };
	const output = await tool.execute("call-1", params, undefined);
	return { calls: fake.calls as Record<string, unknown>[], output };
}

describe("browser_design 工具", () => {
	it("kind 与 browser/contracts.ts 的单源保持一致", () => {
		expect([...BROWSER_DESIGN_TOOL_KINDS]).toEqual([...BROWSER_DESIGN_KINDS]);
		expect(BROWSER_DESIGN_ACTION_SIGNATURE).toContain("preview(kind)");
		expect(BROWSER_DESIGN_TOOL_ACTIONS).toContain("save");
	});

	it("只把 kind / content 透传给页面调用", () => {
		expect(collectBrowserDesignArgs({ action: "save", kind: "theme", content: "a{}", timeoutMs: 1 })).toEqual({
			kind: "theme",
			content: "a{}",
		});
	});

	it("get 把状态、起步标记与正文分开摆开，超长正文截断并指向磁盘路径", () => {
		const long = "x".repeat(30_000);
		const text = formatBrowserDesignResult("get", {
			status: { kind: "newtab", custom: false, path: "E:/data/browser/custom/newtab.html" },
			content: long,
			starter: true,
		});
		expect(text).toContain('"path": "E:/data/browser/custom/newtab.html"');
		expect(text).toContain("(starter template: nothing is saved yet)");
		expect(text).toContain("…(truncated; 30000 chars total");
		expect(text.length).toBeLessThan(long.length);
	});

	it("失败信息中英各一条，并说明需要桌面版浏览器", () => {
		const text = formatBrowserDesignError("preview", "boom");
		expect(text).toContain('browser_design "preview" failed: boom');
		expect(text).toContain("失败：boom");
		expect(text).toContain("desktop AI Browser");
	});

	it("缺少 action 时直接给签名，不乱发一轮请求", async () => {
		await expect(run({ kind: "newtab" })).rejects.toThrow(/status \| get\(kind\?\)/);
	});

	it("save 必须带 kind 与完整正文", async () => {
		await expect(run({ action: "save", content: "<p/>" })).rejects.toThrow(/needs kind/);
		await expect(run({ action: "save", kind: "newtab" })).rejects.toThrow(/full file body/);
	});

	it("把动作翻成 design.* 页面调用，并带上会话所有者与解包参数", async () => {
		const { calls } = await run(
			{ action: "save", kind: "theme", content: ":root{--pb-accent:#0ff}" },
			{ result: { ok: true, result: { kind: "theme", custom: true } } },
		);
		expect(calls[0]).toMatchObject({
			op: "design.save",
			args: { kind: "theme", content: ":root{--pb-accent:#0ff}" },
			timeoutMs: 30000,
		});
	});

	it("preview 给足加载时间，并能带图返回", async () => {
		const png = Buffer.from("fake-jpeg").toString("base64");
		const { calls, output } = await run(
			{ action: "preview", kind: "newtab" },
			{
				canSeeImages: true,
				result: {
					ok: true,
					result: {
						kind: "newtab",
						url: "file:///data/browser/custom/newtab.html",
						image: { dataUrl: `data:image/jpeg;base64,${png}`, mimeType: "image/jpeg", width: 1280, height: 720 },
					},
				},
			},
		);
		expect(calls[0]).toMatchObject({ op: "design.preview", timeoutMs: 60000 });
		expect(output.content.map((part) => part.type)).toEqual(["text", "image"]);
		expect(output.content[0]?.text).toContain("the new tab page (file:///data/browser/custom/newtab.html)");
	});

	it("模型看不见图时退化成文字说明，而不是丢一张空图", async () => {
		const png = Buffer.from("fake-jpeg").toString("base64");
		const { output } = await run(
			{ action: "preview", kind: "theme" },
			{
				result: {
					ok: true,
					result: { kind: "theme", image: { dataUrl: `data:image/jpeg;base64,${png}`, width: 640, height: 480 } },
				},
			},
		);
		expect(output.content).toHaveLength(1);
		expect(output.content[0]?.text).toContain("Rendered at 640×480 px.");
	});

	it("宿主报错时抛成工具失败，带下一步指引", async () => {
		await expect(run({ action: "status" }, { result: { ok: false, error: "no host" } })).rejects.toThrow(/no host/);
	});

	it("工具名与目录登记一致", () => {
		expect(BROWSER_DESIGN_TOOL_NAME).toBe("browser_design");
	});
});
