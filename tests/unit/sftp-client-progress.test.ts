// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

type Post = { path: string; body: Record<string, unknown> };

const posts: Post[] = [];
let state: Record<string, unknown> = {};
let planToken: string | null = "p-preview-1";

(globalThis.window as unknown as { __piWebUiHost?: unknown }).__piWebUiHost = {
	version: 11,
	setView: () => {},
	onUiAction: () => () => {},
};
const bundle = (await import("../../plugins/sftp/client/entry.mjs")).default as {
	mount: (c: HTMLElement) => () => void;
};

const PLAN = {
	profile: "mock",
	summary: { upload: 1, download: 0, trashRemote: 0, trashLocal: 0, skip: 2, conflict: 0, total: 3 },
	roots: [],
	warnings: [],
	at: null,
};

function baseState(): Record<string, unknown> {
	return {
		cwd: "E:/proj",
		configPath: ".pi/sftp.json",
		localPath: ".pi/sftp.local.json",
		trashPath: ".pi/sftp-trash",
		active: "mock",
		connection: { name: "mock", host: "127.0.0.1", port: 22, remotePath: "/home/test", ready: true },
		profiles: [{ name: "mock", ready: true }],
		settings: {},
		warnings: [],
		plaintext: [],
		dep: { status: "ready" },
		pool: [],
		job: {
			running: false,
			kind: "",
			phase: "",
			done: 0,
			total: 0,
			rel: "",
			bytes: 0,
			scan: { side: "", files: 0, dirs: 0 },
			error: "",
			cancelled: false,
			reusedPlan: false,
			result: null,
		},
		lastPlan: null,
		vscodeImportAvailable: false,
	};
}

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const u = String(url);
			const send = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
			if (u.includes("/plan")) {
				posts.push({ path: "/plan", body });
				return send({ plan: PLAN, text: "plan", planToken, reused: false });
			}
			if (u.includes("/sync")) {
				posts.push({ path: "/sync", body });
				return send({
					dryRun: body.dryRun !== false,
					plan: PLAN,
					result: null,
					text: "plan",
					planToken,
					reused: body.reuse === true && body.planToken === planToken,
				});
			}
			if (u.includes("/cancel")) {
				posts.push({ path: "/cancel", body });
				return send({ cancelled: true });
			}
			if (u.includes("/remote")) return send({ dir: "/home/test", entries: [] });
			return send(state);
		}),
	);
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

let cleanup: (() => void) | undefined;
function mount(): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	cleanup = bundle.mount(container);
	return container;
}

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	posts.length = 0;
	planToken = "p-preview-1";
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("sftp 面板：扫描进度与停止", () => {
	it("扫描期间显示进度计数，停止键可见且点了真的请求 /cancel", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		state.job = {
			running: true,
			kind: "plan",
			phase: "scan",
			done: 0,
			total: 0,
			rel: "",
			bytes: 0,
			scan: { side: "remote", files: 4321, dirs: 210 },
			error: "",
			cancelled: false,
			reusedPlan: false,
			result: null,
		};
		stubFetch();
		const el = mount();
		await flush();

		expect(el.textContent ?? "").toContain("扫描远端：4321 个文件 / 210 个目录");
		const stop = el.querySelector(".btn-stop") as HTMLButtonElement;
		expect(stop.classList.contains("hidden")).toBe(false);
		expect(stop.disabled).toBe(false);

		stop.click();
		await flush();
		expect(posts.map((p) => p.path)).toContain("/cancel");
	});

	it("没有任务时停止键藏起来（不占位、不误导）", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		stubFetch();
		const el = mount();
		await flush();
		expect((el.querySelector(".btn-stop") as HTMLElement).classList.contains("hidden")).toBe(true);
	});

	it("被停止的任务写「已停止」，不再显示传输进度", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		state.job = {
			running: false,
			kind: "sync",
			phase: "cancelled",
			done: 1,
			total: 9,
			rel: "",
			bytes: 0,
			scan: { side: "remote", files: 3, dirs: 1 },
			error: "",
			cancelled: true,
			reusedPlan: false,
			result: null,
		};
		stubFetch();
		const el = mount();
		await flush();
		expect(el.textContent ?? "").toContain("已停止（已完成的文件保留）");
	});
});

describe("sftp 面板：计划复用", () => {
	it("预览后参数没变：执行带 reuse + planToken（服务端不必重扫）", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		stubFetch();
		const el = mount();
		await flush();
		globalThis.confirm = () => true;

		(el.querySelector(".btn-plan") as HTMLButtonElement).click();
		await flush();
		(el.querySelector(".btn-run") as HTMLButtonElement).click();
		await flush();

		const sync = posts.find((p) => p.path === "/sync");
		expect(sync?.body).toMatchObject({ dryRun: false, reuse: true, planToken: "p-preview-1" });
	});

	it("预览后改了参数：不带 token（老老实实重扫）", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		stubFetch();
		const el = mount();
		await flush();
		globalThis.confirm = () => true;

		(el.querySelector(".btn-plan") as HTMLButtonElement).click();
		await flush();
		(el.querySelector(".f-path") as HTMLInputElement).value = "src/deep";
		(el.querySelector(".btn-run") as HTMLButtonElement).click();
		await flush();

		const sync = posts.find((p) => p.path === "/sync");
		expect(sync?.body.reuse).toBeUndefined();
		expect(sync?.body.planToken).toBeUndefined();
		expect(sync?.body.path).toBe("src/deep");
	});

	it("token 用掉即作废：连续两次执行只有第一次带 token", async () => {
		document.documentElement.lang = "zh";
		state = baseState();
		stubFetch();
		const el = mount();
		await flush();
		globalThis.confirm = () => true;

		(el.querySelector(".btn-plan") as HTMLButtonElement).click();
		await flush();
		(el.querySelector(".btn-run") as HTMLButtonElement).click();
		await flush();
		(el.querySelector(".btn-run") as HTMLButtonElement).click();
		await flush();

		const syncs = posts.filter((p) => p.path === "/sync");
		expect(syncs).toHaveLength(2);
		expect(syncs[0]?.body.reuse).toBe(true);
		expect(syncs[1]?.body.reuse).toBeUndefined();
	});

	it("后台正在跑其他项目的同步：进度条带项目名前缀，停止键可用", async () => {
		document.documentElement.lang = "zh";
		const s = baseState();
		s.cwd = "E:/proj-b";
		(s.job as Record<string, unknown>).running = true;
		(s.job as Record<string, unknown>).phase = "upload";
		(s.job as Record<string, unknown>).done = 3;
		(s.job as Record<string, unknown>).total = 10;
		(s.job as Record<string, unknown>).cwd = "E:/proj-a";
		(s.job as Record<string, unknown>).projectName = "proj-a";
		state = s;
		stubFetch();
		const el = mount();
		await flush();

		const prog = el.querySelector(".progress") as HTMLElement;
		expect(prog.classList.contains("hidden")).toBe(false);
		expect(prog.textContent).toContain("[proj-a]");
		expect(prog.textContent).toContain("3/10");

		const stopBtn = el.querySelector(".btn-stop") as HTMLButtonElement;
		expect(stopBtn.classList.contains("hidden")).toBe(false);
		expect(stopBtn.disabled).toBe(false);

		stopBtn.click();
		await flush();
		const cancel = posts.find((p) => p.path === "/cancel");
		expect(cancel).toBeDefined();
	});
});
