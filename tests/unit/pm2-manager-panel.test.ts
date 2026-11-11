// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import pm2Panel from "../../plugins/pm2-manager/client/entry.mjs";

type Payload = Record<string, unknown>;

function deferredFetch() {
	let resolve!: (payload: Payload) => void;
	const calls: string[] = [];
	const fetchStub = vi.fn((url: string) => {
		calls.push(String(url));
		return new Promise((res) => {
			resolve = (payload: Payload) => res({ ok: true, json: async () => payload });
		});
	});
	vi.stubGlobal("fetch", fetchStub);
	return { calls, reply: (payload: Payload) => resolve(payload) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let cleanup: (() => void) | undefined;

function mountPanel() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	cleanup = pm2Panel.mount(container) as () => void;
	return container;
}

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	(pm2Panel as { _resetCache?: () => void })._resetCache?.();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("pm2-manager 面板首帧", () => {
	it("首帧不下结论：/status 未回来前不闪「未检测到 pm2」/「没有应用」", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();

		const first = container.textContent ?? "";
		expect(first).not.toContain("未检测到");
		expect(first).not.toContain("当前没有托管任何应用");
		expect(first).toContain("正在检测");

		reply({ ok: true, installed: false, version: "", apps: [], error: "", platform: "win32" });
		await flush();
		const after = container.textContent ?? "";
		expect(after).toContain("未检测到");
		expect(after).not.toContain("正在检测");
	});

	it("已装 pm2：首帧同样不闪黄条，回来后直接显示版本与应用表", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();
		expect(container.textContent ?? "").not.toContain("未检测到");

		reply({
			ok: true,
			installed: true,
			version: "5.4.2",
			apps: [{ name: "api", status: "online", cpu: 1, memory: 1024, restarts: 0, startedAt: Date.now() }],
			error: "",
			platform: "win32",
		});
		await flush();
		const after = container.textContent ?? "";
		expect(after).toContain("pm2 5.4.2");
		expect(after).toContain("api");
		expect(after).not.toContain("未检测到");
		expect(after).not.toContain("正在检测");
	});

	it("请求失败或网络异常时不误报「未检测到 pm2」", async () => {
		document.documentElement.lang = "zh";
		const fetchStub = vi.fn(() => Promise.reject(new Error("Network Error")));
		vi.stubGlobal("fetch", fetchStub);

		const container = mountPanel();
		await flush();
		const text = container.textContent ?? "";
		expect(text).not.toContain("未检测到");
		expect(text).toContain("Network Error");
	});

	it("安装/管理/卸载一体：已安装时有启动新应用与卸载入口，未安装时没有", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();

		reply({
			ok: true,
			installed: true,
			version: "5.4.2",
			apps: [{ name: "api", status: "online", cpu: 1, memory: 1024, restarts: 0, startedAt: Date.now() }],
			error: "",
			platform: "win32",
		});
		await flush();
		expect(container.textContent ?? "").toContain("启动新应用");
		expect(container.textContent ?? "").toContain("卸载 pm2");
	});

	it("未安装时不显示启动表单与卸载：只显示安装横幅", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();

		reply({ ok: true, installed: false, version: "", apps: [], error: "", platform: "win32" });
		await flush();
		const text = container.textContent ?? "";
		expect(text).toContain("安装 pm2");
		expect(text).not.toContain("启动新应用");
		expect(text).not.toContain("卸载 pm2");
	});

	it("卸载走二次确认：先问、确认后才 POST /uninstall", async () => {
		document.documentElement.lang = "zh";
		const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init?: { method?: string; body?: unknown }) => {
				calls.push({ url: String(url), method: init?.method, body: init?.body });
				if (String(url).endsWith("/uninstall"))
					return Promise.resolve({
						ok: true,
						json: async () => ({ ok: true, installed: false, version: "", apps: [], error: "", platform: "win32" }),
					});
				return Promise.resolve({
					ok: true,
					json: async () => ({
						ok: true,
						installed: true,
						version: "5.4.2",
						apps: [],
						error: "",
						platform: "win32",
					}),
				});
			}),
		);
		const container = mountPanel();
		await flush();
		await flush();

		const buttons = () => [...container.querySelectorAll("button")];
		const uninstallBtn = buttons().find((b) => b.textContent?.includes("卸载 pm2"));
		expect(uninstallBtn).toBeDefined();
		uninstallBtn!.click();
		expect(container.textContent ?? "").toContain("确认卸载");
		expect(calls.some((c) => c.url.endsWith("/uninstall"))).toBe(false);

		buttons()
			.find((b) => b.textContent?.includes("确认卸载"))!
			.click();
		await flush();
		await flush();
		await flush();
		expect(calls.some((c) => c.url.endsWith("/uninstall"))).toBe(true);
		expect(container.textContent ?? "").toContain("未检测到");
	});

	it("启动新应用：展开表单、填入口、POST /action 下发 start", async () => {
		document.documentElement.lang = "zh";
		const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init?: { method?: string; body?: unknown }) => {
				calls.push({ url: String(url), method: init?.method, body: init?.body });
				if (String(url).endsWith("/action"))
					return Promise.resolve({
						ok: true,
						json: async () => ({
							ok: true,
							installed: true,
							version: "5.4.2",
							apps: [{ name: "api", status: "online", cpu: 1, memory: 1024, restarts: 0, startedAt: Date.now() }],
							error: "",
							platform: "win32",
							output: "已用 pm2 托管 api",
						}),
					});
				return Promise.resolve({
					ok: true,
					json: async () => ({ ok: true, installed: true, version: "5.4.2", apps: [], error: "", platform: "win32" }),
				});
			}),
		);
		const container = mountPanel();
		await flush();
		await flush();

		container.querySelector<HTMLElement>("summary[data-act='toggle-start']")?.click();
		const scriptInput = container.querySelector<HTMLInputElement>("input[data-field='script']");
		expect(scriptInput).not.toBeNull();
		scriptInput!.value = "server.js";
		scriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
		container.querySelector<HTMLElement>("button[data-act='start-new']")?.click();
		await flush();
		await flush();
		await flush();
		const startCall = calls.find((c) => c.url.endsWith("/action"));
		expect(startCall).toBeDefined();
		const body = JSON.parse(String(startCall!.body));
		expect(body).toMatchObject({ action: "start", script: "server.js" });
		expect(container.textContent ?? "").toContain("api");
	});

	it("二次打开复用已知状态缓存：首帧直接呈现真实结构，零占位零闪烁", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container1 = mountPanel();

		reply({
			ok: true,
			installed: true,
			version: "5.4.2",
			apps: [{ name: "web", status: "online", cpu: 2, memory: 2048, restarts: 0, startedAt: Date.now() }],
			error: "",
			platform: "win32",
		});
		await flush();
		expect(container1.textContent ?? "").toContain("pm2 5.4.2");

		cleanup?.();
		cleanup = undefined;
		document.body.innerHTML = "";

		deferredFetch();
		const container2 = mountPanel();
		const firstFrame = container2.textContent ?? "";

		expect(firstFrame).toContain("pm2 5.4.2");
		expect(firstFrame).toContain("web");
		expect(firstFrame).not.toContain("正在检测");
		expect(firstFrame).not.toContain("未检测到");
	});
});
