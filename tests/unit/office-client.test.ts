// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import office, { fileHandlers } from "../../plugins/office/client/entry.mjs";

const broker = vi.hoisted(() => ({ attach: vi.fn(), dispose: vi.fn() }));
vi.mock("../../plugins/office/client/canvas-broker.mjs", () => ({ attachCanvasBroker: broker.attach }));

const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const ctx = {
	apiUrl: (path: string, params?: Record<string, unknown>) => {
		const query = new URLSearchParams(Object.entries(params ?? {}).map(([key, value]) => [key, String(value)]));
		return `http://localhost/office${path}${query.size ? `?${query}` : ""}`;
	},
};
const file = { name: "book.xlsx", path: "docs/book.xlsx" };
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
const button = (action: string) => container.querySelector<HTMLButtonElement>(`[data-act="${action}"]`)!;
const frame = () => container.querySelector("iframe")!;
const appReady = () => broker.attach.mock.calls.at(-1)![0].onReady();
function mount() {
	cleanup = fileHandlers[0].mount(container, file, ctx);
}
const canvasSession = {
	ok: true,
	token: "canvas-token",
	channel: "canvas-channel",
	srcdoc: '<!doctype html><meta http-equiv="Content-Security-Policy" content="connect-src none">',
	sandbox: "allow-scripts allow-downloads",
	csp: "connect-src none",
};
function remoteFetch() {
	vi.stubGlobal("window", { location: new URL("https://remote.example/workspace") });
	fetchMock.mockImplementation(async (url: string) => {
		if (url.endsWith("/status")) return response({ hasArtifacts: true });
		if (new URL(url).pathname.endsWith("/open")) return response({ viewerUrl: "http://127.0.0.1:1234/viewer" });
		if (url.endsWith("/canvas-create")) return response(canvasSession);
		if (url.endsWith("/canvas-rpc")) return response({ ok: true, result: { value: 7 } });
		if (url.endsWith("/canvas-close")) return response({ ok: true });
		if (url.endsWith("/inspect"))
			return response({ result: { kind: "document", paragraphs: [{ text: "<img src=x> document text" }] } });
		if (url.endsWith("/save")) return response({ ok: true, path: file.path, size: 123 });
		throw new Error(`Unexpected request: ${url}`);
	});
}
function readyFetch(saveResponse = response({ ok: true, path: file.path, size: 123 })) {
	fetchMock.mockImplementation(async (url: string) => {
		if (url.endsWith("/status")) return response({ ready: false, hasArtifacts: true });
		if (new URL(url).pathname.endsWith("/open")) return response({ viewerUrl: "http://localhost:1234/viewer" });
		if (url.endsWith("/canvas-create")) return response(canvasSession);
		if (url.endsWith("/canvas-close")) return response({ ok: true });
		if (url.endsWith("/inspect"))
			return response({ result: { kind: "document", paragraphs: [{ text: "Local document" }] } });
		if (url.endsWith("/save")) return saveResponse;
		throw new Error(`Unexpected request: ${url}`);
	});
}
beforeEach(() => {
	// 面板文案跟随界面语言：这些断言校验中文渲染，显式固定语言（jsdom 默认 en-US）。
	localStorage.setItem("pi-web-ui:lang", "zh");

	vi.useFakeTimers();
	broker.attach.mockReset();
	broker.dispose.mockReset();
	broker.attach.mockImplementation(() => broker.dispose);
	container = document.createElement("div");
	document.body.appendChild(container);
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Office client lifecycle", () => {
	it("requires the sandbox broker on localhost, gates save on application readiness and persists save success", async () => {
		readyFetch();
		mount();
		expect(button("save").disabled).toBe(true);
		await settle();
		expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
		expect(frame().hasAttribute("src")).toBe(false);
		expect(frame().srcdoc).toBe(canvasSession.srcdoc);
		expect(broker.attach).toHaveBeenCalledTimes(1);
		frame().dispatchEvent(new Event("load"));
		expect(button("save").disabled).toBe(true);
		expect(button("save-as").disabled).toBe(true);
		appReady();
		button("save").click();
		await settle();
		expect(container.querySelector('[data-el="notice"]')?.textContent).toContain("已保存到磁盘");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(container.querySelector('[data-el="notice"]')?.textContent).toContain("123 B");
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/status"))).toHaveLength(1);
	});

	it("ignores late open responses after reload and maintains one frame", async () => {
		let resolveOld!: (value: unknown) => void;
		let opens = 0;
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith("/status")) return response({ hasArtifacts: true });
			if (new URL(url).pathname.endsWith("/open")) {
				if (++opens === 1) return new Promise((resolve) => (resolveOld = resolve));
				return response({ viewerUrl: "http://localhost:1234/new" });
			}
			if (url.endsWith("/canvas-create")) return response(canvasSession);
			if (url.endsWith("/canvas-close")) return response({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		});
		mount();
		await settle();
		const oldSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
		button("reload").click();
		await settle();
		expect(oldSignal.aborted).toBe(true);
		resolveOld(response({ viewerUrl: "http://localhost:1234/old" }));
		await settle();
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		expect(frame().hasAttribute("src")).toBe(false);
		expect(frame().srcdoc).toBe(canvasSession.srcdoc);
		expect(broker.attach).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.some(([url]) => new URL(url).searchParams.get("reload") === "1")).toBe(true);
	});

	it("polls artifacts rather than gateway readiness and cancels provisioning work once available", async () => {
		let statuses = 0;
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith("/status")) return response({ downloading: true, hasArtifacts: ++statuses >= 3 });
			if (url.endsWith("/provision-runtime")) return new Promise(() => {});
			if (url.endsWith("/canvas-create")) return response(canvasSession);
			if (url.endsWith("/canvas-close")) return response({ ok: true });
			return response({ viewerUrl: "http://localhost:1234/viewer" });
		});
		mount();
		await settle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		const provision = fetchMock.mock.calls.find(([url]) => url.endsWith("/provision-runtime"))!;
		expect(provision[1].signal.aborted).toBe(true);
		appReady();
		await vi.advanceTimersByTimeAsync(5000);
		expect(statuses).toBe(3);
	});

	it("bounds polling, offers retry and clears all timers on disposal", async () => {
		fetchMock.mockImplementation(async () => response({ downloading: true }));
		mount();
		await settle();
		await vi.advanceTimersByTimeAsync(600_001);
		expect(container.textContent).toContain("超时");
		expect(container.textContent).toContain("重试");
		const calls = fetchMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(calls);
		cleanup!();
		cleanup = undefined;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts an in-flight request on disposal without rendering a late result", async () => {
		let resolve!: (value: unknown) => void;
		fetchMock.mockImplementation(() => new Promise((done) => (resolve = done)));
		mount();
		const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
		cleanup!();
		cleanup = undefined;
		expect(signal.aborted).toBe(true);
		resolve(response({ hasArtifacts: true }));
		await settle();
		expect(container.children).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows HTTP errors even when JSON claims success", async () => {
		fetchMock.mockResolvedValue(response({ ok: true }, 503));
		mount();
		await settle();
		expect(container.textContent).toContain("HTTP 503");
		expect(button("save").disabled).toBe(true);
	});

	it("keeps save errors inline and offers reload and save-as for a conflict", async () => {
		readyFetch(response({ error: "File changed" }, 409));
		mount();
		await settle();
		appReady();
		button("save").click();
		await settle();
		expect(button("save").disabled).toBe(true);
		expect(button("reload").disabled).toBe(false);
		expect(container.querySelector("form")!.hidden).toBe(false);
		expect(container.textContent).toContain("保存冲突");
		readyFetch();
		container.querySelector<HTMLInputElement>("input")!.value = "docs/recovered.xlsx";
		container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		const posts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/save"));
		expect(JSON.parse(posts[1][1].body)).toEqual({ path: file.path, targetPath: "docs/recovered.xlsx" });
		expect(container.textContent).toContain("副本已保存");
		expect(button("save").disabled).toBe(true);
		button("reload").click();
		await settle();
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		appReady();
		expect(button("save").disabled).toBe(false);
	});

	it("preserves conflict status for non-JSON errors and aborts an active save on disposal", async () => {
		readyFetch({
			ok: false,
			status: 412,
			json: async () => {
				throw new SyntaxError("HTML error page");
			},
		});
		mount();
		await settle();
		appReady();
		button("save").click();
		await settle();
		expect(container.textContent).toContain("保存冲突：HTTP 412");
		fetchMock.mockImplementation((url: string) =>
			url.endsWith("/canvas-close") ? Promise.resolve(response({ ok: true })) : new Promise(() => {}),
		);
		container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
		cleanup!();
		cleanup = undefined;
		expect(signal.aborted).toBe(true);
		await settle();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("attaches the remote broker before srcdoc and enables saves only on application readiness", async () => {
		remoteFetch();
		broker.attach.mockImplementation(({ iframe }) => {
			expect(iframe.isConnected).toBe(false);
			expect(iframe.srcdoc).toBe("");
			return broker.dispose;
		});
		mount();
		await settle();
		expect(office.fileHandlers).toBe(fileHandlers);
		expect(frame().srcdoc).toBe(canvasSession.srcdoc);
		expect(frame().hasAttribute("src")).toBe(false);
		expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
		const create = fetchMock.mock.calls.find(([url]) => url.endsWith("/canvas-create"))!;
		expect(JSON.parse(create[1].body)).toEqual({ path: file.path });
		frame().dispatchEvent(new Event("load"));
		expect(button("save").disabled).toBe(true);
		expect(button("save-as").disabled).toBe(true);
		const options = broker.attach.mock.calls[0][0];
		expect(options.channel).toBe(canvasSession.channel);
		options.onReady();
		expect(button("save").disabled).toBe(false);
		button("save").click();
		await settle();
		expect(container.textContent).toContain("已保存到磁盘");
		expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/inspect"))).toBe(false);
	});

	it("unwraps remote RPC results, forwards cancellation and aborts RPCs on disposal", async () => {
		remoteFetch();
		mount();
		await settle();
		const options = broker.attach.mock.calls[0][0];
		const message = { id: 1, op: "getSession" };
		await expect(options.request(message, {})).resolves.toEqual({ value: 7 });
		const rpc = fetchMock.mock.calls.find(([url]) => url.endsWith("/canvas-rpc"))!;
		expect(JSON.parse(rpc[1].body)).toEqual({ token: canvasSession.token, message });
		fetchMock.mockImplementation((url: string) => {
			if (url.endsWith("/canvas-close")) return Promise.resolve(response({ ok: true }));
			return new Promise((_resolve, reject) => {
				const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
				signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
			});
		});
		const request = new AbortController();
		const pending = options.request(message, { signal: request.signal });
		const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		request.abort();
		await cancelled;
		const active = options.request(message);
		const aborted = expect(active).rejects.toMatchObject({ name: "AbortError" });
		cleanup!();
		cleanup = undefined;
		await aborted;
		await settle();
		expect(options.signal.aborted).toBe(true);
		expect(broker.dispose).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["create", "build", "startup", "timeout"])(
		"falls back to safe readonly inspection on remote %s failure",
		async (failure) => {
			remoteFetch();
			const normalFetch = fetchMock.getMockImplementation()! as (url: string, init: RequestInit) => unknown;
			fetchMock.mockImplementation((url: string, init: RequestInit) => {
				if (url.endsWith("/canvas-create") && failure === "create")
					return Promise.resolve(response({ error: "Build failed" }, 503));
				if (url.endsWith("/canvas-create") && failure === "build")
					return Promise.resolve(response({ ...canvasSession, srcdoc: null }));
				return normalFetch(url, init);
			});
			mount();
			await settle();
			if (failure === "startup") broker.attach.mock.calls[0][0].onError(new Error("Runtime failed"));
			if (failure === "timeout") {
				frame().dispatchEvent(new Event("load"));
				await vi.advanceTimersByTimeAsync(60_000);
			}
			await settle();
			expect(container.querySelector(".office-preview")?.textContent).toContain("<img src=x> document text");
			expect(container.querySelector("img")).toBeNull();
			expect(container.querySelector("iframe")).toBeNull();
			expect(button("save").disabled).toBe(true);
			expect(button("save-as").disabled).toBe(true);
			expect(container.textContent).toContain("编辑器不可用");
			expect(container.textContent).toContain("只读文本预览");
			const inspection = fetchMock.mock.calls.find(([url]) => url.endsWith("/inspect"))!;
			expect(JSON.parse(inspection[1].body)).toEqual({ path: file.path });
			expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/canvas-close"))).toHaveLength(
				failure === "create" ? 0 : 1,
			);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("releases the superseded token once and ignores stale readiness after reload", async () => {
		remoteFetch();
		mount();
		await settle();
		const old = broker.attach.mock.calls[0][0];
		button("reload").click();
		await settle();
		expect(old.signal.aborted).toBe(true);
		expect(broker.dispose).toHaveBeenCalledTimes(1);
		old.onReady();
		expect(button("save").disabled).toBe(true);
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/canvas-close"))).toHaveLength(1);
		broker.attach.mock.calls[1][0].onReady();
		expect(button("save").disabled).toBe(false);
	});

	it("releases late create allocations after disposal without mounting a frame", async () => {
		remoteFetch();
		const normalFetch = fetchMock.getMockImplementation()! as (url: string, init: RequestInit) => unknown;
		let resolveCreate!: (value: unknown) => void;
		fetchMock.mockImplementation((url: string, init: RequestInit) => {
			if (url.endsWith("/canvas-create")) return new Promise((resolve) => (resolveCreate = resolve));
			return normalFetch(url, init);
		});
		mount();
		await settle();
		const createSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
		cleanup!();
		cleanup = undefined;
		expect(createSignal.aborted).toBe(true);
		resolveCreate(response(canvasSession));
		await settle();
		expect(broker.attach).not.toHaveBeenCalled();
		expect(container.children).toHaveLength(0);
		const close = fetchMock.mock.calls.filter(([url]) => url.endsWith("/canvas-close"));
		expect(close).toHaveLength(1);
		expect(JSON.parse(close[0][1].body)).toEqual({ token: canvasSession.token });
		expect(close[0][1].signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds best-effort token release after disposal and consumes rejection", async () => {
		remoteFetch();
		mount();
		await settle();
		fetchMock.mockRejectedValue(new Error("Connection closed"));
		cleanup!();
		cleanup = undefined;
		await settle();
		expect(vi.getTimerCount()).toBe(0);
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/canvas-close"))).toHaveLength(1);
	});

	it("aborts a hung close request after its independent cleanup deadline", async () => {
		remoteFetch();
		mount();
		await settle();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
						once: true,
					});
				}),
		);
		cleanup!();
		cleanup = undefined;
		const closeSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
		expect(closeSignal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(closeSignal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("falls back to readonly on localhost when the canvas loads without application readiness", async () => {
		readyFetch();
		mount();
		await settle();
		frame().dispatchEvent(new Event("load"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(container.textContent).toContain("安全画布启动超时");
		expect(container.querySelector(".office-preview")?.textContent).toContain("Local document");
		expect(container.querySelector("iframe")).toBeNull();
		expect(button("save").disabled).toBe(true);
		expect(button("save-as").disabled).toBe(true);
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/canvas-close"))).toHaveLength(1);
	});

	it("cancels a superseded list request and does not insert server strings as HTML", async () => {
		let resolveOld!: (value: unknown) => void;
		fetchMock.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
		fetchMock.mockResolvedValue(response({ files: ["<img src=x>.xlsx"] }));
		cleanup = office.mount(container, ctx);
		button("refresh").click();
		await settle();
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
		resolveOld(response({ files: ["old.xlsx"] }));
		await settle();
		expect(container.textContent).toContain("<img src=x>.xlsx");
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).not.toContain("old.xlsx");
	});
});
