// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ws from "../../plugins/image-toolkit/client/workspace.mjs";
import { basename, el } from "../../plugins/image-toolkit/client/util.mjs";
import view from "../../plugins/image-toolkit/client/entry.mjs";

function dummyPngBytes() {
	return new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	]);
}

describe("image-toolkit 图片流转核心基础", () => {
	it("ws.readImage 正常导出并返回 ArrayBuffer", async () => {
		const fakePng = dummyPngBytes();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				blob: async () => new Blob([fakePng], { type: "image/png" }),
			}),
		);

		expect(typeof ws.readImage).toBe("function");
		const buf = await ws.readImage("pics/sample.png");
		expect(buf instanceof ArrayBuffer).toBe(true);
		const u8 = new Uint8Array(buf);
		expect(u8[0]).toBe(0x89);
		expect(u8[1]).toBe(0x50);
		expect(u8[2]).toBe(0x4e);
		expect(u8[3]).toBe(0x47);
	});

	it("basename 处理各种斜杠和边界路径", () => {
		expect(basename("generated/foo.png")).toBe("foo.png");
		expect(basename("generated\\bar.jpg")).toBe("bar.jpg");
		expect(basename("baz.webp")).toBe("baz.webp");
		expect(basename("")).toBe("image");
		expect(basename(null as any)).toBe("image");
	});

	it("el() 能够正确支持 style 对象与字符串声明", () => {
		const nodeObj = el("div", { style: { display: "none", width: "100px" } });
		expect(nodeObj.style.display).toBe("none");
		expect(nodeObj.style.width).toBe("100px");

		const nodeStr = el("div", { style: "display: flex; height: 50px;" });
		expect(nodeStr.style.display).toBe("flex");
		expect(nodeStr.style.height).toBe("50px");
	});
});

describe("image-toolkit 视图外壳与一体化布局", () => {
	let container: HTMLElement;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				const s = String(url);
				if (s.includes("/ws/settings")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ settings: { defaultFormat: "keep", quality: 0.82 } }),
					};
				}
				if (s.includes("/gen/config") || s.includes("/config")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								cwd: "E:/ws",
								config: { services: [], outputDir: "generated" },
								shapes: [],
								presets: [],
								jobs: [],
							}),
					};
				}
				if (s.includes("/gen/jobs") || s.includes("/jobs")) {
					return {
						ok: true,
						status: 200,
						text: async () => JSON.stringify({ jobs: [] }),
					};
				}
				if (s.includes("/ws/image")) {
					return {
						ok: true,
						status: 200,
						blob: async () => new Blob([dummyPngBytes()], { type: "image/png" }),
					};
				}
				return { ok: true, status: 200, text: async () => "{}" };
			}),
		);
	});

	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
		container.remove();
		vi.unstubAllGlobals();
	});

	it("初始化渲染一体化 Studio 顶栏与四模态导航", async () => {
		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		const top = container.querySelector(".igt-top");
		expect(top).toBeTruthy();

		const navTabs = [...container.querySelectorAll(".igt-nav-tab")];
		expect(navTabs.length).toBe(4);
		const modes = navTabs.map((t) => t.getAttribute("data-mode"));
		expect(modes).toEqual(["edit", "gen", "svc", "cfg"]);

		expect(navTabs[0].classList.contains("on")).toBe(true);
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");

		const actions = container.querySelector(".igt-actions");
		expect(actions).toBeTruthy();
		expect(actions!.querySelector(".igt-act-hero-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-flow-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-batch-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-history-row")).toBeTruthy();

		const useAsRefBtn = actions!.querySelector(".igt-btn-flow");
		expect(useAsRefBtn).toBeTruthy();
	});

	it("点击 Studio 顶栏可在编辑模式与生图模式之间自由双向切换，绝不陷死", async () => {
		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		const navTabs = [...container.querySelectorAll(".igt-nav-tab")] as HTMLButtonElement[];
		const [editTab, genTab, svcTab, cfgTab] = navTabs;
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;

		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");

		genTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(genTab.classList.contains("on")).toBe(true);
		expect(editTab.classList.contains("on")).toBe(false);

		svcTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(svcTab.classList.contains("on")).toBe(true);

		cfgTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(cfgTab.classList.contains("on")).toBe(true);

		editTab.click();
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");
		expect(editTab.classList.contains("on")).toBe(true);
		expect(cfgTab.classList.contains("on")).toBe(false);
	});

	it("图片流转：在 AI 生图页面点击「在图片工具箱处理」能顺利读取图片并切换到编辑状态", async () => {
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 200, height: 150, close: vi.fn() }));
		HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
			drawImage: vi.fn(),
			getImageData: vi.fn().mockReturnValue({ data: new Uint8Array(400) }),
			putImageData: vi.fn(),
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			translate: vi.fn(),
			rotate: vi.fn(),
			scale: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			clip: vi.fn(),
			rect: vi.fn(),
			arc: vi.fn(),
			stroke: vi.fn(),
			fill: vi.fn(),
		}) as any;
		HTMLCanvasElement.prototype.toBlob = function (callback) {
			callback(new Blob([dummyPngBytes()], { type: "image/png" }));
		};

		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				const s = String(url);
				if (s.includes("/ws/settings")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ settings: { defaultFormat: "keep", quality: 0.82 } }),
					};
				}
				if (s.includes("/gen/config") || s.includes("/config")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								cwd: "E:/ws",
								config: {
									services: [{ id: "mock-svc", name: "Mock Service", enabled: true, models: ["m1"], sizes: ["1:1"] }],
									outputDir: "generated",
								},
								shapes: [],
								presets: [],
								jobs: [
									{
										id: "job-1",
										status: "done",
										prompt: "a cute robot",
										serviceId: "mock-svc",
										model: "m1",
										files: [{ path: "generated/robot.png", bytes: 1024, mime: "image/png" }],
									},
								],
							}),
					};
				}
				if (s.includes("/gen/jobs") || s.includes("/jobs")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								jobs: [
									{
										id: "job-1",
										status: "done",
										prompt: "a cute robot",
										serviceId: "mock-svc",
										model: "m1",
										files: [{ path: "generated/robot.png", bytes: 1024, mime: "image/png" }],
									},
								],
							}),
					};
				}
				if (s.includes("/ws/image")) {
					return {
						ok: true,
						status: 200,
						blob: async () => new Blob([dummyPngBytes()], { type: "image/png" }),
					};
				}
				if (s.includes("/ws/save")) {
					return {
						ok: true,
						status: 200,
						text: async () => JSON.stringify({ ok: true, path: "temp/ref-robot.png" }),
					};
				}
				return { ok: true, status: 200, text: async () => "{}" };
			}),
		);

		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		const navTabs = [...container.querySelectorAll(".igt-nav-tab")] as HTMLButtonElement[];
		const [editTab, genTab] = navTabs;
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;

		genTab.click();
		expect(genWrap.style.display).toBe("flex");
		expect(main.style.display).toBe("none");

		for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));

		const editInToolkitBtn = [...genWrap.querySelectorAll("button")].find(
			(b) => b.textContent?.includes("进入处理") || b.textContent?.includes("Edit in Toolkit"),
		);
		expect(editInToolkitBtn).toBeTruthy();

		const readSpy = vi.spyOn(ws, "readImage");
		editInToolkitBtn!.click();

		await new Promise((r) => setTimeout(r, 60));

		expect(readSpy).toHaveBeenCalledWith("generated/robot.png");
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");
		expect(editTab.classList.contains("on")).toBe(true);

		const queueItems = container.querySelectorAll(".igt-qitem");
		expect(queueItems.length).toBe(1);
		expect(container.textContent).toContain("robot.png");

		const saveSpy = vi.spyOn(ws, "saveImage");
		const useAsRefBtn = container.querySelector(".igt-btn-flow") as HTMLButtonElement;
		expect(useAsRefBtn).toBeTruthy();

		useAsRefBtn.click();
		await new Promise((r) => setTimeout(r, 60));

		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(genTab.classList.contains("on")).toBe(true);

		expect(genWrap.textContent).toContain("robot.png");
	});
});
