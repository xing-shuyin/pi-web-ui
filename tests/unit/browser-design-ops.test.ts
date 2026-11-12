import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPageRequest, BrowserTab } from "../../browser/contracts.js";
import { createBrowserExecutor, type BrowserExecutorManager } from "../../browser/automation/executor.js";
import type { BrowserDesignHost } from "../../browser/automation/design.js";

function manager(tabs: BrowserTab[] = []): BrowserExecutorManager {
	return {
		getTabs: () => tabs,
		getActiveTabId: () => tabs[0]?.id ?? null,
		getWebContents: () => undefined as unknown as WebContents,
		createTab: vi.fn(() => "created"),
		navigate: vi.fn(async () => {}),
	};
}

function designHost(overrides: Partial<BrowserDesignHost> = {}) {
	const status = {
		kind: "newtab" as const,
		file: "newtab.html",
		path: "/data/custom/newtab.html",
		custom: false,
		bytes: 0,
		maxBytes: 524288,
	};
	const host: BrowserDesignHost = {
		designStatus: () => [status, { ...status, kind: "theme", file: "theme.css", path: "/data/custom/theme.css" }],
		designDocument: (kind) => ({ status: { ...status, kind }, content: "<h1/>", starter: true }),
		saveDesign: (_kind, content) => ({ ...status, custom: true, bytes: String(content).length }),
		resetDesign: (kind) => ({ ...status, kind }),
		previewDesign: async (kind) => ({
			kind,
			url: "file:///data/custom/newtab.html",
			image: { dataUrl: "data:image/jpeg;base64,Zm9v", mimeType: "image/jpeg", width: 100, height: 50 },
		}),
		...overrides,
	};
	return host;
}

const call = (design: BrowserDesignHost | undefined, op: string, args?: Record<string, unknown>) =>
	createBrowserExecutor(manager(), { design })({
		op,
		...(args ? { args } : {}),
		timeoutMs: 30000,
	} as BrowserPageRequest);

describe("browser automation design ops", () => {
	it("无需任何标签页就能读写自定义资产（浏览器只剩内部页时也照常可用）", async () => {
		const host = designHost();
		expect(await call(host, "design.status")).toMatchObject({
			ok: true,
			result: [{ kind: "newtab" }, { kind: "theme" }],
		});
		expect(await call(host, "design.get", { kind: "theme" })).toMatchObject({
			ok: true,
			result: { content: "<h1/>", starter: true, status: { kind: "theme" } },
		});
		expect(await call(host, "design.save", { kind: "newtab", content: "<p>hi</p>" })).toMatchObject({
			ok: true,
			result: { custom: true, bytes: 9 },
		});
		expect(await call(host, "design.reset", { kind: "newtab" })).toMatchObject({ ok: true });
	});

	it("preview 原样带回图片（尺寸与 mimeType 由宿主给）", async () => {
		const result = await call(designHost(), "design.preview", { kind: "newtab" });
		expect(result).toMatchObject({
			ok: true,
			result: { kind: "newtab", image: { mimeType: "image/jpeg", width: 100, height: 50 } },
		});
	});

	it("缺省 kind 落到 newtab；非法 kind 直接拒绝", async () => {
		const host = designHost();
		expect(await call(host, "design.get")).toMatchObject({ ok: true, result: { status: { kind: "newtab" } } });
		const bad = await call(host, "design.get", { kind: "pages" });
		expect(bad.ok).toBe(false);
		expect((bad as { error: string }).error).toMatch(/Invalid design kind/);
	});

	it("未知 design 动作与未接宿主都报成可读错误，不落到页面操作分支", async () => {
		const unknown = await call(designHost(), "design.explode");
		expect(unknown).toMatchObject({ ok: false });
		expect((unknown as { error: string }).error).toMatch(/Unsupported browser design action: explode/);
		const missing = await call(undefined, "design.status");
		expect(missing).toMatchObject({ ok: false });
		expect((missing as { error: string }).error).toMatch(/unavailable in this browser build/);
	});

	it("受「允许 AI 控制浏览器」总开关约束，预览再叠一层截图开关", async () => {
		const off = createBrowserExecutor(manager(), { design: designHost(), aiControl: false });
		const blocked = await off({
			op: "design.save",
			args: { kind: "theme", content: "a{}" },
			timeoutMs: 30000,
		} as BrowserPageRequest);
		expect(blocked).toMatchObject({ ok: false });
		expect((blocked as { error: string }).error).toMatch(/AI control is disabled/);
		const noShot = createBrowserExecutor(manager(), { design: designHost(), allowShot: false });
		const preview = await noShot({
			op: "design.preview",
			args: { kind: "newtab" },
			timeoutMs: 30000,
		} as BrowserPageRequest);
		expect((preview as { error: string }).error).toMatch(/screenshots are disabled/);
		// 只读的状态查询不需要截图权限
		expect(await noShot({ op: "design.status", timeoutMs: 30000 } as BrowserPageRequest)).toMatchObject({ ok: true });
	});

	it("design 动作不碰标签解析：即使只有一个内部页也不该报「没有可用页面」", async () => {
		const internal: BrowserTab[] = [
			{
				id: "internal",
				url: "file:///app/dist/browser/renderer/newtab.html",
				title: "newtab",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				internal: true,
			},
		];
		const result = await createBrowserExecutor(manager(internal), { design: designHost() })({
			op: "design.status",
			timeoutMs: 30000,
		} as BrowserPageRequest);
		expect(result.ok).toBe(true);
	});
});
